#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rhine_music::{library::Store, server::Service};
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

/// Read only after the user switches on the queue in player-skin mode. `source` asks for the
/// playlist the queue came from as well: set only while playlist columns are switched on.
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
/// playlist columns are switched on in player-skin mode (which needs the queue shown).
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

/// Whether a start opens the player skin (`?mode=external`) rather than local music. `--skin`
/// and `--local` (the two launchers) decide, `--skin` first, as when they are forwarded to a
/// running window. A plain start resumes the player skin when the last session was in it and a
/// source is remembered there, so that the source is connected again without being chosen (the
/// owner, 2026-10-06); otherwise it opens local music, as before. The page keeps both in its
/// preferences (`playerMode`, `playerLink`; src/music-app.ts).
fn opens_skin(args: &[String], preferences: &serde_json::Value) -> bool {
    if args.iter().any(|arg| arg == "--skin") {
        return true;
    }
    if args.iter().any(|arg| arg == "--local") {
        return false;
    }
    preferences.get("playerMode").and_then(serde_json::Value::as_str) == Some("external")
        && preferences.get("playerLink").is_some_and(remembers_source)
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
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if let Some(window) = app.get_webview_window("main") {
                if args.iter().any(|arg| arg == "--skin" || arg == "--local") {
                    if let Ok(mut url) = window.url() {
                        url.set_path("/");
                        url.set_query(if args.iter().any(|arg| arg == "--skin") {
                            Some("mode=external")
                        } else {
                            None
                        });
                        let _ = window.navigate(url);
                    }
                }
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
            let skin = opens_skin(&std::env::args().collect::<Vec<_>>(), &preferences);
            app.manage(DesktopState { directory: data_dir, preferences: Mutex::new(preferences) });
            let entry = if skin {
                format!("{origin}/?mode=external")
            } else {
                origin
            };
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

    fn args(list: &[&str]) -> Vec<String> {
        std::iter::once("Rhine Music.exe")
            .chain(list.iter().copied())
            .map(String::from)
            .collect()
    }

    #[test]
    fn a_plain_start_resumes_the_player_skin_only_with_a_remembered_source() {
        let skin = |link: Value| json!({ "theme": "night", "playerMode": "external", "playerLink": link });
        for link in [
            json!({ "player": "netease" }),
            json!({ "player": "qqmusic" }),
            json!({ "app": "Fictional.Player_0abc!App", "name": "Fictional Player" }),
            json!({ "app": "fictional.exe" }),
            json!({ "app": "x".repeat(512) }),
        ] {
            assert!(opens_skin(&args(&[]), &skin(link.clone())), "{link}");
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
            assert!(!opens_skin(&args(&[]), &skin(link.clone())), "{link}");
        }
        // Never connected in the player skin (no link at all).
        assert!(!opens_skin(&args(&[]), &json!({ "playerMode": "external" })));
        // The last session was local music, older preferences have no mode, or there are none.
        for preferences in [
            json!({ "playerMode": "local", "playerLink": { "player": "netease" } }),
            json!({ "playerLink": { "player": "netease" } }),
            json!({ "playerMode": "EXTERNAL", "playerLink": { "player": "netease" } }),
            json!({ "playerMode": true, "playerLink": { "player": "netease" } }),
            Value::Null,
            json!([]),
        ] {
            assert!(!opens_skin(&args(&[]), &preferences), "{preferences}");
        }
    }

    #[test]
    fn the_launchers_arguments_win_over_the_saved_mode() {
        let remembered = json!({ "playerMode": "external", "playerLink": { "player": "qqmusic" } });
        let local = json!({ "playerMode": "local" });
        assert!(opens_skin(&args(&["--skin"]), &local));
        assert!(opens_skin(&args(&["--skin"]), &Value::Null));
        assert!(!opens_skin(&args(&["--local"]), &remembered));
        // Both given: the player skin, as when they are forwarded to a running window.
        assert!(opens_skin(&args(&["--local", "--skin"]), &local));
        // Anything else is not a mode.
        assert!(opens_skin(&args(&["--data-dir", "x"]), &remembered));
        assert!(!opens_skin(&args(&["skin", "--Skin"]), &local));
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
