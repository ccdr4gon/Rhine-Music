import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(project, 'dist');
if (!(await lstat(dist)).isDirectory() || (await lstat(dist)).isSymbolicLink()) {
  throw new Error('Build the frontend into the project dist directory first.');
}
await lstat(path.join(dist, 'index.html'));
const target = process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET
  || execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
if (!target) throw new Error('Cannot determine the Rust target for license collection.');
const metadata = JSON.parse(execFileSync('cargo', [
  'metadata', '--locked', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml',
  '--filter-platform', target,
], { cwd: project, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));

// Keep build dependencies as well: generated code may carry their notices.
// Development-only tests are not distributed in the client.
const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
const reached = new Set();
const pending = [metadata.resolve.root];
while (pending.length) {
  const id = pending.pop();
  if (reached.has(id)) continue;
  reached.add(id);
  for (const dependency of nodes.get(id)?.deps || []) {
    if (dependency.dep_kinds.some(kind => kind.kind !== 'dev')) pending.push(dependency.pkg);
  }
}
const packages = metadata.packages.filter(pkg => reached.has(pkg.id) && pkg.source)
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
const supplemental = {
  'alloc-stdlib@0.3.0': 'alloc-stdlib-0.3.0-BSD.txt',
  'defmt-parser@1.0.0': 'defmt-parser-1.0.0-MIT.txt',
  'lofty@0.25.4': 'lofty-0.25.4-MIT.txt',
  'lofty_attr@0.13.0': 'lofty_attr-0.13.0-MIT.txt',
  'ogg_pager@0.7.2': 'ogg_pager-0.7.2-MIT.txt',
  'webview2-com@0.39.1': 'webview2-com-0.39.1-MIT.txt',
  'webview2-com-macros@0.8.1': 'webview2-com-macros-0.8.1-MIT.txt',
  'webview2-com-sys@0.39.1': 'webview2-com-0.39.1-MIT.txt',
};
const licenseName = /^(licen[cs]e|copying|notice|copyright|unlicense)(?:$|[._-])/i;
const sections = [
  `Rhine Music — Rust dependency notices (${target})`,
  'Generated from Cargo.lock. Includes runtime and build dependencies; excludes development-only tests.',
  'Dependency source archives are available at the Sources URLs below. No third-party Rust source is modified by this build.',
];
const index = [];
async function licenseFiles(directory, prefix = '', selected = false) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isFile() && (selected || licenseName.test(entry.name))) files.push(relative);
    if (entry.isDirectory() && (selected || /^(licenses?|legal)$/i.test(entry.name))) {
      files.push(...await licenseFiles(path.join(directory, entry.name), relative, true));
    }
  }
  return files;
}
for (const pkg of packages) {
  const id = `${pkg.name}@${pkg.version}`;
  const directory = path.dirname(pkg.manifest_path);
  const sources = `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`;
  const files = new Set(await licenseFiles(directory));
  if (pkg.license_file) files.add(pkg.license_file);
  const texts = [];
  for (const file of [...files].sort()) texts.push(`${file.replaceAll('\\', '/')}\n\n${await readFile(path.resolve(directory, file), 'utf8')}`);
  if (!texts.length && supplemental[id]) {
    texts.push(await readFile(path.join(project, 'scripts/desktop-licenses', supplemental[id]), 'utf8'));
  }
  // These packages declare a standard license but omit its text from the crate.
  if (!texts.length && ['ferrous-opencc@0.4.0', 'ferrous-opencc-compiler@0.4.0'].includes(id)) {
    texts.push(`Apache-2.0 as declared in the published Cargo.toml.\n\n${await readFile(path.join(project, 'public/licenses/apache-2.0.txt'), 'utf8')}`);
  }
  if (id === 'ferrous-opencc@0.4.0') {
    const dictionaries = path.join(directory, 'assets/dictionaries');
    for (const file of (await readdir(dictionaries)).filter(file => file.endsWith('.txt')).sort()) {
      const header = (await readFile(path.join(dictionaries, file), 'utf8')).split(/\r?\n/)
        .filter(line => line.startsWith('#')).join('\n');
      if (header) texts.push(header);
    }
  }
  if (!texts.length && id === 'selectors@0.38.0') {
    texts.push(await readFile(path.join(project, 'scripts/desktop-licenses/MPL-2.0.txt'), 'utf8'));
  }
  if (!texts.length) throw new Error(`Missing license text for ${id}; add a verified upstream notice before distributing.`);
  index.push({ name: pkg.name, version: pkg.version, license: pkg.license, authors: pkg.authors, sources });
  sections.push(`\n${'='.repeat(72)}\n${id}\nLicense: ${pkg.license || 'See license text'}\nAuthors: ${pkg.authors.join(', ') || 'See license text / source archive'}\nSources: ${sources}\n\n${texts.join('\n\n')}`);
}

const licenses = path.join(dist, 'licenses');
await mkdir(licenses, { recursive: true });
await writeFile(path.join(licenses, 'rust-dependencies.txt'), `${sections.join('\n')}\n`);
await writeFile(path.join(licenses, 'rust-dependencies.json'), `${JSON.stringify({ target, packages: index }, null, 2)}\n`);
await copyFile(path.join(project, 'LICENSE'), path.join(licenses, 'rhine-music-MIT.txt'));
await copyFile(path.join(project, 'NOTICE.md'), path.join(licenses, 'rhine-music-NOTICE.md'));
await copyFile(path.join(project, 'scripts/desktop-licenses/sources.json'), path.join(licenses, 'supplemental-license-sources.json'));
await copyFile(path.join(project, 'scripts/desktop-licenses/README.md'), path.join(licenses, 'supplemental-license-README.md'));
// These are generated launcher/cache manifests, never music or source data.
for (const file of ['.music-build.json', 'pwa-build.json']) {
  await unlink(path.join(dist, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
console.log(`Desktop resources ready: ${packages.length} Rust dependency notices for ${target}; no Node runtime is bundled.`);
