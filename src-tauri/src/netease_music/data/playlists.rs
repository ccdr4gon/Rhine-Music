//! NetEase Cloud Music keeps a local SQLite database, `Library/webdb.dat`. Only after the
//! user switches on playlist columns in player-skin mode (which needs NetEase's queue
//! shown), read from it the playlists the user created (the liked-songs playlist included),
//! so that each can be shown as a column.
//! Collected playlists are not read. Exactly this is read:
//!
//! - table `persistentModel`, the one row `async:hostResource`: for each entry of
//!   `data.createPlaylist` its id, name, cover address, song count and liked-songs marker,
//!   and `data.starPlaylistId`. Nothing else in that row is deserialized.
//! - table `playlistTrackIds`, the rows of those playlists: the song ids, in order. NetEase
//!   saves this list only for playlists that were opened on this PC.
//! - table `dbTrack`, the rows of those songs: the display fields the queue reader returns
//!   (song id, title, artists, album name and id, duration, public cover address).
//!
//! The database is opened read-only and without locks, so NetEase's own writes are never
//! blocked. Because no lock is held, a read can meet one of those writes. To notice that,
//! the first 28 bytes of the file, its size and its modified time are compared before and
//! after, and the first eight bytes of its rollback journal (`webdb.dat-journal`) tell
//! whether a write is under way; such a read is repeated or reported as "being updated".
//! The database is not copied, and nothing read is written or cached to disk or logged.
//! Never read: every other table and row (play history, play counts, cached responses,
//! cloud-disk songs, profile pages), a playlist's creator and user fields, the liked-song
//! map, cookies and the embedded browser's storage.
use super::queue::{cover, digits, display_track, text, QueueTrack};
use rusqlite::{types::ValueRef, Connection, OpenFlags, Statement};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// The row with the playlist list.
const MAX_LIST_BYTES: usize = 4 * 1024 * 1024;
/// One playlist's row of song ids.
const MAX_IDS_BYTES: usize = 1024 * 1024;
/// One song's row.
const MAX_TRACK_BYTES: usize = 64 * 1024;
const MAX_PLAYLISTS: usize = 200;
/// Per playlist, the same as the queue.
const MAX_TRACKS: usize = 3000;
/// Across all playlists; later playlists are cut.
const MAX_TOTAL_TRACKS: usize = 12_000;

const HOST_KEY: &str = "async:hostResource";
/// `specialType` of the liked-songs playlist.
const LIKED_SONGS: i64 = 5;

/// NetEase writes the database every few minutes; a read that meets a write is repeated.
const ATTEMPTS: usize = 3;
const RETRY_PAUSE: Duration = Duration::from_millis(60);
/// The first bytes of an SQLite rollback journal while its transaction is open.
const JOURNAL_MAGIC: [u8; 8] = [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7];

const ERR_BUSY: &str = "网易云歌单数据正在更新，稍后重试";
const ERR_FORMAT: &str = "无法识别网易云歌单数据，可能是客户端版本已变化";
const ERR_SIZE: &str = "网易云歌单数据过大，已跳过";
const ERR_OPEN: &str = "无法打开网易云歌单数据";

// `octet_length` and `typeof` need only the row's header, so a payload over the cap is
// never loaded. Every lookup is by primary key.
const SQL_LIST: &str = "SELECT octet_length(jsonStr), \
    CASE WHEN typeof(jsonStr) = 'text' AND octet_length(jsonStr) <= ?2 THEN jsonStr END \
    FROM persistentModel WHERE uniKey = ?1";
const SQL_IDS: &str = "SELECT octet_length(jsonStr), \
    CASE WHEN typeof(jsonStr) = 'text' AND octet_length(jsonStr) <= ?2 THEN jsonStr END \
    FROM playlistTrackIds WHERE id = ?1";
const SQL_TRACK: &str = "SELECT octet_length(jsonStr), \
    CASE WHEN typeof(jsonStr) = 'text' AND octet_length(jsonStr) <= ?2 THEN jsonStr END \
    FROM dbTrack WHERE id = ?1";

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub name: String,
    /// HTTPS address on NetEase's public image server, without a size parameter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_url: Option<String>,
    /// NetEase's own count of the playlist's songs.
    pub track_count: u32,
    /// The liked-songs playlist.
    pub liked: bool,
    /// The songs of the list saved on this PC, in NetEase's order. Empty when NetEase has
    /// saved no list for this playlist here.
    pub tracks: Vec<QueueTrack>,
    /// The saved list names `track_count` songs and every one of them is in `tracks`.
    pub complete: bool,
    /// The saved list is longer than `tracks` because a cap cut it.
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PlaylistsReply {
    /// No database file: NetEase has saved nothing for this Windows user.
    Missing,
    /// The playlists are the same as those identified by `stamp`.
    Unchanged { stamp: String },
    Playlists {
        stamp: String,
        /// The created playlists in the order of NetEase's sidebar.
        playlists: Vec<Playlist>,
        /// There are more than `MAX_PLAYLISTS` playlists, or the cap on songs across all
        /// playlists cut some of them.
        truncated: bool,
    },
}

pub fn database_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(base)
            .join("NetEase")
            .join("CloudMusic")
            .join("Library")
            .join("webdb.dat"),
    )
}

/// `known` is the stamp of the playlists the caller already shows. The stamp follows what
/// was read, not the file's modified time: it identifies the created playlists and their
/// saved song lists, and unchanged ones are not looked up in `dbTrack` again. While a
/// listed song has no usable record, the stamp also says which songs those are, and they
/// are looked up on every call so that they appear once NetEase has saved them.
pub fn read(known: Option<&str>) -> Result<PlaylistsReply, String> {
    match database_path() {
        Some(path) => read_from(&path, known),
        None => Ok(PlaylistsReply::Missing),
    }
}

pub fn read_from(path: &Path, known: Option<&str>) -> Result<PlaylistsReply, String> {
    for attempt in 0..ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(RETRY_PAUSE);
        }
        match attempt_read(path, known) {
            Ok(reply) => return Ok(reply),
            Err(Problem::Busy) => {}
            Err(Problem::Failed(message)) => return Err(message),
        }
    }
    // The caller keeps the playlists it shows and asks again.
    Err(ERR_BUSY.into())
}

enum Problem {
    /// NetEase was writing; the same read may succeed a moment later.
    Busy,
    Failed(String),
}

fn attempt_read(path: &Path, known: Option<&str>) -> Result<PlaylistsReply, Problem> {
    let before = match glance(path)? {
        Glance::Missing => return Ok(PlaylistsReply::Missing),
        Glance::Writing => return Err(Problem::Busy),
        steady => steady,
    };
    // The connection is closed before the second glance.
    let result = open(path).and_then(|database| collect(&database, known));
    // Without locks, a read that overlapped a write may have mixed two states of the
    // database; whatever it returned is discarded.
    if glance(path)? != before {
        return Err(Problem::Busy);
    }
    result
}

/// What tells one saved state of the database from the next.
#[derive(PartialEq)]
enum Glance {
    Missing,
    /// NetEase's rollback journal is open: a write is under way.
    Writing,
    Steady {
        /// SQLite's file change counter (header bytes 24 to 27).
        counter: [u8; 4],
        length: u64,
        modified: Option<SystemTime>,
    },
}

fn glance(path: &Path) -> Result<Glance, Problem> {
    let unreadable = |error: std::io::Error| Problem::Failed(format!("无法读取网易云歌单数据：{error}"));
    let meta = match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => meta,
        Ok(_) => return Ok(Glance::Missing),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Glance::Missing),
        Err(error) => return Err(unreadable(error)),
    };
    if writing(path) {
        return Ok(Glance::Writing);
    }
    let mut header = [0u8; 28];
    match std::fs::File::open(path).and_then(|mut file| file.read_exact(&mut header)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Glance::Missing),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
            return Err(Problem::Failed(ERR_FORMAT.into()))
        }
        Err(error) => return Err(unreadable(error)),
    }
    if &header[..16] != b"SQLite format 3\0" {
        return Err(Problem::Failed(ERR_FORMAT.into()));
    }
    Ok(Glance::Steady {
        counter: [header[24], header[25], header[26], header[27]],
        length: meta.len(),
        modified: meta.modified().ok(),
    })
}

/// Whether SQLite's rollback journal (`webdb.dat-journal`) says that a write is under way:
/// it then starts with `JOURNAL_MAGIC`. A journal left behind by a finished write is empty
/// or starts with zeros. Only these eight bytes of the journal are read.
fn writing(path: &Path) -> bool {
    let mut journal = path.as_os_str().to_owned();
    journal.push("-journal");
    let mut start = [0u8; 8];
    match std::fs::File::open(journal).and_then(|mut file| file.read_exact(&mut start)) {
        Ok(()) => start == JOURNAL_MAGIC,
        // A journal that exists but cannot be opened is being created or deleted.
        Err(error) => !matches!(
            error.kind(),
            std::io::ErrorKind::NotFound | std::io::ErrorKind::UnexpectedEof
        ),
    }
}

/// Read-only and `immutable`: SQLite takes no locks and creates no journal or other file
/// next to NetEase's database.
fn open(path: &Path) -> Result<Connection, Problem> {
    let mut address = url::Url::from_file_path(dunce::simplified(path))
        .map_err(|()| Problem::Failed(ERR_OPEN.into()))?;
    address.set_query(Some("mode=ro&immutable=1"));
    Connection::open_with_flags(
        address.as_str(),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(problem)
}

fn problem(error: rusqlite::Error) -> Problem {
    use rusqlite::ErrorCode::{CannotOpen, DatabaseBusy, DatabaseCorrupt, DatabaseLocked, SystemIoFailure};
    match error.sqlite_error_code() {
        // What a read looks like when pages change under it.
        Some(DatabaseCorrupt | SystemIoFailure | DatabaseBusy | DatabaseLocked) => Problem::Busy,
        Some(CannotOpen) => Problem::Failed(ERR_OPEN.into()),
        // A missing table or column, or a file that is not a database.
        _ => Problem::Failed(ERR_FORMAT.into()),
    }
}

enum Payload {
    /// No such row, or its payload is not text.
    Absent,
    TooLarge,
    Text(Vec<u8>),
}

fn payload(statement: &mut Statement<'_>, key: &str, cap: usize) -> Result<Payload, Problem> {
    let cap = cap as i64;
    let mut rows = statement.query(rusqlite::params![key, cap]).map_err(problem)?;
    let Some(row) = rows.next().map_err(problem)? else {
        return Ok(Payload::Absent);
    };
    let length: Option<i64> = row.get(0).map_err(problem)?;
    Ok(match row.get_ref(1).map_err(problem)? {
        ValueRef::Text(bytes) => Payload::Text(bytes.to_vec()),
        _ if length.is_some_and(|length| length > cap) => Payload::TooLarge,
        _ => Payload::Absent,
    })
}

/// Invalid JSON is what a half-written payload looks like; valid JSON of another shape
/// means NetEase changed its format.
fn parse<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, Problem> {
    serde_json::from_slice(bytes).map_err(|error| match error.classify() {
        serde_json::error::Category::Data => Problem::Failed(ERR_FORMAT.into()),
        _ => Problem::Busy,
    })
}

// Only the fields below are deserialized; serde skips every other key of NetEase's
// records (creator, user id, play count, the liked-song map…) without keeping it.
#[derive(Deserialize)]
struct HostRow {
    #[serde(default)]
    data: Option<HostData>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostData {
    #[serde(default)]
    create_playlist: Option<Vec<RawPlaylist>>,
    #[serde(default)]
    star_playlist_id: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPlaylist {
    #[serde(default)]
    id: Value,
    #[serde(default)]
    name: Value,
    #[serde(default)]
    cover_img_url: Value,
    #[serde(default)]
    track_count: Value,
    #[serde(default)]
    special_type: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawList {
    #[serde(default)]
    track_ids: Option<Vec<RawEntry>>,
}

#[derive(Deserialize)]
struct RawEntry {
    #[serde(default)]
    id: Value,
}

/// A created playlist as listed, before its songs are looked up.
struct Listed {
    id: String,
    name: String,
    cover_url: Option<String>,
    track_count: u32,
    liked: bool,
    local: Local,
}

/// The song list NetEase saved for a playlist on this PC.
enum Local {
    None,
    /// Larger than `MAX_IDS_BYTES`; not loaded.
    Oversized,
    /// `count` songs are listed; `ids` holds the first `MAX_TRACKS` of them.
    List { count: usize, ids: Vec<String> },
}

/// The created playlists in NetEase's order, and whether there are more than
/// `MAX_PLAYLISTS`.
fn created(database: &Connection) -> Result<(Vec<Listed>, bool), Problem> {
    let mut statement = database.prepare(SQL_LIST).map_err(problem)?;
    let bytes = match payload(&mut statement, HOST_KEY, MAX_LIST_BYTES)? {
        Payload::Text(bytes) => bytes,
        Payload::TooLarge => return Err(Problem::Failed(ERR_SIZE.into())),
        // NetEase has not saved a playlist list: nobody has signed in on this PC.
        Payload::Absent => return Ok((Vec::new(), false)),
    };
    let Some(data) = parse::<HostRow>(&bytes)?.data else {
        return Ok((Vec::new(), false));
    };
    let star = text(Some(&data.star_playlist_id));
    let mut seen = HashSet::new();
    let mut listed = Vec::new();
    for raw in data.create_playlist.unwrap_or_default() {
        let id = text(Some(&raw.id));
        if !digits(&id) || !seen.insert(id.clone()) {
            continue;
        }
        if listed.len() == MAX_PLAYLISTS {
            return Ok((listed, true));
        }
        listed.push(Listed {
            name: text(Some(&raw.name)),
            cover_url: raw.cover_img_url.as_str().and_then(cover),
            track_count: raw
                .track_count
                .as_u64()
                .map_or(0, |count| count.min(u64::from(u32::MAX)) as u32),
            liked: raw.special_type.as_i64() == Some(LIKED_SONGS) || id == star,
            local: Local::None,
            id,
        });
    }
    Ok((listed, false))
}

fn local(statement: &mut Statement<'_>, playlist: &str) -> Result<Local, Problem> {
    let bytes = match payload(statement, playlist, MAX_IDS_BYTES)? {
        Payload::Text(bytes) => bytes,
        Payload::TooLarge => return Ok(Local::Oversized),
        Payload::Absent => return Ok(Local::None),
    };
    let entries = parse::<RawList>(&bytes)?.track_ids.unwrap_or_default();
    Ok(Local::List {
        count: entries.len(),
        ids: entries
            .iter()
            .take(MAX_TRACKS)
            .map(|entry| text(Some(&entry.id)))
            .collect(),
    })
}

/// One song's display fields. `None` when the id is not a number, NetEase has not saved the
/// song on this PC, or the saved record cannot be used.
fn resolve(statement: &mut Statement<'_>, id: &str) -> Result<Option<QueueTrack>, Problem> {
    if !digits(id) {
        return Ok(None);
    }
    let Payload::Text(bytes) = payload(statement, id, MAX_TRACK_BYTES)? else {
        return Ok(None);
    };
    let Ok(record) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(None);
    };
    Ok(display_track(&record).filter(|track| track.id == id))
}

/// Identifies the playlists and their saved song lists.
fn content_stamp(listed: &[Listed], more: bool) -> String {
    let mut hasher = Sha256::new();
    let mut field = |text: &str| {
        hasher.update((text.len() as u64).to_le_bytes());
        hasher.update(text.as_bytes());
    };
    field("netease playlists 1");
    for playlist in listed {
        field(&playlist.id);
        field(&playlist.name);
        field(playlist.cover_url.as_deref().unwrap_or(""));
        field(&playlist.track_count.to_string());
        field(if playlist.liked { "liked" } else { "" });
        match &playlist.local {
            Local::None => field("no list"),
            Local::Oversized => field("oversized"),
            Local::List { count, ids } => {
                field(&count.to_string());
                field(&ids.len().to_string());
                ids.iter().for_each(|id| field(id));
            }
        }
    }
    field(if more { "more" } else { "end" });
    format!("{:x}", hasher.finalize())
}

fn collect(database: &Connection, known: Option<&str>) -> Result<PlaylistsReply, Problem> {
    let (mut listed, more) = created(database)?;
    let mut statement = database.prepare(SQL_IDS).map_err(problem)?;
    for playlist in &mut listed {
        playlist.local = local(&mut statement, &playlist.id)?;
    }
    let content = content_stamp(&listed, more);
    if known == Some(content.as_str()) {
        return Ok(PlaylistsReply::Unchanged { stamp: content });
    }

    let mut statement = database.prepare(SQL_TRACK).map_err(problem)?;
    let mut budget = MAX_TOTAL_TRACKS;
    let mut truncated = more;
    let mut unresolved = Sha256::new();
    let mut gaps = false;
    let mut playlists = Vec::with_capacity(listed.len());
    for item in listed {
        let mut playlist = Playlist {
            id: item.id,
            name: item.name,
            cover_url: item.cover_url,
            track_count: item.track_count,
            liked: item.liked,
            tracks: Vec::new(),
            complete: false,
            truncated: false,
        };
        match item.local {
            Local::None => {}
            Local::Oversized => playlist.truncated = true,
            Local::List { count, ids } => {
                let take = ids.len().min(budget);
                budget -= take;
                truncated |= take < ids.len();
                playlist.truncated = take < count;
                for id in &ids[..take] {
                    match resolve(&mut statement, id)? {
                        Some(track) => playlist.tracks.push(track),
                        None => {
                            gaps = true;
                            unresolved.update(format!("{}/{id}\n", playlist.id));
                        }
                    }
                }
                playlist.complete =
                    count == playlist.track_count as usize && playlist.tracks.len() == count;
            }
        }
        playlists.push(playlist);
    }
    // A listed song without a usable record may get one later without the list changing.
    // Such a reply gets a stamp of its own, so that the songs are looked up again.
    let stamp = if gaps {
        format!("{content}+{}", &format!("{:x}", unresolved.finalize())[..16])
    } else {
        content
    };
    if known == Some(stamp.as_str()) {
        return Ok(PlaylistsReply::Unchanged { stamp });
    }
    Ok(PlaylistsReply::Playlists {
        stamp,
        playlists,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SCHEMA: &str = "
        PRAGMA page_size = 1024;
        CREATE TABLE persistentModel (time BIGINT, clearTime BIGINT, uniKey VARCHAR(40) NOT NULL PRIMARY KEY, jsonStr TEXT);
        CREATE TABLE playlistTrackIds (id VARCHAR(40) NOT NULL PRIMARY KEY, jsonStr TEXT);
        CREATE TABLE dbTrack (id VARCHAR(40) NOT NULL PRIMARY KEY, jsonStr TEXT);
        CREATE TABLE historyTracks (id VARCHAR(40) NOT NULL PRIMARY KEY, jsonStr TEXT);
    ";

    /// A synthetic database with NetEase's tables and columns.
    struct Fixture {
        dir: tempfile::TempDir,
        path: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("webdb.dat");
            let fixture = Self { dir, path };
            fixture.edit(|database| database.execute_batch(SCHEMA).unwrap());
            fixture
        }

        /// Writes like NetEase would, and closes the connection before returning.
        fn edit(&self, change: impl FnOnce(&Connection)) {
            let database = Connection::open(&self.path).unwrap();
            change(&database);
        }

        fn put(&self, table: &str, key_column: &str, key: &str, payload: &str) {
            self.edit(|database| {
                database
                    .execute(
                        &format!("INSERT OR REPLACE INTO {table} ({key_column}, jsonStr) VALUES (?1, ?2)"),
                        [key, payload],
                    )
                    .unwrap();
            });
        }

        /// The row of playlists, with the account fields NetEase stores beside them.
        fn playlists(&self, created: Value, collected: Value, star: &str) {
            let row = json!({
                "uniKey": HOST_KEY, "namespace": "async", "strategy": "s", "time": 1, "expireTime": 2, "clearTime": 3,
                "data": {
                    "createPlaylist": created, "favPlaylist": collected, "starPlaylistId": star,
                    "likeTrackIds": ["900001", "900002"], "likeTracksMap": { "900001": true },
                    "favPlaylistIdsMap": { "40": true }, "voicePlayRecordMap": { "PRIVATE-VOICE": 1 },
                },
            });
            self.put("persistentModel", "uniKey", HOST_KEY, &row.to_string());
        }

        fn list(&self, playlist: &str, ids: &[&str]) {
            let entries: Vec<Value> = ids.iter().map(|id| json!({ "id": id, "v": 3 })).collect();
            let row = json!({ "id": playlist, "trackIds": entries, "updateTime": 1_700_000_000_000u64 });
            self.put("playlistTrackIds", "id", playlist, &row.to_string());
        }

        fn track(&self, id: &str, title: &str) {
            self.put("dbTrack", "id", id, &song(id, title).to_string());
        }

        fn read(&self, known: Option<&str>) -> Result<PlaylistsReply, String> {
            read_from(&self.path, known)
        }

        fn playlists_read(&self) -> (String, Vec<Playlist>, bool) {
            match self.read(None).unwrap() {
                PlaylistsReply::Playlists { stamp, playlists, truncated } => (stamp, playlists, truncated),
                other => panic!("{other:?}"),
            }
        }

        fn files(&self) -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(self.dir.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        }
    }

    fn playlist(id: Value, name: &str, count: u32) -> Value {
        json!({
            "id": id, "name": name, "trackCount": count, "specialType": null, "subscribed": false, "privacy": 0,
            "coverImgUrl": format!("http://p1.music.126.net/list-{}.jpg?param=40y40", text(Some(&id))),
            "updateTime": 1_700_000_000_000u64, "createTime": 1_600_000_000_000u64, "userId": 424242, "playCount": 31337,
            "description": "PRIVATE-DESCRIPTION", "tags": ["PRIVATE-TAG"],
            "creator": { "nickname": "PRIVATE-NICK", "userId": 424242, "signature": "PRIVATE-SIGNATURE",
                         "avatarUrl": "https://p1.music.126.net/private-avatar.jpg" },
        })
    }

    fn song(id: &str, title: &str) -> Value {
        json!({
            "id": id, "name": title, "duration": 215_000, "fee": 8, "privilege": { "PRIVATE-PRIVILEGE": 1 },
            "artists": [{ "id": "1", "name": "A" }, { "id": "2", "name": " B " }],
            "album": { "id": "9", "name": "Album", "albumName": "Album", "picId": "5",
                       "picUrl": "http://p3.music.126.net/abc==/1.jpg?param=40y40" },
        })
    }

    fn ids(playlists: &[Playlist]) -> Vec<&str> {
        playlists.iter().map(|playlist| playlist.id.as_str()).collect()
    }

    fn titles(playlist: &Playlist) -> Vec<&str> {
        playlist.tracks.iter().map(|track| track.title.as_str()).collect()
    }

    #[test]
    fn created_playlists_keep_their_order_and_collected_ones_are_ignored() {
        let fixture = Fixture::new();
        let mut liked = playlist(json!("10"), "Liked", 2);
        liked["specialType"] = json!(5);
        fixture.playlists(
            json!([liked, playlist(json!("30"), "Second", 2), playlist(json!("20"), "Third", 4)]),
            json!([playlist(json!("40"), "Collected", 1)]),
            "10",
        );
        fixture.list("10", &["1", "2"]);
        fixture.list("30", &["3", "2"]);
        fixture.list("40", &["1"]);
        fixture.list("dailyRecommend:424242", &["1"]);
        for (id, title) in [("1", "One"), ("2", "Two"), ("3", "Three")] {
            fixture.track(id, title);
        }

        let (stamp, playlists, truncated) = fixture.playlists_read();
        assert!(!stamp.is_empty() && !truncated);
        assert_eq!(ids(&playlists), ["10", "30", "20"], "NetEase's order, created only");
        assert_eq!(playlists.iter().map(|p| p.liked).collect::<Vec<_>>(), [true, false, false]);
        assert_eq!(playlists[1].name, "Second");
        assert_eq!(playlists[1].cover_url.as_deref(), Some("https://p1.music.126.net/list-30.jpg"));
        assert_eq!(playlists[2].track_count, 4);
        assert_eq!(titles(&playlists[0]), ["One", "Two"]);
        assert_eq!(titles(&playlists[1]), ["Three", "Two"], "the saved list's order");
        assert!(playlists[0].complete && playlists[1].complete);
        assert!(!playlists[0].truncated);

        // No list on this PC: returned without songs.
        assert!(playlists[2].tracks.is_empty());
        assert!(!playlists[2].complete && !playlists[2].truncated);

        // Songs are mapped exactly as the queue reader maps them.
        let queue_track = display_track(&song("3", "Three")).unwrap();
        assert_eq!(playlists[1].tracks[0], queue_track);
        assert_eq!(queue_track.artist, "A / B");
        assert_eq!(queue_track.cover_url.as_deref(), Some("https://p3.music.126.net/abc==/1.jpg"));
        assert_eq!(queue_track.duration, Some(215.0));
    }

    #[test]
    fn the_liked_playlist_is_marked_by_either_field() {
        let fixture = Fixture::new();
        let mut special = playlist(json!("12"), "By type", 0);
        special["specialType"] = json!(5);
        fixture.playlists(json!([playlist(json!("11"), "By star id", 0), special, playlist(json!("13"), "Plain", 0)]), json!([]), "11");
        let (_, playlists, _) = fixture.playlists_read();
        assert_eq!(playlists.iter().map(|p| p.liked).collect::<Vec<_>>(), [true, true, false]);
    }

    #[test]
    fn replies_carry_no_account_fields() {
        let fixture = Fixture::new();
        fixture.playlists(json!([playlist(json!("10"), "Mine", 1)]), json!([playlist(json!("40"), "Collected", 1)]), "10");
        fixture.list("10", &["1"]);
        fixture.track("1", "One");
        fixture.put("persistentModel", "uniKey", "host", r#"{"data":{"PRIVATE-HOST":"PRIVATE-ACCOUNT"}}"#);
        fixture.put("persistentModel", "uniKey", "page:userDetail", r#"{"data":{"nickname":"PRIVATE-PROFILE"}}"#);
        fixture.put("historyTracks", "id", "1", r#"{"id":"1","name":"PRIVATE-HISTORY"}"#);

        let reply = fixture.read(None).unwrap();
        let serialized = serde_json::to_string(&reply).unwrap();
        for private in [
            "creator", "nickname", "userId", "likeTrackIds", "likeTracksMap", "favPlaylist", "PRIVATE",
            "424242", "31337", "900001", "Collected", "description", "tags", "privilege", "fee",
        ] {
            assert!(!serialized.contains(private), "{private} in {serialized}");
        }
        let expected = json!({
            "status": "playlists",
            "stamp": match &reply { PlaylistsReply::Playlists { stamp, .. } => stamp.clone(), other => panic!("{other:?}") },
            "truncated": false,
            "playlists": [{
                "id": "10", "name": "Mine", "coverUrl": "https://p1.music.126.net/list-10.jpg",
                "trackCount": 1, "liked": true, "complete": true, "truncated": false,
                "tracks": [{ "id": "1", "title": "One", "artist": "A / B", "album": "Album", "albumId": "9",
                             "coverUrl": "https://p3.music.126.net/abc==/1.jpg", "duration": 215.0 }],
            }],
        });
        assert_eq!(serde_json::to_value(&reply).unwrap(), expected);
        assert_eq!(serde_json::to_value(PlaylistsReply::Missing).unwrap(), json!({ "status": "missing" }));
        assert_eq!(
            serde_json::to_value(PlaylistsReply::Unchanged { stamp: "s".into() }).unwrap(),
            json!({ "status": "unchanged", "stamp": "s" })
        );
    }

    #[test]
    fn songs_without_a_usable_record_are_skipped_and_leave_the_playlist_incomplete() {
        let fixture = Fixture::new();
        fixture.playlists(
            json!([playlist(json!("10"), "Gaps", 8), playlist(json!("20"), "Short list", 3)]),
            json!([]),
            "",
        );
        fixture.list("10", &["1", "2", "3", "4", "5", "6", "7", "8"]);
        fixture.list("20", &["1", "8"]);
        fixture.track("1", "One");
        // 2 has no record at all.
        fixture.put("dbTrack", "id", "3", r#"{"id":"3","duration":1000}"#); // no title
        fixture.put("dbTrack", "id", "4", r#"{"id":"4","name":"Cut off"#); // not JSON
        fixture.put("dbTrack", "id", "5", &song("55", "Another song's record").to_string());
        fixture.edit(|database| {
            database.execute("INSERT INTO dbTrack (id, jsonStr) VALUES ('6', NULL)", []).unwrap();
            database.execute("INSERT INTO dbTrack (id, jsonStr) VALUES ('7', x'7b7d')", []).unwrap();
        });
        fixture.track("8", "Eight");

        let (stamp, playlists, truncated) = fixture.playlists_read();
        assert_eq!(titles(&playlists[0]), ["One", "Eight"]);
        assert!(!playlists[0].complete && !playlists[0].truncated && !truncated);
        // Every listed song resolved, but NetEase counts three songs and the saved list has two.
        assert_eq!(titles(&playlists[1]), ["One", "Eight"]);
        assert!(!playlists[1].complete);

        // The same gaps: nothing new to show.
        assert_eq!(fixture.read(Some(&stamp)).unwrap(), PlaylistsReply::Unchanged { stamp: stamp.clone() });
        // NetEase saves a missing song later, without touching the list.
        fixture.track("2", "Two");
        let PlaylistsReply::Playlists { stamp: next, playlists, .. } = fixture.read(Some(&stamp)).unwrap() else { panic!() };
        assert_ne!(next, stamp);
        assert_eq!(titles(&playlists[0]), ["One", "Two", "Eight"]);

        for (id, title) in [("3", "Three"), ("4", "Four"), ("5", "Five"), ("6", "Six"), ("7", "Seven")] {
            fixture.track(id, title);
        }
        let (_, playlists, _) = fixture.playlists_read();
        assert_eq!(playlists[0].tracks.len(), 8);
        assert!(playlists[0].complete);
    }

    #[test]
    fn ids_that_are_not_plain_numbers_are_rejected() {
        let fixture = Fixture::new();
        fixture.playlists(
            json!([
                playlist(json!("12a"), "Letters", 0),
                playlist(json!(""), "Empty", 0),
                playlist(json!(-5), "Negative", 0),
                playlist(json!(1.5), "Fraction", 0),
                playlist(json!({ "x": 1 }), "Object", 0),
                playlist(json!("dailyRecommend:1"), "Other key", 0),
                playlist(json!("123456789012345678901"), "Too long", 0),
                playlist(json!(15), "Number", 3),
                playlist(json!("15"), "Duplicate", 3),
                playlist(json!("16"), "Text", 0),
            ]),
            json!([]),
            "",
        );
        fixture.list("15", &["1", "7x", "../8"]);
        fixture.list("dailyRecommend:1", &["1"]);
        fixture.track("1", "One");
        fixture.track("7x", "Not a number");
        fixture.track("../8", "Not a number either");

        let (_, playlists, _) = fixture.playlists_read();
        assert_eq!(ids(&playlists), ["15", "16"]);
        assert_eq!(playlists[0].name, "Number", "the first entry with an id wins");
        assert_eq!(titles(&playlists[0]), ["One"]);
        assert!(!playlists[0].complete);
    }

    #[test]
    fn long_lists_are_cut_per_playlist_and_across_playlists() {
        let fixture = Fixture::new();
        let names: Vec<String> = (1..=MAX_TRACKS + 100).map(|number| number.to_string()).collect();
        fixture.edit(|database| {
            database.execute_batch("BEGIN").unwrap();
            let mut insert = database.prepare("INSERT INTO dbTrack (id, jsonStr) VALUES (?1, ?2)").unwrap();
            for name in &names {
                insert.execute([name, &song(name, "Song").to_string()]).unwrap();
            }
            drop(insert);
            database.execute_batch("COMMIT").unwrap();
        });
        let all: Vec<&str> = names.iter().map(String::as_str).collect();
        let long = (MAX_TRACKS + 100) as u32;
        let full = MAX_TRACKS as u32;

        // One list over the per-playlist cap, well under the total.
        fixture.playlists(json!([playlist(json!("1"), "Long", long), playlist(json!("2"), "Short", 2)]), json!([]), "");
        fixture.list("1", &all);
        fixture.list("2", &all[..2]);
        let (_, playlists, truncated) = fixture.playlists_read();
        assert_eq!(playlists[0].tracks.len(), MAX_TRACKS);
        assert!(playlists[0].truncated && !playlists[0].complete);
        assert_eq!(playlists[0].tracks.last().unwrap().id, MAX_TRACKS.to_string(), "the first songs are kept");
        assert!(playlists[1].complete && !playlists[1].truncated);
        assert!(!truncated, "no playlist lost songs to the total cap");

        // Five lists that together pass the total cap.
        fixture.playlists(
            json!([
                playlist(json!("1"), "Long", long),
                playlist(json!("2"), "Full", full),
                playlist(json!("3"), "Full", full),
                playlist(json!("4"), "Nearly full", full - 10),
                playlist(json!("5"), "Cut", full),
                playlist(json!("6"), "Nothing left", full),
                playlist(json!("7"), "No list", 5),
            ]),
            json!([]),
            "",
        );
        for id in ["2", "3", "5", "6"] {
            fixture.list(id, &all[..MAX_TRACKS]);
        }
        fixture.list("4", &all[..MAX_TRACKS - 10]);
        let (_, playlists, truncated) = fixture.playlists_read();
        let counts: Vec<usize> = playlists.iter().map(|playlist| playlist.tracks.len()).collect();
        assert_eq!(counts, [MAX_TRACKS, MAX_TRACKS, MAX_TRACKS, MAX_TRACKS - 10, 10, 0, 0]);
        assert_eq!(counts.iter().sum::<usize>(), MAX_TOTAL_TRACKS);
        assert_eq!(
            playlists.iter().map(|playlist| playlist.truncated).collect::<Vec<_>>(),
            [true, false, false, false, true, true, false]
        );
        assert_eq!(
            playlists.iter().map(|playlist| playlist.complete).collect::<Vec<_>>(),
            [false, true, true, true, false, false, false]
        );
        assert!(truncated);
    }

    #[test]
    fn at_most_two_hundred_playlists_are_listed() {
        let fixture = Fixture::new();
        let entries = |count: usize| -> Value {
            (1..=count).map(|number| playlist(json!(number.to_string()), "Playlist", 0)).collect::<Vec<_>>().into()
        };
        fixture.playlists(entries(MAX_PLAYLISTS), json!([]), "");
        let (_, playlists, truncated) = fixture.playlists_read();
        assert_eq!(playlists.len(), MAX_PLAYLISTS);
        assert!(!truncated);

        fixture.playlists(entries(MAX_PLAYLISTS + 5), json!([]), "");
        let (_, playlists, truncated) = fixture.playlists_read();
        assert_eq!(playlists.len(), MAX_PLAYLISTS);
        assert_eq!(playlists.last().unwrap().id, MAX_PLAYLISTS.to_string());
        assert!(truncated);
    }

    #[test]
    fn oversized_payloads_are_not_loaded() {
        let fixture = Fixture::new();
        fixture.playlists(json!([playlist(json!("10"), "Songs", 2), playlist(json!("20"), "Huge list", 1)]), json!([]), "");
        fixture.list("10", &["1", "2"]);
        fixture.track("1", "One");
        let mut huge = song("2", "Two");
        huge["padding"] = json!("x".repeat(MAX_TRACK_BYTES));
        fixture.put("dbTrack", "id", "2", &huge.to_string());
        let row = json!({ "id": "20", "trackIds": [{ "id": "1" }], "padding": "x".repeat(MAX_IDS_BYTES) });
        fixture.put("playlistTrackIds", "id", "20", &row.to_string());

        let (_, playlists, truncated) = fixture.playlists_read();
        assert_eq!(titles(&playlists[0]), ["One"]);
        assert!(!playlists[0].complete);
        assert!(playlists[1].tracks.is_empty());
        assert!(playlists[1].truncated && !playlists[1].complete && !truncated);

        // A payload exactly at the cap is still read.
        let pad = MAX_TRACK_BYTES - song("2", "Two").to_string().len() - r#","padding":"""#.len();
        let mut exact = song("2", "Two");
        exact["padding"] = json!("x".repeat(pad));
        assert_eq!(exact.to_string().len(), MAX_TRACK_BYTES);
        fixture.put("dbTrack", "id", "2", &exact.to_string());
        let (_, playlists, _) = fixture.playlists_read();
        assert_eq!(titles(&playlists[0]), ["One", "Two"]);

        let row = json!({ "data": { "createPlaylist": [playlist(json!("10"), "Songs", 2)] }, "padding": "x".repeat(MAX_LIST_BYTES) });
        fixture.put("persistentModel", "uniKey", HOST_KEY, &row.to_string());
        assert!(fixture.read(None).unwrap_err().contains("过大"));
    }

    #[test]
    fn names_and_covers_pass_the_queue_readers_filters() {
        let fixture = Fixture::new();
        let mut padded = playlist(json!("10"), &format!("  {}  ", "名".repeat(400)), 1);
        padded["coverImgUrl"] = json!("https://example.com/list.jpg");
        let mut numbered = playlist(json!("20"), "", 0);
        numbered["name"] = json!(2024);
        numbered["coverImgUrl"] = json!("https://p2.music.126.net/x/list.jpg#fragment");
        let mut unnamed = playlist(json!("30"), "", 0);
        unnamed["coverImgUrl"] = json!(null);
        unnamed["trackCount"] = json!("many");
        fixture.playlists(json!([padded, numbered, unnamed]), json!([]), "");
        fixture.list("10", &["1"]);
        fixture.track("1", &format!(" {} ", "t".repeat(400)));

        let (_, playlists, _) = fixture.playlists_read();
        assert_eq!(playlists[0].name, "名".repeat(300), "trimmed, then cut at the queue reader's length");
        assert_eq!(playlists[0].cover_url, None, "not one of NetEase's image hosts");
        assert_eq!(playlists[0].tracks[0].title, "t".repeat(300));
        assert_eq!(playlists[1].name, "2024");
        assert_eq!(playlists[1].cover_url.as_deref(), Some("https://p2.music.126.net/x/list.jpg"));
        assert_eq!((playlists[2].name.as_str(), playlists[2].track_count), ("", 0));
        assert_eq!(playlists[2].cover_url, None);
        let serialized = serde_json::to_string(&playlists[2]).unwrap();
        assert!(!serialized.contains("coverUrl"), "no cover, no field: {serialized}");
    }

    #[test]
    fn the_stamp_follows_the_content_and_not_the_file() {
        let fixture = Fixture::new();
        fixture.playlists(json!([playlist(json!("10"), "Mine", 2), playlist(json!("20"), "Other", 0)]), json!([]), "10");
        fixture.list("10", &["1", "2"]);
        fixture.track("1", "One");
        fixture.track("2", "Two");
        fixture.track("3", "Three");
        let (stamp, _, _) = fixture.playlists_read();
        let unchanged = PlaylistsReply::Unchanged { stamp: stamp.clone() };
        assert_eq!(fixture.read(Some(&stamp)).unwrap(), unchanged);
        assert_eq!(fixture.playlists_read().0, stamp, "the same content gives the same stamp");

        // NetEase rewrites other rows and tables all the time.
        let before = std::fs::metadata(&fixture.path).unwrap().len();
        fixture.put("historyTracks", "id", "1", &"h".repeat(50_000));
        fixture.put("persistentModel", "uniKey", "page:playlist", r#"{"data":{}}"#);
        fixture.list("dailyRecommend:1", &["3"]);
        assert_ne!(std::fs::metadata(&fixture.path).unwrap().len(), before);
        assert_eq!(fixture.read(Some(&stamp)).unwrap(), unchanged);

        // An unchanged stamp is answered without looking up any song.
        fixture.edit(|database| database.execute_batch("ALTER TABLE dbTrack RENAME TO parked").unwrap());
        assert_eq!(fixture.read(Some(&stamp)).unwrap(), unchanged);
        assert!(fixture.read(None).unwrap_err().contains("无法识别"));
        fixture.edit(|database| database.execute_batch("ALTER TABLE parked RENAME TO dbTrack").unwrap());

        // A list changes.
        fixture.list("10", &["1", "2", "3"]);
        let PlaylistsReply::Playlists { stamp: second, playlists, .. } = fixture.read(Some(&stamp)).unwrap() else { panic!() };
        assert_ne!(second, stamp);
        assert_eq!(titles(&playlists[0]), ["One", "Two", "Three"]);
        // A playlist that had no list gets one.
        fixture.list("20", &[]);
        let PlaylistsReply::Playlists { stamp: third, playlists, .. } = fixture.read(Some(&second)).unwrap() else { panic!() };
        assert_ne!(third, second);
        assert!(playlists[1].complete, "an empty playlist with an empty saved list");
        // A playlist is renamed.
        fixture.playlists(json!([playlist(json!("10"), "Renamed", 3), playlist(json!("20"), "Other", 0)]), json!([]), "10");
        let PlaylistsReply::Playlists { stamp: fourth, playlists, .. } = fixture.read(Some(&third)).unwrap() else { panic!() };
        assert_ne!(fourth, third);
        assert_eq!(playlists[0].name, "Renamed");
        assert!(playlists[0].complete);
        // The stamp of an older state no longer matches.
        assert!(matches!(fixture.read(Some(&stamp)).unwrap(), PlaylistsReply::Playlists { .. }));
    }

    #[test]
    fn a_missing_database_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_from(&dir.path().join("webdb.dat"), None).unwrap(), PlaylistsReply::Missing);
        assert_eq!(read_from(&dir.path().join("Library").join("webdb.dat"), Some("stamp")).unwrap(), PlaylistsReply::Missing);
        assert_eq!(read_from(dir.path(), None).unwrap(), PlaylistsReply::Missing, "a folder is not a database");
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none(), "nothing is created");
    }

    #[test]
    fn a_database_without_saved_playlists_lists_none() {
        let fixture = Fixture::new();
        let (stamp, playlists, truncated) = fixture.playlists_read();
        assert!(playlists.is_empty() && !truncated);
        assert_eq!(fixture.read(Some(&stamp)).unwrap(), PlaylistsReply::Unchanged { stamp });
        for row in [r#"{}"#, r#"{"data":null}"#, r#"{"data":{}}"#, r#"{"data":{"createPlaylist":null}}"#, r#"{"data":{"createPlaylist":[]}}"#] {
            fixture.put("persistentModel", "uniKey", HOST_KEY, row);
            assert!(fixture.playlists_read().1.is_empty(), "{row}");
        }
        fixture.edit(|database| {
            database.execute("UPDATE persistentModel SET jsonStr = NULL", []).unwrap();
        });
        assert!(fixture.playlists_read().1.is_empty());
    }

    #[test]
    fn half_written_and_unknown_content_are_errors() {
        let fixture = Fixture::new();
        // Payloads that are not valid JSON: NetEase may be writing them.
        fixture.put("persistentModel", "uniKey", HOST_KEY, r#"{"data":{"createPlaylist":[{"id":"10","na"#);
        assert!(fixture.read(None).unwrap_err().contains("正在更新"));
        fixture.playlists(json!([playlist(json!("10"), "Mine", 1)]), json!([]), "");
        fixture.put("playlistTrackIds", "id", "10", r#"{"id":"10","trackIds":[{"id":"1"},"#);
        assert!(fixture.read(None).unwrap_err().contains("正在更新"));

        // Valid JSON in a shape this reader does not know.
        fixture.put("playlistTrackIds", "id", "10", r#"{"id":"10","trackIds":"1,2,3"}"#);
        assert!(fixture.read(None).unwrap_err().contains("无法识别"));
        fixture.list("10", &["1"]);
        fixture.put("persistentModel", "uniKey", HOST_KEY, r#"{"data":{"createPlaylist":{"10":{}}}}"#);
        assert!(fixture.read(None).unwrap_err().contains("无法识别"));

        // Another schema, and files that are not databases.
        fixture.edit(|database| database.execute_batch("DROP TABLE playlistTrackIds").unwrap());
        fixture.playlists(json!([playlist(json!("10"), "Mine", 1)]), json!([]), "");
        assert!(fixture.read(None).unwrap_err().contains("无法识别"));
        std::fs::write(&fixture.path, "not a database, but longer than a header").unwrap();
        assert!(fixture.read(None).unwrap_err().contains("无法识别"));
        std::fs::write(&fixture.path, "short").unwrap();
        assert!(fixture.read(None).unwrap_err().contains("无法识别"));
    }

    #[test]
    fn a_write_in_progress_is_reported_as_busy() {
        let fixture = Fixture::new();
        fixture.playlists(json!([playlist(json!("10"), "Mine", 0)]), json!([]), "");
        let journal = fixture.dir.path().join("webdb.dat-journal");
        let open = [JOURNAL_MAGIC.as_slice(), &[0u8; 504]].concat();
        std::fs::write(&journal, &open).unwrap();
        assert!(fixture.read(None).unwrap_err().contains("正在更新"));
        assert_eq!(std::fs::read(&journal).unwrap(), open, "the journal is NetEase's; it is left alone");

        // Journals that a finished write left behind do not block reading.
        for finished in [vec![0u8; 512], Vec::new(), b"short".to_vec()] {
            std::fs::write(&journal, &finished).unwrap();
            assert_eq!(fixture.playlists_read().1.len(), 1);
        }
        std::fs::remove_file(&journal).unwrap();
        assert_eq!(fixture.playlists_read().1.len(), 1);

        // A write that finished during a read shows in what is compared around the read.
        let Ok(before) = glance(&fixture.path) else { panic!() };
        fixture.put("historyTracks", "id", "1", "{}");
        let Ok(after) = glance(&fixture.path) else { panic!() };
        assert!(before != after);
        let Ok(again) = glance(&fixture.path) else { panic!() };
        assert!(after == again);
    }

    #[test]
    fn folder_names_with_spaces_and_other_scripts_can_be_opened() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("用户 名 #1 100% & co").join("Library");
        std::fs::create_dir_all(&folder).unwrap();
        let fixture = Fixture::new();
        fixture.playlists(json!([playlist(json!("10"), "Mine", 0)]), json!([]), "");
        let path = folder.join("webdb.dat");
        std::fs::copy(&fixture.path, &path).unwrap();
        let PlaylistsReply::Playlists { playlists, .. } = read_from(&path, None).unwrap() else { panic!() };
        assert_eq!(ids(&playlists), ["10"]);
    }

    #[test]
    fn reading_creates_no_file_and_leaves_the_database_unchanged() {
        let fixture = Fixture::new();
        fixture.playlists(json!([playlist(json!("10"), "Mine", 2), playlist(json!("20"), "Other", 1)]), json!([]), "10");
        fixture.list("10", &["1", "2"]);
        fixture.track("1", "One");
        let files = fixture.files();
        assert_eq!(files, ["webdb.dat"]);
        let bytes = std::fs::read(&fixture.path).unwrap();
        let modified = std::fs::metadata(&fixture.path).unwrap().modified().unwrap();

        let (stamp, _, _) = fixture.playlists_read();
        fixture.read(Some(&stamp)).unwrap();
        fixture.read(Some("another stamp")).unwrap();

        assert_eq!(fixture.files(), files, "no journal, no -wal or -shm, no copy");
        assert!(std::fs::read(&fixture.path).unwrap() == bytes, "the database's bytes changed");
        assert_eq!(std::fs::metadata(&fixture.path).unwrap().modified().unwrap(), modified);
    }
}
