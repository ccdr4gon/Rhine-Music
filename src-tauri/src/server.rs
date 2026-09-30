use crate::{
    library::{self, AllowedFile, SharedStore, Store},
    online,
};
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{Cursor, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tiny_http::{Header, Request, Response, Server, StatusCode};

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
fn header(name: &str, value: impl AsRef<str>) -> Header {
    Header::from_bytes(name, value.as_ref()).unwrap()
}
fn get_header(request: &Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.to_string())
}
fn json_response(request: Request, status: u16, value: Value) {
    let response = Response::from_data(serde_json::to_vec(&value).unwrap())
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json; charset=utf-8"))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("X-Content-Type-Options", "nosniff"));
    let _ = request.respond(response);
}
fn body(request: &mut Request) -> Result<Value, (u16, String)> {
    if !get_header(request, "Content-Type")
        .unwrap_or_default()
        .to_lowercase()
        .starts_with("application/json")
    {
        return Err((415, "请使用 application/json 请求体".into()));
    }
    let mut bytes = Vec::new();
    request
        .as_reader()
        .take(128 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| (400, e.to_string()))?;
    if bytes.len() > 128 * 1024 {
        return Err((413, "请求体过大".into()));
    }
    let value: Value = serde_json::from_slice(if bytes.is_empty() { b"{}" } else { &bytes })
        .map_err(|e| (400, e.to_string()))?;
    if !value.is_object() {
        return Err((400, "JSON 请求体必须是对象".into()));
    }
    Ok(value)
}
fn handle(mut request: Request, store: &SharedStore, assets: &Path) {
    let host = get_header(&request, "Host").unwrap_or_default();
    let parsed = url::Url::parse(&format!("http://{host}"));
    let Ok(host_url) = parsed else {
        return json_response(request, 403, json!({"error":"无效 Host"}));
    };
    if !matches!(
        host_url.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]")
    ) {
        return json_response(request, 403, json!({"error":"本服务仅接受 localhost 请求"}));
    }
    if get_header(&request, "Origin")
        .is_some_and(|origin| origin != host_url.origin().ascii_serialization())
    {
        return json_response(request, 403, json!({"error":"不接受跨站点访问本地曲库"}));
    }
    let Ok(url) = host_url.join(request.url()) else {
        return json_response(request, 400, json!({"error":"无效路径"}));
    };
    let Ok(route) = percent_encoding::percent_decode_str(url.path()).decode_utf8() else {
        return json_response(request, 400, json!({"error":"无效路径编码"}));
    };
    if route.contains(['\0', '\\']) {
        return json_response(request, 400, json!({"error":"无效路径"}));
    }
    let get = matches!(request.method().as_str(), "GET" | "HEAD");
    let post = request.method().as_str() == "POST";
    let input = if post {
        match body(&mut request) {
            Ok(value) => value,
            Err((status, error)) => return json_response(request, status, json!({"error":error})),
        }
    } else {
        json!({})
    };
    if let Some(suffix) = route.strip_prefix("/api/foobar/") {
        if (get || post) && !(suffix == "status" && get) {
            return proxy_foobar(request, store, suffix, url.query(), &input);
        }
    }
    let result: Result<(u16, Value), (u16, String)> = (|| {
        let bad = |error: String| (400, error);
        match route.as_ref() {
            "/api/health" if get => Ok((
                200,
                json!({"service":"rhine-native-music","backend":"rust","pid":std::process::id()}),
            )),
            "/api/library" if get => {
                let mut s = store.lock().unwrap();
                s.reload_rules().map_err(bad)?;
                Ok((200, s.snapshot()))
            }
            "/api/library/scan" if post => {
                Store::begin_scan(store, input.get("roots")).map_err(bad)?;
                Ok((202, store.lock().unwrap().snapshot()))
            }
            "/api/config" | "/api/library/config" if get => {
                Ok((200, store.lock().unwrap().config_snapshot()))
            }
            "/api/config" | "/api/library/config" if post => {
                let mut s = store.lock().unwrap();
                if input.get("roots").is_some() && s.scan["running"] == true {
                    return Err((409, "正在扫描，请完成后再更改根目录".into()));
                }
                Ok((200, s.update_config(&input).map_err(bad)?))
            }
            "/api/genre-rules" if get => {
                let mut s = store.lock().unwrap();
                s.reload_rules().map_err(bad)?;
                Ok((200, s.rules.clone()))
            }
            "/api/genre-rules" if post => Ok((
                200,
                store
                    .lock()
                    .unwrap()
                    .update_rules(input.clone())
                    .map_err(bad)?,
            )),
            "/api/library/enrich" if post => {
                online::begin_enrich(store, &input, true).map_err(bad)?;
                Ok((202, store.lock().unwrap().snapshot()))
            }
            "/api/library/introductions" if post => {
                online::begin_introductions(store, &input).map_err(bad)?;
                Ok((202, store.lock().unwrap().snapshot()))
            }
            "/api/foobar/status" if get => {
                let s = store.lock().unwrap();
                Ok((
                    200,
                    json!({"configured":s.config["foobarBaseUrl"].is_string(),"baseUrl":s.config["foobarBaseUrl"],"connected":false,"note":"连接状态需读取 player 的实际响应"}),
                ))
            }
            _ => Err((404, "API 不存在或请求方法不支持".into())),
        }
    })();
    if let Some((artwork, id)) = route
        .strip_prefix("/api/audio/")
        .map(|id| (false, id))
        .or_else(|| route.strip_prefix("/api/artwork/").map(|id| (true, id)))
    {
        if get && !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            let descriptor = store.lock().unwrap().file(id, artwork);
            return match descriptor {
                Some(file) => serve_file(
                    request,
                    file,
                    if artwork {
                        "private, max-age=3600"
                    } else {
                        "private, no-cache"
                    },
                ),
                None => json_response(request, 404, json!({"error":"索引中没有此文件"})),
            };
        }
    }
    if route.starts_with("/api/") {
        return match result {
            Ok((status, data)) => json_response(request, status, data),
            Err((status, error)) => json_response(request, status, json!({"error":error})),
        };
    }
    if !get {
        return json_response(request, 405, json!({"error":"只接受 GET/HEAD"}));
    }
    let path = assets.join(if route == "/" {
        "index.html"
    } else {
        route.trim_start_matches('/')
    });
    let mime = library::mime(&path).into();
    serve_file(
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

fn proxy_foobar(
    request: Request,
    store: &SharedStore,
    suffix: &str,
    query: Option<&str>,
    input: &Value,
) {
    let result = (|| -> Result<_, (u16, String)> {
        let bad = |error: reqwest::Error| (400, error.to_string());
        let base = store.lock().unwrap().config["foobarBaseUrl"]
            .as_str()
            .map(str::to_owned)
            .ok_or((503, "foobar2000 / Beefweb 尚未配置连接".into()))?;
        if !regex::Regex::new(r"^[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*$")
            .unwrap()
            .is_match(suffix)
        {
            return Err((400, "不支持的 Beefweb 请求".into()));
        }
        let mut target =
            url::Url::parse(&format!("{base}/api/{suffix}")).map_err(|e| (400, e.to_string()))?;
        target.set_query(query);
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(bad)?;
        let upstream = if request.method().as_str() == "POST" {
            client.post(target).json(input)
        } else {
            client.get(target)
        }
        .send()
        .map_err(bad)?;
        let status = upstream.status().as_u16();
        let content_type = upstream
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/json")
            .to_owned();
        // Beefweb's playback commands return 204, artwork returns bytes, and
        // errors are not necessarily JSON. Preserve their status and body.
        let bytes = upstream.bytes().map_err(bad)?.to_vec();
        Ok(Response::from_data(bytes)
            .with_status_code(status)
            .with_header(header("Content-Type", content_type))
            .with_header(header("Cache-Control", "no-store"))
            .with_header(header("X-Content-Type-Options", "nosniff")))
    })();
    match result {
        Ok(response) => {
            let _ = request.respond(response);
        }
        Err((status, error)) => json_response(request, status, json!({"error":error})),
    }
}

/// Inclusive, single byte ranges, including suffix requests used by audio decoders.
pub fn parse_range(header: Option<&str>, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(header) = header else {
        return Ok(None);
    };
    if size == 0 {
        return Err(());
    }
    let content = header.strip_prefix("bytes=").ok_or(())?;
    let (a, b) = content.split_once('-').ok_or(())?;
    if !a.bytes().all(|c| c.is_ascii_digit()) || !b.bytes().all(|c| c.is_ascii_digit()) {
        return Err(());
    }
    if a.is_empty() {
        let suffix = b.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        return Ok(Some((size.saturating_sub(suffix), size - 1)));
    }
    let start = a.parse::<u64>().map_err(|_| ())?;
    let end = if b.is_empty() {
        size - 1
    } else {
        b.parse::<u64>().map_err(|_| ())?
    };
    if start >= size || end < start {
        return Err(());
    }
    Ok(Some((start, end.min(size - 1))))
}
fn serve_file(request: Request, file: AllowedFile, cache: &str) {
    let resolved = (|| -> Result<_, (u16, String)> {
        let failure = |e: std::io::Error| {
            (
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) {
                    404
                } else {
                    400
                },
                e.to_string(),
            )
        };
        let root = dunce::canonicalize(&file.root).map_err(failure)?;
        let path = dunce::canonicalize(&file.path).map_err(failure)?;
        if !path.starts_with(&root) {
            return Err((403, "文件已移出允许的目录".into()));
        }
        let metadata = std::fs::metadata(&path).map_err(failure)?;
        if !metadata.is_file() {
            return Err((404, "文件不存在".into()));
        }
        let size = metadata.len();
        let range = parse_range(get_header(&request, "Range").as_deref(), size);
        let mut headers = vec![
            header("Content-Type", &file.mime),
            header("Accept-Ranges", "bytes"),
            header("Cache-Control", cache),
            header("X-Content-Type-Options", "nosniff"),
            header("Referrer-Policy", "same-origin"),
        ];
        if let Ok(modified) = metadata.modified() {
            let date: chrono::DateTime<chrono::Utc> = modified.into();
            headers.push(header(
                "Last-Modified",
                date.format("%a, %d %b %Y %H:%M:%S GMT").to_string(),
            ));
        }
        if range.is_err() {
            headers.push(header("Content-Range", format!("bytes */{size}")));
            return Ok((
                416,
                headers,
                Box::new(Cursor::new(Vec::<u8>::new())) as Box<dyn Read + Send>,
                0,
            ));
        }
        let mut source = File::open(path).map_err(failure)?;
        let (status, length) = if let Some((start, end)) = range.unwrap() {
            source.seek(SeekFrom::Start(start)).map_err(failure)?;
            headers.push(header(
                "Content-Range",
                format!("bytes {start}-{end}/{size}"),
            ));
            (206, end - start + 1)
        } else {
            (200, size)
        };
        Ok((
            status,
            headers,
            Box::new(source.take(length)) as Box<dyn Read + Send>,
            length as usize,
        ))
    })();
    match resolved {
        Ok((status, headers, reader, length)) => {
            let _ = request.respond(
                Response::new(StatusCode(status), headers, reader, Some(length), None)
                    .with_chunked_threshold(usize::MAX),
            );
        }
        Err((status, error)) => json_response(request, status, json!({"error":error})),
    }
}
