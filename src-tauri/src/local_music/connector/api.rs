//! The local music's routes under `/api/`: the library and its scan, the settings, the genre
//! rules, the online introductions, the foobar2000 / Beefweb bridge, and the audio and covers of
//! indexed songs (streamed from their files, which are only read). The page server
//! (`app_server`) checks the Host, the Origin and the path and reads a POST's JSON body before it
//! hands a route here.
use crate::{
    http::{self, json_response, serve_file},
    local_music::data::{
        library::{SharedStore, Store},
        online,
    },
};
use serde_json::{json, Value};
use std::time::Duration;
use tiny_http::{Request, Response};

/// Answers a route that starts with `/api/` (every one of them: an unknown route or method is a
/// JSON 404). `input` is the POST's body, `{}` otherwise.
pub fn respond(
    request: Request,
    route: &str,
    query: Option<&str>,
    get: bool,
    post: bool,
    input: &Value,
    store: &SharedStore,
) {
    if let Some(suffix) = route.strip_prefix("/api/foobar/") {
        if (get || post) && !(suffix == "status" && get) {
            return proxy_foobar(request, store, suffix, query, input);
        }
    }
    let result: Result<(u16, Value), (u16, String)> = (|| {
        let bad = |error: String| (400, error);
        match route {
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
                Ok((200, s.update_config(input).map_err(bad)?))
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
                online::begin_enrich(store, input, true).map_err(bad)?;
                Ok((202, store.lock().unwrap().snapshot()))
            }
            "/api/library/introductions" if post => {
                online::begin_introductions(store, input).map_err(bad)?;
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
    match result {
        Ok((status, data)) => json_response(request, status, data),
        Err((status, error)) => json_response(request, status, json!({"error":error})),
    }
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
            .with_header(http::header("Content-Type", content_type))
            .with_header(http::header("Cache-Control", "no-store"))
            .with_header(http::header("X-Content-Type-Options", "nosniff")))
    })();
    match result {
        Ok(response) => {
            let _ = request.respond(response);
        }
        Err((status, error)) => json_response(request, status, json!({"error":error})),
    }
}
