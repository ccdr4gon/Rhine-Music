# Windows 独立客户端

v0.3.0 使用 Tauri + Rust，保留原 TypeScript / Three.js 界面。客户端启动独立窗口，曲库服务运行在同一个 Rust 程序内；无需 Node 运行时、npm 或 Vite 开发服务器，启动不会打开外部浏览器。Windows 11 x64 的构建、安装、启动及核心交互已完成本机验证，尚未公开发布新标签或 Windows 下载链接。原 v0.2.0 macOS ZIP 保留原状。

## 使用

1. 运行 Windows x64 安装程序 `Rhine Music_*_x64-setup.exe`，安装到当前用户目录。
2. 从开始菜单打开 **Rhine Music**，在“音乐库”点击“选择文件夹”，或填写 `D:\Music`，每行一个目录、不加引号。
3. 保存并扫描。中文与空格目录按 Windows 路径规则处理，音乐只读，不复制进安装目录。

连接已有播放器时，点击“连接播放器”，或运行安装目录中的 `启动播放器皮肤.cmd`。`rhine-music.exe --skin` 进入连接模式，`--local` 切回本地模式；已有实例时切换同一窗口。连接能力和网易云限制见 [播放器皮肤说明](PLAYER-SKIN.md)。

普通使用不需要 Node.js、Rust 或 Visual Studio。Windows 需要 Microsoft Edge WebView2 Runtime；当前安装器使用 `downloadBootstrapper`，已安装则复用系统组件，缺少时联网安装。未采用附带完整 WebView2 的离线安装方式。安装包目前没有代码签名。

再次启动会显示并聚焦已有窗口；最小化保留应用，关闭窗口退出并停止内部服务。服务仍只监听 `127.0.0.1`，保留 Origin / Host 校验和只读音乐目录限制，使用可用本机端口；没有对局域网开放。外部资料链接通过默认浏览器打开，播放器本身保持独立窗口。

默认数据目录为 `%LOCALAPPDATA%\io.github.ccdr4gon.rhine-music\`；界面偏好保存到其中的 `preferences.json`，不依赖内部端口保持不变。需要其他位置时，先退出应用，在 PowerShell 设置 `$env:MUSIC_DATA_DIR = 'D:\RhineMusicData'` 再运行安装目录中的 `rhine-music.exe`。它不会自动寻找旧曲库；迁移前备份旧数据、停止旧 Node 服务，禁止同时写同一目录。跨系统迁移需重新选择 Windows 音乐目录。

源码根目录的 `启动音乐播放器.cmd` 只寻找现成 `rhine-music.exe`：优先根目录，其次 `src-tauri/target/release/`，最后 `src-tauri/target/debug/`。它不替用户安装开发环境；找不到时明确提示使用安装程序或先构建。复制 release 程序时必须同时保留它旁边的 `web/` 资源，不能只拿走 exe。

## 从源码构建

开发环境需要 Node.js 22.12 或更新的 LTS、Rust MSVC 工具链、Visual Studio C++ 构建工具和 Windows SDK，以及 WebView2。在工程根目录运行：

```powershell
npm.cmd ci
npm.cmd run desktop:build
```

安装程序输出到 `src-tauri/target/release/bundle/nsis/`，普通 release 程序在 `src-tauri/target/release/rhine-music.exe`。第一次构建需联网获取锁定 Rust 依赖和 Tauri 安装器工具。`npm.cmd start` 或 `npm.cmd run desktop:dev` 用于开发窗口，`npm.cmd run check:desktop` 运行 Rust 测试。客户端目前使用已构建前端，修改界面后需重新运行开发命令或准备资源，没有单独启动 Vite 实时更新服务器。

`npm.cmd run desktop:prepare` 会构建前端、根据 Cargo 目标收集许可证，并删除生成目录里的 `.music-build.json`、`pwa-build.json`；它不删除个人数据或源码。Tauri 的开发和正式构建都会自动执行此准备步骤。Rust 依赖版本来自 `src-tauri/Cargo.lock`；未随源码包附带的许可证从锁定提交补存在 `scripts/desktop-licenses/`，未知缺失许可会阻止资源准备。

正式构建通过 `scripts/build-desktop.mjs` 将 Rust 产物中的用户目录、Cargo 缓存目录和工程目录改为通用构建路径，避免错误消息携带构建者的本机用户名。开发调试入口仍保留可定位源码的原路径。

`npm.cmd run start:legacy` 保留旧 Node 服务和浏览器调试路径；macOS `启动音乐播放器.command` 继续使用旧服务。`npm.cmd run build` 只构建共享前端，不会生成客户端。开发依赖和旧 Node 服务源码都不进入桌面安装包。

## 实现范围

- `src-tauri/src/main.rs`：窗口、文件夹选择、单实例、偏好保存和内部服务生命周期。
- `src-tauri/src/`：Rust 曲库扫描、元数据／封面、增量缓存、流派规则、音频分段读取和在线资料查询。
- `src/desktop.ts`：共享界面与桌面功能之间的小型调用入口，三维模型、材质、字轮、镜头与搜索沿用原实现。
- `src-tauri/tauri.conf.json`：仅将 `dist/` 映射为安装目录中的 `web/`；无 Node 程序或后台子程序配置。启动页使用独立 `bootstrap/`，避免同时嵌入和复制整份界面资源。
- `scripts/desktop-resources.mjs`：将项目、前端和 Rust 依赖许可整理到 `web/licenses/`，清单只写公开源码链接，不写本机路径。

Rust 重写曲库服务不等同于原生音频引擎。实际音频仍由 WebView2 的 `HTMLAudioElement` 解码，DSF / DFF 只索引不播放；其他编码需要实际播放器验证。

## v0.3.0 当前验证记录

### 播放器皮肤追加验证

开始新增连接功能前，已重跑现有音乐检查、内容检查 18 项、viewport、TypeScript、Rust 29 项及额外参考 2 项、真实 release HTTP 合同 8 组。发现源码 `.cmd` 仍是旧 Node 入口，修复后 14 项入口检查通过，2 项 macOS 检查按平台跳过，再开始新功能实现。

新增连接后，Rust 全套 37 项通过；前端 `npm run check:media` 的 9 项和既有 `check:music` 的 43 项及 5 个专项检查通过。`cargo fmt --check`、TypeScript 通过。夹具源码是 `src-tauri/examples/media_fixture.rs`，只在开发验证时构建，不进入安装包。

安装版操作曾出现仍在运行的来源需要重选。审查后修复了枚举中途失败会丢掉全部旧标识的确定问题，并将前端临时请求失败与明确来源消失区分：前者禁用控制后重试，只接受原来的精确 ID 恢复；后者仍需用户重选。随后在合成音频循环时再次复现系统会话对象更新，进一步改为使用唯一的 Windows 应用标识保持同一播放器的连接；有多个同应用来源时仍不猜测对应关系。不会按显示名称或歌名绑定。进度条也改为只在实际拖动期间暂停跟随，释放后即恢复更新。

使用同一个程序、相同应用标识的两个独立测试播放器，实际调用 Windows 媒体接口验证：来源区分、重复刷新标识、当前曲目/封面/时长、播放/暂停/上下首/停止/跳转均通过，另一个播放器没有收到控制。退出后的旧来源拒绝控制；同应用多来源的对象被重建时要求重新选择。夹具只使用合成 MP3 与测试图片，静音并在结束时正常退出。

额外使用两个不同应用标识及真正的 5.064 秒音频，连续观察 30 秒、采样 31 次：主来源自然循环 3 次、另一来源 5 次，两者连接 ID 始终稳定，无缺失、警告或控制失败。主来源的切歌、暂停、跳转到 2.532 秒、恢复播放全部成功，另一来源没有收到任何指令。这项验收记录了音频实际回到开头，区别于只运行 30 秒但尚未播完的检查。

最终 Windows 安装版在无 Node 的 PATH、中文/空格安装目录实测：来源选择、实际图片封面、暂停/播放/上下首/停止、拖动进度条到 4 秒、最小化与恢复均通过；界面连接经历至少 32 次自然循环仍保持。横屏和 640×900 窗口的详情均审阅，安装目录的皮肤 `.cmd` 成功切换原有实例，返回本地模式仍显示两专辑/三首合成 MP3。关闭 Rhine 不会向外部测试播放器发送停止指令；卸载测试安装后，音乐和数据保持不变。测试进程及安装登记已清理。

交付安装包为 **33,466,509 字节（31.92 MiB）**，安装文件共 **93 个、47.57 MiB**，包含皮肤启动器，不含 Node/npm；共整理 309 个 Rust 正常/构建依赖许可。最终 release 程序重新执行 HTTP 合同 8 组通过，且检查未包含构建机器的用户目录。SHA256：`1e6ec89d57b2db39b14ed66d6e41f28af7d3655a01d15ac693df240b34d0bfed`。下方“本地曲库迁移验收”的体积记录来自新增皮肤前的构建。

[横屏皮肤截图](media/v0.3.0/native-skin-detail.png) · [640×900 皮肤截图](media/v0.3.0/native-skin-portrait.png)。蓝色图片为专用合成封面，不是加载失败；文档与交付包不包含真实播放器曲目、封面和账户信息。

网易云 `3.1.41.205529` 已做只读检测：窗口标题中的曲名/歌手可读，无标准媒体会话、封面和时间信息，状态显示未知。检测时存在 Chrome 媒体会话，网易云的全局媒体键控制因此禁用；没有发送真实播放指令。不能把受控夹具测试写成网易云全功能或所有播放器验收。

### 本地曲库迁移验收

有效音乐验收使用独立临时目录、应用自带演示封面与合成音频。环境为 Windows 11 x64（10.0.26200）、Node.js 24.15.0、Rust 1.95.0、系统 WebView2。客户端在 PATH 排除 Node、工作目录与工程无关的情况下运行。下面的音频格式检查是标签解析检查；实际播放验收使用自行编码的 MP3，不能据此宣称所有编码或音频设备均已实测。

| 检查 | 当前结果 |
| --- | --- |
| `node --check scripts/desktop-resources.mjs` | 通过 |
| `node scripts/desktop-resources.mjs` | 通过；Windows x64 收集 309 个 Rust 正常／构建依赖的许可证，排除仅供测试的依赖 |
| `npm ci` 与 `npm run desktop:build` | 通过；包含 TypeScript、Vite、Rust release 编译及 Windows 安装器生成 |
| `npm run check:desktop` | 29 项默认 Rust 检查通过；另有 2 项需要参考环境的检查默认跳过，已单独执行通过 |
| `cargo test --test metadata_parity -- --ignored --nocapture`（指定项目 manifest 并设置 `RHINE_FFMPEG`） | 2 项通过：Node 参考服务对照及 10 种真实编码的元数据解析；FFmpeg 仅作临时验证工具，不进入安装包 |
| `node scripts/check-desktop-contract.mjs --binary src-tauri/target/release/rhine-music.exe` | 8 组真实 HTTP 对照通过；包括前端字段类型、目录/ID/缓存、重启、断盘重连、Range 字节、只读源文件及进程退出 |
| `npm run check:music` | 43 项既有曲库/介绍/播放/呈现测试及场景、动效、镜头、受光、模型检查通过；检查入口已在 Node 24.15 和 22.12 实测 |
| `node --test scripts/check-music-launcher.mjs` | 14 项通过，2 项 macOS 专属检查在 Windows 跳过；Windows 入口缺少 exe 时不再回退到浏览器服务 |
| 原生窗口操作 | 系统文件夹选择器返回经核对的测试路径；两专辑/三首 MP3 扫描、三维详情、详情换片、搜索定位且不自动播放、播放与停止通过 |
| 最小化续播 | 通过标准系统最小化命令，连续 10 秒保持最小化，第一首 MP3 结束后自动进入第二首 |
| 偏好与单实例 | 深夜主题和按专辑排列在刷新、关闭与安装版重启后保留；第二次启动退出并聚焦原窗口，服务 PID 不变 |
| 安装、启动与卸载 | 在中文/空格测试路径安装成功；安装后的 exe 从 Windows 工作目录、无 Node 的 PATH 启动并显示原曲库；正常关闭及测试卸载成功，音乐和数据保留 |
| 包内容与体积 | 安装包 31.88 MiB，程序文件 47.46 MiB（92 个文件）；exe 仅主程序与卸载器，无 Node/npm。体积不含共享 WebView2、个人曲库和运行缓存 |
| 格式及发布边界 | `cargo fmt --check`、`git diff --check` 通过；临时音频、工具、未用于文档的截图和测试安装不进源码或安装包，许可位于 `web/licenses/` |
| macOS 客户端、Windows ARM、全部音频编码、睡眠恢复和完整性能 | 未验证 |

验收过程中，早期文件夹选择自动化曾误返回默认“文档”目录；已立即关闭测试进程并清空隔离索引，没有改写源文件或上传数据，也没有留下内嵌封面缓存。后续先校验选择器返回路径，再执行扫描。该次误选不作为有效验收结果。首次最小化实验也因窗口恢复而未计入通过，最终记录来自标准系统命令下连续采样验证。

当前构建仍有 Vite 单个共享产物超过 500 kB 的提示；不影响构建完成，未以减画质或删共享资源的方式消除。窗口截图仅确认这台设备的显示效果，不等同于跨显卡、跨系统的像素一致性或性能承诺。

## v0.2.0 Windows 浏览器适配历史记录

以下仅记录迁移前的 Node 启动器与 Chrome 检查，旧 `.cmd` 已被独立客户端入口替换。这些结果不能证明 v0.3.0 窗口、安装包或 Rust 服务已通过检查。

环境：Windows 11 x64（10.0.26200）、Node.js 24.15.0、npm 11.12.1、Chrome。所有音乐检查使用独立临时目录和合成 WAV，不读取私人曲库。

| 检查 | 结果 |
| --- | --- |
| `npm.cmd ci` | 成功安装锁定依赖，无依赖升级 |
| `npm.cmd run build` | TypeScript、Vite 生产构建、离线资源清单生成通过；存在单个产物超过 500 kB 的体积提示 |
| `node --test scripts/check-music-launcher.mjs scripts/check-music-library.mjs` | 24 项通过，2 项 macOS 专属检查在 Windows 跳过 |
| `node --experimental-strip-types --test scripts/check-music-player.mjs` | 4 项播放控制检查通过 |
| 真实 `.cmd` 启动 | 从其他目录启动，自动构建、打开默认 Chrome；启动器退出后服务仍响应，HTML 与入口资源返回 200 |
| 再次运行 `.cmd` | 复用同一个服务 PID，没有重复构建 |
| 中文与特殊字符路径 | 实际执行 npm 脚本及 `.cmd` 入口，包含中文、空格、`$()`、`&`、`%` 和 `!`；失败退出码保留 |
| 曲库与音频 | 中文目录扫描、真实 WAV 元数据解析、音频分段读取、增删扫描与缓存通过 |
| 浏览器操作 | 从空库填写中文路径，显示测试专辑，打开三维详情，点击播放、暂停、停止，界面状态正确 |

浏览器验证使用 60 秒合成静音 WAV，只确认浏览器接受该音频并进入相应播放状态，不代表真实音乐听感或音频设备输出验收。没有验证所有音频编码、Windows ARM、实际 UNC 网络共享、其他浏览器或 macOS 真机；macOS 代码分支保留不等于本次已在 macOS 重跑。DSF / DFF 仍不支持浏览器播放，其他格式受浏览器解码能力限制。

除明确纳入 `docs/media/` 的文档截图外，验证截图与合成音频属于临时检查材料，不纳入发布源码；没有修改或上传私人曲库、配置或缓存。
