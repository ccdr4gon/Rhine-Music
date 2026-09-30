import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagePortable } from './package-portable.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('当前 Portable 构建只支持 Windows x64。');
}
if (process.argv.length > 2) {
  throw new Error('desktop:build 只生成 Portable ZIP，不接受安装器或自定义打包参数。');
}
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
try {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(project, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--no-bundle', '--', '--locked',
    ], {
      cwd: project, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') },
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`客户端编译失败 (${code})`)));
  });
  const result = await packagePortable(project);
  console.log(`Portable ZIP: ${result.archive} (${(result.bytes / 1024 / 1024).toFixed(2)} MiB)`);
  console.log(`SHA256: ${result.sha256}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
