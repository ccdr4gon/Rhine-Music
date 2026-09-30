/** Exercise the actual Rust executable and compare its public JSON to the Node service.
 * Usage: node scripts/check-desktop-contract.mjs [--binary path/to/rhine-music.exe]
 * All audio is synthesized in an isolated temporary directory. No external queries run.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { MusicLibraryStore } from './music-library.mjs';
import { createMusicServer } from './music-server.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--binary'), 'Usage: node scripts/check-desktop-contract.mjs [--binary path]');
const binary = path.resolve(args[1] || path.join(project, 'src-tauri/target/debug', process.platform === 'win32' ? 'rhine-music.exe' : 'rhine-music'));
const assets = path.join(project, 'dist');
assert.ok((await fs.stat(binary)).isFile(), `Build the Rust executable first: ${binary}`);
assert.ok((await fs.stat(path.join(assets, 'index.html'))).isFile(), 'Run npm run build first.');

// Read the current TypeScript declarations rather than duplicating a schema that
// can silently drift. Optional properties must be absent or have their declared
// type; null is not an optional string/number/object.
const declarations = ts.createSourceFile('music-types.ts', await fs.readFile(path.join(project, 'src/music-types.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const interfaces = new Map(declarations.statements.filter(ts.isInterfaceDeclaration).map(node => [node.name.text, node]));
function checkAll(items, check) {
  const errors = [];
  items.forEach((entry, index) => { try { check(entry, index); } catch (error) { errors.push(error.message); } });
  if (errors.length) assert.fail(errors.join('\n'));
}
function validate(value, type, location) {
  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName.getText(declarations);
    if (name === 'Record') {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${location}: expected Record`);
      for (const [key, entry] of Object.entries(value)) validate(entry, type.typeArguments[1], `${location}.${key}`);
      return;
    }
    const declaration = interfaces.get(name);
    assert.ok(declaration, `Unsupported contract reference ${name}`);
    return validateMembers(value, declaration.members, location);
  }
  if (ts.isTypeLiteralNode(type)) return validateMembers(value, type.members, location);
  if (ts.isArrayTypeNode(type)) {
    assert.ok(Array.isArray(value), `${location}: expected array, got ${JSON.stringify(value)}`);
    checkAll(value, (entry, index) => validate(entry, type.elementType, `${location}[${index}]`));
    return;
  }
  if (ts.isUnionTypeNode(type)) {
    const errors = [];
    for (const candidate of type.types) {
      try { validate(value, candidate, location); return; } catch (error) { errors.push(error.message); }
    }
    assert.fail(`${location}: ${JSON.stringify(value)} does not match ${type.getText(declarations)}\n${errors.join('\n')}`);
  }
  if (ts.isLiteralTypeNode(type)) {
    const literal = type.literal;
    const expected = ts.isStringLiteral(literal) ? literal.text : Number(literal.getText(declarations));
    assert.equal(value, expected, `${location}: expected ${JSON.stringify(expected)}`);
    return;
  }
  const primitive = new Map([[ts.SyntaxKind.StringKeyword, 'string'], [ts.SyntaxKind.NumberKeyword, 'number'], [ts.SyntaxKind.BooleanKeyword, 'boolean']]).get(type.kind);
  assert.ok(primitive, `Unsupported contract type ${type.getText(declarations)}`);
  assert.equal(typeof value, primitive, `${location}: expected ${primitive}, got ${JSON.stringify(value)}`);
  if (primitive === 'number') assert.ok(Number.isFinite(value), `${location}: expected finite number`);
}
function validateMembers(value, members, location) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${location}: expected object, got ${JSON.stringify(value)}`);
  for (const key of Object.keys(value)) assert.ok(!key.startsWith('_'), `${location}.${key}: private field exposed`);
  checkAll(members, member => {
    assert.ok(ts.isPropertySignature(member), `Unsupported contract member ${member.getText(declarations)}`);
    const name = member.name.getText(declarations).replace(/^"|"$/g, '');
    if (!Object.hasOwn(value, name)) {
      assert.ok(member.questionToken, `${location}.${name}: required field missing`);
      return;
    }
    validate(value[name], member.type, `${location}.${name}`);
  });
}
function contract(library, label) { validateMembers(library, interfaces.get('MusicLibrary').members, label); }

function synchsafe(n) { return Buffer.from([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]); }
function chunk(name, bytes) {
  const header = Buffer.alloc(8); header.write(name); header.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([header, bytes, bytes.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function wav(tags = {}) {
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0); format.writeUInt16LE(1, 2); format.writeUInt32LE(48000, 4);
  format.writeUInt32LE(96000, 8); format.writeUInt16LE(2, 12); format.writeUInt16LE(16, 14);
  const chunks = [chunk('fmt ', format), chunk('data', Buffer.alloc(96000))];
  if (Object.keys(tags).length) {
    const frames = Object.entries(tags).map(([id, value]) => {
      const data = Buffer.concat([Buffer.from([3]), Buffer.from(value)]);
      return Buffer.concat([Buffer.from(id), synchsafe(data.length), Buffer.alloc(2), data]);
    });
    const body = Buffer.concat(frames);
    chunks.push(chunk('id3 ', Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0]), synchsafe(body.length), body])));
  }
  const body = Buffer.concat([Buffer.from('WAVE'), ...chunks]);
  const header = Buffer.alloc(8); header.write('RIFF'); header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(task, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await task(); if (value) return value; } catch (error) { last = error; }
    await delay(40);
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ''}`);
}
async function json(origin, route, body, expected = 200) {
  const response = await fetch(`${origin}${route}`, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  const value = await response.json();
  assert.equal(response.status, expected, `${route}: ${JSON.stringify(value)}`);
  return value;
}
async function idle(origin) {
  return until(async () => {
    const library = await json(origin, '/api/library');
    if (library.scan.running) return false;
    assert.ok(!library.scan.error, library.scan.error);
    return library;
  }, 'scan completion');
}
// Differences permitted by the migration: scan timestamps, filesystem error
// wording, traversal order of albums/genres, artwork cache version, and the
// explicitly equivalent PCM display name. Track order and all other fields stay.
function comparable(library) {
  const result = structuredClone(library);
  delete result.scan.startedAt; delete result.scan.finishedAt;
  for (const root of result.roots) delete root.error;
  result.albums.sort((a, b) => a.id.localeCompare(b.id));
  result.genres.sort((a, b) => a.id.localeCompare(b.id));
  for (const album of result.albums) {
    if (album.coverUrl) {
      const url = new URL(album.coverUrl, 'http://fixture.invalid');
      assert.ok(url.searchParams.has('v'), 'artwork cache version missing');
      url.searchParams.delete('v');
      album.coverUrl = `${url.pathname}${url.search}`;
    }
    for (const track of album.tracks) {
      if (['PCM', 'PCM (uncompressed)'].includes(track.codec)) track.codec = 'PCM';
    }
  }
  return result;
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-desktop-contract-'));
const root = path.join(temporary, '中文 空格 & Music');
const rustData = path.join(temporary, 'rust-index');
const nodeData = path.join(temporary, 'node-index');
let child;
let childExit;
let nativeOrigin;
let nodeServer;
let nativeLog = '';
let checkpoints = 0;
async function startNative() {
  const env = { ...process.env, MUSIC_DATA_DIR: rustData };
  for (const key of Object.keys(env)) {
    if (['MUSIC_ROOTS', 'MUSICBRAINZ_CONTACT'].includes(key.toUpperCase())) delete env[key];
  }
  child = spawn(binary, ['--headless', '--data-dir', rustData, '--assets', assets, '--port', '0'], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let announced;
  let spawnError;
  nativeLog = '';
  child.on('error', error => { spawnError = error; });
  childExit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stdout.on('data', bytes => {
    nativeLog += bytes.toString();
    for (const line of nativeLog.split(/\r?\n/)) {
      try { const value = JSON.parse(line); if (value.backend === 'rust' && value.port) announced = value; } catch {}
    }
  });
  child.stderr.on('data', bytes => { nativeLog += bytes.toString(); });
  const info = await until(() => {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, `Rust exited before startup: ${nativeLog}`);
    return announced;
  }, 'Rust startup');
  assert.equal(info.pid, child.pid, 'headless port announcement must come from the created process');
  nativeOrigin = `http://127.0.0.1:${info.port}`;
  const health = await json(nativeOrigin, '/api/health');
  assert.equal(health.backend, 'rust');
  assert.equal(health.pid, child.pid, 'HTTP server must be inside the created Rust process');
  await idle(nativeOrigin);
}
async function stopNative() {
  if (!child) return;
  const origin = nativeOrigin;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  let timer;
  try {
    await Promise.race([childExit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Created Rust process did not exit')), 5000); })]);
  } finally { clearTimeout(timer); }
  child = undefined;
  if (origin) await until(async () => {
    try { await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(300) }); return false; } catch { return true; }
  }, 'service must disappear after its Rust process exits', 3000);
}
try {
  await fs.mkdir(path.join(root, 'Album A', 'Nested'), { recursive: true });
  await fs.writeFile(path.join(root, '单曲一.wav'), wav());
  await fs.writeFile(path.join(root, '单曲二.wav'), wav());
  const common = { TALB: '合成专辑', TPE1: '曲目歌手', TPE2: '专辑歌手', TDRC: '2001', TCON: 'Jazz', TPOS: '1/2' };
  await fs.writeFile(path.join(root, 'Album A', '1-10 Ten.wav'), wav({ ...common, TIT2: '第十首', TRCK: '10/10' }));
  await fs.writeFile(path.join(root, 'Album A', '1-02 Two.wav'), wav({ ...common, TIT2: '第二首', TRCK: '2/10' }));
  await fs.writeFile(path.join(root, 'Album A', 'Nested', '1-01 Nested.wav'), wav());
  await fs.writeFile(path.join(root, 'Album A', 'cover.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', 'base64'));
  const original = new Map();
  for (const file of ['单曲一.wav', '单曲二.wav', 'Album A/1-10 Ten.wav', 'Album A/1-02 Two.wav', 'Album A/Nested/1-01 Nested.wav']) original.set(file, await fs.readFile(path.join(root, file)));
  const store = await new MusicLibraryStore({ dataDir: nodeData, defaultRoots: [], musicBrainzContact: '', fetcher: () => { throw new Error('Contract fixture must not query network'); } }).init();
  ({ server: nodeServer } = await createMusicServer({ store, distDir: assets, autoScan: false }));
  await new Promise(resolve => nodeServer.listen(0, '127.0.0.1', resolve));
  const nodeOrigin = `http://127.0.0.1:${nodeServer.address().port}`;
  await startNative();
  async function compare(label) {
    const [rust, node] = await Promise.all([idle(nativeOrigin), idle(nodeOrigin)]);
    contract(rust, `Rust ${label}`); contract(node, `Node ${label}`);
    assert.deepEqual(comparable(rust), comparable(node), `${label}: public library differs from Node behavior`);
    checkpoints++;
    console.log(`PASS ${label}: ${rust.albums.length} albums, ${rust.albums.reduce((n, a) => n + a.tracks.length, 0)} tracks`);
    return rust;
  }
  async function scanBoth() {
    await Promise.all([nativeOrigin, nodeOrigin].map(origin => json(origin, '/api/library/scan', {}, 202)));
  }
  await compare('initial empty library');
  const configuration = { roots: [root, path.join(root, 'Album A'), root], onlineEnabled: false, musicBrainzContact: 'contract@example.invalid', foobarBaseUrl: null };
  const [rustConfig, nodeConfig] = await Promise.all([nativeOrigin, nodeOrigin].map(origin => json(origin, '/api/config', configuration)));
  assert.deepEqual(rustConfig, nodeConfig, 'configuration JSON contract');
  assert.deepEqual(rustConfig.roots, [root], 'nested and duplicate roots are collapsed');
  await scanBoth();
  const first = await compare('tagged WAV, root singles, nested albums and missing optional tags');
  assert.equal(first.albums.length, 4);
  const tagged = first.albums.find(a => a.title === common.TALB);
  assert.ok(tagged); assert.equal(tagged.year, 2001); assert.equal(tagged.discCount, 2);
  assert.deepEqual(tagged.tracks.map(t => t.trackNumber), [2, 10]);
  assert.equal(tagged.genreId, 'jazz'); assert.ok(tagged.coverUrl);
  const audio = tagged.tracks[0];
  const ranged = await fetch(`${nativeOrigin}${audio.audioUrl}`, { headers: { Range: 'bytes=0-43' } });
  assert.equal(ranged.status, 206);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), original.get('Album A/1-02 Two.wav').subarray(0, 44));
  const rules = await json(nodeOrigin, '/api/genre-rules');
  rules.albumOverrides[tagged.id] = 'classical';
  await Promise.all([nativeOrigin, nodeOrigin].map(origin => json(origin, '/api/genre-rules', rules)));
  await fs.writeFile(path.join(root, 'Album A', '1-03 Added.wav'), wav({ ...common, TIT2: '新增第三首', TRCK: '3/10' }));
  await scanBoth();
  const changed = await compare('incremental addition and manual genre');
  assert.equal(changed.albums.find(a => a.id === tagged.id).genreId, 'classical');
  assert.deepEqual(changed.albums.find(a => a.id === tagged.id).tracks.map(t => t.trackNumber), [2, 3, 10]);
  await fs.unlink(path.join(root, 'Album A', '1-03 Added.wav'));
  await scanBoth();
  await compare('incremental removal');
  await stopNative();
  await startNative();
  await compare('restart preserves IDs, roots and genre rules');
  const disconnected = `${root}-disconnected`;
  await fs.rename(root, disconnected);
  try {
    await scanBoth();
    const offline = await compare('disconnected directory retains indexed albums');
    assert.equal(offline.roots[0].status, 'offline');
    assert.ok(offline.albums.every(a => a.offline));
  } finally { await fs.rename(disconnected, root); }
  await scanBoth();
  await compare('reconnected directory');
  for (const [file, bytes] of original) assert.deepEqual(await fs.readFile(path.join(root, file)), bytes, `Source file changed: ${file}`);
  await Promise.all([nativeOrigin, nodeOrigin].map(origin => json(origin, '/api/config', { roots: [] })));
  const removed = await compare('removed root hides its albums');
  assert.equal(removed.albums.length, 0);
  await stopNative();
  console.log(`PASS desktop contract: ${checkpoints} comparisons; Rust PID/health, Range bytes, read-only files and process shutdown verified.`);
} finally {
  await stopNative();
  if (nodeServer) { nodeServer.closeAllConnections(); await new Promise(resolve => nodeServer.close(resolve)); }
  // Only this mkdtemp directory is owned by the checker; never delete project data.
  assert.ok(path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('rhine-desktop-contract-'));
  await fs.rm(temporary, { recursive: true, force: true });
}
