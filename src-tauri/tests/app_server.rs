//! The page's server (`app_server`) after it was split from the local music's routes (2026-10-06):
//! the page and its assets for every source's address, the same Host / Origin / path / method
//! answers as before, and every `/api/` route still the local music's, with the same bodies.
use rhine_music::{app_server::Service, library::Store};
use serde_json::{json, Value};
use std::{
    fs,
    time::{Duration, Instant},
};

fn served() -> (tempfile::TempDir, Service, String) {
    let temporary = tempfile::tempdir().unwrap();
    let store = Store::open(temporary.path().join("data")).unwrap();
    let assets = temporary.path().join("web");
    fs::create_dir_all(assets.join("assets")).unwrap();
    fs::write(assets.join("index.html"), b"fixture page").unwrap();
    fs::write(assets.join("assets/app-0001.js"), b"export {};").unwrap();
    fs::write(assets.join("manifest.webmanifest"), b"{}").unwrap();
    let service = Service::start(store, assets, 0).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while service.store.lock().unwrap().scan["running"] == true {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let origin = format!("http://127.0.0.1:{}", service.port);
    (temporary, service, origin)
}
fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}
fn json_reply(response: reqwest::blocking::Response) -> (u16, String, String, Value) {
    let status = response.status().as_u16();
    let kind = response.headers()["content-type"].to_str().unwrap().to_owned();
    let cache = response.headers()["cache-control"].to_str().unwrap().to_owned();
    (status, kind, cache, response.json().unwrap())
}

#[test]
fn the_page_is_served_for_every_source_and_its_assets_keep_their_caching() {
    let (_temporary, service, origin) = served();
    let client = client();
    // 本地音乐, a player, and the address an earlier build used for the player skin.
    for address in ["/", "/?source=player", "/?mode=external", "/?source=player&scene=archive"] {
        let response = client.get(format!("{origin}{address}")).send().unwrap();
        assert_eq!(response.status(), 200, "{address}");
        assert_eq!(response.headers()["content-type"], "text/html; charset=utf-8");
        assert_eq!(response.headers()["cache-control"], "no-cache");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(response.bytes().unwrap().as_ref(), b"fixture page");
    }
    let script = client.get(format!("{origin}/assets/app-0001.js")).send().unwrap();
    assert_eq!(script.status(), 200);
    assert_eq!(script.headers()["content-type"], "text/javascript; charset=utf-8");
    assert_eq!(script.headers()["cache-control"], "public, max-age=31536000, immutable");
    let manifest = client.get(format!("{origin}/manifest.webmanifest")).send().unwrap();
    assert_eq!(manifest.headers()["content-type"], "application/manifest+json");
    assert_eq!(client.get(format!("{origin}/missing.html")).send().unwrap().status(), 404);
    // The other localhost names are the same server.
    for host in ["localhost", "[::1]"] {
        let response = client
            .get(format!("{origin}/"))
            .header("Host", format!("{host}:{}", service.port))
            .send()
            .unwrap();
        assert_eq!(response.status(), 200, "{host}");
    }
    service.stop();
}

#[test]
fn host_origin_path_and_method_answers_are_unchanged() {
    let (_temporary, service, origin) = served();
    let client = client();
    let error = |text: &str| json!({ "error": text });
    let reply = json_reply(client.get(format!("{origin}/")).header("Host", "unrelated.example").send().unwrap());
    assert_eq!(reply, (403, "application/json; charset=utf-8".into(), "no-store".into(), error("本服务仅接受 localhost 请求")));
    let reply = json_reply(client.get(format!("{origin}/api/library")).header("Origin", "https://unrelated.example").send().unwrap());
    assert_eq!((reply.0, reply.3), (403, error("不接受跨站点访问本地曲库")));
    // The same origin is welcome.
    let same = client.get(format!("{origin}/api/health")).header("Origin", &origin).send().unwrap();
    assert_eq!(same.status(), 200);
    let health: Value = same.json().unwrap();
    assert_eq!((health["service"].as_str(), health["backend"].as_str()), (Some("rhine-native-music"), Some("rust")));
    // A backslash or a NUL in the decoded path.
    for path in ["/%5Cwindows", "/api/%00library"] {
        let reply = json_reply(client.get(format!("{origin}{path}")).send().unwrap());
        assert_eq!((reply.0, reply.3), (400, error("无效路径")), "{path}");
    }
    // A POST is read as JSON first, wherever it goes: then the page answers GET and HEAD only.
    let reply = json_reply(client.post(format!("{origin}/")).body("{}").send().unwrap());
    assert_eq!((reply.0, reply.3), (415, error("请使用 application/json 请求体")));
    let reply = json_reply(client.post(format!("{origin}/")).json(&json!({})).send().unwrap());
    assert_eq!((reply.0, reply.3), (405, error("只接受 GET/HEAD")));
    let reply = json_reply(client.post(format!("{origin}/api/config")).json(&json!([])).send().unwrap());
    assert_eq!((reply.0, reply.3), (400, error("JSON 请求体必须是对象")));
    let reply = json_reply(
        client
            .post(format!("{origin}/api/config"))
            .header("Content-Type", "application/json")
            .body(vec![b' '; 128 * 1024 + 1])
            .send()
            .unwrap(),
    );
    assert_eq!((reply.0, reply.3), (413, error("请求体过大")));
    // Every /api/ route is the local music's: an unknown one, or a known one by another method.
    for (method, path) in [("GET", "/api/missing"), ("PUT", "/api/library"), ("DELETE", "/api/config"), ("GET", "/api/library/scan")] {
        let request = client.request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), format!("{origin}{path}"));
        let reply = json_reply(request.send().unwrap());
        assert_eq!(reply, (404, "application/json; charset=utf-8".into(), "no-store".into(), error("API 不存在或请求方法不支持")), "{method} {path}");
    }
    let reply = json_reply(client.get(format!("{origin}/api/audio/not-indexed")).send().unwrap());
    assert_eq!((reply.0, reply.3), (404, error("索引中没有此文件")));
    let reply = json_reply(client.get(format!("{origin}/api/foobar/status")).send().unwrap());
    assert_eq!(reply.0, 200);
    assert_eq!(reply.3["configured"], false);
    let reply = json_reply(client.get(format!("{origin}/api/foobar/player")).send().unwrap());
    assert_eq!((reply.0, reply.3), (503, error("foobar2000 / Beefweb 尚未配置连接")));
    // The library and its settings answer as before.
    let library = client.get(format!("{origin}/api/library")).send().unwrap();
    assert_eq!(library.status(), 200);
    assert_eq!(library.json::<Value>().unwrap()["version"], 1);
    let config = client.get(format!("{origin}/api/library/config")).send().unwrap();
    assert_eq!(config.status(), 200);
    service.stop();
}
