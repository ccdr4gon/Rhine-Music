#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rhine_music::{library::Store, server::Service};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
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
            media_control
        ])
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
            app.manage(DesktopState { directory: data_dir, preferences: Mutex::new(preferences) });
            let entry = if std::env::args().any(|arg| arg == "--skin") {
                format!("{origin}/?mode=external")
            } else {
                origin
            };
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(entry.parse()?))
                .data_directory(webview_data)
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

#[cfg(test)]
mod tests {
    use super::*;

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
