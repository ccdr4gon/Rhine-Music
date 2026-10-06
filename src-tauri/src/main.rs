#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rhine_music::{app_server::Service, library::Store};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct DesktopState {
    directory: PathBuf,
    preferences: Mutex<serde_json::Value>,
}

#[tauri::command]
async fn media_snapshot() -> Result<rhine_music::media::Snapshot, String> {
    tauri::async_runtime::spawn_blocking(rhine_music::media::snapshot)
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

/// NetEase's local DevTools port; polled while its queue is shown and playing the selected
/// song with the play button is not turned off.
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

#[tauri::command]
async fn netease_debug_seek(track_id: String, position: f64) -> Result<f64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rhine_music::netease_music::connector::debug_port::seek(&track_id, position)
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
    if !preferences.is_object() || preferences.to_string().len() > 32 * 1024 {
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
            netease_debug_seek,
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
            let preferred = std::fs::read_to_string(data_dir.join("desktop-port.json"))
                .ok()
                .and_then(|s| serde_json::from_str::<u16>(&s).ok())
                .unwrap_or(5177);
            let service =
                Service::start(store, assets_dir, preferred).map_err(std::io::Error::other)?;
            let _ = std::fs::write(data_dir.join("desktop-port.json"), service.port.to_string());
            let origin = format!("http://127.0.0.1:{}", service.port);
            let allowed_origin = origin.clone();
            app.manage(Mutex::new(Some(service)));
            let preferences = std::fs::read(data_dir.join("preferences.json")).ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .filter(serde_json::Value::is_object).unwrap_or(serde_json::Value::Null);
            let initialization = format!(
                "Object.defineProperty(window, '__RHINE_DESKTOP__', {{ value: true }}); try {{ const session = '{}'; if (sessionStorage.getItem('rhine-desktop-session') !== session) {{ const saved = JSON.parse({}); if (saved) localStorage.setItem('rhine-music-preferences', JSON.stringify(saved)); sessionStorage.setItem('rhine-desktop-session', session); }} }} catch (error) {{ console.error('无法恢复播放器偏好', error); }}",
                uuid::Uuid::new_v4(), serde_json::to_string(&preferences.to_string())?
            );
            let entry = entry_url(&origin, &preferences);
            app.manage(DesktopState { directory: data_dir, preferences: Mutex::new(preferences) });
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(entry.parse()?))
                .data_directory(webview_data)
                .title("Rhine Music")
                // The page draws its own title bar (src/window-frame.ts): no native one. The
                // window keeps its resize borders, its shadow and Windows 11's rounded corners.
                .decorations(false)
                .shadow(true)
                .inner_size(1440.0, 900.0)
                .min_inner_size(640.0, 480.0)
                .center()
                .initialization_script(initialization)
                .on_navigation(move |url| url.origin().ascii_serialization() == allowed_origin)
                .on_new_window(|url, _| {
                    if matches!(url.scheme(), "http" | "https") {
                        let _ = webbrowser::open(url.as_str());
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!());
    match application {
        Ok(app) => app.run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(service) = app.state::<Mutex<Option<Service>>>().lock().unwrap().take()
                {
                    service.stop();
                }
            }
        }),
        Err(error) => {
            rfd::MessageDialog::new()
                .set_title("Rhine Music 启动失败")
                .set_description(error.to_string())
                .set_level(rfd::MessageLevel::Error)
                .show();
        }
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
}
