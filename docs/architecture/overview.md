# 当前客户端结构

v0.3.0 的 Windows 正式入口是 `src-tauri/src/main.rs`。Tauri 创建独立窗口、提供系统文件夹选择、管理单实例和偏好保存。窗口关闭时 Rust 内部服务结束；没有 Node 后台子程序。客户端默认将数据写入用户应用数据目录，可由 `MUSIC_DATA_DIR` 覆盖。

`src-tauri/src/server.rs` 在同一进程中绑定 `127.0.0.1`，提供现有 `/api/` 路由和安装目录下的 `web/` 资源。音频以文件流和单段 Range 返回，不通过 JSON 搬运整首歌曲。目录读取检查实际文件位置，并保留 Host、Origin 和 JSON 写入约束。

`library.rs` 管理配置、扫描、索引、封面和流派。`metadata.rs` 使用 Lofty、ID3 及有限的 DSF/DFF/ADPCM 文件头读取，保持只读，不承担音频解码。`online.rs` 负责百科与 MusicBrainz 的限流、匹配、归属、缓存和失败状态。异步扫描及查询在写回前重新核对当前专辑，避免旧任务覆盖新状态。

`src/music-types.ts` 是共享前端的数据合同；`scripts/check-desktop-contract.mjs` 对照实际 Rust 程序与旧 Node 服务，核对公开字段、ID、扫描和持久化。索引仍使用 version 1，文件路径生成的 ID 沿用旧规则；解析器自己的 `_metadataVersion` 用于使旧解析缓存失效。

前端保留现有 TypeScript、Three.js、CSS 和模型资源。`src/desktop.ts` 仅连接系统文件夹选择与偏好写入；三维场景、搜索路线、字轮和播放器实现沿用原逻辑。音乐仍由 WebView2 的 HTMLAudioElement 播放，Rust 曲库迁移不代表新增 DSD 解码。

`src-tauri/src/media.rs` 及其 Windows 实现连接系统媒体会话，独立于本地曲库 HTTP 路由；`main.rs` 通过两个受窗口权限限制的 Tauri 命令提供状态和控制。`src/external-media.ts` 管理用户选择、能力及断线，`music-app.ts` 的 `?mode=external` 分支复用原场景，仅映射所选来源的当前曲目，且不创建本地 MusicPlayer。原播放器负责发声；媒体封面与状态仅保存在内存。具体能力与边界见 [播放器连接说明](../PLAYER-SKIN.md)。

`npm run desktop:prepare` 构建界面并收集依赖许可，Tauri 将 `dist/` 作为 `web/` 资源打包。Node、Vite、TypeScript 和 Rust 工具链仅用于开发。旧 `scripts/music-*.mjs` 保留为 macOS 浏览器入口与行为对照，不进入桌面安装包。

已运行的验证和未覆盖范围见 [Windows 记录](../WINDOWS.md)，决策范围见 [迁移决策](../refactor/desktop-decision.md)。
