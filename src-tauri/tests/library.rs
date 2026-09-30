use id3::TagLike;
use rhine_music::{
    library::{self, Store},
    metadata,
    online::{assess_candidate, normalize_name, Provider},
    server::{parse_range, Service},
};
use serde_json::{json, Value};
use std::{fs, path::Path, sync::Arc, time::Duration};

fn wav(path: &Path) -> Vec<u8> {
    let samples = 48000u32;
    let size = samples * 2;
    let mut data = Vec::new();
    data.extend(b"RIFF");
    data.extend((size + 36).to_le_bytes());
    data.extend(b"WAVEfmt ");
    data.extend(16u32.to_le_bytes());
    data.extend(1u16.to_le_bytes());
    data.extend(1u16.to_le_bytes());
    data.extend(samples.to_le_bytes());
    data.extend((samples * 2).to_le_bytes());
    data.extend(2u16.to_le_bytes());
    data.extend(16u16.to_le_bytes());
    data.extend(b"data");
    data.extend(size.to_le_bytes());
    data.resize((size + 44) as usize, 0);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, &data).unwrap();
    data
}
fn tagged_wav(path: &Path) {
    wav(path);
    let mut tag = id3::Tag::new();
    tag.set_title("测试曲目");
    tag.set_artist("测试歌手");
    tag.set_album("夜航");
    tag.set_album_artist("专辑歌手");
    tag.set_year(2001);
    tag.set_genre("Mandopop");
    tag.set_track(2);
    tag.set_disc(1);
    tag.add_frame(id3::frame::Comment {
        lang: "zho".into(),
        description: String::new(),
        text: "本地备注，不是百科介绍".into(),
    });
    tag.add_frame(id3::frame::Picture {
        mime_type: "image/png".into(),
        picture_type: id3::frame::PictureType::CoverFront,
        description: String::new(),
        data: vec![137, 80, 78, 71, 13, 10, 26, 10],
    });
    tag.write_to_path(path, id3::Version::Id3v24).unwrap();
}
fn store(temp: &tempfile::TempDir, root: &Path) -> Store {
    let mut s = Store::open(temp.path().join("索引")).unwrap();
    s.update_config(&json!({"roots":[root]})).unwrap();
    s
}

#[test]
fn real_tags_embedded_covers_and_file_immutability() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("中文 & 音乐");
    let file = root.join("专辑 A").join("1-02 歌曲.wav");
    tagged_wav(&file);
    let original = fs::read(&file).unwrap();
    let mut s = store(&temp, &root);
    s.scan_sync().unwrap();
    s.save_index().unwrap();
    let snapshot = s.snapshot();
    let album = &snapshot["albums"][0];
    let track = &album["tracks"][0];
    assert_eq!(album["title"], "夜航");
    assert_eq!(album["artist"], "专辑歌手");
    assert_eq!(album["year"], 2001);
    assert_eq!(album["genreId"], "mandopop");
    assert_eq!(album["localNote"], "本地备注，不是百科介绍");
    assert!(album.get("description").is_none());
    assert_eq!(track["title"], "测试曲目");
    assert_eq!(track["sampleRate"], 48000);
    assert_eq!(track["bitsPerSample"], 16);
    assert_eq!(track["duration"], 1.0);
    assert_eq!(track["trackNumber"], 2);
    assert!(track.get("_path").is_none());
    assert!(s.index["albums"][0]["_cover"]["embedded"]
        .as_bool()
        .unwrap());
    let cover = file.parent().unwrap().join("cover.jpg");
    fs::write(&cover, b"folder cover").unwrap();
    s.scan_sync().unwrap();
    assert_eq!(
        s.file(library::text(&album["id"]), true).unwrap().path,
        cover
    );
    fs::remove_file(cover).unwrap();
    s.scan_sync().unwrap();
    assert_eq!(s.index["albums"][0]["_cover"]["embedded"], true);
    assert_eq!(
        fs::read(&file).unwrap(),
        original,
        "scanning never changes source tags or audio"
    );
    let cached = s.index["albums"][0]["tracks"][0].clone();
    s.scan_sync().unwrap();
    assert_eq!(s.index["albums"][0]["tracks"][0], cached);
    let reopened = Store::open(s.data_dir.clone()).unwrap();
    assert_eq!(reopened.snapshot()["albums"][0]["id"], album["id"]);
}

#[test]
fn root_singles_nested_albums_incremental_and_disconnected_library() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("音乐");
    wav(&root.join("Single 1.wav"));
    wav(&root.join("Single 2.wav"));
    wav(&root.join("Album").join("1-10 Test.wav"));
    wav(&root.join("Album").join("1-2 Test.wav"));
    let mut s = store(&temp, &root);
    s.scan_sync().unwrap();
    assert_eq!(s.snapshot()["albums"].as_array().unwrap().len(), 3);
    let album = s.index["albums"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["title"] == "Album")
        .unwrap();
    assert_eq!(album["tracks"][0]["trackNumber"], 2);
    let id = library::text(&album["id"]).to_owned();
    let mut rules = s.rules.clone();
    rules["albumOverrides"][&id] = json!("jazz");
    s.update_rules(rules).unwrap();
    s.scan_sync().unwrap();
    assert_eq!(
        s.snapshot()["albums"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == id)
            .unwrap()["genreId"],
        "jazz"
    );
    fs::remove_file(root.join("Single 1.wav")).unwrap();
    s.scan_sync().unwrap();
    assert_eq!(s.snapshot()["albums"].as_array().unwrap().len(), 2);
    let offline = temp.path().join("暂时断开");
    fs::rename(&root, &offline).unwrap();
    s.scan_sync().unwrap();
    assert_eq!(s.snapshot()["albums"].as_array().unwrap().len(), 2);
    assert_eq!(s.snapshot()["roots"][0]["status"], "offline");
    assert!(s.snapshot()["albums"]
        .as_array()
        .unwrap()
        .iter()
        .all(|a| a["offline"] == true));
    fs::rename(offline, &root).unwrap();
    s.scan_sync().unwrap();
    assert_eq!(s.snapshot()["roots"][0]["status"], "online");
    s.update_config(&json!({"roots":[]})).unwrap();
    assert!(s.snapshot()["albums"].as_array().unwrap().is_empty());
    assert!(s.file(&id, true).is_none());
}

#[test]
fn configuration_and_rules_reject_invalid_changes_without_clobbering_files() {
    let temp = tempfile::tempdir().unwrap();
    let mut s = Store::open(temp.path().join("index")).unwrap();
    let original = s.config.clone();
    for value in [
        json!({"roots":["relative"]}),
        json!({"onlineEnabled":"yes"}),
        json!({"musicBrainzContact":"bad\nheader"}),
        json!({"foobarBaseUrl":"http://example.com"}),
    ] {
        assert!(s.update_config(&value).is_err());
        assert_eq!(s.config, original);
    }
    let roots = if cfg!(windows) {
        json!(["D:\\Music", "d:/Music/Album", "d:/Music"])
    } else {
        json!(["/Music", "/Music/Album", "/Music"])
    };
    assert_eq!(library::safe_roots(&roots).unwrap().len(), 1);
    let file = s.data_dir.join("genre-rules.json");
    let before = fs::read(&file).unwrap();
    assert!(s
        .update_rules(json!({"version":1,"genres":[],"albumOverrides":{"x":"missing"}}))
        .is_err());
    assert_eq!(fs::read(&file).unwrap(), before);
    s.update_rules(s.rules.clone()).unwrap();
    assert_eq!(
        fs::read(s.data_dir.join("genre-rules.json.backup")).unwrap(),
        before
    );
    fs::write(s.data_dir.join("library-index.json"), b"broken data").unwrap();
    assert!(Store::open(s.data_dir.clone()).is_err());
    assert_eq!(
        fs::read(s.data_dir.join("library-index.json")).unwrap(),
        b"broken data"
    );
}

#[test]
fn http_serves_byte_ranges_and_keeps_directory_host_origin_boundaries() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("音乐");
    let bytes = wav(&root.join("单曲.wav"));
    let mut store = store(&temp, &root);
    store.scan_sync().unwrap();
    let track_id = library::text(&store.index["albums"][0]["tracks"][0]["id"]).to_owned();
    let assets = temp.path().join("web");
    fs::create_dir(&assets).unwrap();
    fs::write(assets.join("index.html"), b"test UI").unwrap();
    let service = Service::start(store, assets, 0).unwrap();
    for _ in 0..200 {
        if service.store.lock().unwrap().scan["running"] != true {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_ne!(service.store.lock().unwrap().scan["running"], true);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let origin = format!("http://127.0.0.1:{}", service.port);
    let audio = format!("{origin}/api/audio/{track_id}");
    let response = client
        .get(&audio)
        .header("Range", "bytes=0-43")
        .send()
        .unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(
        response.headers()["content-range"],
        format!("bytes 0-43/{}", bytes.len())
    );
    assert_eq!(response.bytes().unwrap().as_ref(), &bytes[..44]);
    let response = client
        .get(&audio)
        .header("Range", "bytes=-9")
        .send()
        .unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(response.bytes().unwrap().len(), 9);
    let response = client.head(&audio).send().unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.headers()["content-length"],
        bytes.len().to_string()
    );
    assert!(response.bytes().unwrap().is_empty());
    assert_eq!(
        client
            .get(&audio)
            .header("Range", "bytes=99999999-")
            .send()
            .unwrap()
            .status(),
        416
    );
    assert_eq!(
        client
            .get(format!("{origin}/api/library"))
            .header("Origin", "https://unrelated.example")
            .send()
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .get(format!("{origin}/api/health"))
            .header("Host", "unrelated.example")
            .send()
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .post(format!("{origin}/api/config"))
            .body("{}")
            .send()
            .unwrap()
            .status(),
        415
    );
    assert_eq!(
        client
            .get(format!("{origin}/%2e%2e%2foutside.txt"))
            .send()
            .unwrap()
            .status(),
        404
    );
    // Simulate a stale/corrupt index pointing outside the configured root.
    let outside = temp.path().join("outside.wav");
    wav(&outside);
    {
        let mut s = service.store.lock().unwrap();
        s.index["albums"][0]["tracks"][0]["_path"] = json!(outside);
    }
    assert_eq!(client.get(&audio).send().unwrap().status(), 403);
    service.stop();
}

#[test]
fn range_parser_and_dsf_support_do_not_claim_dsd_playback() {
    assert_eq!(parse_range(Some("bytes=7-99"), 10), Ok(Some((7, 9))));
    for h in [
        "bytes=0-2,4-5",
        "bytes=-0",
        "bytes=7-2",
        "bytes=abc-",
        "bytes=+1-2",
    ] {
        assert!(parse_range(Some(h), 10).is_err());
    }
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("track.dsf");
    let mut bytes = vec![0u8; 92];
    bytes[..4].copy_from_slice(b"DSD ");
    bytes[4..12].copy_from_slice(&28u64.to_le_bytes());
    bytes[12..20].copy_from_slice(&92u64.to_le_bytes());
    bytes[28..32].copy_from_slice(b"fmt ");
    bytes[32..40].copy_from_slice(&52u64.to_le_bytes());
    bytes[52..56].copy_from_slice(&2u32.to_le_bytes());
    bytes[56..60].copy_from_slice(&2822400u32.to_le_bytes());
    bytes[60..64].copy_from_slice(&1u32.to_le_bytes());
    bytes[64..72].copy_from_slice(&2822400u64.to_le_bytes());
    bytes[80..84].copy_from_slice(b"data");
    bytes[84..92].copy_from_slice(&12u64.to_le_bytes());
    fs::write(&file, bytes).unwrap();
    let parsed = metadata::read(&file, true).unwrap();
    assert_eq!(parsed.track["duration"], 1.0);
    assert_eq!(parsed.track["sampleRate"], 2822400);
    assert_eq!(parsed.track["codec"], "DSD");
    let mut s = Store::open(temp.path().join("index")).unwrap();
    s.update_config(&json!({"roots":[temp.path()]})).unwrap();
    s.scan_sync().unwrap();
    assert_eq!(
        s.snapshot()["albums"][0]["tracks"][0]["browserPlayable"],
        false
    );
}

fn album() -> Value {
    json!({"title":"夜航 (Night Flight)","artist":"测试歌手","year":2001})
}
fn page() -> Value {
    json!({"pageid":10,"title":"夜航","extract":"《夜航》是測試歌手於2001年發行的專輯。這是測試導言。","language":"zh"})
}
#[test]
fn online_matching_keeps_titles_artist_year_and_work_type_strict() {
    assert_eq!(normalize_name("後來 ‘夜航’"), normalize_name("后来 '夜航'"));
    let empty = json!({});
    assert!(assess_candidate(&album(), &page(), &empty, &empty).is_ok());
    let mut wrong = album();
    wrong["artist"] = json!("另一歌手");
    assert_eq!(
        assess_candidate(&wrong, &page(), &empty, &empty),
        Err("insufficient-evidence")
    );
    let mut song = page();
    song["extract"] = json!("《夜航》是測試歌手於2001年發行的一首歌曲，收錄在同名專輯中。");
    assert_eq!(
        assess_candidate(&album(), &song, &empty, &empty),
        Err("work-type")
    );
    let entity = json!({"claims":{"P577":[{"mainsnak":{"datavalue":{"value":{"time":"+2000-01-01T00:00:00Z"}}}}]}});
    assert_eq!(
        assess_candidate(&album(), &page(), &entity, &empty),
        Err("year")
    );
    let mut disambiguation = page();
    disambiguation["pageprops"] = json!({"disambiguation":""});
    assert_eq!(
        assess_candidate(&album(), &disambiguation, &empty, &empty),
        Err("disambiguation")
    );
}
#[test]
fn encyclopedia_returns_attributed_article_and_distinguishes_failure_and_ambiguity() {
    let mut provider = Provider::with_fetcher(
        Arc::new(|url| {
            assert!(!url.as_str().contains("private"));
            Ok(json!({"query":{"pages":[page()]}}))
        }),
        Duration::ZERO,
    );
    let result = provider.lookup(&album());
    assert_eq!(result["status"], "matched");
    assert_eq!(result["description"], page()["extract"]);
    assert!(library::text(&result["descriptionSource"]["url"])
        .starts_with("https://zh.wikipedia.org/wiki/"));
    let mut failing =
        Provider::with_fetcher(Arc::new(|_| Err("fixture timeout".into())), Duration::ZERO);
    assert_eq!(failing.lookup(&album())["status"], "error");
    let mut ambiguous = Provider::with_fetcher(
        Arc::new(|_| {
            let mut another = page();
            another["pageid"] = json!(11);
            another["title"] = json!("Night Flight (album)");
            Ok(json!({"query":{"pages":[page(),another]}}))
        }),
        Duration::ZERO,
    );
    assert_eq!(ambiguous.lookup(&album())["status"], "uncertain");
    let mut discovery = Provider::with_fetcher(
        Arc::new(|url| {
            let mut p = page();
            p["snippet"] = json!("NEVER USE A SEARCH SNIPPET");
            Ok(
                json!({"query":{"pages":if url.query_pairs().any(|(k,_)|k=="generator"){vec![p]}else{vec![]}}}),
            )
        }),
        Duration::ZERO,
    );
    let found = discovery.lookup(&album());
    assert_eq!(found["description"], page()["extract"]);
}
