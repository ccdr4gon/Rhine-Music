use id3::TagLike;
use rhine_music::{
    app_server::Service,
    http::parse_range,
    library::{self, Store},
    metadata,
    online::{assess_candidate, normalize_name, Provider},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

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

/// The owner, 2026-10-06: "Local music means choosing a main folder, and each playlist will be a
/// subfolder." A fictional tree with nested folders, loose files, an empty and a hidden folder.
#[test]
fn main_folder_subfolders_are_playlists_and_earlier_folders_stay_unused() {
    let temp = tempfile::tempdir().unwrap();
    let main = temp.path().join("主文件夹 Main");
    wav(&main.join("Loose 10.wav"));
    wav(&main.join("Loose 2.wav"));
    tagged_wav(&main.join("夜航 Night").join("Track 10.wav"));
    wav(&main.join("夜航 Night").join("Track 2.wav"));
    wav(&main.join("夜航 Night").join("CD 2").join("Track 1.wav"));
    wav(&main.join("Album 10").join("a.wav"));
    wav(&main.join("Album 9").join("Deep").join("Deeper").join("b.wav"));
    // Not playlists: a folder without audio, a hidden folder; not songs: a `._` copy and
    // QQ Music's encrypted downloads (counted only).
    fs::create_dir_all(main.join("Empty").join("Still empty")).unwrap();
    fs::write(main.join("Empty").join("notes.txt"), b"no audio").unwrap();
    wav(&main.join(".hidden").join("x.wav"));
    wav(&main.join("夜航 Night").join("._Track 2.wav"));
    fs::write(main.join("夜航 Night").join("download.mflac"), b"encrypted").unwrap();
    fs::write(main.join("download.qmc0"), b"encrypted").unwrap();
    fs::write(main.join("Album 10").join("download.mgg1"), b"encrypted").unwrap();
    #[cfg(windows)]
    {
        let marked = main.join("Marked hidden");
        wav(&marked.join("y.wav"));
        assert!(std::process::Command::new("attrib")
            .arg("+h")
            .arg(&marked)
            .status()
            .unwrap()
            .success());
        // A folder marked system only (no hidden mark) is skipped as well.
        let system = main.join("Marked system");
        wav(&system.join("s.wav"));
        assert!(std::process::Command::new("attrib")
            .arg("+s")
            .arg(&system)
            .status()
            .unwrap()
            .success());
    }
    let elsewhere = temp.path().join("Earlier second folder");
    wav(&elsewhere.join("Old").join("z.wav"));
    let mut s = Store::open(temp.path().join("索引")).unwrap();
    s.update_config(&json!({"roots":[&elsewhere]})).unwrap();
    s.scan_sync().unwrap();
    let old_track = library::text(&s.index["albums"][0]["tracks"][0]["id"]).to_owned();
    // An earlier version's two folders: the first is the main folder, the second stays saved.
    s.update_config(&json!({"roots":[&main, &elsewhere]})).unwrap();
    s.scan_sync().unwrap();
    let snapshot = s.snapshot();
    let lists = snapshot["playlists"].as_array().unwrap();
    let names: Vec<_> = lists.iter().map(|p| library::text(&p["name"])).collect();
    assert_eq!(names, ["主文件夹 Main", "Album 9", "Album 10", "夜航 Night"]);
    assert_eq!(lists.iter().map(|p| p["main"] == true).collect::<Vec<_>>(), [true, false, false, false]);
    assert_eq!(lists[0]["folder"], json!(main));
    assert_eq!(lists[3]["folder"], json!(main.join("夜航 Night")));
    assert_eq!(
        lists[3]["id"],
        format!("playlist-{}", library::hash(main.join("夜航 Night").to_string_lossy().as_bytes()))
    );
    let path_of = |id: &Value| {
        snapshot["albums"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|a| a["tracks"].as_array().unwrap())
            .find(|t| t["id"] == *id)
            .map(|t| library::text(&t["relativePath"]).replace('\\', "/"))
            .unwrap()
    };
    let songs = |list: &Value| list["trackIds"].as_array().unwrap().iter().map(path_of).collect::<Vec<_>>();
    assert_eq!(songs(&lists[0]), ["Loose 2.wav", "Loose 10.wav"]);
    assert_eq!(songs(&lists[1]), ["Album 9/Deep/Deeper/b.wav"]);
    assert_eq!(
        songs(&lists[3]),
        ["夜航 Night/CD 2/Track 1.wav", "夜航 Night/Track 2.wav", "夜航 Night/Track 10.wav"]
    );
    let all = lists.iter().map(|p| p["trackIds"].as_array().unwrap().len()).sum::<usize>();
    assert_eq!(all, 7, "every song once; nothing from the hidden or empty folders");
    assert_eq!(snapshot["roots"][0]["encrypted"], 3);
    assert_eq!(snapshot["roots"][1]["path"], json!(elsewhere.to_string_lossy()));
    assert_eq!(snapshot["roots"][1]["status"], "unscanned");
    // A song's own tags for its details; never written back.
    let tagged = snapshot["albums"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|a| a["tracks"].as_array().unwrap())
        .find(|t| t["title"] == "测试曲目")
        .unwrap();
    assert_eq!((tagged["album"].clone(), tagged["year"].clone()), (json!("夜航"), json!(2001)));
    // The earlier second folder is neither shown nor served.
    assert!(s.file(&old_track, false).is_none());
    assert!(s.index["albums"].as_array().unwrap().iter().all(|a| a["_root"] == json!(main.to_string_lossy())));
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
    // The first folder is the main folder: a later one containing it is dropped, not the main one.
    let main_first = if cfg!(windows) {
        json!(["D:\\Music\\Main", "d:/Music", "E:\\Old", "e:/old/inner"])
    } else {
        json!(["/Music/Main", "/Music", "/Old", "/Old/inner"])
    };
    let kept = library::safe_roots(&main_first).unwrap();
    assert_eq!(kept.len(), 2);
    assert!(kept[0].ends_with("Main"));
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
    // A damaged index does not stop the start: it is set aside beside it, as it was, and the
    // library starts from an empty one (the start-up scan reads the folder again).
    fs::write(s.data_dir.join("library-index.json"), b"broken data").unwrap();
    let reopened = Store::open(s.data_dir.clone()).unwrap();
    assert_eq!(reopened.set_aside.len(), 1);
    assert!(reopened.set_aside[0].starts_with("library-index.json.unreadable-"));
    assert_eq!(
        fs::read(s.data_dir.join(&reopened.set_aside[0])).unwrap(),
        b"broken data"
    );
    assert!(!s.data_dir.join("library-index.json").exists());
    assert_eq!(reopened.snapshot()["setAside"], json!(reopened.set_aside));
}

/// A data file damaged (say by a power cut, which can leave zeros) or written by a newer version
/// must not keep the client from starting (it serves every source): it is set aside under a new
/// name, never deleted or written over, and the store opens with what it would have without it.
#[test]
fn damaged_or_newer_data_files_are_set_aside_and_the_store_opens() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let root = temp.path().join("音乐");
    wav(&root.join("单曲.wav"));
    {
        let mut s = Store::open(data.clone()).unwrap();
        s.update_config(&json!({"roots":[&root]})).unwrap();
        s.scan_sync().unwrap();
        s.save_index().unwrap();
    }
    // A valid config is not written again at every start; one with a byte order mark is read.
    let config = fs::read(data.join("config.json")).unwrap();
    let mut with_bom = b"\xEF\xBB\xBF".to_vec();
    with_bom.extend(&config);
    fs::write(data.join("config.json"), &with_bom).unwrap();
    let s = Store::open(data.clone()).unwrap();
    assert!(s.set_aside.is_empty());
    assert_eq!(s.main_folder(), root.to_str());
    assert_eq!(fs::read(data.join("config.json")).unwrap(), with_bom);
    assert!(s.snapshot().get("setAside").is_none());
    let index = fs::read(data.join("library-index.json")).unwrap();
    for (file, bytes) in [
        ("config.json", vec![0u8; 120]),
        ("config.json", b"[]".to_vec()),
        ("config.json", br#"{"version":1,"roots":["relative"]}"#.to_vec()),
        ("library-index.json", br#"{"version":2,"albums":[]}"#.to_vec()),
        ("library-index.json", index[..index.len() / 2].to_vec()),
        ("genre-rules.json", vec![0u8; 64]),
    ] {
        fs::write(data.join(file), &bytes).unwrap();
        let s = Store::open(data.clone()).unwrap_or_else(|e| panic!("{file}: {e}"));
        assert_eq!(s.set_aside.len(), 1, "{file}");
        assert!(s.set_aside[0].starts_with(&format!("{file}.unreadable-")), "{file}");
        assert_eq!(fs::read(data.join(&s.set_aside[0])).unwrap(), bytes, "{file} kept as it was");
        // What the store opened with instead, written where it is written at a start.
        match file {
            "config.json" => {
                assert_eq!(s.main_folder(), None, "the main folder is not guessed");
                assert!(data.join("config.json").exists());
                fs::write(data.join("config.json"), &config).unwrap();
            }
            "library-index.json" => {
                assert!(s.index["albums"].as_array().unwrap().is_empty());
                fs::write(data.join("library-index.json"), &index).unwrap();
            }
            _ => assert_eq!(s.rules, library::validate_rules(library::default_rules()).unwrap()),
        }
        fs::remove_file(data.join(&s.set_aside[0])).unwrap();
    }
    // Another error than the content's still stops the start: here the index is a folder.
    fs::remove_file(data.join("library-index.json")).unwrap();
    fs::create_dir(data.join("library-index.json")).unwrap();
    assert!(Store::open(data.clone()).is_err());
}

/// The owner, 2026-10-06: one main folder. A new one that is not there (a typing error) is refused
/// before anything is saved or scanned; the chosen one, away for a while, can be saved again.
#[test]
fn a_new_main_folder_that_is_not_there_is_refused() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("音乐");
    wav(&root.join("单曲.wav"));
    let mut s = store(&temp, &root);
    s.scan_sync().unwrap();
    let config = fs::read(s.data_dir.join("config.json")).unwrap();
    let file = root.join("单曲.wav");
    for (missing, message) in [
        (temp.path().join("没有这个文件夹"), "找不到文件夹"),
        (file.clone(), "不是文件夹"),
    ] {
        let error = s.update_config(&json!({"roots":[&missing]})).unwrap_err();
        assert!(error.starts_with(message), "{error}");
        assert_eq!(s.main_folder(), root.to_str());
        assert_eq!(fs::read(s.data_dir.join("config.json")).unwrap(), config);
    }
    // Through the scan route too, with nothing started.
    let shared = Arc::new(std::sync::Mutex::new(s));
    assert!(Store::begin_scan(&shared, Some(&json!([temp.path().join("没有")]))).is_err());
    assert_ne!(shared.lock().unwrap().scan["running"], true);
    // While a scan runs, a new main folder is refused, not dropped; a plain rescan is taken.
    let other = temp.path().join("另一个");
    wav(&other.join("歌.wav"));
    shared.lock().unwrap().scan["running"] = json!(true);
    assert!(Store::begin_scan(&shared, Some(&json!([&other]))).unwrap_err().starts_with("正在扫描"));
    assert!(Store::begin_scan(&shared, None).is_ok());
    shared.lock().unwrap().scan["running"] = json!(false);
    let mut s = Arc::try_unwrap(shared).ok().unwrap().into_inner().unwrap();
    assert_eq!(s.main_folder(), root.to_str());
    // The chosen folder while it is away: saved again, it keeps its index, offline.
    let away = temp.path().join("暂时断开");
    fs::rename(&root, &away).unwrap();
    s.update_config(&json!({"roots":[&root]})).unwrap();
    s.scan_sync().unwrap();
    assert_eq!(s.snapshot()["roots"][0]["status"], "offline");
    assert_eq!(s.snapshot()["albums"].as_array().unwrap().len(), 1);
    // Another folder that is there is taken; clearing the folder too.
    s.update_config(&json!({"roots":[&other]})).unwrap();
    s.update_config(&json!({"roots":[]})).unwrap();
    // The routes look for a new main folder with the store unlocked (a network folder whose host
    // does not answer takes about 21 s): under the lock, the folder found is not looked for again.
    let shared = Arc::new(std::sync::Mutex::new(s));
    let gone = temp.path().join("刚才还在");
    fs::create_dir(&gone).unwrap();
    let checked = Store::checked_main_folder(&shared, &json!([&gone])).unwrap();
    assert_eq!(checked.as_deref(), gone.to_str());
    fs::remove_dir(&gone).unwrap();
    let mut s = shared.lock().unwrap();
    s.update_config_checked(&json!({"roots":[&gone]}), checked.as_deref()).unwrap();
    assert_eq!(s.main_folder(), gone.to_str());
    // Another folder than the one found is looked for there.
    let missing = json!({"roots":[temp.path().join("没有")]});
    assert!(s.update_config_checked(&missing, checked.as_deref()).unwrap_err().starts_with("找不到文件夹"));
    drop(s);
    // Saving the main folder again asks nothing of the disk; during a scan it is refused first.
    assert_eq!(Store::checked_main_folder(&shared, &json!([&gone])).unwrap(), None);
    shared.lock().unwrap().scan["running"] = json!(true);
    assert_eq!(Store::checked_main_folder(&shared, &json!([&other])).unwrap_err(), library::SCANNING);
}

/// A scan without a main folder (none chosen yet, or config.json set aside at a start) leaves the
/// index as it is, unshown; the same folder chosen again finds its albums with what was cached.
#[test]
fn a_scan_without_a_main_folder_keeps_the_index() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let root = temp.path().join("音乐");
    wav(&root.join("歌单 A").join("歌.wav"));
    wav(&root.join("单曲.wav"));
    {
        let mut s = Store::open(data.clone()).unwrap();
        s.update_config(&json!({"roots":[&root]})).unwrap();
        s.scan_sync().unwrap();
        // Stands for what the online lookups cached (fictional).
        for album in s.index["albums"].as_array_mut().unwrap() {
            album["introduction"] = json!({"status":"found","text":"虚构的介绍","checkedAt":"2026-10-23T00:00:00Z"});
        }
        s.save_index().unwrap();
    }
    let index = fs::read(data.join("library-index.json")).unwrap();
    let albums = |s: &Store| s.index["albums"].as_array().unwrap().len();
    fs::write(data.join("config.json"), vec![0u8; 120]).unwrap();
    let s = Store::open(data.clone()).unwrap();
    assert_eq!((s.set_aside.len(), s.main_folder()), (1, None));
    // The start's scan (app_server) writes nothing over it.
    let shared = Arc::new(std::sync::Mutex::new(s));
    Store::begin_scan(&shared, None).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while shared.lock().unwrap().scan["running"] == true {
        assert!(Instant::now() < deadline, "scan did not finish");
        std::thread::sleep(Duration::from_millis(20));
    }
    let s = shared.lock().unwrap();
    assert!(s.scan.get("error").is_none() && s.scan["finishedAt"].is_string());
    assert_eq!(fs::read(data.join("library-index.json")).unwrap(), index);
    assert_eq!(albums(&s), 2);
    assert!(s.snapshot()["albums"].as_array().unwrap().is_empty());
    let id = library::text(&s.index["albums"][0]["tracks"][0]["id"]).to_owned();
    assert!(s.file(&id, false).is_none(), "nor served");
    drop(s);
    // The next start (config.json now holds no main folder, nothing is set aside): the same.
    let mut s = Store::open(data.clone()).unwrap();
    assert!(s.set_aside.is_empty());
    s.scan_sync().unwrap();
    assert_eq!(albums(&s), 2);
    // The same folder chosen again: its albums come back with what was cached.
    s.update_config(&json!({"roots":[&root]})).unwrap();
    s.scan_sync().unwrap();
    let snapshot = s.snapshot();
    let shown = snapshot["albums"].as_array().unwrap();
    assert_eq!(shown.len(), 2);
    assert!(shown.iter().all(|a| a["introduction"]["text"] == "虚构的介绍"));
    assert!(s.file(&id, false).is_some());
    // Another folder leaves them out.
    let other = temp.path().join("另一个");
    wav(&other.join("别的.wav"));
    s.update_config(&json!({"roots":[&other]})).unwrap();
    s.scan_sync().unwrap();
    assert_eq!(albums(&s), 1);
}

/// A data folder that cannot be written stops the start, which says why (main.rs), also when it
/// already holds valid data, which a start writes nothing else to (a portable folder copied into
/// C:\Program Files, say). Nothing in it is changed.
#[cfg(windows)]
#[test]
fn a_data_folder_that_cannot_be_written_stops_the_start() {
    use std::process::Command;
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let root = temp.path().join("音乐");
    wav(&root.join("单曲.wav"));
    {
        let mut s = Store::open(data.clone()).unwrap();
        s.update_config(&json!({"roots":[&root]})).unwrap();
        s.scan_sync().unwrap();
        s.save_index().unwrap();
    }
    let listing = || {
        let mut files: Vec<_> = fs::read_dir(&data)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.is_file())
            .map(|path| (path.clone(), fs::read(path).unwrap()))
            .collect();
        files.sort();
        files
    };
    let before = listing();
    // The current user may not add or change anything in it (a deny entry, removed again).
    let user = String::from_utf8(
        Command::new("whoami").args(["/user", "/fo", "csv", "/nh"]).output().unwrap().stdout,
    )
    .unwrap();
    let sid = format!("*{}", user.trim().rsplit(',').next().unwrap().trim_matches('"'));
    struct Allow(std::path::PathBuf, String);
    impl Drop for Allow {
        fn drop(&mut self) {
            let _ = Command::new("icacls")
                .arg(&self.0)
                .args(["/remove:d", &self.1, "/T", "/Q"])
                .output();
        }
    }
    let denied = Command::new("icacls")
        .arg(&data)
        .args(["/deny", &format!("{sid}:(OI)(CI)(WD,AD,WA,WEA,DC)"), "/T", "/Q"])
        .output()
        .unwrap();
    let _allow = Allow(data.clone(), sid);
    assert!(denied.status.success(), "{}", String::from_utf8_lossy(&denied.stderr));
    assert!(fs::write(data.join("config.json"), b"{}").is_err(), "the folder is write-denied");
    assert!(Store::open(data.clone()).is_err());
    drop(_allow);
    assert_eq!(listing(), before);
    assert!(Store::open(data.clone()).is_ok());
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
    // A new main folder while a scan runs is refused (409, as on /api/config), never dropped; one
    // that is not there is refused (400) before anything is saved or scanned.
    let scan = |body: Value| {
        client
            .post(format!("{origin}/api/library/scan"))
            .header("Content-Type", "application/json")
            .body(body.to_string())
            .send()
            .unwrap()
            .status()
    };
    service.store.lock().unwrap().scan["running"] = json!(true);
    assert_eq!(scan(json!({"roots":[temp.path()]})), 409);
    assert_eq!(scan(json!({})), 202);
    service.store.lock().unwrap().scan["running"] = json!(false);
    assert_eq!(scan(json!({"roots":[temp.path().join("没有这个文件夹")]})), 400);
    assert_eq!(service.store.lock().unwrap().main_folder(), root.to_str());
    service.stop();
}

/// Songs, covers and lyrics whose full path is longer than 260 characters are served like any
/// other (they were refused as outside their folder: the folder and the file were compared in two
/// forms).
#[test]
fn songs_covers_and_lyrics_on_paths_over_260_characters_are_served() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("音乐");
    let mut folder = root.join("长路径歌单");
    while folder.to_string_lossy().encode_utf16().count() < 280 {
        folder.push("a-long-fictional-folder-name");
    }
    let song = folder.join("虚构长路径歌曲.wav");
    let bytes = wav(&song);
    fs::write(folder.join("cover.png"), b"fictional cover").unwrap();
    fs::write(folder.join("虚构长路径歌曲.lrc"), "[00:01.00]虚构的歌词").unwrap();
    let mut store = store(&temp, &root);
    store.scan_sync().unwrap();
    let album = store.snapshot()["albums"][0].clone();
    let assets = temp.path().join("web");
    fs::create_dir(&assets).unwrap();
    fs::write(assets.join("index.html"), b"test UI").unwrap();
    let service = Service::start(store, assets, 0).unwrap();
    let client = reqwest::blocking::Client::new();
    let origin = format!("http://127.0.0.1:{}", service.port);
    let response = client
        .get(format!("{origin}{}", library::text(&album["tracks"][0]["audioUrl"])))
        .header("Range", "bytes=0-43")
        .send()
        .unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(response.bytes().unwrap().as_ref(), &bytes[..44]);
    let lyrics = client
        .get(format!("{origin}/api/lyrics/{}", library::text(&album["tracks"][0]["id"])))
        .send()
        .unwrap();
    assert_eq!(lyrics.status(), 200);
    assert_eq!(lyrics.text().unwrap(), "[00:01.00]虚构的歌词");
    let cover = client
        .get(format!("{origin}{}", library::text(&album["coverUrl"])))
        .send()
        .unwrap();
    assert_eq!(cover.status(), 200);
    assert_eq!(cover.bytes().unwrap().as_ref(), b"fictional cover");
    service.stop();
}

/// A small made-up WAV: many of them stay small on the disk.
fn short_wav(path: &Path) {
    let mut data = b"RIFF".to_vec();
    data.extend(236u32.to_le_bytes());
    data.extend(b"WAVEfmt ");
    data.extend(16u32.to_le_bytes());
    data.extend(1u16.to_le_bytes());
    data.extend(1u16.to_le_bytes());
    data.extend(8000u32.to_le_bytes());
    data.extend(16000u32.to_le_bytes());
    data.extend(2u16.to_le_bytes());
    data.extend(16u16.to_le_bytes());
    data.extend(b"data");
    data.extend(200u32.to_le_bytes());
    data.resize(244, 0);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, data).unwrap();
}

/// The scan at every start reads only what changed, with one look-up per song: never slower than
/// the first scan, however many songs share a folder or the main folder (its cost grew with their
/// square: 16,000 songs in one folder took 37 s at every start). Its result is the first one's.
#[test]
fn the_scan_of_an_unchanged_library_takes_one_look_up_per_song() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("音乐");
    for i in 0..2500 {
        short_wav(&root.join("一个大歌单").join(format!("虚构 {i:04}.wav")));
    }
    for i in 0..600 {
        short_wav(&root.join(format!("单曲 {i:03}.wav")));
        fs::write(root.join(format!("单曲 {i:03}.png")), b"cover").unwrap();
    }
    let mut s = store(&temp, &root);
    let started = Instant::now();
    s.scan_sync().unwrap();
    let first = started.elapsed();
    let albums = s.index["albums"].clone();
    assert_eq!(albums.as_array().unwrap().len(), 601);
    assert_eq!(
        s.file(library::text(&albums[0]["id"]), true).unwrap().path,
        root.join("单曲 000.png"),
        "a song directly in the main folder keeps the image of its name"
    );
    let started = Instant::now();
    s.scan_sync().unwrap();
    let again = started.elapsed();
    assert_eq!(s.index["albums"], albums);
    assert!(again < first, "the scan of an unchanged library took {again:?}, the first {first:?}");
}

/// A name that is not valid Unicode (a lone UTF-16 surrogate, which NTFS allows and a tool cutting
/// a name in two leaves) cannot be a path in the index: such a song or folder is counted and left
/// out, and the scan goes on (the scan panicked, which ended the client at every start).
#[cfg(windows)]
#[test]
fn names_that_are_not_unicode_are_counted_and_left_out() {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};
    let lone = |name: &str, extension: &str| {
        let mut wide: Vec<u16> = name.encode_utf16().collect();
        wide.push(0xD800);
        wide.extend(extension.encode_utf16());
        OsString::from_wide(&wide)
    };
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("音乐");
    let playlist = root.join("歌单");
    wav(&playlist.join("正常.wav"));
    let mut s = store(&temp, &root);
    s.scan_sync().unwrap();
    // Added to a folder already indexed, and in a new folder, the main folder and as a cover.
    wav(&playlist.join(lone("虚构歌曲", ".wav")));
    wav(&root.join(lone("歌单", "")).join("歌.wav"));
    wav(&root.join(lone("单曲", ".wav")));
    fs::write(playlist.join(lone("封面", ".png")), b"not a song").unwrap();
    s.scan_sync().unwrap();
    let snapshot = s.snapshot();
    assert_eq!(snapshot["roots"][0]["status"], "online");
    assert_eq!(snapshot["roots"][0]["unreadable"], 3);
    let tracks: Vec<_> = snapshot["albums"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|a| a["tracks"].as_array().unwrap())
        .map(|t| library::text(&t["title"]).to_owned())
        .collect();
    assert_eq!(tracks, ["正常"]);
}

/// One song in use by another program (or not permitted), or one folder that cannot be listed,
/// takes only itself out of a scan, not the main folder: a new song waits for the next scan, a
/// known one keeps its record, a folder its albums (offline), and the rest stays online.
#[cfg(windows)]
#[test]
fn an_entry_in_use_takes_only_itself_out_of_the_scan() {
    use std::os::windows::fs::OpenOptionsExt;
    // FILE_FLAG_BACKUP_SEMANTICS: needed to open a folder. Nothing else may open it meanwhile.
    let exclusive = |path: &Path| {
        fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .custom_flags(0x0200_0000)
            .open(path)
            .unwrap()
    };
    let titles = |s: &Store| {
        let mut titles: Vec<_> = s.index["albums"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|a| a["tracks"].as_array().unwrap())
            .map(|t| library::text(&t["title"]).to_owned())
            .collect();
        titles.sort();
        titles
    };
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("音乐");
    wav(&root.join("单曲.wav"));
    wav(&root.join("歌单甲").join("一.wav"));
    wav(&root.join("歌单乙").join("二.wav"));
    let downloading = root.join("歌单甲").join("下载中.wav");
    wav(&downloading);
    let mut s = store(&temp, &root);
    // The first scan, with a new song in use: the rest of the library is there.
    {
        let _held = exclusive(&downloading);
        s.scan_sync().unwrap();
    }
    assert_eq!(s.index["roots"][0]["status"], "online");
    assert_eq!(s.index["roots"][0]["unreadable"], 1);
    assert_eq!(titles(&s), ["一", "二", "单曲"]);
    s.scan_sync().unwrap();
    assert_eq!(titles(&s), ["一", "下载中", "二", "单曲"]);
    assert!(s.index["roots"][0].get("unreadable").is_none());
    // A folder that cannot be listed keeps its album, offline; the others stay online.
    {
        let _held = exclusive(&root.join("歌单乙"));
        s.scan_sync().unwrap();
    }
    assert_eq!(s.index["roots"][0]["status"], "online");
    assert_eq!(s.index["roots"][0]["unreadable"], 1);
    assert_eq!(titles(&s), ["一", "下载中", "二", "单曲"]);
    for album in s.index["albums"].as_array().unwrap() {
        let away = library::text(&album["folder"]).ends_with("歌单乙");
        assert_eq!(album["offline"], away, "{}", album["folder"]);
    }
    s.scan_sync().unwrap();
    assert!(s.index["albums"].as_array().unwrap().iter().all(|a| a["offline"] == false));
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
