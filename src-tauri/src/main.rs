#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rhine_music::{library::Store, server::Service};
use std::{path::PathBuf, sync::Mutex};
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

#[tauri::command]
async fn choose_music_folders(initial_directory: Option<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut picker = rfd::FileDialog::new().set_title("选择音乐文件夹");
        if let Some(directory) = initial_directory
            .map(PathBuf::from)
            .filter(|p| p.is_absolute() && p.is_dir())
        {
            picker = picker.set_directory(directory);
        }
        picker
            .pick_folders()
            .unwrap_or_default()
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
            media_control
        ])
        .setup(|app| {
            let data_dir = std::env::var_os("MUSIC_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_local_data_dir()?);
            let resources = app.path().resource_dir()?.join("web");
            let assets_dir = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist")
            } else {
                resources
            };
            let store = Store::open(data_dir.clone()).map_err(std::io::Error::other)?;
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
            app.manage(DesktopState { directory: data_dir, preferences: Mutex::new(preferences) });
            let entry = if std::env::args().any(|arg| arg == "--skin") {
                format!("{origin}/?mode=external")
            } else {
                origin
            };
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(entry.parse()?))
                .title("Rhine Music")
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
