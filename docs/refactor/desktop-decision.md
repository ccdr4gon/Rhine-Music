# Tauri + Rust 客户端迁移

2026-09-30，用户确认最终目标为 Tauri + Rust，并授权完成整个重构。

## 交付目标

Windows 独立客户端及安装程序，运行时不需要 Node、npm、开发服务器或外部浏览器。保留现有 TypeScript / Three.js 前端、材质、字轮、镜头、主题、搜索定位及音频交互。开发构建仍使用 Node 和 Vite。

Rust 负责目录配置、只读扫描、标签/封面、增量索引、离线目录保留、流派规则、音频 Range 读取、在线资料查询。以 `src/music-types.ts` 和现有 Node 服务为行为对照；不能将重写曲库服务等同于新增原生音频解码。

## 实施顺序与验收

1. 建立 Tauri 外壳、Rust 服务入口、构建与安装配置。
2. 迁移配置、扫描、元数据、封面、缓存及音频读取，使用临时合成音频进行 HTTP / 数据合同对照。
3. 迁移在线资料、繁简匹配、来源与失败状态，保留严格匹配和限流行为。
4. 接入系统文件夹选择，验证窗口生命周期、原始三维效果、前后台播放与偏好保存。
5. 构建 Windows 安装包，检查运行依赖、资源许可、包内容、体积及启动结果，更新文档。

当前索引格式和旧 Node 服务保留作兼容对照。客户端默认使用用户应用数据目录，`MUSIC_DATA_DIR` 仍可指定其他位置；不自动读取或发布私人音乐目录。macOS 原有入口保留，不能声称已在 macOS 真机验证客户端。

## 构建与交付约定

- 客户端版本统一为 `0.3.0`，Windows 默认目标是 x64 NSIS 当前用户安装。`npm run desktop:build` 生成安装包，`npm start` 开发运行；`npm run start:legacy` 继续启动旧 Node 服务。
- 运行程序不包含 Node 或 npm。Tauri 使用小型 `bootstrap/`，将构建后的 `dist/` 作为 `web/` 资源分发；Rust 内部服务提供界面、API、封面和音乐读取，退出窗口停止服务。原始共享模型、字体、音效及原版入口资源继续保留。
- `desktop:prepare` 在构建和开发启动前编译前端，并按 Cargo 目标收集完整依赖许可证；生成清单不能包含本机目录。无许可证原文的包必须补齐来源，不能默默省略。安装包不附加 Node 运行时、开发依赖或私人音乐数据。
- Windows 默认复用系统 WebView2，缺少时安装器在线获取。不以“小体积”为由宣称完全离线安装，也不以三维前端未重写为由宣称效果或性能已实测一致。
- Windows `.cmd` 只启动已构建 exe，缺失时告知安装版或开发构建步骤；macOS `.command` 沿用原行为。

## 验证记录

- 迁移前 `node --test scripts/check-music-library.mjs scripts/check-album-introductions.mjs`：18 项通过。
- `node --check scripts/desktop-resources.mjs` 与 `node scripts/desktop-resources.mjs` 已运行；Windows x64 收集 309 个正常／构建依赖许可，不包含仅供测试的依赖。每次 Rust 依赖变化需重新生成，不能沿用该数字作为永久通过声明。
- 迁移完成后的验证：Rust 默认 29 项、额外参考对照 2 项、真实 HTTP 合同对照 8 组通过；既有音乐检查在 Node 24.15 与 22.12 通过。Windows 安装包及无 Node 运行、窗口交互、最小化续播、偏好、单实例和测试卸载已实际验证。详细命令与限制见 [Windows 记录](../WINDOWS.md)。
- Windows x64 安装包约 31.88 MiB，安装后程序文件约 47.46 MiB。未创建公开 Release 或提交版本标签；macOS 原有入口保留，不将 Windows 结果外推为 macOS 客户端验收。
