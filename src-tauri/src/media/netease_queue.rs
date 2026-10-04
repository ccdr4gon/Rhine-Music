//! NetEase Cloud Music saves its current play queue to `webdata/file/playingList` and
//! rewrites the file whenever the queue changes. Only after the user switches this on, read
//! that file and return display fields: song id, title, artists, album (name and id),
//! duration and the album's public cover address. Only when the user has also switched on
//! playlist columns (`with_source`), and every item was queued from the same playlist, that
//! playlist's id and name are returned too, so that its column can be marked as the queue;
//! they come from each item's `scene`, `href` and `fromInfo.sourceData`. Without that switch
//! those fields are not looked at.
//! Nothing is written or cached to disk; account data, cookies, play history, the paths of
//! local songs and the rest of the source record (its cover, its play count) are never
//! read or returned.
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TRACKS: usize = 3000;
const MAX_TEXT: usize = 300;
/// NetEase's ids are decimal numbers; the longest 64-bit one has 20 digits.
const MAX_ID_DIGITS: usize = 20;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueueTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_id: String,
    /// HTTPS address on NetEase's public image server, without a size parameter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_url: Option<String>,
    /// Seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
}

/// The playlist a queue was started from.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueueSource {
    pub id: String,
    /// May be empty when NetEase saved no name.
    pub name: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum QueueReply {
    /// No queue file: NetEase has not saved a queue for this Windows user.
    Missing,
    /// The file is the same as the one identified by `stamp`.
    Unchanged { stamp: String },
    Queue {
        stamp: String,
        tracks: Vec<QueueTrack>,
        truncated: bool,
        /// Present only when every item of the queue names the same source playlist.
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<QueueSource>,
    },
}

pub fn queue_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(base)
            .join("NetEase")
            .join("CloudMusic")
            .join("webdata")
            .join("file")
            .join("playingList"),
    )
}

/// `known` is the stamp of the queue the caller already shows; an unchanged file is not
/// read again. `with_source` asks for the playlist the queue came from as well (playlist
/// columns are switched on); the stamp says which was asked, so switching it re-reads.
pub fn read(known: Option<&str>, with_source: bool) -> Result<QueueReply, String> {
    match queue_path() {
        Some(path) => read_from(&path, known, with_source),
        None => Ok(QueueReply::Missing),
    }
}

pub fn read_from(path: &Path, known: Option<&str>, with_source: bool) -> Result<QueueReply, String> {
    let meta = match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => meta,
        Ok(_) => return Ok(QueueReply::Missing),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(QueueReply::Missing)
        }
        Err(error) => return Err(format!("无法读取网易云播放队列：{error}")),
    };
    if meta.len() > MAX_BYTES {
        return Err("网易云播放队列文件过大，已跳过".into());
    }
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |time| time.as_nanos());
    let stamp = format!("{modified}-{}{}", meta.len(), if with_source { "-s" } else { "" });
    if known == Some(stamp.as_str()) {
        return Ok(QueueReply::Unchanged { stamp });
    }
    let bytes = std::fs::read(path).map_err(|error| format!("无法读取网易云播放队列：{error}"))?;
    // NetEase may be rewriting the file; the caller keeps its queue and asks again.
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "网易云播放队列正在更新，稍后重试".to_string())?;
    let (tracks, truncated) = parse(&value);
    Ok(QueueReply::Queue {
        stamp,
        tracks,
        truncated,
        source: if with_source { source(&value) } else { None },
    })
}

/// The playlist the whole queue came from. `None` when the queue is empty, the items name
/// different playlists, or any item has no playlist source (an album, a search, a song
/// added by hand).
fn source(value: &Value) -> Option<QueueSource> {
    let list = value.get("list").and_then(Value::as_array)?;
    let mut found: Option<QueueSource> = None;
    for item in list {
        let next = item_source(item)?;
        match &found {
            None => found = Some(next),
            Some(first) if first.id == next.id => {}
            Some(_) => return None,
        }
    }
    found
}

/// An item counts as coming from a playlist only when its `scene` says so and its `href`
/// names the same playlist as its source record.
fn item_source(item: &Value) -> Option<QueueSource> {
    if item.get("scene").and_then(Value::as_str) != Some("playlist") {
        return None;
    }
    let data = item.get("fromInfo")?.get("sourceData")?;
    let id = text(data.get("id"));
    let linked = item
        .get("href")
        .and_then(Value::as_str)
        .and_then(|href| href.strip_prefix("/playlist/"));
    if !digits(&id) || linked != Some(id.as_str()) {
        return None;
    }
    Some(QueueSource {
        id,
        name: text(data.get("name")),
    })
}

/// Ids of songs and playlists that may be used as keys: plain decimal numbers.
pub(crate) fn digits(id: &str) -> bool {
    (1..=MAX_ID_DIGITS).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_digit())
}

/// Tracks in the order NetEase lists them (`displayOrder`), not its shuffle order.
fn parse(value: &Value) -> (Vec<QueueTrack>, bool) {
    let Some(list) = value.get("list").and_then(Value::as_array) else {
        return (Vec::new(), false);
    };
    let mut items: Vec<(f64, usize, &Value)> = list
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let order = item.get("displayOrder").and_then(Value::as_f64);
            (order.filter(|o| o.is_finite()).unwrap_or(index as f64), index, item)
        })
        .collect();
    items.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let truncated = items.len() > MAX_TRACKS;
    let tracks = items
        .into_iter()
        .take(MAX_TRACKS)
        .filter_map(|(_, _, item)| track(item))
        .collect();
    (tracks, truncated)
}

/// A string or a number as trimmed text of at most `MAX_TEXT` characters; anything else is
/// empty.
pub(crate) fn text(value: Option<&Value>) -> String {
    let text = match value {
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    };
    text.chars().take(MAX_TEXT).collect()
}

fn track(item: &Value) -> Option<QueueTrack> {
    display_track(item.get("track")?)
}

/// The display fields of one of NetEase's song records. The queue file and the local
/// database (`netease_playlists`) store songs in the same shape.
pub(crate) fn display_track(track: &Value) -> Option<QueueTrack> {
    let id = text(track.get("id"));
    let title = text(track.get("name"));
    if id.is_empty() || title.is_empty() {
        return None;
    }
    let artist = track
        .get("artists")
        .and_then(Value::as_array)
        .map(|artists| {
            artists
                .iter()
                .map(|artist| text(artist.get("name")))
                .filter(|name| !name.is_empty())
                .collect::<Vec<_>>()
                .join(" / ")
        })
        .unwrap_or_default();
    let album = track.get("album");
    let album_id = text(album.and_then(|album| album.get("id")));
    Some(QueueTrack {
        id,
        title,
        artist,
        album: text(album.and_then(|album| album.get("name"))),
        album_id: if album_id == "0" { String::new() } else { album_id },
        cover_url: album
            .and_then(|album| album.get("picUrl"))
            .and_then(Value::as_str)
            .and_then(cover),
        duration: track
            .get("duration")
            .and_then(Value::as_f64)
            .filter(|ms| ms.is_finite() && *ms > 0.0)
            .map(|ms| ms / 1000.0),
    })
}

/// Only NetEase's public image hosts (p1.music.126.net, p2…), always over HTTPS.
pub(crate) fn cover(address: &str) -> Option<String> {
    let mut url = url::Url::parse(address).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let image_host = host.strip_suffix(".music.126.net").is_some_and(|name| {
        name.len() >= 2 && name.starts_with('p') && name[1..].chars().all(|c| c.is_ascii_digit())
    });
    if !image_host
        || !matches!(url.scheme(), "http" | "https")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.set_scheme("https").ok()?;
    url.set_query(None);
    url.set_fragment(None);
    Some(url.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(order: f64, id: u64, name: &str, album: Value) -> Value {
        json!({ "displayOrder": order, "randomOrder": 7, "localTrack": { "path": "D:/private/song.flac" },
                "track": { "id": id, "name": name, "duration": 215_000,
                           "artists": [{ "name": "A" }, { "name": " B " }], "album": album } })
    }

    #[test]
    fn queue_follows_display_order_and_keeps_only_display_fields() {
        let value = json!({ "list": [
            item(1.0, 2, "Second", json!({ "id": 0, "name": "", "picUrl": "" })),
            item(0.0, 1, "First", json!({ "id": 9, "name": "Album", "picUrl": "http://p3.music.126.net/abc==/1.jpg?param=40y40" })),
            json!({ "displayOrder": 2, "track": { "id": 3 } }),
        ] });
        let (tracks, truncated) = parse(&value);
        assert!(!truncated);
        assert_eq!(tracks.len(), 2, "entries without a title are skipped");
        assert_eq!(tracks[0].title, "First");
        assert_eq!(tracks[0].artist, "A / B");
        assert_eq!(tracks[0].album_id, "9");
        assert_eq!(tracks[0].cover_url.as_deref(), Some("https://p3.music.126.net/abc==/1.jpg"));
        assert_eq!(tracks[0].duration, Some(215.0));
        assert_eq!(tracks[1].album_id, "", "album id 0 means no album");
        assert_eq!(tracks[1].cover_url, None);
        let serialized = serde_json::to_string(&tracks).unwrap();
        assert!(!serialized.contains("private") && !serialized.contains("randomOrder"));
    }

    #[test]
    fn covers_come_only_from_netease_image_hosts() {
        for address in [
            "https://example.com/1.jpg",
            "https://p3.music.126.net.example.com/1.jpg",
            "https://music.126.net/1.jpg",
            "https://px.music.126.net/1.jpg",
            "https://p3.music.126.net:8443/1.jpg",
            "https://user@p3.music.126.net/1.jpg",
            "file:///C:/cover.jpg",
            "data:image/png;base64,AAAA",
        ] {
            assert_eq!(cover(address), None, "{address}");
        }
        assert_eq!(cover("http://p1.music.126.net/x/2.jpg#a").as_deref(), Some("https://p1.music.126.net/x/2.jpg"));
    }

    #[test]
    fn unchanged_files_are_not_read_again_and_partial_writes_are_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("playingList");
        assert_eq!(read_from(&path, None, true).unwrap(), QueueReply::Missing);
        std::fs::write(&path, serde_json::to_vec(&json!({ "list": [item(0.0, 1, "Song", json!({}))] })).unwrap()).unwrap();
        let QueueReply::Queue { stamp, tracks, source, .. } = read_from(&path, None, true).unwrap() else { panic!() };
        assert_eq!(tracks.len(), 1);
        assert_eq!(source, None, "items without a source record name no playlist");
        assert_eq!(read_from(&path, Some(&stamp), true).unwrap(), QueueReply::Unchanged { stamp: stamp.clone() });
        std::fs::write(&path, b"{\"list\": [").unwrap();
        assert!(read_from(&path, Some(&stamp), true).unwrap_err().contains("正在更新"));
    }

    /// An item as NetEase saves it when the song was queued from a playlist.
    fn queued(order: f64, id: u64, playlist: Value, name: &str) -> Value {
        let mut value = item(order, id, "Song", json!({}));
        value["scene"] = json!("playlist");
        value["href"] = json!(format!("/playlist/{}", text(Some(&playlist))));
        value["fromInfo"] = json!({ "originalScene": "playlist", "originalResourceType": "playlist",
            "sourceData": { "id": playlist, "name": name, "playCount": 4242,
                            "coverImgUrl": "https://p1.music.126.net/source-cover.jpg" } });
        value
    }

    #[test]
    fn source_is_the_playlist_every_item_was_queued_from() {
        let long = format!("  {} ", "n".repeat(MAX_TEXT + 40));
        let value = json!({ "list": [queued(0.0, 1, json!("77"), &long), queued(1.0, 2, json!(77), "Renamed")] });
        let found = source(&value).unwrap();
        assert_eq!(found.id, "77");
        assert_eq!(found.name, "n".repeat(MAX_TEXT), "the name is trimmed like other text");

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("playingList");
        let value = json!({ "list": [queued(0.0, 1, json!("77"), "Mix"), queued(1.0, 2, json!("77"), "Mix")] });
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let reply = read_from(&path, None, true).unwrap();
        let QueueReply::Queue { source: Some(found), .. } = &reply else { panic!() };
        assert_eq!(found, &QueueSource { id: "77".into(), name: "Mix".into() });
        let serialized = serde_json::to_string(&reply).unwrap();
        assert!(serialized.contains(r#""source":{"id":"77","name":"Mix"}"#), "{serialized}");
        // The whole source as returned: its id and name, nothing else of the record. (The
        // stamp holds a time in digits, so the numeric play count is checked on the value.)
        assert_eq!(serde_json::to_value(&reply).unwrap()["source"], json!({ "id": "77", "name": "Mix" }));
        for private in ["source-cover", "playCount", "fromInfo", "href"] {
            assert!(!serialized.contains(private), "{private}");
        }

        // Without playlist columns the source is not returned, and the stamp differs, so
        // switching the columns on or off reads the file again.
        let QueueReply::Queue { stamp: with, .. } = &reply else { panic!() };
        let plain = read_from(&path, None, false).unwrap();
        let QueueReply::Queue { stamp: without, source: None, tracks, .. } = &plain else { panic!("{plain:?}") };
        assert_eq!(tracks.len(), 2);
        assert_ne!(with, without);
        assert!(!serde_json::to_string(&plain).unwrap().contains("source"));
        assert!(matches!(read_from(&path, Some(without), false).unwrap(), QueueReply::Unchanged { .. }));
        assert!(matches!(read_from(&path, Some(without), true).unwrap(), QueueReply::Queue { source: Some(_), .. }));
        assert!(matches!(read_from(&path, Some(with), false).unwrap(), QueueReply::Queue { source: None, .. }));

        std::fs::write(&path, serde_json::to_vec(&json!({ "list": [item(0.0, 1, "Song", json!({}))] })).unwrap()).unwrap();
        let serialized = serde_json::to_string(&read_from(&path, None, true).unwrap()).unwrap();
        assert!(!serialized.contains("source"), "no source, no field: {serialized}");
    }

    #[test]
    fn mixed_or_partial_sources_name_no_playlist() {
        let first = queued(0.0, 1, json!("77"), "Mix");
        for other in [
            queued(1.0, 2, json!("78"), "Other"),
            item(1.0, 2, "Added by hand", json!({})),
        ] {
            assert_eq!(source(&json!({ "list": [first.clone(), other.clone()] })), None);
            assert_eq!(source(&json!({ "list": [other, first.clone()] })), None);
        }
        assert_eq!(source(&json!({ "list": [] })), None);
        assert_eq!(source(&json!({})), None);
    }

    #[test]
    fn items_without_a_valid_playlist_source_name_no_playlist() {
        let change = |edit: &dyn Fn(&mut Value)| {
            let mut value = queued(0.0, 1, json!("77"), "Mix");
            edit(&mut value);
            source(&json!({ "list": [value] }))
        };
        assert!(change(&|_| {}).is_some());
        // Missing fields.
        assert_eq!(change(&|v| { v.as_object_mut().unwrap().remove("scene"); }), None);
        assert_eq!(change(&|v| { v.as_object_mut().unwrap().remove("href"); }), None);
        assert_eq!(change(&|v| { v.as_object_mut().unwrap().remove("fromInfo"); }), None);
        assert_eq!(change(&|v| { v["fromInfo"].as_object_mut().unwrap().remove("sourceData"); }), None);
        assert_eq!(change(&|v| { v["fromInfo"]["sourceData"].as_object_mut().unwrap().remove("id"); }), None);
        assert_eq!(change(&|v| v["fromInfo"]["sourceData"] = json!(null)), None);
        // Sources that are not playlists.
        assert_eq!(change(&|v| v["scene"] = json!("album")), None);
        assert_eq!(change(&|v| v["scene"] = json!(1)), None);
        assert_eq!(change(&|v| v["href"] = json!("/album/77")), None);
        assert_eq!(change(&|v| v["href"] = json!("/playlist/78")), None, "href and source disagree");
        assert_eq!(change(&|v| v["href"] = json!("/playlist/77/extra")), None);
        // Ids that are not plain numbers.
        for id in ["77a", "-77", "7 7", "", "123456789012345678901"] {
            assert_eq!(
                change(&|v| { v["fromInfo"]["sourceData"]["id"] = json!(id); v["href"] = json!(format!("/playlist/{id}")); }),
                None,
                "{id}"
            );
        }
        // A name is not required; the id identifies the playlist.
        let unnamed = change(&|v| { v["fromInfo"]["sourceData"].as_object_mut().unwrap().remove("name"); }).unwrap();
        assert_eq!((unnamed.id.as_str(), unnamed.name.as_str()), ("77", ""));
    }
}
