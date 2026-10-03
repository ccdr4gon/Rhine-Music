//! NetEase Cloud Music saves its current play queue to `webdata/file/playingList` and
//! rewrites the file whenever the queue changes. Only after the user switches this on, read
//! that file and return display fields: song id, title, artists, album (name and id),
//! duration and the album's public cover address.
//! Nothing is written or cached to disk; account data, cookies, play history and the paths
//! of local songs are never read or returned.
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TRACKS: usize = 3000;
const MAX_TEXT: usize = 300;

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
/// read again.
pub fn read(known: Option<&str>) -> Result<QueueReply, String> {
    match queue_path() {
        Some(path) => read_from(&path, known),
        None => Ok(QueueReply::Missing),
    }
}

pub fn read_from(path: &Path, known: Option<&str>) -> Result<QueueReply, String> {
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
    let stamp = format!("{modified}-{}", meta.len());
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
    })
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

fn text(value: Option<&Value>) -> String {
    let text = match value {
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    };
    text.chars().take(MAX_TEXT).collect()
}

fn track(item: &Value) -> Option<QueueTrack> {
    let track = item.get("track")?;
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
fn cover(address: &str) -> Option<String> {
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
        assert_eq!(read_from(&path, None).unwrap(), QueueReply::Missing);
        std::fs::write(&path, serde_json::to_vec(&json!({ "list": [item(0.0, 1, "Song", json!({}))] })).unwrap()).unwrap();
        let QueueReply::Queue { stamp, tracks, .. } = read_from(&path, None).unwrap() else { panic!() };
        assert_eq!(tracks.len(), 1);
        assert_eq!(read_from(&path, Some(&stamp)).unwrap(), QueueReply::Unchanged { stamp: stamp.clone() });
        std::fs::write(&path, b"{\"list\": [").unwrap();
        assert!(read_from(&path, Some(&stamp)).unwrap_err().contains("正在更新"));
    }
}
