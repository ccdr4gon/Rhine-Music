import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function checkTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Portable 资源不能包含符号链接：${entry.name}`);
    if (/\.(exe|msi|msix|appx|node|pdb)$/i.test(entry.name) || entry.name === 'node_modules') {
      throw new Error(`界面资源中不允许包含安装器、额外程序或开发依赖：${entry.name}`);
    }
    if (entry.isDirectory()) await checkTree(file);
    else if (!entry.isFile()) throw new Error(`不支持的资源类型：${entry.name}`);
  }
}

export async function packagePortable(project) {
  const root = await realpath(project);
  const dist = path.join(root, 'dist');
  if (!(await lstat(dist)).isDirectory() || (await lstat(dist)).isSymbolicLink()) throw new Error('dist 必须是普通目录');
  await checkTree(dist);
  await stat(path.join(dist, 'index.html'));
  await stat(path.join(dist, 'licenses/rust-dependencies.txt'));
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('无效版本号');
  const stagingParent = path.join(root, '.tools/portable-builds');
  await mkdir(stagingParent, { recursive: true });
  const canonicalParent = await realpath(stagingParent);
  if (!canonicalParent.startsWith(root + path.sep)) throw new Error('临时打包目录超出工程范围');
  const stage = await mkdtemp(path.join(canonicalParent, 'build-'));
  try {
    const folder = path.join(stage, 'Rhine Music');
    await mkdir(folder);
    // Use an allowlist. Never package an existing user's portable data/cache.
    await copyFile(path.join(root, 'src-tauri/target/release/rhine-music.exe'), path.join(folder, 'Rhine Music.exe'));
    await cp(dist, path.join(folder, 'web'), { recursive: true, dereference: false });
    for (const name of ['LICENSE', 'NOTICE.md', '启动音乐播放器.cmd', '启动播放器皮肤.cmd']) {
      await copyFile(path.join(root, name), path.join(folder, name));
    }
    await writeFile(path.join(folder, '使用说明.txt'), [
      `Rhine Music ${version} — Windows x64 Portable Edition`,
      '',
      '请先完整解压，再双击 Rhine Music.exe。无需安装，无需管理员权限或 Node.js。',
      'Rhine Music.exe 与 web 文件夹必须保留在同一目录，不能只拷走 exe。',
      '第一次运行会在程序旁创建 data，保存设置、索引、封面缓存和 WebView 界面缓存。',
      '搬移时先关闭程序，再搬走整个文件夹；更新时保留自己的 data。',
      '音乐文件仍在原位置，只读使用；换电脑或盘符后可重新选择音乐文件夹。',
      '播放器皮肤模式：双击 启动播放器皮肤.cmd，或在界面内点击连接播放器。',
      '连上的播放器会被记住：在皮肤模式中退出后，下次直接双击 Rhine Music.exe 会回到皮肤模式并自动连接它；点“断开连接”后不再自动连接。',
      '启动音乐播放器.cmd 总是打开本地音乐，启动播放器皮肤.cmd 总是打开播放器皮肤。',
      '需要系统已有 Microsoft Edge WebView2 Runtime；本程序不会自动下载安装组件。',
      '请放在可写文件夹，不要在压缩包或只读目录里直接运行。',
      '需要单独存放数据时，可用绝对路径的 MUSIC_DATA_DIR 环境变量覆盖。',
      '停止使用：退出程序后移走或删除本文件夹；data 内有个人设置，请按需备份。',
      '',
      '本包不附带歌曲、Node.js、安装器或卸载器。代码与第三方资源许可见 LICENSE、NOTICE.md 和 web/licenses。',
      '',
    ].join('\r\n'), 'utf8');
    const temporaryZip = path.join(stage, 'portable.zip');
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    await run(shell, ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:RHINE_PORTABLE_FOLDER, $env:RHINE_PORTABLE_ZIP, [IO.Compression.CompressionLevel]::Optimal, $true)",
    ], { windowsHide: true, env: { ...process.env, RHINE_PORTABLE_FOLDER: folder, RHINE_PORTABLE_ZIP: temporaryZip } });
    const bytes = await readFile(temporaryZip);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const release = path.join(root, 'release');
    await mkdir(release, { recursive: true });
    const name = `Rhine-Music-${version}-windows-x64-portable.zip`;
    const archive = path.join(release, name);
    await rename(temporaryZip, archive);
    await writeFile(path.join(release, 'SHA256SUMS-portable.txt'), `${sha256}  ${name}\n`);
    return { archive, sha256, bytes: bytes.length };
  } finally {
    // Only remove the newly created staging directory after checking its real path.
    const resolved = await realpath(stage);
    if (!resolved.startsWith(canonicalParent + path.sep) || !path.basename(resolved).startsWith('build-')) {
      throw new Error('拒绝清理预期范围以外的目录');
    }
    await rm(resolved, { recursive: true, force: true });
  }
}
