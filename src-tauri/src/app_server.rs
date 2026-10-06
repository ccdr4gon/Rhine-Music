//! The page's server on 127.0.0.1, for every source (本地音乐 and the players alike; the owner,
//! 2026-10-06: no modes, only sources). It serves the page and its assets from `web/` (in debug
//! builds `dist/`), accepts only localhost Hosts and same-origin requests, and hands every `/api/`
//! route to the local music (`local_music::connector::api`), the only source that is reached
//! over HTTP. The players are reached through Tauri commands instead (main.rs).
use crate::{
    http::{self, AllowedFile},
    local_music::{
        connector::api,
        data::library::{SharedStore, Store},
    },
};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tiny_http::{Request, Server};

pub struct Service {
    pub port: u16,
    pub store: SharedStore,
    stop: Arc<AtomicBool>,
    server: Arc<Server>,
}
impl Service {
    pub fn start(store: Store, assets: PathBuf, preferred: u16) -> Result<Self, String> {
        let mut ports = vec![preferred];
        if preferred != 0 {
            ports.extend((1..10).filter_map(|n| preferred.checked_add(n)));
            ports.push(0);
        }
        let server = ports
            .into_iter()
            .find_map(|p| Server::http(("127.0.0.1", p)).ok())
            .ok_or("无法启动本地音乐服务")?;
        let port = server
            .server_addr()
            .to_ip()
            .ok_or("无法读取服务地址")?
            .port();
        let server = Arc::new(server);
        let store = Arc::new(Mutex::new(store));
        let stop = Arc::new(AtomicBool::new(false));
        // Audio responses stream from File; large tracks never enter a JSON buffer.
        for _ in 0..6 {
            let (server, store, assets, stop) =
                (server.clone(), store.clone(), assets.clone(), stop.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    match server.recv_timeout(Duration::from_millis(250)) {
                        Ok(Some(request)) => handle(request, &store, &assets),
                        Ok(None) => {}
                        Err(_) => break,
                    }
                }
            });
        }
        // The local library is brought up to date at every start, whatever the current source.
        Store::begin_scan(&store, None)?;
        Ok(Self {
            port,
            store,
            stop,
            server,
        })
    }
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        for _ in 0..6 {
            self.server.unblock();
        }
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.stop();
    }
}
fn handle(mut request: Request, store: &SharedStore, assets: &Path) {
    let host = http::get_header(&request, "Host").unwrap_or_default();
    let parsed = url::Url::parse(&format!("http://{host}"));
    let Ok(host_url) = parsed else {
        return http::json_response(request, 403, json!({"error":"无效 Host"}));
    };
    if !matches!(
        host_url.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]")
    ) {
        return http::json_response(request, 403, json!({"error":"本服务仅接受 localhost 请求"}));
    }
    if http::get_header(&request, "Origin")
        .is_some_and(|origin| origin != host_url.origin().ascii_serialization())
    {
        return http::json_response(request, 403, json!({"error":"不接受跨站点访问本地曲库"}));
    }
    let Ok(url) = host_url.join(request.url()) else {
        return http::json_response(request, 400, json!({"error":"无效路径"}));
    };
    let Ok(route) = percent_encoding::percent_decode_str(url.path()).decode_utf8() else {
        return http::json_response(request, 400, json!({"error":"无效路径编码"}));
    };
    if route.contains(['\0', '\\']) {
        return http::json_response(request, 400, json!({"error":"无效路径"}));
    }
    let get = matches!(request.method().as_str(), "GET" | "HEAD");
    let post = request.method().as_str() == "POST";
    let input = if post {
        match http::body(&mut request) {
            Ok(value) => value,
            Err((status, error)) => {
                return http::json_response(request, status, json!({"error":error}))
            }
        }
    } else {
        json!({})
    };
    if route.starts_with("/api/") {
        return api::respond(request, &route, url.query(), get, post, &input, store);
    }
    if !get {
        return http::json_response(request, 405, json!({"error":"只接受 GET/HEAD"}));
    }
    let path = assets.join(if route == "/" {
        "index.html"
    } else {
        route.trim_start_matches('/')
    });
    let mime = http::mime(&path).into();
    http::serve_file(
        request,
        AllowedFile {
            path,
            root: assets.into(),
            mime,
        },
        if route.starts_with("/assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        },
    );
}
