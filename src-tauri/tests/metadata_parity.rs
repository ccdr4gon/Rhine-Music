use id3::TagLike;
use rhine_music::{
    library::{self, Store},
    metadata,
};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

fn save(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn wave(path: &Path, format: u16) {
    let bits = if format == 1 { 16u16 } else { 8 };
    let samples = 8000u32;
    let size = samples * u32::from(bits / 8);
    let mut bytes = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
    bytes.extend(16u32.to_le_bytes());
    bytes.extend(format.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(samples.to_le_bytes());
    bytes.extend(size.to_le_bytes());
    bytes.extend((bits / 8).to_le_bytes());
    bytes.extend(bits.to_le_bytes());
    if format != 1 {
        bytes.extend(b"fact");
        bytes.extend(4u32.to_le_bytes());
        bytes.extend(samples.to_le_bytes());
    }
    bytes.extend(b"data");
    bytes.extend(size.to_le_bytes());
    bytes.resize(bytes.len() + size as usize, 0);
    let length = bytes.len() as u32 - 8;
    bytes[4..8].copy_from_slice(&length.to_le_bytes());
    save(path, &bytes);
}

fn aiff(path: &Path, compression: Option<&[u8; 4]>) {
    let mut bytes = b"FORM\0\0\0\0".to_vec();
    bytes.extend(if compression.is_some() {
        b"AIFC"
    } else {
        b"AIFF"
    });
    bytes.extend(b"COMM");
    bytes.extend(if compression.is_some() { 24u32 } else { 18 }.to_be_bytes());
    bytes.extend(1u16.to_be_bytes());
    bytes.extend(8000u32.to_be_bytes());
    bytes.extend(16u16.to_be_bytes());
    // 8000 Hz in the AIFF 80-bit extended floating point representation.
    bytes.extend([0x40, 0x0b, 0xfa, 0, 0, 0, 0, 0, 0, 0]);
    if let Some(compression) = compression {
        bytes.extend(compression);
        bytes.extend([0, 0]);
    }
    bytes.extend(b"SSND");
    bytes.extend(16008u32.to_be_bytes());
    bytes.extend([0; 8]);
    bytes.resize(bytes.len() + 16000, 0);
    let length = bytes.len() as u32 - 8;
    bytes[4..8].copy_from_slice(&length.to_be_bytes());
    save(path, &bytes);
}

fn tag() -> id3::Tag {
    let mut tag = id3::Tag::new();
    tag.set_title("夜航");
    tag.set_artist("测试歌手");
    tag.set_album("测试专辑");
    tag.set_album_artist("专辑歌手");
    tag.set_year(2001);
    tag.set_genre("Mandopop");
    tag.set_track(2);
    tag.set_disc(1);
    tag.set_total_discs(2);
    tag.add_frame(id3::frame::InvolvedPeopleList {
        items: vec![id3::frame::InvolvedPeopleListItem {
            involvement: "producer".into(),
            involvee: "测试制作人".into(),
        }],
    });
    tag.add_frame(id3::frame::Comment {
        lang: "zho".into(),
        description: "".into(),
        text: "本地备注".into(),
    });
    tag.add_frame(id3::frame::ExtendedText {
        description: "MusicBrainz Album Id".into(),
        value: "12345678-1234-1234-1234-123456789abc".into(),
    });
    for (picture_type, data) in [
        (id3::frame::PictureType::CoverBack, b"back".to_vec()),
        (id3::frame::PictureType::CoverFront, b"front".to_vec()),
    ] {
        tag.add_frame(id3::frame::Picture {
            mime_type: "image/png".into(),
            picture_type,
            description: "".into(),
            data,
        });
    }
    tag
}

fn dsf(path: &Path) {
    let mut bytes = vec![0u8; 92];
    bytes[..4].copy_from_slice(b"DSD ");
    bytes[4..12].copy_from_slice(&28u64.to_le_bytes());
    bytes[20..28].copy_from_slice(&92u64.to_le_bytes());
    bytes[28..32].copy_from_slice(b"fmt ");
    bytes[32..40].copy_from_slice(&52u64.to_le_bytes());
    bytes[40..44].copy_from_slice(&1u32.to_le_bytes());
    bytes[48..52].copy_from_slice(&2u32.to_le_bytes());
    bytes[52..56].copy_from_slice(&2u32.to_le_bytes());
    bytes[56..60].copy_from_slice(&2822400u32.to_le_bytes());
    bytes[60..64].copy_from_slice(&1u32.to_le_bytes());
    bytes[64..72].copy_from_slice(&5644800u64.to_le_bytes());
    bytes[72..76].copy_from_slice(&4096u32.to_le_bytes());
    bytes[80..84].copy_from_slice(b"data");
    bytes[84..92].copy_from_slice(&12u64.to_le_bytes());
    tag().write_to(&mut bytes, id3::Version::Id3v24).unwrap();
    let length = bytes.len() as u64;
    bytes[12..20].copy_from_slice(&length.to_le_bytes());
    save(path, &bytes);
}

fn chunk(id: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut bytes = id.to_vec();
    bytes.extend((payload.len() as u64).to_be_bytes());
    bytes.extend(payload);
    if payload.len() % 2 == 1 {
        bytes.push(0);
    }
    bytes
}

fn dff(path: &Path, dst: bool) {
    let mut bytes = b"FRM8\0\0\0\0\0\0\0\0DSD ".to_vec();
    let mut prop = b"SND ".to_vec();
    prop.extend(chunk(b"FS  ", &2822400u32.to_be_bytes()));
    let mut channels = 2u16.to_be_bytes().to_vec();
    channels.extend(b"SLFTSRGT");
    prop.extend(chunk(b"CHNL", &channels));
    prop.extend(chunk(
        b"CMPR",
        if dst {
            b"DST \x00\x00"
        } else {
            b"DSD \x00\x00"
        },
    ));
    bytes.extend(chunk(b"PROP", &prop));
    if dst {
        let mut frames = 150u32.to_be_bytes().to_vec();
        frames.extend(75u16.to_be_bytes());
        bytes.extend(chunk(b"DST ", &chunk(b"FRTE", &frames)));
    } else {
        bytes.extend(chunk(b"DSD ", &vec![0; 1411200]));
    }
    let mut id3 = Vec::new();
    tag().write_to(&mut id3, id3::Version::Id3v24).unwrap();
    bytes.extend(chunk(b"ID3 ", &id3));
    let length = bytes.len() as u64 - 12;
    bytes[4..12].copy_from_slice(&length.to_be_bytes());
    save(path, &bytes);
}

fn store(path: &Path, root: &Path) -> Store {
    let mut store = Store::open(path.into()).unwrap();
    store.update_config(&json!({"roots":[root]})).unwrap();
    store
}

#[test]
fn codec_comes_from_audio_contents_including_compressed_wave_and_aifc() {
    let temp = tempfile::tempdir().unwrap();
    for (name, format, codec, lossless) in [
        ("pcm.wav", 1, "PCM", true),
        ("alaw.wav", 6, "ITU G.711 A-law", false),
        ("wrong-extension.mp3", 1, "PCM", true),
    ] {
        let path = temp.path().join(name);
        wave(&path, format);
        let metadata = metadata::read(&path, false).unwrap();
        assert_eq!(metadata.track["codec"], codec);
        assert_eq!(metadata.track["lossless"], lossless);
        assert_eq!(metadata.track["duration"], 1.0);
    }
    for (compression, lossless) in [(None, true), (Some(b"alaw"), false), (Some(b"sowt"), true)] {
        let path = temp.path().join("aifc.aiff");
        aiff(&path, compression);
        let metadata = metadata::read(&path, false).unwrap();
        assert_eq!(metadata.track["lossless"], lossless);
        assert_eq!(metadata.track["duration"], 1.0);
        if !lossless {
            assert_ne!(metadata.track["codec"], "PCM");
        }
    }
}

#[test]
fn dsd_tags_cover_duration_and_index_only_playback_are_preserved() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("music");
    dsf(&root.join("single.dsf"));
    dff(&root.join("single.dff"), false);
    dff(&root.join("compressed.dff"), true);
    for name in ["single.dsf", "single.dff", "compressed.dff"] {
        let path = root.join(name);
        let before = fs::read(&path).unwrap();
        let metadata = metadata::read(&path, true).unwrap();
        assert_eq!(metadata.track["title"], "夜航");
        assert_eq!(metadata.track["duration"], 2.0);
        assert_eq!(metadata.track["bitsPerSample"], 1);
        assert_eq!(metadata.track["sampleRate"], 2822400);
        assert_eq!(metadata.common["year"], 2001);
        assert_eq!(metadata.common["albumartist"], "专辑歌手");
        assert_eq!(metadata.common["discTotal"], 2);
        assert_eq!(metadata.common["producers"], json!(["测试制作人"]));
        assert_eq!(metadata.picture.unwrap().1, b"front");
        assert!(metadata::read(&path, false).unwrap().picture.is_none());
        assert_eq!(fs::read(&path).unwrap(), before);
    }
    let mut store = store(&temp.path().join("index"), &root);
    store.scan_sync().unwrap();
    assert_eq!(store.index["albums"].as_array().unwrap().len(), 3);
    for album in store.index["albums"].as_array().unwrap() {
        assert_eq!(album["tracks"][0]["browserPlayable"], false);
        assert_eq!(
            album["online"]["releaseId"],
            "12345678-1234-1234-1234-123456789abc"
        );
    }
    let mut invalid = fs::read(root.join("single.dff")).unwrap();
    invalid[20..28].copy_from_slice(&u64::MAX.to_be_bytes());
    save(&root.join("truncated.dff"), &invalid);
    assert!(metadata::read(&root.join("truncated.dff"), false).is_err());
}

#[test]
fn old_index_ids_overrides_and_introductions_survive_migration_and_cache_repair() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("music");
    let path = root.join("Album").join("1-02 song.wav");
    wave(&path, 1);
    tag().write_to_path(&path, id3::Version::Id3v24).unwrap();
    let mut store = store(&temp.path().join("index"), &root);
    store.scan_sync().unwrap();
    let id = store.index["albums"][0]["id"].clone();
    let track_id = store.index["albums"][0]["tracks"][0]["id"].clone();
    assert_eq!(
        id,
        format!(
            "album-{}",
            library::hash(path.parent().unwrap().to_string_lossy().as_bytes())
        )
    );
    assert_eq!(
        track_id,
        format!("track-{}", library::hash(path.to_string_lossy().as_bytes()))
    );
    // Simulate the previous Node index metadata version. IDs and overrides are
    // path-based and must stay valid even though metadata must be re-read once.
    store.index["albums"][0]["tracks"][0]["_metadataVersion"] = json!(2);
    store.index["albums"][0]["description"] = json!("有出处的专辑介绍");
    store.index["albums"][0]["descriptionSource"] =
        json!({"url":"https://example.com/album", "checkedAt":"2026-09-01T00:00:00Z"});
    store.index["albums"][0]["introduction"] = json!({"status":"matched"});
    store.rules["albumOverrides"][id.as_str().unwrap()] = json!("jazz");
    store.update_rules(store.rules.clone()).unwrap();
    store.save_index().unwrap();
    let mut store = Store::open(store.data_dir.clone()).unwrap();
    store.scan_sync().unwrap();
    assert_eq!(store.index["albums"][0]["id"], id);
    assert_eq!(store.index["albums"][0]["tracks"][0]["id"], track_id);
    assert_eq!(store.snapshot()["albums"][0]["genreId"], "jazz");
    let cover = PathBuf::from(store.index["albums"][0]["_cover"]["path"].as_str().unwrap());
    fs::remove_file(&cover).unwrap();
    store.scan_sync().unwrap();
    assert_eq!(fs::read(cover).unwrap(), b"front");
    let stable = store.index["albums"][0]["tracks"][0].clone();
    store.scan_sync().unwrap();
    assert_eq!(store.index["albums"][0]["tracks"][0], stable);
    let extra = root.join("Album").join("1-03 song.wav");
    wave(&extra, 1);
    store.scan_sync().unwrap();
    assert_eq!(store.index["albums"][0]["description"], "有出处的专辑介绍");
    assert_eq!(
        store.index["albums"][0]["tracks"].as_array().unwrap().len(),
        2
    );
}

#[test]
fn zero_tag_numbers_use_filename_and_invalid_index_is_preserved() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("music");
    let path = root.join("1-02 song.wav");
    wave(&path, 1);
    let mut tag = tag();
    tag.set_disc(0);
    tag.set_track(0);
    tag.set_year(0);
    tag.write_to_path(&path, id3::Version::Id3v24).unwrap();
    let mut store = store(&temp.path().join("index"), &root);
    store.scan_sync().unwrap();
    let track = &store.index["albums"][0]["tracks"][0];
    assert_eq!(track["discNumber"], 1);
    assert_eq!(track["trackNumber"], 2);
    assert_eq!(track["_common"]["discNumberSource"], "filename");
    assert!(store.index["albums"][0]["year"].is_null());
    for invalid in [
        json!({"version":1,"albums":[null]}),
        json!({"version":1,"albums":[{"tracks":[false]}]}),
    ] {
        library::write_json(&store.data_dir.join("library-index.json"), &invalid).unwrap();
        assert!(Store::open(store.data_dir.clone()).is_err());
        let saved: Value =
            serde_json::from_slice(&fs::read(store.data_dir.join("library-index.json")).unwrap())
                .unwrap();
        assert_eq!(saved, invalid);
    }
    for id in [" jazz ", "爵士"] {
        assert!(library::validate_rules(
            json!({"version":1,"genres":[{"id":id,"name":"Jazz"}],"albumOverrides":{}})
        )
        .is_err());
    }
}

#[cfg(windows)]
#[test]
fn sharing_violation_keeps_previous_root_instead_of_replacing_tags() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("music");
    let path = root.join("song.wav");
    wave(&path, 1);
    let mut store = store(&temp.path().join("index"), &root);
    store.scan_sync().unwrap();
    let previous = store.index["albums"][0]["tracks"].clone();
    // Changed data needs another metadata read, but an exclusive file owner
    // currently prevents it (e.g. a media synchronizer or removable drive).
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"\0")
        .unwrap();
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    store.scan_sync().unwrap();
    assert_eq!(store.index["roots"][0]["status"], "offline");
    assert_eq!(store.index["albums"][0]["tracks"], previous);
    drop(locked);
    store.scan_sync().unwrap();
    assert_eq!(store.index["roots"][0]["status"], "online");
}

#[test]
fn public_optional_fields_are_omitted_without_changing_private_index_or_config() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("music");
    wave(&root.join("song.wav"), 1);
    let mut store = store(&temp.path().join("index"), &root);
    store.scan_sync().unwrap();
    store
        .config
        .as_object_mut()
        .unwrap()
        .remove("onlineEnabled");
    store.index["albums"][0]["producers"] = json!([{
        "name":"producer", "role":"producer", "source":"local", "trackTitle":null, "url":null
    }]);
    store.index["albums"][0]["introduction"] = json!({"status":"unqueried", "checkedAt":null});
    store.scan["error"] = Value::Null;
    let index_before = store.index.clone();
    let config_before = store.config.clone();
    let public = store.snapshot();
    let album = &public["albums"][0];
    assert!(album.get("year").is_none());
    assert!(album.get("localNote").is_none());
    assert!(album["online"].get("releaseId").is_none());
    assert!(album["online"].get("releaseGroupId").is_none());
    assert!(album["introduction"].get("checkedAt").is_none());
    assert!(album["producers"][0].get("trackTitle").is_none());
    assert!(album["producers"][0].get("url").is_none());
    assert!(public["scan"].get("error").is_none());
    assert_eq!(public["onlineEnabled"], false);
    assert_eq!(store.index, index_before);
    assert_eq!(store.config, config_before);
    assert!(store
        .config_snapshot()
        .get("foobarBaseUrl")
        .unwrap()
        .is_null());
}

#[test]
#[ignore = "reference comparison requires npm ci and Node for the previous service"]
fn node_and_rust_scans_agree_on_shared_metadata_and_identity() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("music");
    let path = root.join("Album").join("1-02 song.wav");
    wave(&path, 1);
    tag().write_to_path(&path, id3::Version::Id3v24).unwrap();
    dsf(&root.join("single.dsf"));
    dff(&root.join("single.dff"), false);
    let mut rust = store(&temp.path().join("rust-index"), &root);
    rust.scan_sync().unwrap();
    let mut child = Command::new("node")
        .args([
            "--input-type=module",
            "-e",
            r#"
        import { MusicLibraryStore } from './scripts/music-library.mjs';
        import { parseFile } from 'music-metadata';
        let input=''; for await (const part of process.stdin) input+=part;
        const config=JSON.parse(input);
        const store=new MusicLibraryStore({dataDir:config.dataDir,defaultRoots:[config.root]});
        await store.init(); await store.scan();
        const assets=['atmosphere.ogg','motif.ogg','observatory-preview.mp3','pulse.ogg','typing-preview.wav'];
        const formats=[];
        for (const name of assets) formats.push({name, format:(await parseFile(`public/audio/${name}`,{duration:true})).format});
        process.stdout.write(JSON.stringify({snapshot:store.snapshot(),formats}));
    "#,
        ])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            json!({"root":root,"dataDir":temp.path().join("node-index")})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reference: Value = serde_json::from_slice(&output.stdout).unwrap();
    for asset in reference["formats"].as_array().unwrap() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("public/audio")
            .join(asset["name"].as_str().unwrap());
        let actual = metadata::read(&path, false).unwrap().track;
        let expected = &asset["format"];
        for field in ["sampleRate", "numberOfChannels", "lossless"] {
            if !expected[field].is_null() {
                assert_eq!(
                    actual[field], expected[field],
                    "asset {}: {field}",
                    asset["name"]
                );
            }
        }
        assert!(
            (actual["duration"].as_f64().unwrap() - expected["duration"].as_f64().unwrap()).abs()
                < 0.05,
            "asset {} duration differs by over 50ms",
            asset["name"]
        );
    }
    let node = &reference["snapshot"];
    let rust = rust.snapshot();
    assert_eq!(
        rust["albums"].as_array().unwrap().len(),
        node["albums"].as_array().unwrap().len()
    );
    for expected in node["albums"].as_array().unwrap() {
        let actual = rust["albums"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == expected["id"])
            .unwrap();
        for field in [
            "id",
            "title",
            "artist",
            "year",
            "discCount",
            "genreId",
            "rawGenres",
            "localNote",
        ] {
            assert_eq!(actual[field], expected[field], "album {field}");
        }
        // Keep every credit found by the old parser. The Rust ID3 reader also
        // accepts TIPL credits that older music-metadata versions may omit.
        for producer in expected["producers"].as_array().unwrap() {
            assert!(actual["producers"].as_array().unwrap().contains(producer));
        }
        for field in [
            "id",
            "albumId",
            "title",
            "artist",
            "duration",
            "discNumber",
            "trackNumber",
            "sampleRate",
            "bitsPerSample",
            "numberOfChannels",
            "lossless",
            "browserPlayable",
            "relativePath",
        ] {
            let (actual, expected) = (&actual["tracks"][0][field], &expected["tracks"][0][field]);
            if actual.is_number() && expected.is_number() {
                assert_eq!(actual.as_f64(), expected.as_f64(), "track {field}");
            } else {
                assert_eq!(actual, expected, "track {field}");
            }
        }
    }
}

#[test]
#[ignore = "optional format verification requires RHINE_FFMPEG or ffmpeg on PATH"]
fn encoded_aac_alac_flac_opus_and_pcm_preserve_codec_and_audio_properties() {
    let temp = tempfile::tempdir().unwrap();
    let ffmpeg = std::env::var_os("RHINE_FFMPEG").unwrap_or_else(|| "ffmpeg".into());
    for (encoder, filename, expected_codec, lossless) in [
        ("aac", "aac.m4a", "MPEG-4/AAC", false),
        ("alac", "alac.m4a", "MPEG-4/ALAC", true),
        ("flac", "flac.flac", "FLAC", true),
        ("libopus", "opus.ogg", "Opus", false),
        ("libvorbis", "vorbis.ogg", "Vorbis", false),
        ("pcm_s24le", "24bit.wav", "PCM", true),
        ("pcm_s16be", "pcm.aiff", "PCM", true),
        ("pcm_alaw", "alaw.wav", "ITU G.711 A-law", false),
        ("adpcm_ima_wav", "adpcm.wav", "IMA ADPCM", false),
        ("adpcm_ms", "ms-adpcm.wav", "Microsoft ADPCM", false),
    ] {
        let path = temp.path().join(filename);
        let output = Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=1",
                "-ac",
                "2",
                "-c:a",
                encoder,
            ])
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{encoder}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        if encoder.starts_with("adpcm_") {
            tag().write_to_path(&path, id3::Version::Id3v24).unwrap();
        }
        let result =
            metadata::read(&path, false).unwrap_or_else(|error| panic!("{filename}: {error}"));
        assert_eq!(result.track["codec"], expected_codec, "{filename}");
        assert_eq!(result.track["lossless"], lossless, "{filename}");
        assert_eq!(result.track["numberOfChannels"], 2, "{filename}");
        assert_eq!(result.track["sampleRate"], 48000, "{filename}");
        if encoder.starts_with("adpcm_") {
            assert_eq!(result.track["title"], "夜航", "compressed WAV retains tags");
            assert_eq!(result.track["bitsPerSample"], 4);
        }
        assert!(
            (result.track["duration"].as_f64().unwrap() - 1.0).abs() < 0.05,
            "{filename}: duration {}",
            result.track["duration"]
        );
    }
}
