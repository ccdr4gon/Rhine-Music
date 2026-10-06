import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { supportedNode, dependenciesReady, buildFingerprint, probeMusicService, choosePort, launchMusic, sameLegacyProcess, npmCommand, runNpm, openBrowser, SERVICE_ID } from './launch-music.mjs'
import { createMusicServer } from './music-server.mjs'

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'music-launch-'))
  const root = path.join(base, '中文 与 空格 $() & % ! 工程')
  await fs.mkdir(root)
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  return fs.realpath(root)
}
const refusal = () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }
const free = async (port) => ({ port, kind: 'free' })

test('Node engine matches package.json', () => {
  for (const version of ['22.12.0', '24.0.0', '26.3.0']) assert.equal(supportedNode(version), true)
  for (const version of ['18.20.0', '20.18.0', '20.19.0', '21.7.0', '22.11.0']) assert.equal(supportedNode(version), false)
})

test('health identity distinguishes our project, another project, HTML, and free ports', async () => {
  const probe = (body, status = 200) => probeMusicService(5175, '/project', { request: async () => ({ status, body }), legacy: () => false })
  assert.equal((await probe({ service: SERVICE_ID, projectDir: '/project', pid: 123 })).kind, 'ours')
  assert.equal((await probe({ service: SERVICE_ID, projectDir: '/another', pid: 123 })).kind, 'occupied')
  assert.equal((await probe(undefined)).kind, 'occupied')
  assert.equal((await probeMusicService(5175, '/project', { request: refusal, legacy: () => false })).kind, 'free')
})

test('old service requires both exact local process identity and music APIs', async () => {
  const request = async (_port, route) => route === '/api/health' ? { status: 404 } : route === '/api/config' ? { status: 200, body: { roots: [] } } : { status: 200, body: { version: 1, albums: [], genres: [] } }
  assert.equal((await probeMusicService(5175, '/project', { request, legacy: () => true })).kind, 'ours')
  assert.equal((await probeMusicService(5175, '/project', { request, legacy: () => false })).kind, 'occupied')
  assert.equal((await probeMusicService(5175, '/project', { request: async () => ({ status: 500 }), legacy: () => true })).kind, 'starting')
})

test('legacy process identity supports Chinese spaced cwd and rejects another script', { skip: process.platform !== 'darwin' }, () => {
  const root = '/Users/example/中文 与 空格 工程'
  const runner = (command, args) => ({ stdout: command === '/bin/ps' ? `/opt/homebrew/bin/node ${root}/scripts/music-server.mjs --port 5175\n` : args.includes('cwd') ? `p123\nn${root}\n` : '123\n' })
  assert.equal(sameLegacyProcess(5175, root, runner), true)
  assert.equal(sameLegacyProcess(5175, `${root}/another`, runner), false)
  assert.equal(sameLegacyProcess(5175, root, (command, args) => command === '/bin/ps' ? { stdout: '/opt/homebrew/bin/node another-server.mjs scripts/music-server.mjs' } : runner(command, args)), false)
})

test('reuse wins over free default; occupied default selects next free port', async () => {
  assert.deepEqual(await choosePort('/project', async (port) => ({ port, kind: port === 5178 ? 'ours' : 'free' })), { kind: 'ours', port: 5178 })
  assert.deepEqual(await choosePort('/project', async (port) => ({ port, kind: port === 5175 ? 'occupied' : 'free' })), { kind: 'free', port: 5176 })
  assert.deepEqual(await choosePort('/project', async (port) => ({ port, kind: port === 5173 ? 'ours' : 'free' })), { kind: 'ours', port: 5173 })
  await assert.rejects(choosePort('/project', async (port) => ({ port, kind: 'occupied' })), /均被其他程序占用/)
  await assert.rejects(choosePort('/project', async (port) => ({ port, kind: port === 5175 ? 'starting' : 'free' })), /暂时没有响应/)
})

test('existing service is opened without installing, building, starting, or writing data', async (t) => {
  const projectDir = await fixture(t)
  const dataDir = path.join(projectDir, 'untouched-data')
  const opened = []
  const forbid = () => assert.fail('reuse must not prepare or start')
  const result = await launchMusic({ projectDir, dataDir, probe: async (port) => ({ port, kind: port === 5175 ? 'ours' : 'free' }), prepare: forbid, start: forbid, open: (url) => opened.push(url) })
  assert.equal(result.reused, true)
  assert.deepEqual(opened, ['http://127.0.0.1:5175/'])
  await assert.rejects(fs.access(dataDir), { code: 'ENOENT' })
})

test('cold launch preserves spaced paths and releases lock; build failure never starts or opens', async (t) => {
  const projectDir = await fixture(t)
  const dataDir = path.join(projectDir, '音乐 数据')
  const calls = []
  await launchMusic({ projectDir, dataDir, probe: free, prepare: async (root) => calls.push(['prepare', root]), start: async (...args) => calls.push(['start', ...args]), open: (url) => calls.push(['open', url]) })
  assert.deepEqual(calls, [['prepare', projectDir], ['start', projectDir, dataDir, 5175], ['open', 'http://127.0.0.1:5175/']])
  await assert.rejects(fs.access(path.join(dataDir, 'launcher.lock')), { code: 'ENOENT' })
  await assert.rejects(launchMusic({ projectDir, dataDir, probe: free, prepare: async () => { throw new Error('offline install failed') }, start: () => assert.fail('must not start'), open: () => assert.fail('must not open') }), /offline install failed/)
  await assert.rejects(fs.access(path.join(dataDir, 'launcher.lock')), { code: 'ENOENT' })
})

test('concurrent double click cannot prepare two copies', async (t) => {
  const projectDir = await fixture(t)
  const dataDir = path.join(projectDir, 'data')
  let proceed, entered
  const ready = new Promise((resolve) => { entered = resolve })
  const gate = new Promise((resolve) => { proceed = resolve })
  const first = launchMusic({ projectDir, dataDir, probe: free, prepare: async () => { entered(); await gate }, start: async () => {}, open: () => {} })
  await ready
  await assert.rejects(launchMusic({ projectDir, dataDir, probe: free, prepare: () => assert.fail('duplicate prepare'), open: () => {} }), /另一个启动器/)
  proceed()
  await first
})

test('two launches do not race to delete a crashed launchers stale lock', async (t) => {
  const projectDir = await fixture(t)
  const dataDir = path.join(projectDir, 'data')
  await fs.mkdir(dataDir)
  const file = path.join(dataDir, 'launcher.lock')
  const original = JSON.stringify({ pid: 2147483647, token: 'previous-launch' })
  await fs.writeFile(file, original)
  const options = { projectDir, dataDir, probe: free, prepare: () => assert.fail('must not prepare'), start: () => assert.fail('must not start'), open: () => assert.fail('must not open') }
  await Promise.all([assert.rejects(launchMusic(options), /未正常退出/), assert.rejects(launchMusic(options), /未正常退出/)])
  assert.equal(await fs.readFile(file, 'utf8'), original)
})

test('content hash sees same-mtime edits and removals without rebuilding for README', async (t) => {
  const root = await fixture(t)
  await fs.mkdir(path.join(root, 'src'))
  const file = path.join(root, 'src/app.ts')
  await fs.writeFile(file, 'first')
  const before = await buildFingerprint(root)
  const stat = await fs.stat(file)
  await fs.writeFile(file, 'other')
  await fs.utimes(file, stat.atime, stat.mtime)
  const after = await buildFingerprint(root)
  assert.notEqual(before, after)
  await fs.writeFile(path.join(root, 'README.md'), 'documentation only')
  assert.equal(after, await buildFingerprint(root))
  await fs.unlink(file)
  assert.notEqual(after, await buildFingerprint(root))
})

test('installed ESM-only and type-only dependencies are ready without require entrypoints', async () => {
  assert.equal(await dependenciesReady(PROJECT_DIR), true)
})

test('Finder command changes cwd safely from another directory', { skip: process.platform !== 'darwin' }, async (t) => {
  const projectDir = await fixture(t)
  await fs.mkdir(path.join(projectDir, 'scripts'))
  const command = path.join(projectDir, '启动音乐播放器.command')
  await fs.copyFile(path.join(PROJECT_DIR, '启动音乐播放器.command'), command)
  await fs.writeFile(path.join(projectDir, 'scripts/launch-music.mjs'), 'console.log(JSON.stringify({cwd:process.cwd()}))')
  const result = spawnSync('/bin/bash', [command], { cwd: os.tmpdir(), encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).cwd, projectDir)
  assert.ok((await fs.stat(path.join(PROJECT_DIR, '启动音乐播放器.command'))).mode & 0o100)
})

test('npm runs lifecycle scripts in Chinese spaced paths without shell interpolation', async (t) => {
  const projectDir = await fixture(t)
  await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({ scripts: { check: 'node check.cjs' } }))
  await fs.writeFile(path.join(projectDir, 'check.cjs'), "require('node:fs').writeFileSync('cwd.txt', process.cwd())")
  const npm = await npmCommand(['--version'])
  assert.equal(spawnSync(npm.command, npm.args, { windowsHide: true }).status, 0)
  await runNpm(['run', 'check'], projectDir)
  assert.equal(await fs.readFile(path.join(projectDir, 'cwd.txt'), 'utf8'), projectDir)
  await assert.rejects(runNpm(['run', 'missing-script'], projectDir), /未完成/)
})

test('Explorer launcher never falls back to the legacy browser service when the native build is missing', { skip: process.platform !== 'win32' }, async (t) => {
  const projectDir = await fixture(t)
  await fs.mkdir(path.join(projectDir, 'scripts'))
  const script = path.join(projectDir, 'scripts/launch-music.mjs')
  const run = (command) => spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', '""%RHINE_TEST_LAUNCHER%""'], {
    cwd: os.tmpdir(), encoding: 'utf8', input: '\n', timeout: 15000, windowsHide: true, windowsVerbatimArguments: true,
    env: { ...process.env, RHINE_TEST_LAUNCHER: command },
  })
  await fs.writeFile(script, "import {writeFileSync} from 'node:fs'; writeFileSync('legacy-was-started.txt', 'unexpected')")
  // One launcher (2026-10-06: no modes, only sources; the player-skin launcher is gone).
  for (const name of ['启动音乐播放器.cmd']) {
    const command = path.join(projectDir, name)
    await fs.copyFile(path.join(PROJECT_DIR, name), command)
    const failure = run(command)
    assert.equal(failure.status, 1, failure.stderr + failure.stdout)
    await assert.rejects(fs.access(path.join(projectDir, 'legacy-was-started.txt')), { code: 'ENOENT' })
  }
})

test('the one Windows launcher starts the client as it is: no mode argument, no second launcher', async () => {
  // The client opens the source chosen last by itself (main.rs opens_player): there is nothing to
  // pass, and the player-skin launcher with its --skin / --local is gone (the owner, 2026-10-06).
  const text = await fs.readFile(path.join(PROJECT_DIR, '启动音乐播放器.cmd'), 'utf8')
  const starts = text.split(/\r?\n/).filter((line) => line.startsWith('start '))
  assert.equal(starts.length, 4)
  for (const line of starts) assert.match(line, /^start "" "[^"]+\.exe"$/, line)
  assert.doesNotMatch(text, /--skin|--local/)
  await assert.rejects(fs.access(path.join(PROJECT_DIR, '启动播放器皮肤.cmd')), { code: 'ENOENT' })
})

test('browser launch uses the platform opener and passes Windows URLs as data', () => {
  const url = 'http://127.0.0.1:5175/'
  openBrowser(url, { platform: 'win32', run: (command, args, options) => {
    assert.match(command, /powershell\.exe$/)
    assert.equal(options.env.RHINE_MUSIC_URL, url)
    assert.equal(options.windowsHide, true)
    assert.ok(!args.includes(url))
    return { status: 0 }
  } })
  openBrowser(url, { platform: 'darwin', run: (command, args) => {
    assert.equal(command, '/usr/bin/open')
    assert.deepEqual(args, [url])
    return { status: 0 }
  } })
})

test('health endpoint is read-only and retains Host and Origin restrictions', async () => {
  const { server } = await createMusicServer({ store: {}, autoScan: false })
  const request = (headers) => new Promise((resolve) => {
    let status
    server.emit('request', { method: 'GET', url: '/api/health', headers }, { setHeader() {}, writeHead(value) { status = value }, end(body) { resolve({ status, body: JSON.parse(body) }) } })
  })
  const valid = await request({ host: '127.0.0.1:5175' })
  assert.equal(valid.status, 200)
  assert.deepEqual(valid.body, { service: SERVICE_ID, projectDir: PROJECT_DIR, pid: process.pid })
  assert.equal((await request({ host: 'example.com' })).status, 403)
  assert.equal((await request({ host: '127.0.0.1:5175', origin: 'https://example.com' })).status, 403)
})
