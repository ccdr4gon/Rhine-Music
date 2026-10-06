use rhine_music::{app_server::Service, library::Store};
use serde_json::json;
use std::{
    fs,
    time::{Duration, Instant},
};
use tiny_http::{Header, Response, Server};

fn roundtrip(
    method: &str,
    route: &str,
    status: u16,
    content_type: Option<&str>,
    bytes: &[u8],
) -> (u16, String, Vec<u8>) {
    let upstream = Server::http(("127.0.0.1", 0)).unwrap();
    let upstream_origin = format!("http://{}", upstream.server_addr().to_ip().unwrap());
    let expected_method = method.to_owned();
    let expected_route = format!("/api/{route}");
    let payload = bytes.to_vec();
    let content_type = content_type.map(str::to_owned);
    let worker = std::thread::spawn(move || {
        let mut request = upstream
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .expect("upstream request");
        assert_eq!(request.method().as_str(), expected_method);
        assert_eq!(request.url(), expected_route);
        if expected_method == "POST" {
            let value: serde_json::Value = serde_json::from_reader(request.as_reader()).unwrap();
            assert_eq!(value, json!({"fixture":"保持JSON请求体"}));
        }
        let mut response = Response::from_data(payload).with_status_code(status);
        if let Some(content_type) = content_type {
            response =
                response.with_header(Header::from_bytes("Content-Type", content_type).unwrap());
        }
        request.respond(response).unwrap();
    });

    let temporary = tempfile::tempdir().unwrap();
    let mut store = Store::open(temporary.path().join("index")).unwrap();
    store
        .update_config(&json!({"roots":[],"foobarBaseUrl":upstream_origin}))
        .unwrap();
    let assets = temporary.path().join("web");
    fs::create_dir(&assets).unwrap();
    fs::write(assets.join("index.html"), b"fixture").unwrap();
    let service = Service::start(store, assets, 0).unwrap();
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let url = format!("http://127.0.0.1:{}/api/foobar/{route}", service.port);
    let request = if method == "POST" {
        client.post(&url).json(&json!({"fixture":"保持JSON请求体"}))
    } else {
        client.get(&url)
    };
    let response = request.send().unwrap();
    let status = response.status().as_u16();
    let content_type = response.headers()["content-type"]
        .to_str()
        .unwrap()
        .to_owned();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let bytes = response.bytes().unwrap().to_vec();
    worker.join().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while service.store.lock().unwrap().scan["running"] == true {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    service.stop();
    (status, content_type, bytes)
}

#[test]
fn playback_command_preserves_204_empty_success() {
    let (status, content_type, bytes) = roundtrip("POST", "player/play", 204, None, b"");
    assert_eq!(status, 204);
    assert_eq!(content_type, "application/json");
    assert!(bytes.is_empty());
}

#[test]
fn artwork_preserves_binary_bytes_content_type_and_query() {
    let image = [0xff, 0xd8, 0xff, 0xe0, 0, 0x80, 0xfe, 0xff, 0xd9];
    let (status, content_type, bytes) = roundtrip(
        "GET",
        "artwork/1?column=%22album%22&index=2",
        200,
        Some("image/jpeg"),
        &image,
    );
    assert_eq!(status, 200);
    assert_eq!(content_type, "image/jpeg");
    assert_eq!(bytes, image);
}

#[test]
fn upstream_errors_keep_status_and_unmodified_text_or_json_body() {
    for (expected_status, kind, body) in [
        (
            503,
            "text/plain; charset=utf-8",
            "fixture temporarily unavailable\n",
        ),
        (
            422,
            "application/json",
            "{ \"error\": \"fixture invalid\" }\n",
        ),
    ] {
        let (status, content_type, bytes) = roundtrip(
            "GET",
            "player",
            expected_status,
            Some(kind),
            body.as_bytes(),
        );
        assert_eq!(status, expected_status);
        assert_eq!(content_type, kind);
        assert_eq!(bytes, body.as_bytes());
    }
}
