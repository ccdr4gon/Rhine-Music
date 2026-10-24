//! The local music's routes under `/api/`: the library and its scan, the settings, the genre
//! rules, the online introductions, the foobar2000 / Beefweb bridge, and the audio, covers and
//! lyrics of indexed songs (from their files, which are only read). The page server
//! (`app_server`) checks the Host, the Origin and the path and reads a POST's JSON body before it
//! hands a route here.
use crate::{
    http::{self, json_response, serve_file},
    local_music::data::{
        library::{self, SharedStore, Store},
        lyrics, online,
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
    // The library with its tag (ETag): a page polling it sends back the tag of the one it has and,
    // while that is still the library, gets 304, without the snapshot being built or sent again.
    // The genre rules are read again first, as before (they may be edited by hand meanwhile).
    if route == "/api/library" && get {
        let reply = {
            let mut s = store.lock().unwrap();
            s.reload_rules().map(|()| {
                let tag = s.library_tag();
                let same =
                    http::get_header(&request, "If-None-Match").is_some_and(|sent| sent == tag);
                let library = (!same).then(|| s.snapshot());
                (tag, library)
            })
        };
        return match reply {
            Ok((tag, Some(library))) => http::tagged_json_response(request, library, &tag),
            Ok((tag, None)) => http::not_modified(request, &tag),
            Err(error) => json_response(request, 400, json!({ "error": error })),
        };
    }
    let result: Result<(u16, Value), (u16, String)> = (|| {
        let bad = |error: String| (400, error);
        // A new main folder during a scan (found so after its folder was looked for, too) is 409.
        let refused = |error: String| (if error == library::SCANNING { 409 } else { 400 }, error);
        match route {
            "/api/health" if get => Ok((
                200,
                json!({"service":"rhine-native-music","backend":"rust","pid":std::process::id()}),
            )),
            "/api/library/scan" if post => {
                // A new main folder is refused while a scan runs, as on /api/config.
                if input.get("roots").is_some() && store.lock().unwrap().scan["running"] == true {
                    return Err((409, "正在扫描，请完成后再更改根目录".into()));
                }
                Store::begin_scan(store, input.get("roots")).map_err(refused)?;
                Ok((202, store.lock().unwrap().snapshot()))
            }
            "/api/config" | "/api/library/config" if get => {
                Ok((200, store.lock().unwrap().config_snapshot()))
            }
            "/api/config" | "/api/library/config" if post => {
                // A new main folder is looked for on the disk with the store unlocked; one asked
                // for while a scan runs is refused (409) before that and again once it is locked.
                let checked = match input.get("roots") {
                    Some(roots) => Store::checked_main_folder(store, roots).map_err(refused)?,
                    None => None,
                };
                let mut s = store.lock().unwrap();
                Ok((
                    200,
                    s.update_config_checked(input, checked.as_deref())
                        .map_err(refused)?,
                ))
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
    // A song's lyrics (its .lrc beside it, else its tags; the owner, 2026-10-17) as their bytes,
    // which the page decodes; 204 when it has none.
    if let Some(id) = route.strip_prefix("/api/lyrics/") {
        if get && !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            let song = store.lock().unwrap().file(id, false);
            let Some(song) = song else {
                return json_response(request, 404, json!({"error":"索引中没有此文件"}));
            };
            let response = match lyrics::read(&song) {
                Ok(Some(bytes)) => Response::from_data(bytes)
                    .with_header(http::header("Content-Type", "application/octet-stream")),
                Ok(None) => Response::from_data(Vec::new()).with_status_code(204),
                Err((status, error)) => {
                    return json_response(request, status, json!({"error":error}))
                }
            };
            let _ = request.respond(
                response
                    .with_header(http::header("Cache-Control", "no-store"))
                    .with_header(http::header("X-Content-Type-Options", "nosniff")),
            );
            return;
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
