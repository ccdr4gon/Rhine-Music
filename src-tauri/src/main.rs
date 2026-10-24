#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rhine_music::{app_server::Service, library::Store};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct DesktopState {
    directory: PathBuf,
    preferences: Mutex<serde_json::Value>,
    /// The page's server (http://127.0.0.1:port).
    origin: String,
}

/// The most the page may keep as its preferences (their compact JSON), saved or read at a start.
const PREFERENCES_LIMIT: usize = 32 * 1024;
/// The most of preferences.json a start reads: saved pretty-printed (library::write_json),
/// preferences within PREFERENCES_LIMIT take more room in the file. A larger file is not parsed.
const PREFERENCES_FILE_LIMIT: u64 = 1024 * 1024;

fn acceptable_preferences(preferences: &serde_json::Value) -> bool {
    preferences.is_object() && preferences.to_string().len() <= PREFERENCES_LIMIT
}

/// The preferences saved last (`file`), or null: none saved, or a file that cannot be read, holds
/// no object, or more than the page may save. Only an edit from outside makes one that large; read,
/// it would refuse every save after it and undo the user's changes at each start. With null the
/// page keeps its own (opens_player: 本地音乐), and its next save replaces the file.
fn read_preferences(file: &Path) -> serde_json::Value {
    let mut bytes = Vec::new();
    std::fs::File::open(file)
        .and_then(|file| file.take(PREFERENCES_FILE_LIMIT + 1).read_to_end(&mut bytes))
        .ok()
        .filter(|&read| read as u64 <= PREFERENCES_FILE_LIMIT)
        .and_then(|_| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .filter(acceptable_preferences)
        .unwrap_or(serde_json::Value::Null)
}

/// `known_covers`: the cover revision of each source the page holds (media::snapshot_known); those
/// covers are not sent again until they change.
#[tauri::command]
async fn media_snapshot(
    known_covers: Option<std::collections::HashMap<String, u64>>,
) -> Result<rhine_music::media::Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rhine_music::media::snapshot_known(&known_covers.unwrap_or_default())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn media_control(
    source_id: String,
    action: rhine_music::media::Action,
    position: Option<f64>,
    allow_global_media_keys: Option<bool>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        rhine_music::media::control(
            &source_id,
            action,
            position,
            allow_global_media_keys.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Read only after the user switches on the queue while NetEase is the current source. `source`
/// asks for the playlist the queue came from as well: set only while playlist columns are on.
#[tauri::command]
async fn netease_queue(
    stamp: Option<String>,
    source: Option<bool>,
) -> Result<rhine_music::netease_music::data::queue::QueueReply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rhine_music::netease_music::data::queue::read(stamp.as_deref(), source.unwrap_or(false))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The playlists the user created in NetEase, from its local database. Asked for only while
/// playlist columns are switched on with NetEase as the current source (which needs the queue shown).
#[tauri::command]
async fn netease_playlists(
    stamp: Option<String>,
) -> Result<rhine_music::netease_music::data::playlists::PlaylistsReply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rhine_music::netease_music::data::playlists::read(stamp.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// NetEase's local DevTools port; polled while its queue is shown.
#[tauri::command]
async fn netease_debug_state() -> Result<rhine_music::netease_music::connector::debug_port::DebugState, String> {
    tauri::async_runtime::spawn_blocking(rhine_music::netease_music::connector::debug_port::state)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn netease_debug_play(track_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        rhine_music::netease_music::connector::debug_port::play(&track_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// One of the user's NetEase playlists, from one of its songs: NetEase's queue becomes the
/// playlist (the owner, 2026-10-10).
#[tauri::command]
async fn netease_debug_play_playlist(playlist_id: String, track_id: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        rhine_music::netease_music::connector::debug_port::play_playlist(&playlist_id, &track_id, &name)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn netease_debug_seek(track_id: String, position: f64) -> Result<f64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rhine_music::netease_music::connector::debug_port::seek(&track_id, position)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The lyrics NetEase has loaded for the song it plays; with `load`, NetEase is first asked to
/// load them as its playing page does (the owner, 2026-10-17). Read while that song's details show.
#[tauri::command]
async fn netease_debug_lyrics(
    track_id: String,
    load: bool,
) -> Result<rhine_music::netease_music::connector::debug_port::DebugLyrics, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rhine_music::netease_music::connector::debug_port::lyrics(&track_id, load)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Closes NetEase and starts it with the debugging port; only from the user's button.
#[tauri::command]
async fn netease_debug_restart() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(rhine_music::netease_music::connector::debug_port::restart)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn save_preferences(
    preferences: serde_json::Value,
    state: tauri::State<'_, DesktopState>,
) -> Result<(), String> {
    if !acceptable_preferences(&preferences) {
        return Err("无效的播放器偏好设置".into());
    }
    let mut saved = state.preferences.lock().map_err(|e| e.to_string())?;
    rhine_music::library::write_json(&state.directory.join("preferences.json"), &preferences)?;
    *saved = preferences;
    Ok(())
}

/// The system folder picker for the main music folder: one folder (the owner, 2026-10-06: each
/// playlist is a subfolder of it). The command keeps its name and its list reply (none or one).
#[tauri::command]
async fn choose_music_folders(initial_directory: Option<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut picker = rfd::FileDialog::new().set_title("选择音乐主文件夹");
        if let Some(directory) = initial_directory
            .map(PathBuf::from)
            .filter(|p| p.is_absolute() && p.is_dir())
        {
            picker = picker.set_directory(directory);
        }
        picker
            .pick_folder()
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

fn option(name: &str) -> Option<String> {
    let args: Vec<_> = std::env::args().collect();
    args.windows(2).find(|a| a[0] == name).map(|a| a[1].clone())
}

/// Whether a start opens a player rather than 本地音乐 (the owner, 2026-10-06: no modes, only
/// sources; what was chosen last opens at the next start without asking): the source chosen last
/// was a player (`source`, which the page saves on every load, or, until the page has replaced
/// it, the mode an earlier build saved, `playerMode`) and that player is remembered (`playerLink`),
/// so that it is connected again without being chosen. Anything else opens 本地音乐: the first
/// start ever, 本地音乐 chosen last, a player after 断开连接, or a player that cannot be remembered.
/// The page keeps both in its preferences (src/music-app.ts).
fn opens_player(preferences: &serde_json::Value) -> bool {
    let player = match preferences.get("source") {
        Some(source) => source.as_str() == Some("player"),
        None => preferences.get("playerMode").and_then(serde_json::Value::as_str) == Some("external"),
    };
    player && preferences.get("playerLink").is_some_and(remembers_source)
}

/// The page a start opens: the player (`?source=player`, music-sources.ts pageSource) or 本地音乐.
fn entry_url(origin: &str, preferences: &serde_json::Value) -> String {
    if opens_player(preferences) {
        format!("{origin}/?source=player")
    } else {
        origin.to_owned()
    }
}

/// A remembered source as the page saves it (`readSourceLink` in
/// src/external_player/external-media.ts accepts the same): a player Rhine knows, by its module
/// id, or any other by the app id of its media session. `null` (the user disconnected) and
/// anything this version cannot read remember nothing.
fn remembers_source(link: &serde_json::Value) -> bool {
    match link.get("player") {
        Some(serde_json::Value::String(player)) => {
            player == rhine_music::netease_music::PLAYER || player == rhine_music::qq_music::PLAYER
        }
        _ => link
            .get("app")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|app| !app.is_empty() && app.encode_utf16().count() <= 512),
    }
}

// Portable state follows the executable, never the shell's working directory.
fn portable_paths(
    executable: &Path,
    override_data: Option<PathBuf>,
) -> Result<(PathBuf, PathBuf), String> {
    let directory = executable
        .parent()
        .filter(|path| path.is_absolute())
        .ok_or("无法确定便携版程序目录")?;
    let data = override_data.unwrap_or_else(|| directory.join("data"));
    if !data.is_absolute() {
        return Err("MUSIC_DATA_DIR 必须是绝对路径".into());
    }
    Ok((directory.join("web"), data))
}

/// Said when WebView2 cannot be found: Rhine Music never installs it (docs/WINDOWS.md), only names it.
const WEBVIEW2_MISSING: &str = "这台电脑上没有找到 Microsoft Edge WebView2 Runtime，Rhine Music 需要它来显示界面。请从 https://developer.microsoft.com/microsoft-edge/webview2/ 下载并安装 WebView2 Runtime（Evergreen），然后再打开 Rhine Music。";

/// Says why Rhine Music cannot start, then ends it. Every start-up error ends here: Tauri panics on
/// an error returned from its setup hook, and the release build (no console) then ends without a word.
fn startup_failed(message: &dyn std::fmt::Display) -> ! {
    rfd::MessageDialog::new()
        .set_title("Rhine Music 启动失败")
        .set_description(message.to_string())
        .set_level(rfd::MessageLevel::Error)
        .show();
    std::process::exit(1);
}

/// Everything a start does before its window shows (Tauri's setup hook): the data folder, the
/// page's server, the preferences saved last, and the window.
fn start(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Without WebView2 there is no window: Tauri would say so in English at every try below, over
    // a blank window, and the start would end without a word.
    if !matches!(tauri::webview_version(), Ok(version) if !version.is_empty()) {
        return Err(WEBVIEW2_MISSING.into());
    }
    let (resources, data_dir) = portable_paths(
        &std::env::current_exe()?,
        std::env::var_os("MUSIC_DATA_DIR").map(PathBuf::from),
    ).map_err(std::io::Error::other)?;
    let assets_dir = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist")
    } else {
        resources
    };
    if !assets_dir.join("index.html").is_file() {
        return Err(std::io::Error::other("找不到 web 界面资源。请先完整解压 Portable ZIP，保留 exe 旁的 web 文件夹，不要直接从压缩包中运行。").into());
    }
    let store = Store::open(data_dir.clone()).map_err(|error| std::io::Error::other(
        format!("无法打开便携数据目录：{error}。请将整个程序文件夹放在可写位置。")
    ))?;
    let webview_data = data_dir.join("webview");
    std::fs::create_dir_all(&webview_data)?;
    // WebView2 left running on this folder by the last start would keep the new window
    // blank for half a minute: ended first, under this start's claim on the folder, which
    // is released on exit (stale_webview.rs).
    rhine_music::stale_webview::end_leftovers(&webview_data);
    let preferred = std::fs::read_to_string(data_dir.join("desktop-port.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<u16>(&s).ok())
        .unwrap_or(5177);
    let service =
        Service::start(store, assets_dir, preferred).map_err(std::io::Error::other)?;
    let _ = std::fs::write(data_dir.join("desktop-port.json"), service.port.to_string());
    let origin = format!("http://127.0.0.1:{}", service.port);
    app.manage(Mutex::new(Some(service)));
    let preferences = read_preferences(&data_dir.join("preferences.json"));
    app.manage(DesktopState { directory: data_dir, preferences: Mutex::new(preferences), origin });
    open_main(app.handle())
}

/// The script run before the page at every navigation: it marks the client and, at the first page
/// of a WebView2 session, puts `preferences` (those saved last) where the page reads its own.
fn initialization_script(preferences: &serde_json::Value) -> serde_json::Result<String> {
    Ok(format!(
        "Object.defineProperty(window, '__RHINE_DESKTOP__', {{ value: true }}); try {{ const session = '{}'; if (sessionStorage.getItem('rhine-desktop-session') !== session) {{ const saved = JSON.parse({}); if (saved) localStorage.setItem('rhine-music-preferences', JSON.stringify(saved)); sessionStorage.setItem('rhine-desktop-session', session); }} }} catch (error) {{ console.error('无法恢复播放器偏好', error); }}",
        uuid::Uuid::new_v4(), serde_json::to_string(&preferences.to_string())?
    ))
}

/// Opens the window, the one the capability names ("main"), on the page of the source chosen last
/// with the preferences saved last: at the start, and again when WebView2 ended under the window
/// (watch_webview), when the page's settings since the start are the ones saved.
fn open_main(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let state = app.state::<DesktopState>();
    let preferences = state.preferences.lock().map_err(|error| error.to_string())?.clone();
    let (origin, webview_data) = (state.origin.clone(), state.directory.join("webview"));
    let initialization = initialization_script(&preferences)?;
    let entry = entry_url(&origin, &preferences);
    let url: tauri::Url = entry.parse()?;
    // WebView2 still finishing the last start's shutdown on this folder can refuse a new
    // webview for a moment ("请求的资源在使用中", 0x800700AA): measured 2026-10-11 in 4 of
    // 16 starts within 3 s of a close, and in 2 of 16 without ending the leftovers (one
    // after 19 s), where Rhine then stopped. The window is tried again, after ending what
    // is left on the folder, for up to 15 s; a failed try leaves no window behind.
    let deadline = Instant::now() + Duration::from_secs(15);
    let window = loop {
        let allowed_origin = origin.clone();
        let built = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.clone()))
            .data_directory(webview_data.clone())
            .title("Rhine Music")
            // The page draws its own title bar (src/window-frame.ts): no native one. The
            // window keeps its resize borders, its shadow and Windows 11's rounded corners.
            .decorations(false)
            .shadow(true)
            .inner_size(1440.0, 900.0)
            .min_inner_size(640.0, 480.0)
            .center()
            .initialization_script(initialization.clone())
            .on_navigation(move |url| url.origin().ascii_serialization() == allowed_origin)
            .on_new_window(|url, _| {
                if matches!(url.scheme(), "http" | "https") {
                    let _ = webbrowser::open(url.as_str());
                }
                tauri::webview::NewWindowResponse::Deny
            })
            .build();
        match built {
            Ok(window) => break window,
            Err(error) if Instant::now() < deadline => {
                eprintln!("Rhine Music: 窗口未能创建，稍后重试：{error}");
                std::thread::sleep(Duration::from_millis(300));
                rhine_music::stale_webview::end_more(&webview_data);
            }
            Err(error) => {
                return Err(format!("Rhine Music 的窗口（Microsoft Edge WebView2）没有打开：{error}。请稍后再打开 Rhine Music；如果仍然如此，请重新启动电脑。").into())
            }
        }
    };
    watch_webview(&window);
    Ok(())
}

/// The window's recoveries so far (may_recover).
static RECOVERIES: Mutex<Vec<Instant>> = Mutex::new(Vec::new());
/// Windows being made again (reopen_main): the old one closing is then no reason to exit.
static REOPENING: AtomicUsize = AtomicUsize::new(0);

/// Whether WebView2 failing under the window is recovered from once more: at most three times in
/// two minutes (`times`, the recoveries so far, kept here), so that a page or a WebView2 that keeps
/// failing is not opened over and over.
fn may_recover(times: &mut Vec<Instant>, now: Instant) -> bool {
    times.retain(|time| now.duration_since(*time) < Duration::from_secs(120));
    if times.len() >= 3 {
        return false;
    }
    times.push(now);
    true
}

/// Watches the window's WebView2 for one of its processes ending. The page draws the window's only
/// title bar and buttons (src/window-frame.ts), so without it the window could be neither moved nor
/// closed, and starting Rhine Music again only brings it forward. The page's own process ending:
/// the page is loaded again. WebView2's browser process ending (the webview cannot come back): the
/// window is made again. Either at most as may_recover allows; then Rhine Music says so and closes.
/// WebView2 restarts its other processes by itself, and a page that stopped answering may recover.
#[cfg(windows)]
fn watch_webview(window: &tauri::WebviewWindow) {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        },
        ProcessFailedEventHandler,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SHUTTINGDOWN};
    let app = window.app_handle().clone();
    let watched = window.with_webview(move |webview| {
        let handler = ProcessFailedEventHandler::create(Box::new(move |core, args| {
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            if let Some(args) = args {
                unsafe { args.ProcessFailedKind(&mut kind)? };
            }
            let page = kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED;
            if !page && kind != COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                return Ok(());
            }
            // Windows ending the session ends WebView2 as well: nothing to open again then.
            if unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) } != 0 {
                return Ok(());
            }
            eprintln!("Rhine Music: WebView2 的{}进程意外退出", if page { "页面" } else { "浏览器" });
            let recover = RECOVERIES.lock().is_ok_and(|mut times| may_recover(&mut times, Instant::now()));
            if !recover {
                stopped(app.clone(), "Rhine Music 的界面（Microsoft Edge WebView2）接连意外停止，已经重新打开了三次。Rhine Music 将关闭；请再打开它，如果仍然如此，请重新启动电脑。".into());
            } else if page {
                if let Some(core) = core {
                    unsafe { core.Reload()? };
                }
            } else {
                reopen_main(app.clone());
            }
            Ok(())
        }));
        let mut token = 0;
        let added = unsafe {
            webview.controller().CoreWebView2().and_then(|core| core.add_ProcessFailed(&handler, &mut token))
        };
        if let Err(error) = added {
            eprintln!("Rhine Music: 无法监视 WebView2 的进程：{error}");
        }
    });
    if let Err(error) = watched {
        eprintln!("Rhine Music: 无法监视 WebView2 的进程：{error}");
    }
}
#[cfg(not(windows))]
fn watch_webview(_window: &tauri::WebviewWindow) {}

/// Makes the window again after WebView2's browser process ended under it: the old window is closed
/// and a new one opened on the page of the source shown (open_main). Off the main thread, as Tauri
/// requires for making a window while the app runs, and one at a time.
fn reopen_main(app: tauri::AppHandle) {
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
    REOPENING.fetch_add(1, Ordering::SeqCst);
    let reopening = app.clone();
    let spawned = std::thread::Builder::new().name("reopen-window".into()).spawn(move || {
        let app = reopening;
        let reopened = {
            let _turn = ONE_AT_A_TIME.lock();
            (|| -> Result<(), Box<dyn std::error::Error>> {
                if let Some(window) = app.get_webview_window("main") {
                    window.destroy()?;
                }
                let deadline = Instant::now() + Duration::from_secs(10);
                while app.get_webview_window("main").is_some() {
                    if Instant::now() > deadline {
                        return Err("原来的窗口没有关闭".into());
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                // What is left of the ended WebView2 on the folder (this start holds its claim).
                rhine_music::stale_webview::end_more(&app.state::<DesktopState>().directory.join("webview"));
                open_main(&app)
            })()
        };
        REOPENING.fetch_sub(1, Ordering::SeqCst);
        if let Err(error) = reopened {
            stopped(app, format!("Rhine Music 的界面（Microsoft Edge WebView2）意外停止，重新打开窗口没有成功：{error}\n\nRhine Music 将关闭，请再打开它。"));
        }
    });
    if spawned.is_err() {
        REOPENING.fetch_sub(1, Ordering::SeqCst);
        app.exit(1);
    }
}

/// Says why Rhine Music stops, then closes it as the window's own close button would (RunEvent::Exit
/// stops the page's server and gives the WebView2 folder back). Once, and off the main thread: the
/// WebView2 event that found it returns first.
fn stopped(app: tauri::AppHandle, message: String) {
    static STOPPING: AtomicBool = AtomicBool::new(false);
    if STOPPING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        rfd::MessageDialog::new()
            .set_title("Rhine Music 已停止")
            .set_description(message)
            .set_level(rfd::MessageLevel::Error)
            .show();
        app.exit(1);
    });
}

fn main() {
    // The same Rust backend can be exercised without a WebView or private library.
    if std::env::args().any(|a| a == "--headless") {
        let result = (|| -> Result<(), String> {
            let data = option("--data-dir").ok_or("--data-dir is required")?;
            let assets = option("--assets").ok_or("--assets is required")?;
            let port = option("--port")
                .unwrap_or_else(|| "0".into())
                .parse()
                .map_err(|_| "Invalid port")?;
            let service = Service::start(
                Store::open(PathBuf::from(data))?,
                PathBuf::from(assets),
                port,
            )?;
            println!(
                "{}",
                serde_json::json!({"port":service.port,"pid":std::process::id(),"backend":"rust"})
            );
            loop {
                std::thread::park();
            }
        })();
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    let application = tauri::Builder::default()
        // A second start brings the window that is open to the front, as it is: the source shown
        // there stays (it is changed in the window itself).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            choose_music_folders,
            save_preferences,
            media_snapshot,
            media_control,
            netease_queue,
            netease_playlists,
            netease_debug_state,
            netease_debug_play,
            netease_debug_play_playlist,
            netease_debug_seek,
            netease_debug_lyrics,
            netease_debug_restart
        ])
        .on_window_event(|window, event| {
            // WebView2 keeps a minimized window's page visible and drawing. Hide
            // the WebView while minimized, like a background browser tab: the
            // scene stops drawing and releases its buffers; playback continues.
            static MINIMIZED: AtomicBool = AtomicBool::new(false);
            if let tauri::WindowEvent::Resized(_) = event {
                let minimized = window.is_minimized().unwrap_or(false);
                if MINIMIZED.swap(minimized, Ordering::Relaxed) == minimized {
                    return;
                }
                if let Some(main) = window.app_handle().get_webview_window(window.label()) {
                    let webview: &tauri::Webview = main.as_ref();
                    let _ = if minimized {
                        webview.hide()
                    } else {
                        webview.show()
                    };
                }
            }
        })
        .setup(|app| {
            // An error here would make Tauri panic, which the release build ends without a word.
            if let Err(error) = start(app) {
                startup_failed(&error);
            }
            Ok(())
        })
        .build(tauri::generate_context!());
    match application {
        Ok(app) => app.run(|app, event| match event {
            // The window closed to be made again (reopen_main) leaves none open for a moment.
            tauri::RunEvent::ExitRequested { code: None, api, .. }
                if REOPENING.load(Ordering::SeqCst) > 0 =>
            {
                api.prevent_exit()
            }
            tauri::RunEvent::Exit => {
                if let Some(services) = app.try_state::<Mutex<Option<Service>>>() {
                    if let Some(service) = services.lock().unwrap().take() {
                        service.stop();
                    }
                }
                // A start right after this one need not wait for this process to end.
                rhine_music::stale_webview::release_claim();
            }
            _ => {}
        }),
        Err(error) => startup_failed(&error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn a_plain_start_opens_the_player_chosen_last_only_while_it_is_remembered() {
        let player = |link: Value| json!({ "theme": "night", "source": "player", "playerLink": link });
        for link in [
            json!({ "player": "netease" }),
            json!({ "player": "qqmusic" }),
            json!({ "app": "Fictional.Player_0abc!App", "name": "Fictional Player" }),
            json!({ "app": "fictional.exe" }),
            json!({ "app": "x".repeat(512) }),
        ] {
            assert!(opens_player(&player(link.clone())), "{link}");
        }
        // Nothing remembered: the user disconnected (null), or a link this version cannot read.
        for link in [
            Value::Null,
            json!({}),
            json!({ "player": "spotify" }),
            json!({ "player": "NETEASE" }),
            json!({ "player": "spotify", "app": "spotify.exe" }),
            json!({ "player": 7 }),
            json!({ "app": "" }),
            json!({ "app": 7 }),
            json!({ "app": "x".repeat(513) }),
            json!("netease"),
            json!(["netease"]),
        ] {
            assert!(!opens_player(&player(link.clone())), "{link}");
        }
        // A player chosen last that was never connected (no link at all).
        assert!(!opens_player(&json!({ "source": "player" })));
        // 本地音乐 chosen last, a value this version does not know, or nothing saved: 本地音乐.
        for preferences in [
            json!({ "source": "local", "playerLink": { "player": "netease" } }),
            json!({ "source": "PLAYER", "playerLink": { "player": "netease" } }),
            json!({ "source": true, "playerLink": { "player": "netease" } }),
            json!({ "source": null, "playerLink": { "player": "netease" } }),
            json!({ "playerLink": { "player": "netease" } }),
            json!({ "theme": "day" }),
            Value::Null,
            json!([]),
        ] {
            assert!(!opens_player(&preferences), "{preferences}");
        }
    }

    #[test]
    fn the_first_start_ever_opens_local_music() {
        // No preferences file (or an unreadable one: main reads it as null), or one of an earlier
        // version without a source.
        for preferences in [Value::Null, json!({}), json!({ "theme": "night", "intro": false })] {
            assert!(!opens_player(&preferences), "{preferences}");
            assert_eq!(entry_url("http://127.0.0.1:5177", &preferences), "http://127.0.0.1:5177");
        }
    }

    #[test]
    fn an_earlier_builds_mode_is_read_until_the_page_saves_the_source() {
        // Saved by a build with modes: the player skin with a remembered player opens that player.
        let skin = json!({ "playerMode": "external", "playerLink": { "player": "qqmusic" } });
        assert!(opens_player(&skin));
        assert_eq!(entry_url("http://127.0.0.1:5177", &skin), "http://127.0.0.1:5177/?source=player");
        for preferences in [
            json!({ "playerMode": "local", "playerLink": { "player": "netease" } }),
            json!({ "playerMode": "EXTERNAL", "playerLink": { "player": "netease" } }),
            json!({ "playerMode": true, "playerLink": { "player": "netease" } }),
            json!({ "playerMode": "external", "playerLink": null }),
            json!({ "playerMode": "external" }),
        ] {
            assert!(!opens_player(&preferences), "{preferences}");
        }
        // Once the page has saved the source, it decides, whatever an earlier mode says.
        assert!(!opens_player(&json!({ "source": "local", "playerMode": "external", "playerLink": { "player": "netease" } })));
        assert!(opens_player(&json!({ "source": "player", "playerMode": "local", "playerLink": { "player": "netease" } })));
    }

    #[test]
    fn the_entry_is_the_player_page_or_local_music() {
        let origin = "http://127.0.0.1:5180";
        let player = json!({ "source": "player", "playerLink": { "app": "Fictional.Player_0abc!App", "name": "Fictional Player" } });
        let local = json!({ "source": "local", "playerLink": { "player": "netease" } });
        assert_eq!(entry_url(origin, &player), "http://127.0.0.1:5180/?source=player");
        assert_eq!(entry_url(origin, &local), origin);
    }

    #[test]
    fn portable_resources_and_state_follow_the_executable_when_moved() {
        let root = std::env::temp_dir();
        for folder in ["便携 音乐 A", "另一位置 B"] {
            let directory = root.join(folder);
            let (web, data) = portable_paths(&directory.join("Rhine Music.exe"), None).unwrap();
            assert_eq!(web, directory.join("web"));
            assert_eq!(data, directory.join("data"));
        }
    }

    #[test]
    fn explicit_data_override_does_not_relocate_resources() {
        let root = std::env::temp_dir();
        let (web, data) = portable_paths(
            &root.join("app/Rhine Music.exe"),
            Some(root.join("custom-data")),
        )
        .unwrap();
        assert_eq!(web, root.join("app/web"));
        assert_eq!(data, root.join("custom-data"));
        assert!(portable_paths(
            &root.join("app/Rhine Music.exe"),
            Some(PathBuf::from("relative-data"))
        )
        .is_err());
    }

    #[test]
    fn a_start_reads_no_more_preferences_than_the_page_may_save() {
        let origin = "http://127.0.0.1:5177";
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("preferences.json");
        // None saved, or a file that holds no object: null, and 本地音乐 opens.
        assert_eq!(read_preferences(&file), Value::Null);
        for text in ["", "{", "[]", "\"player\"", "null", "7"] {
            std::fs::write(&file, text).unwrap();
            assert_eq!(read_preferences(&file), Value::Null, "{text}");
        }
        // Saved as the page saves them (write_json, pretty-printed), up to save_preferences' limit.
        let mut preferences = json!({ "source": "player", "playerLink": { "player": "netease" }, "pad": "" });
        let room = PREFERENCES_LIMIT - preferences.to_string().len();
        preferences["pad"] = json!("x".repeat(room));
        assert!(acceptable_preferences(&preferences));
        rhine_music::library::write_json(&file, &preferences).unwrap();
        assert_eq!(read_preferences(&file), preferences);
        assert_eq!(entry_url(origin, &read_preferences(&file)), format!("{origin}/?source=player"));
        // One character more: save_preferences refuses it, and a start does not read it either (it
        // would undo the user's changes at every start), whatever source it names.
        preferences["pad"] = json!("x".repeat(room + 1));
        assert!(!acceptable_preferences(&preferences));
        rhine_music::library::write_json(&file, &preferences).unwrap();
        assert_eq!(read_preferences(&file), Value::Null);
        assert_eq!(entry_url(origin, &read_preferences(&file)), origin);
        // Within the limit, pretty-printing takes more room in the file: still read.
        let nested: serde_json::Map<String, Value> =
            (0..2000).map(|n| (format!("k{n:04}"), json!([[1]]))).collect();
        let nested = Value::Object(nested);
        assert!(acceptable_preferences(&nested));
        rhine_music::library::write_json(&file, &nested).unwrap();
        assert!(std::fs::metadata(&file).unwrap().len() > PREFERENCES_LIMIT as u64);
        assert_eq!(read_preferences(&file), nested);
        // A file over a megabyte is not even parsed.
        std::fs::write(&file, format!("{{\"theme\":\"night\",\"pad\":\"{}\"}}", "a".repeat(2 << 20))).unwrap();
        assert_eq!(read_preferences(&file), Value::Null);
    }

    #[test]
    fn the_page_gets_the_preferences_saved_last_once_a_session() {
        let preferences = json!({ "theme": "night", "note": "引号 \" 与 \\ 反斜杠 </script>" });
        let script = initialization_script(&preferences).unwrap();
        // A JS string literal of the preferences' JSON (JSON.parse reads it back).
        let literal = serde_json::to_string(&preferences.to_string()).unwrap();
        assert!(script.contains(&format!("JSON.parse({literal})")), "{script}");
        // Nothing saved: null, which the script leaves alone.
        assert!(initialization_script(&Value::Null).unwrap().contains("JSON.parse(\"null\")"));
        // A new session each time: a window made again seeds the page as a start does.
        assert_ne!(script, initialization_script(&preferences).unwrap());
    }

    #[test]
    fn a_failing_webview_is_recovered_at_most_three_times_in_two_minutes() {
        let first = Instant::now();
        let at = |seconds| first + Duration::from_secs(seconds);
        let mut times = Vec::new();
        for seconds in [0, 10, 20] {
            assert!(may_recover(&mut times, at(seconds)), "{seconds}");
        }
        assert!(!may_recover(&mut times, at(30)));
        assert!(!may_recover(&mut times, at(119)));
        // Two minutes after the first recovery, one more.
        assert!(may_recover(&mut times, at(120)));
        assert!(!may_recover(&mut times, at(121)));
        assert_eq!(times.len(), 3);
    }
}
