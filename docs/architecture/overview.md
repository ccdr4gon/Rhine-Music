# 当前客户端结构

v0.3.0 的 Windows 正式入口是 `src-tauri/src/main.rs`，目前只交付 Portable Edition。Tauri 创建独立窗口、提供系统文件夹选择、管理单实例和偏好保存。窗口关闭时 Rust 内部服务结束；没有 Node 后台子程序。客户端从 exe 旁的 `web/` 读取界面，默认将数据写入旁边的 `data/`，可由绝对路径 `MUSIC_DATA_DIR` 覆盖。WebView 的数据目录也明确设在其中的 `webview/`，不依赖启动工作目录。

`src-tauri/src/local_music/connector/server.rs` 在同一进程中绑定 `127.0.0.1`，提供现有 `/api/` 路由和安装目录下的 `web/` 资源。音频以文件流和单段 Range 返回，不通过 JSON 搬运整首歌曲。目录读取检查实际文件位置，并保留 Host、Origin 和 JSON 写入约束。

`src-tauri/src/local_music/data/` 下，`library.rs` 管理配置（第一个目录是主文件夹）、扫描、索引、封面、流派和主文件夹的歌单（由已索引歌曲的路径得出）。`metadata.rs` 使用 Lofty、ID3 及有限的 DSF/DFF/ADPCM 文件头读取，保持只读，不承担音频解码。`online.rs` 负责百科与 MusicBrainz 的限流、匹配、归属、缓存和失败状态。异步扫描及查询在写回前重新核对当前专辑，避免旧任务覆盖新状态。

`src/music-types.ts` 是共享前端的数据合同；`scripts/check-desktop-contract.mjs` 对照实际 Rust 程序与旧 Node 服务，核对公开字段、ID、扫描和持久化。索引仍使用 version 1，文件路径生成的 ID 沿用旧规则；解析器自己的 `_metadataVersion` 用于使旧解析缓存失效。

前端保留现有 TypeScript、Three.js、CSS 和模型资源。`src/desktop.ts` 只负责偏好写入和客户端标记，系统文件夹选择在 `src/local_music/connector/folders.ts`；三维场景、搜索路线、字轮和播放器实现沿用原逻辑。音乐仍由 WebView2 的 HTMLAudioElement 播放，Rust 曲库迁移不代表新增 DSD 解码。

`src-tauri/src/media.rs` 及其 Windows 实现连接系统媒体会话，独立于本地曲库 HTTP 路由；`main.rs` 通过两个受窗口权限限制的 Tauri 命令提供状态和控制。`src/external_player/external-media.ts` 管理用户选择、能力及断线，`music-app.ts` 的 `?mode=external` 分支复用原场景，仅映射所选来源的当前曲目，且不创建本地 MusicPlayer。原播放器负责发声；媒体封面与状态仅保存在内存。具体能力与边界见 [播放器连接说明](../PLAYER-SKIN.md)。

`npm run desktop:prepare` 构建界面并收集依赖许可。`build-desktop.mjs` 强制 `--no-bundle`，`package-portable.mjs` 从干净临时目录、按允许清单生成 ZIP；只带主程序、`dist/` 映射的 `web/`、原生启动脚本和许可，不复制现有用户数据。不再生成 NSIS/MSI，也不自动安装 WebView2。Node、Vite、TypeScript 和 Rust 工具链仅用于开发。旧 `scripts/music-*.mjs` 保留为 macOS 浏览器入口与行为对照，不进入便携包。

已运行的验证和未覆盖范围见 [Windows 记录](../WINDOWS.md)，决策范围见 [迁移决策](../refactor/desktop-decision.md)。

## 按音乐来源分目录（2026-10-06）

用户要求每个音乐来源各有一个文件夹，内分 `data/` 与 `connector/`。`data/` 是读到的内容及其如何变成专辑架上的记录，`connector/` 是如何连到这个来源（本机服务、系统媒体会话、调试端口、原生命令）。前端与 Rust 两侧的文件夹同名。这次只移动和拆分代码，行为不变；本地曲库的模型随后改为主文件夹与子文件夹歌单（见本节末尾）。QQ 音乐随后接入，只用它的系统媒体会话（见下文）。

```
src/
  music-app.ts             组合根：场景、界面与各来源在这里接起来；皮肤模式的界面绘制（详情、提示、面板开关）仍在这里
  music-sources.ts         已知的播放器（网易云音乐、QQ 音乐）与默认连接；连接记住的来源（playerLinks：偏好 playerLink）；
                           应用读取的媒体端口（playerMediaPort）按各播放器的模块显示来源
  external_player/         外部播放器共用：系统媒体会话的连接、选择与记住的来源（external-media.ts：SourceLink、readSourceLink），
                           歌曲的显示字段（player-track.ts）
  local_music/
    data/                  主文件夹的歌单在专辑架上的列与盒子（playlists.ts：每个歌单一列、每首歌一个盒子）、演示歌单（demo-library.ts）
    connector/             本机音乐服务的 /api 客户端（library-api.ts）、系统文件夹选择（folders.ts）、播放器（music-player.ts）
  netease_music/
    data/                  播放队列与歌单，以及它们在专辑架上的列与记录（queue.ts）
    connector/             原生命令（ports.ts）、进度时钟（playback-clock.ts）、识别与名称（player.ts）、面板开关与说明（settings.ts）、
                           会话（session.ts：读取队列、歌单与调试端口，点播放时播放选中的歌，跟随与跳转）
  qq_music/
    data/                  当前曲目（now-playing.ts）：它的会话报告的内容，以“QQ音乐”命名，只在内存中，不读取任何文件
    connector/             识别与名称（player.ts），不调用任何原生命令
src-tauri/src/
  main.rs                  窗口、启动参数（不带参数时按偏好决定打开哪个模式：opens_skin）、便携路径和 Tauri 命令的包装
  media.rs、media/windows_media.rs
                           共用：系统媒体会话（GSMTC）的读取与控制，按应用标识判断来源属于哪个播放器（player_of），
                           并按那个播放器的模块显示它（player_source）
  local_music/data/        library.rs、metadata.rs、online.rs
  local_music/connector/   server.rs（也为皮肤模式提供界面资源）
  netease_music/data/      queue.rs（playingList）、playlists.rs（webdb.dat，只读）
  netease_music/connector/ mod.rs（按应用标识识别）、window.rs（没有媒体会话时的窗口标题与全局媒体键）、debug_port.rs（127.0.0.1:9233）
  qq_music/                mod.rs（标识 qqmusic 与名称 QQ音乐）、data/mod.rs（now_playing：会话的当前曲目，只在内存中）、
                           connector/mod.rs（只按完整的应用标识 QQMusic.exe 识别）
```

依赖规则：

- 场景、界面和三维代码（`src/` 下其余文件）只通过 `music-app.ts` 与 `music-sources.ts` 使用来源模块；`song-list.ts` 只用共用的 `external_player/player-track.ts` 类型。
- `local_music` 只使用核心的数据类型与工具。`netease_music` 与 `qq_music` 使用核心和 `external_player`，彼此不引用，也不引用 `local_music`。`external_player` 只使用核心，不引用任何来源模块。
- 引入写到具体文件，不使用 `index.ts` 或目录引入：检查脚本的 TypeScript 加载器只解析文件。
- 网易云的会话（`netease_music/connector/session.ts`）通过显式的宿主接口 `NeteaseSessionHost` 使用应用：专辑架的记录与选中项、能否跟随、移动选中项、重绘、快速重读和提示。它不接触页面元素；应用不直接读取网易云，只调用会话。
- Rust：`local_music` 不使用 `media`、`netease_music`、`qq_music`；`netease_music` 与 `qq_music` 可以使用 `media` 的类型（网易云的窗口标题回退还用它的 Windows 错误说明 `win_error`）；`media` 只在 `player_of`、`player_source` 和网易云的窗口标题回退处引用来源模块。`#[tauri::command]` 包装留在 `main.rs`（命令只能在定义它的 crate 中注册）。
- 原有公开路径保留：`rhine_music::library`、`metadata`、`online`、`server` 是 `local_music` 下对应模块的别名，供 `main.rs`、测试与元数据对照检查使用。
- 不随目录改变：Tauri 命令名、权限标识（`permissions/music.toml`、`capabilities/desktop.json`）、偏好键 `rhine-music-preferences` 及其各项（2026-10-06 只新增 `playerMode` 与 `playerLink` 两项）、记录编号前缀（`external:`、`netease-track:`、`netease-list:`、`netease-lane:`）、`/api/*` 路由和媒体快照的字段（快照只新增了 QQ 音乐的 `player: "qqmusic"`，以及 2026-10-06 记住来源用的会话应用标识 `app`）。
- 仍在原处：Node 旧入口（`scripts/music-server.mjs`、`music-library.mjs`、`album-introductions.mjs`、`launch-music.mjs`，按作用属于本地音乐）、所有检查脚本、CSS 和权限文件。界面服务与本地音乐路由尚未拆开，`server.rs` 的位置因此只表示它的主要用途。
- 这些规则由 `check:media` 检查（`scripts/check-external-media.mjs` 的模块依赖测试）：前端按每个引入的文件判断它属于哪个模块，并要求引入写到具体文件；Rust 检查各来源文件夹不使用其他来源，并限定共用的 `media` 只用 QQ 音乐来标记和命名它的会话，`media/windows_media.rs` 不提 QQ 音乐。

QQ 音乐只用它发布的系统媒体会话（用户 2026-10-06 的要求）：Rust 的 `qq_music::connector::is_app` 只认完整的应用标识 `QQMusic.exe`，`media::player_of` 把它的会话标为 `player: "qqmusic"`，`media::player_source` 交给 `qq_music::data::now_playing` 以“QQ音乐”命名，其余字段与控制能力保持会话自己的读数；前端 `music-sources.ts` 的 `playerMediaPort` 同样按 `qq_music` 的模块显示它。连接后是只有当前曲目的来源：没有播放队列、歌单分列、选歌场景和全局媒体键，控制只用会话允许的那些。用户选择过它之前不自动连接（选择后它是记住的来源，见下），不替换用户选择的播放器，别的来源消失时也不换成它；不读取它的文件、数据库、端口、COM 接口、窗口标题或进程内存。范围与核对见 [播放器连接说明](../PLAYER-SKIN.md)。

本地音乐是一个主文件夹（用户 2026-10-06：“Local music means choosing a main folder, and each playlist will be a subfolder.”）：Rust 的 `local_music::data::library` 只扫描、显示、提供第一个保存的目录（`Store::main_folder`、`in_library`），按专辑记录建索引（封面、介绍、在线资料仍属于专辑记录），快照的 `playlists` 把歌曲按主文件夹的直接子文件夹分成歌单（`playlists`，路径逐级自然排序 `path_cmp`），并给出歌曲自己的 `album`／`year` 与 QQ 音乐加密下载的数量 `encrypted`；Node 旧服务 `scripts/music-library.mjs` 按同一规则实现（`folderPlaylists`、`naturalCompare`），`check-desktop-contract` 比较两者。前端 `local_music/data/playlists.ts` 把歌单变成专辑架的列、每首歌一个盒子（`playlistShelf`），给出选歌场景的列表（`playlistSongs`）、播放器的队列（`playlistQueue`）和专辑介绍是否适用（`introductionFits`）；`music-app.ts` 只用这些函数，选中、播放、详情和选歌场景的对象都是歌曲。原生命令 `choose_music_folders` 名称与权限不变，改为单选。

记住连上的来源（用户 2026-10-06 的要求）：`external_player/external-media.ts` 的 `ExternalMediaConnection` 记住它连上的来源（`SourceLink`：已知播放器的模块编号，或会话的应用标识与名称），每次变化时通过 `remember` 告诉应用；`music-sources.ts` 的 `playerLinks` 把偏好里保存的 `playerLink`（经 `readSourceLink` 检查）、已知的播放器和网易云这个从没连上过时的默认连接交给它；`music-app.ts` 把记住的来源和页面所在的模式（`playerMode`）随其他偏好保存，经 `save_preferences` 写入 `data/preferences.json`。`main.rs` 的 `opens_skin` 在启动时读取这两项，决定不带参数时打开皮肤模式还是本地音乐（`--skin`／`--local` 优先）；`remembers_source` 与 `readSourceLink` 接受相同的值，`check:media` 对照两边。快照里系统媒体会话的应用标识（`app`）由 `media/windows_media.rs` 填写，网易云的窗口标题回退没有应用标识，按模块记住。
