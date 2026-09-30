import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Cargo's encoded form preserves paths with spaces as single rustc arguments.
// Retain user flags, then remove personal build paths from panic/source locations.
const flags = process.env.CARGO_ENCODED_RUSTFLAGS !== undefined
  ? process.env.CARGO_ENCODED_RUSTFLAGS.split('\x1f').filter(Boolean)
  : (process.env.RUSTFLAGS ?? '').split(/\s+/).filter(Boolean);
const home = os.homedir();
const remaps = [
  [home, '/build/home'],
  [path.resolve(process.env.CARGO_HOME || path.join(home, '.cargo')), '/build/cargo'],
  [project, '/build/rhine-music'],
];
for (const [source, destination] of remaps) {
  for (const prefix of new Set([source, source.replaceAll('\\', '/')])) {
    flags.push(`--remap-path-prefix=${prefix}=${destination}`);
  }
}
const child = spawn(process.execPath, [
  path.join(project, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', ...process.argv.slice(2),
], {
  cwd: project,
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') },
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
