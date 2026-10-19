//! Jump to an exact song of NetEase Cloud Music's play queue through the Chrome DevTools
//! port NetEase serves when it is started with `--remote-debugging-port=9233`. Used while
//! the user shows NetEase's queue. Connections go to 127.0.0.1 only. The scripts run in
//! NetEase's player page read, from its Redux store, the current song id, playback state,
//! play mode, duration, trial-clip range, pending seek target, whether the song is loaded
//! (play-session id, first-load flag, launch-restore record) and the queue entries' song
//! ids, and the playback position from its progress slider; and, for the song it plays, the
//! lyrics it has loaded (each line's time and text, their translation, and its word-timed
//! lyrics when it has them; the owner, 2026-10-17). They dispatch only the four actions
//! NetEase's own interface dispatches: play a queue entry (its queue panel), seek in the
//! current song (its progress slider), play one of the user's playlists from one of its songs
//! (its 播放全部, which replaces the queue with the playlist; the owner, 2026-10-10), and load
//! the lyrics of the song it plays (what its playing page does when it opens, from its cache
//! or its server; the owner, 2026-10-17). Cookies, storage and account state are never read,
//! and nothing is stored in the page.
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tungstenite::{client::client_with_config, protocol::WebSocketConfig, Message};

pub const PORT: u16 = 9233;

const PAGE_URL: &str = "orpheus://orpheus/pub/app.html";
const MAX_BYTES: usize = 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// `state` is polled every second.
const STATE_BUDGET: Duration = Duration::from_millis(1500);
/// NetEase answers the jump's evaluate call after about 550 ms.
const PLAY_BUDGET: Duration = Duration::from_secs(5);
/// Read once for a song (and a few times while NetEase loads them).
const LYRICS_BUDGET: Duration = Duration::from_secs(3);

const ERR_PORT: &str = "未检测到网易云调试端口（9233），请以调试端口启动网易云";
const ERR_MISSING: &str = "这首歌已不在网易云的播放队列中";
const ERR_FM: &str = "私人 FM 模式下不能切换到队列歌曲";
const ERR_STORE: &str = "无法找到网易云的播放状态，可能是客户端版本已变化";
const ERR_PROTOCOL: &str = "网易云调试端口返回了无法识别的内容";
const ERR_ID: &str = "无效的歌曲编号";
const ERR_POSITION: &str = "无效的播放位置";
const ERR_CHANGED: &str = "网易云已经换歌，没有调整进度";
const ERR_NOT_LOADED: &str = "这首歌还没有加载，暂时不能调整进度";
const ERR_PLAYLIST_ID: &str = "无效的歌单或歌曲编号";
const ERR_PLAYLIST_FM: &str = "私人 FM 模式下不能播放歌单";
/// No song is longer than this; anything larger is a unit mistake.
const MAX_POSITION: f64 = 24.0 * 60.0 * 60.0;
/// The longest playlist name sent back to NetEase with its own playlist (as the queue reader
/// keeps it).
const MAX_NAME: usize = 300;
/// The most lyrics taken from NetEase (in characters, the script's limits too): ordinary songs
/// have a few thousand; within these a reply stays far below the socket's MAX_BYTES even with
/// every character escaped. Word-timed lyrics or a translation over its limit are left out whole
/// (the lines still show), never cut.
const MAX_LYRIC_LINES: usize = 2000;
const MAX_LYRIC_LINE: usize = 300;
const MAX_LYRIC_TEXT: usize = 50_000;
const MAX_LYRIC_TRANSLATION: usize = 30_000;
const MAX_LYRIC_WORDS: usize = 60_000;
const MAX_LYRIC_WORDS_TRANSLATION: usize = 10_000;

/// Defines `findStore`: walks at most 400 React fibre nodes from `#root`, breadth-first,
/// to the node whose props hold the Redux store. Reads nothing else.
const FIND_STORE: &str = r#"
  const findStore = () => {
    const root = document.querySelector('#root');
    if (!root) return null;
    const container = root._reactRootContainer;
    let fibre = container && container._internalRoot && container._internalRoot.current;
    if (!fibre) {
      const key = Object.keys(root).find((name) => name.startsWith('__reactContainer'));
      fibre = key ? root[key] : null;
    }
    const pending = fibre ? [fibre] : [];
    for (let seen = 0; pending.length && seen < 400; seen += 1) {
      const node = pending.shift();
      const store = node.memoizedProps && node.memoizedProps.store;
      if (store && typeof store.getState === 'function' && typeof store.dispatch === 'function') return store;
      if (node.child) pending.push(node.child);
      if (node.sibling) pending.push(node.sibling);
    }
    return null;
  };
"#;

/// Reads `playing.resourceTrackId`, `playingState`, `playingMode`, `resourceDuration`, the
/// pending seek target with the trial clip's start, and the whole seconds shown by the
/// progress slider: the first hook of the component around it (the value NetEase's own
/// relative seek uses), or the slider's range input. Dispatches nothing.
const STATE_BODY: &str = r#"
  const store = findStore();
  if (!store) return { store: false };
  const playing = store.getState().playing || {};
  let position = null;
  const bar = document.querySelector('div[aria-label="播放进度调节"]');
  if (bar) {
    const key = Object.keys(bar).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
    let fibre = key ? bar[key] : null;
    for (let seen = 0; fibre && seen < 40; seen += 1, fibre = fibre.return) {
      const props = fibre.memoizedProps;
      if (typeof fibre.type === 'function' && props && 'restoreResource' in props && 'resourceDuration' in props && 'dispatch' in props) {
        const seconds = fibre.memoizedState && fibre.memoizedState.memoizedState;
        if (typeof seconds === 'number' && Number.isFinite(seconds)) position = seconds;
        break;
      }
    }
    if (position === null) {
      const input = bar.querySelector('input[type="range"]');
      const seconds = input ? Number(input.value) : NaN;
      if (Number.isFinite(seconds)) position = seconds;
    }
  }
  // The slider stands still while a seek is being carried out; its target is the position.
  if (typeof playing.loadingSeekDuration === 'number' && playing.loadingSeekDuration > 0) {
    const trial = playing.freeTrialInfo;
    position = playing.loadingSeekDuration + ((trial && Number(trial.start)) || 0);
  }
  return {
    store: true,
    trackId: playing.resourceTrackId == null ? null : String(playing.resourceTrackId),
    state: playing.playingState,
    mode: playing.playingMode,
    duration: playing.resourceDuration,
    position,
  };
"#;

/// Expects `id` (the song id the caller shows) and `seconds` (a finite number on the
/// full-song scale). Dispatches what the progress slider dispatches when it is released,
/// for the current song only and inside its playable range (a trial clip's range when the
/// song is a trial). Returns "store", "changed" or "unloaded", or the position it sent
/// NetEase to (a number); never starts or pauses playback.
const SEEK_BODY: &str = r#"
  const store = findStore();
  if (!store) return 'store';
  const playing = store.getState().playing || {};
  if (playing.resourceTrackId == null || String(playing.resourceTrackId) !== id) return 'changed';
  const duration = Number(playing.resourceDuration) || 0;
  const loaded = playing.playId && (playing.playingState === 1 || playing.playingState === 2);
  if (duration < 2 || !(loaded || playing.restoreResource || playing.isLoadingFirst)) return 'unloaded';
  let low = 0, high = duration - 1, start = 0;
  const trial = playing.freeTrialInfo;
  if (trial) {
    start = Number(trial.start) || 0;
    low = start;
    if (Number(trial.end) > 0) high = Math.min(high, Number(trial.end) - 1);
  }
  const target = Math.min(Math.max(seconds, low), Math.max(low, high));
  // Not awaited: the action's promise only resolves when the native player answers.
  store.dispatch({ type: 'playing/setPlayingPosition', payload: { duration: target - start } });
  return target;
"#;

/// Expects `id` (the song id, a string). Reads the same `playing` fields and the queue
/// entries' `resourceId`, then dispatches the queue panel's own action with the matching
/// entry. Returns "store", "fm", "current", "missing" or "sent".
const PLAY_BODY: &str = r#"
  const store = findStore();
  if (!store) return 'store';
  const state = store.getState();
  const playing = state.playing || {};
  if (playing.playingMode === 'playFm') return 'fm';
  if (String(playing.resourceTrackId) === id && playing.playingState === 2) return 'current';
  const list = (state.playingList && state.playingList.curPlayingList) || [];
  const item = Array.isArray(list) ? list.find((entry) => entry && String(entry.resourceId) === id) : null;
  if (!item) return 'missing';
  store.dispatch({
    type: 'playing/playOneTrackInPlayingList',
    payload: { item, switchType: 'call', flag: 0, triggerScene: 'playingList' },
  });
  return 'sent';
"#;

/// Expects `playlist` and `track` (ids as exact JavaScript numbers) and `name` (the playlist's
/// name as Rhine read it from NetEase's database). Dispatches NetEase's own generic action as its
/// 播放全部 does for a playlist, starting at `track`: NetEase loads the playlist itself (from its
/// playlist page, its server, or offline its local database) and replaces its play queue with it,
/// as double-clicking that song in the playlist does there. The playlist goes as a number, as its
/// pages give it. The song to start with goes in the type NetEase gives its songs' ids, read from
/// the first entry of its queue (else its playing song): NetEase looks for it among the playlist's
/// songs with a strict comparison, and with the other type it replaces the queue but starts
/// nothing (2026-10-12: strings in NetEase's current version; a number went on with the old song).
/// The source fields (scene, text, href, sourceData) are the ones NetEase saves with a queue
/// started from a playlist page, by which the queue's playlist is told. Returns "store", "fm" or
/// "sent".
const PLAYLIST_BODY: &str = r#"
  const store = findStore();
  if (!store) return 'store';
  const state = store.getState();
  const playing = state.playing || {};
  if (playing.playingMode === 'playFm') return 'fm';
  const queued = (state.playingList && state.playingList.curPlayingList) || [];
  const first = Array.isArray(queued) && queued[0];
  const sample = first ? (first.track && first.track.id != null ? first.track.id : first.resourceId) : playing.resourceTrackId;
  const start = typeof sample === 'number' ? track : String(track);
  // Not awaited: NetEase loads the playlist before it plays.
  store.dispatch({
    type: 'async:action/doAction',
    payload: {
      actionId: 'playAll',
      data: {
        resource: { id: playlist },
        resourceType: 'playlist',
        from: { scene: 'playlist', text: name, href: '/playlist/' + playlist, sourceData: { id: playlist, name }, assignedPlayId: start },
      },
      parentData: {},
    },
  });
  return 'sent';
"#;

/// Expects `id` (the song id the caller shows, a string) and `load` (a boolean). Reads, for the
/// song NetEase plays, the lyrics it keeps for its playing page (`async:lyric`): which song they
/// belong to (compared with the playing song's id, or its online id; neither is returned), whether
/// NetEase is loading lyrics and whether its last load failed, what it shows (`displayType`: lyrics,
/// instrumental or none), its own adjustment of their times (`offset`), each line's time and text,
/// their translation and its word-timed lyrics with their translation. While NetEase holds another
/// song's lyrics and loads none, with `load` it dispatches what its playing page dispatches when it
/// opens: NetEase loads the lyrics of the song it plays (its cache, else its server) and changes
/// nothing it shows. Returns `{ status }`: "store", "changed" (another song plays), "loading"
/// (NetEase is loading lyrics), "asked" (just dispatched), "failed" (after asking: NetEase could not
/// load them), "none" (none for this song: not loaded, instrumental or none at all), or "ready" with
/// `offset` (seconds), `lines` ([time or null, text]), `translations` (aligned with them, or empty),
/// `words` and `wordsTranslation` (NetEase's own texts, or "" when it has none or they are over
/// their limits).
const LYRICS_BODY: &str = r#"
  const store = findStore();
  if (!store) return { status: 'store' };
  const state = store.getState();
  const playing = state.playing || {};
  if (playing.resourceTrackId == null || String(playing.resourceTrackId) !== id) return { status: 'changed' };
  const lyric = state['async:lyric'];
  if (!lyric || typeof lyric !== 'object') return { status: 'store' };
  const online = playing.onlineResourceId == null || playing.onlineResourceId === '' ? id : String(playing.onlineResourceId);
  const owner = lyric.resourceTrackId == null ? '' : String(lyric.resourceTrackId);
  if (owner === '' || (owner !== id && owner !== online)) {
    if (lyric.isLoading) return { status: 'loading' };
    if (!load) return { status: lyric.isLyricFetchFailed === true ? 'failed' : 'none' };
    // Not awaited: NetEase reads its cache, else its server.
    store.dispatch({ type: 'async:lyric/fetchLyric', payload: { force: true } });
    return { status: 'asked' };
  }
  if (lyric.displayType !== 'default') return { status: 'none' };
  const source = Array.isArray(lyric.lyricLines) ? lyric.lyricLines : [];
  const others = Array.isArray(lyric.tlyricLines) && lyric.tlyricLines.length === source.length ? lyric.tlyricLines : null;
  const text = (line) => (line && typeof line.lyric === 'string' ? line.lyric.slice(0, 300) : '');
  const lines = [], translations = [];
  let room = 50000, translationRoom = 30000;
  for (let index = 0; index < source.length && lines.length < 2000; index += 1) {
    const line = source[index];
    const words = text(line);
    room -= words.length;
    if (room < 0) break;
    lines.push([line && typeof line.time === 'number' && Number.isFinite(line.time) ? line.time : null, words]);
    if (others) {
      const translation = text(others[index]);
      translationRoom -= translation.length;
      translations.push(translation);
    }
  }
  const timed = lyric.yrcInfo && typeof lyric.yrcInfo === 'object' ? lyric.yrcInfo : {};
  const whole = (value, limit) => (typeof value === 'string' && value.length <= limit ? value : '');
  return {
    status: 'ready',
    offset: typeof lyric.offset === 'number' && Number.isFinite(lyric.offset) ? lyric.offset : 0,
    lines,
    translations: translationRoom >= 0 && translations.some((line) => line) ? translations : [],
    words: whole(timed.yrc, 60000),
    wordsTranslation: whole(timed.yrcTrans, 10000),
  };
"#;

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DebugState {
    /// False when the port is closed or serves no NetEase player page.
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_id: Option<String>,
    /// "playing", "paused" or "stopped".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playback: Option<String>,
    /// NetEase's play mode, such as "playOrder" or "playRandom".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// Seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    /// Seconds into the song; whole seconds, as NetEase's progress slider shows them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<f64>,
}

/// The lyrics NetEase has loaded for the song it plays (`lyrics`); only kept in the page's memory.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DebugLyrics {
    /// "ready", "loading" (NetEase is loading lyrics), "asked" (Rhine just asked it to load this
    /// song's), "failed" (NetEase could not load them), "none" (none for this song now) or "changed"
    /// (NetEase plays another song).
    pub status: String,
    /// NetEase's own adjustment of the lyrics' times (seconds, positive sooner): already in `lines`,
    /// not in `words` or `words_translation`.
    #[serde(skip_serializing_if = "is_zero")]
    pub offset: f64,
    /// Each line's start in seconds (none for unsynchronised lyrics) and its text, as NetEase
    /// shows them (credit lines included, its offset applied).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lines: Vec<(Option<f64>, String)>,
    /// Each line's translation ("" for a line without one), aligned with `lines`; empty for none.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub translations: Vec<String>,
    /// NetEase's word-timed lyrics (its "yrc" text, credit lines removed) and their translation
    /// (LRC text), when it has them.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub words: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub words_translation: String,
}

enum Failure {
    /// Port closed, no reply in time, or no NetEase player page.
    Unavailable,
    Protocol(String),
}

pub fn state() -> Result<DebugState, String> {
    state_at(PORT)
}

pub fn play(track_id: &str) -> Result<(), String> {
    play_at(PORT, track_id)
}

/// Play the user's NetEase playlist `playlist_id` from its song `track_id` (NetEase's decimal
/// ids): NetEase's queue becomes the playlist. `name` is saved with the queue as its source.
pub fn play_playlist(playlist_id: &str, track_id: &str, name: &str) -> Result<(), String> {
    play_playlist_at(PORT, playlist_id, track_id, name)
}

/// Seek in the song `track_id`, which must still be the one NetEase plays. Returns the
/// position NetEase was sent to, which a trial clip can limit.
pub fn seek(track_id: &str, position: f64) -> Result<f64, String> {
    seek_at(PORT, track_id, position)
}

/// The lyrics NetEase has loaded for its song `track_id`, which must still be the one it plays.
/// With `load`, when it holds none for it and is loading none, NetEase is first asked to load
/// them (its own action; the reply is then "asked", and the lyrics come with a later read).
pub fn lyrics(track_id: &str, load: bool) -> Result<DebugLyrics, String> {
    lyrics_at(PORT, track_id, load)
}

fn state_at(port: u16) -> Result<DebugState, String> {
    match run(port, &state_script(), Instant::now() + STATE_BUDGET) {
        Ok(value) => map_state(&value),
        Err(Failure::Unavailable) => Ok(DebugState::default()),
        Err(Failure::Protocol(message)) => Err(message),
    }
}

fn play_at(port: u16, track_id: &str) -> Result<(), String> {
    if !valid_track_id(track_id) {
        return Err(ERR_ID.into());
    }
    match run(port, &play_script(track_id), Instant::now() + PLAY_BUDGET) {
        Ok(value) => play_outcome(&value),
        Err(Failure::Unavailable) => Err(ERR_PORT.into()),
        Err(Failure::Protocol(message)) => Err(message),
    }
}

fn play_playlist_at(port: u16, playlist_id: &str, track_id: &str, name: &str) -> Result<(), String> {
    let (Some(playlist), Some(track)) = (script_id(playlist_id), script_id(track_id)) else {
        return Err(ERR_PLAYLIST_ID.into());
    };
    match run(port, &playlist_script(playlist, track, name), Instant::now() + PLAY_BUDGET) {
        Ok(value) => playlist_outcome(&value),
        Err(Failure::Unavailable) => Err(ERR_PORT.into()),
        Err(Failure::Protocol(message)) => Err(message),
    }
}

fn seek_at(port: u16, track_id: &str, position: f64) -> Result<f64, String> {
    if !valid_track_id(track_id) {
        return Err(ERR_ID.into());
    }
    if !valid_position(position) {
        return Err(ERR_POSITION.into());
    }
    match run(port, &seek_script(track_id, position), Instant::now() + PLAY_BUDGET) {
        Ok(value) => seek_outcome(&value),
        Err(Failure::Unavailable) => Err(ERR_PORT.into()),
        Err(Failure::Protocol(message)) => Err(message),
    }
}

fn lyrics_at(port: u16, track_id: &str, load: bool) -> Result<DebugLyrics, String> {
    if !valid_track_id(track_id) {
        return Err(ERR_ID.into());
    }
    match run(port, &lyrics_script(track_id, load), Instant::now() + LYRICS_BUDGET) {
        Ok(value) => map_lyrics(&value),
        Err(Failure::Unavailable) => Err(ERR_PORT.into()),
        Err(Failure::Protocol(message)) => Err(message),
    }
}

fn valid_position(position: f64) -> bool {
    position.is_finite() && (0.0..=MAX_POSITION).contains(&position)
}

fn valid_track_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// A NetEase id that a script carries as an exact JavaScript number: decimal digits only, at
/// least 1 and at most 2^53 - 1.
fn script_id(id: &str) -> Option<u64> {
    const MAX_SAFE: u64 = (1 << 53) - 1;
    if id.is_empty() || id.len() > 16 || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    id.parse::<u64>().ok().filter(|value| (1..=MAX_SAFE).contains(value))
}

fn valid_page_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn state_script() -> String {
    ["(() => {", FIND_STORE, STATE_BODY, "})()"].concat()
}

fn play_script(track_id: &str) -> String {
    // The id reaches the script only as a JSON string literal.
    let id = serde_json::to_string(track_id).unwrap_or_else(|_| "\"\"".into());
    format!("(() => {{\n  const id = {id};{FIND_STORE}{PLAY_BODY}}})()")
}

fn playlist_script(playlist: u64, track: u64, name: &str) -> String {
    // The ids are checked numbers; the name reaches the script only as a JSON string literal.
    let name: String = name.trim().chars().take(MAX_NAME).collect();
    let name = serde_json::to_string(&name).unwrap_or_else(|_| "\"\"".into());
    format!(
        "(() => {{\n  const playlist = {playlist};\n  const track = {track};\n  const name = {name};{FIND_STORE}{PLAYLIST_BODY}}})()"
    )
}

fn seek_script(track_id: &str, position: f64) -> String {
    // Both reach the script only as JSON literals.
    let id = serde_json::to_string(track_id).unwrap_or_else(|_| "\"\"".into());
    let seconds = serde_json::to_string(&position).unwrap_or_else(|_| "0".into());
    format!("(() => {{\n  const id = {id};\n  const seconds = {seconds};{FIND_STORE}{SEEK_BODY}}})()")
}

fn lyrics_script(track_id: &str, load: bool) -> String {
    // The id reaches the script only as a JSON string literal.
    let id = serde_json::to_string(track_id).unwrap_or_else(|_| "\"\"".into());
    format!("(() => {{\n  const id = {id};\n  const load = {load};{FIND_STORE}{LYRICS_BODY}}})()")
}

/// The id of NetEase's player page in a `/json/list` body.
fn pick_page(body: &[u8]) -> Result<Option<String>, String> {
    let value: Value = serde_json::from_slice(body).map_err(|_| ERR_PROTOCOL.to_string())?;
    let targets = value.as_array().ok_or(ERR_PROTOCOL)?;
    Ok(targets.iter().find_map(|target| {
        let field = |name| target.get(name).and_then(Value::as_str);
        let id = field("id")?;
        (field("type") == Some("page")
            && field("url").is_some_and(|url| url.starts_with(PAGE_URL))
            && valid_page_id(id))
        .then(|| id.to_owned())
    }))
}

/// Built from the page id; the address in the target list is not used.
fn ws_url(port: u16, page_id: &str) -> Option<String> {
    valid_page_id(page_id).then(|| format!("ws://127.0.0.1:{port}/devtools/page/{page_id}"))
}

/// The value returned by the script in a `Runtime.evaluate` reply.
fn evaluated(reply: &Value) -> Result<Value, String> {
    let result = reply.get("result").filter(|_| reply.get("error").is_none());
    let result = result.ok_or(ERR_PROTOCOL)?;
    if result.get("exceptionDetails").is_some() {
        return Err(ERR_PROTOCOL.into());
    }
    let remote = result.get("result").ok_or(ERR_PROTOCOL)?;
    Ok(remote.get("value").cloned().unwrap_or(Value::Null))
}

fn map_state(value: &Value) -> Result<DebugState, String> {
    match value.get("store").and_then(Value::as_bool) {
        Some(true) => {}
        Some(false) => return Err(ERR_STORE.into()),
        None => return Err(ERR_PROTOCOL.into()),
    }
    let track_id = match value.get("trackId") {
        Some(Value::String(id)) => Some(id.clone()),
        Some(Value::Number(id)) => Some(id.to_string()),
        _ => None,
    };
    let playback = match value.get("state").and_then(Value::as_i64) {
        Some(2) => Some("playing"),
        Some(1) => Some("paused"),
        Some(0 | -1) => Some("stopped"),
        _ => None,
    };
    Ok(DebugState {
        available: true,
        track_id: track_id.filter(|id| valid_track_id(id)),
        playback: playback.map(str::to_owned),
        mode: value
            .get("mode")
            .and_then(Value::as_str)
            .filter(|mode| valid_track_id(mode))
            .map(str::to_owned),
        duration: value
            .get("duration")
            .and_then(Value::as_f64)
            .filter(|seconds| seconds.is_finite() && *seconds > 0.0),
        position: value
            .get("position")
            .and_then(Value::as_f64)
            .filter(|seconds| valid_position(*seconds)),
    })
}

fn seek_outcome(value: &Value) -> Result<f64, String> {
    if let Some(target) = value.as_f64().filter(|target| valid_position(*target)) {
        return Ok(target);
    }
    match value.as_str() {
        Some("changed") => Err(ERR_CHANGED.into()),
        Some("unloaded") => Err(ERR_NOT_LOADED.into()),
        Some("store") => Err(ERR_STORE.into()),
        _ => Err(ERR_PROTOCOL.into()),
    }
}

fn play_outcome(value: &Value) -> Result<(), String> {
    match value.as_str() {
        Some("sent" | "current") => Ok(()),
        Some("missing") => Err(ERR_MISSING.into()),
        Some("fm") => Err(ERR_FM.into()),
        Some("store") => Err(ERR_STORE.into()),
        _ => Err(ERR_PROTOCOL.into()),
    }
}

fn playlist_outcome(value: &Value) -> Result<(), String> {
    match value.as_str() {
        Some("sent") => Ok(()),
        Some("fm") => Err(ERR_PLAYLIST_FM.into()),
        Some("store") => Err(ERR_STORE.into()),
        _ => Err(ERR_PROTOCOL.into()),
    }
}

fn is_zero(value: &f64) -> bool {
    *value == 0.0
}

/// The largest lyrics offset taken from NetEase (it moves them half a second a step).
const MAX_LYRIC_OFFSET: f64 = 60.0;

/// A lyrics reply, held to the script's shapes and limits (checked again here).
fn map_lyrics(value: &Value) -> Result<DebugLyrics, String> {
    let status = value.get("status").and_then(Value::as_str).ok_or(ERR_PROTOCOL)?;
    match status {
        "ready" => {}
        "loading" | "asked" | "failed" | "none" | "changed" => {
            return Ok(DebugLyrics { status: status.into(), ..DebugLyrics::default() })
        }
        "store" => return Err(ERR_STORE.into()),
        _ => return Err(ERR_PROTOCOL.into()),
    }
    let mut room = MAX_LYRIC_TEXT;
    let mut lines = Vec::new();
    let given = value.get("lines").and_then(Value::as_array).ok_or(ERR_PROTOCOL)?;
    for line in given.iter().take(MAX_LYRIC_LINES) {
        let (Some(time), Some(text)) = (line.get(0), line.get(1).and_then(Value::as_str)) else {
            return Err(ERR_PROTOCOL.into());
        };
        let text: String = text.chars().take(MAX_LYRIC_LINE).collect();
        let Some(left) = room.checked_sub(text.chars().count()) else { break };
        room = left;
        // NetEase's own offset can move a first line a little before the song's start.
        let time = time.as_f64().filter(|seconds| seconds.is_finite() && *seconds <= MAX_POSITION);
        lines.push((time.map(|seconds| seconds.max(0.0)), text));
    }
    // Aligned with the lines or not at all.
    let translations: Vec<String> = value
        .get("translations")
        .and_then(Value::as_array)
        .filter(|items| items.len() >= lines.len())
        .map(|items| {
            items[..lines.len()]
                .iter()
                .map(|item| item.as_str().map(|text| text.chars().take(MAX_LYRIC_LINE).collect()))
                .collect::<Option<Vec<String>>>()
                .unwrap_or_default()
        })
        .filter(|items| {
            items.iter().map(|text| text.chars().count()).sum::<usize>() <= MAX_LYRIC_TRANSLATION
                && items.iter().any(|text| !text.is_empty())
        })
        .unwrap_or_default();
    let whole = |name: &str, limit: usize| {
        value
            .get(name)
            .and_then(Value::as_str)
            .filter(|text| text.chars().count() <= limit)
            .unwrap_or_default()
            .to_owned()
    };
    let words = whole("words", MAX_LYRIC_WORDS);
    let words_translation = if words.is_empty() { String::new() } else { whole("wordsTranslation", MAX_LYRIC_WORDS_TRANSLATION) };
    if lines.iter().all(|(_, text)| text.trim().is_empty()) && words.trim().is_empty() {
        return Ok(DebugLyrics { status: "none".into(), ..DebugLyrics::default() });
    }
    let offset = value
        .get("offset")
        .and_then(Value::as_f64)
        .filter(|seconds| seconds.is_finite() && seconds.abs() <= MAX_LYRIC_OFFSET)
        .unwrap_or(0.0);
    Ok(DebugLyrics { status: "ready".into(), offset, lines, translations, words, words_translation })
}

fn remaining(deadline: Instant) -> Result<Duration, Failure> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err(Failure::Unavailable);
    }
    Ok(left)
}

/// A socket whose every read and write ends at one deadline, however slowly the peer feeds
/// it: a per-call socket timeout alone would restart with each byte received.
struct Deadlined {
    stream: TcpStream,
    deadline: Instant,
}

impl Deadlined {
    fn left(&self) -> std::io::Result<Duration> {
        let left = self.deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        Ok(left)
    }
}

impl Read for Deadlined {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.stream.set_read_timeout(Some(self.left()?))?;
        self.stream.read(buffer)
    }
}

impl Write for Deadlined {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.stream.set_write_timeout(Some(self.left()?))?;
        self.stream.write(buffer)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

/// Direct loopback requests: no proxy, no redirects.
fn http() -> Option<&'static reqwest::blocking::Client> {
    static CLIENT: OnceLock<Option<reqwest::blocking::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::blocking::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(CONNECT_TIMEOUT)
                .build()
                .ok()
        })
        .as_ref()
}

fn get(port: u16, path: &str, timeout: Duration) -> Result<Vec<u8>, Failure> {
    let client = http().ok_or(Failure::Unavailable)?;
    let response = client
        .get(format!("http://127.0.0.1:{port}{path}"))
        .timeout(timeout)
        .send()
        .map_err(|_| Failure::Unavailable)?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(Failure::Unavailable);
    }
    let mut body = Vec::new();
    response
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|_| Failure::Unavailable)?;
    if body.len() > MAX_BYTES {
        return Err(Failure::Protocol(ERR_PROTOCOL.into()));
    }
    Ok(body)
}

/// Evaluate `expression` in NetEase's player page and return the script's value.
fn run(port: u16, expression: &str, deadline: Instant) -> Result<Value, Failure> {
    let body = get(port, "/json/list", remaining(deadline)?.min(Duration::from_secs(1)))?;
    let page = pick_page(&body)
        .map_err(Failure::Protocol)?
        .ok_or(Failure::Unavailable)?;
    let url = ws_url(port, &page).ok_or(Failure::Unavailable)?;

    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let stream = TcpStream::connect_timeout(&address, remaining(deadline)?.min(CONNECT_TIMEOUT))
        .map_err(|_| Failure::Unavailable)?;
    let _ = stream.set_nodelay(true);
    let stream = Deadlined { stream, deadline };
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_BYTES))
        .max_frame_size(Some(MAX_BYTES));
    let (mut socket, _) =
        client_with_config(url, stream, Some(config)).map_err(|_| Failure::Unavailable)?;
    let request = json!({
        "id": 1,
        "method": "Runtime.evaluate",
        "params": { "expression": expression, "returnByValue": true, "awaitPromise": true },
    });
    socket
        .send(Message::text(request.to_string()))
        .map_err(|_| Failure::Unavailable)?;
    let reply = loop {
        remaining(deadline)?;
        match socket.read() {
            Ok(Message::Text(text)) => {
                let message: Value = serde_json::from_str(text.as_str())
                    .map_err(|_| Failure::Protocol(ERR_PROTOCOL.into()))?;
                // Events carry no id.
                if message.get("id").and_then(Value::as_u64) == Some(1) {
                    break message;
                }
            }
            Ok(_) => {}
            Err(tungstenite::Error::Capacity(_)) => {
                return Err(Failure::Protocol(ERR_PROTOCOL.into()))
            }
            Err(_) => return Err(Failure::Unavailable),
        }
    };
    let _ = socket.close(None);
    let _ = socket.flush();
    evaluated(&reply).map_err(Failure::Protocol)
}

/// The executable in the `orpheus:` protocol command, such as
/// `"C:\Program Files\Netease\CloudMusic\cloudmusic.exe"--webcmd="%1"`.
fn exe_from_command(command: &str) -> Option<String> {
    let (path, _) = command.trim_start().strip_prefix('"')?.split_once('"')?;
    is_cloudmusic_path(path).then(|| path.to_owned())
}

/// An absolute drive path to `cloudmusic.exe`.
fn is_cloudmusic_path(path: &str) -> bool {
    const NAME: &str = "\\cloudmusic.exe";
    let bytes = path.as_bytes();
    bytes.len() > NAME.len()
        && bytes[bytes.len() - NAME.len()..].eq_ignore_ascii_case(NAME.as_bytes())
        && bytes[0].is_ascii_alphabetic()
        && bytes[1..].starts_with(b":\\")
}

/// Close NetEase and start it again with the debugging port. Called only from the
/// user's explicit button.
pub fn restart() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_restart::restart()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("unsupported：重新启动网易云目前仅支持 Windows".into())
    }
}

#[cfg(target_os = "windows")]
mod windows_restart {
    use super::{exe_from_command, get, is_cloudmusic_path, PORT};
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use windows::{
        core::{w, PCWSTR, PWSTR},
        Win32::{
            Foundation::{CloseHandle, ERROR_SUCCESS},
            System::{
                Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                    TH32CS_SNAPPROCESS,
                },
                Registry::{
                    RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
                },
                RemoteDesktop::ProcessIdToSessionId,
                Threading::{
                    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW,
                    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
                },
            },
        },
    };

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CLOSE_WAIT: Duration = Duration::from_secs(3);
    const PORT_WAIT: Duration = Duration::from_secs(25);

    pub fn restart() -> Result<(), String> {
        static RUNNING: Mutex<()> = Mutex::new(());
        let _guard = RUNNING.try_lock().map_err(|_| "网易云正在重新启动")?;

        let running = processes();
        let exe = running
            .iter()
            .find_map(|pid| image_path(*pid))
            .or_else(registered_exe)
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .ok_or("未找到网易云音乐的安装位置")?;
        if !running.is_empty() {
            taskkill(&running, false)?;
            if !wait_closed() {
                taskkill(&processes(), true)?;
                if !wait_closed() {
                    return Err("无法关闭网易云，请手动退出后重试".into());
                }
            }
        }
        let mut command = Command::new(&exe);
        command
            .arg(format!("--remote-debugging-port={PORT}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(directory) = exe.parent() {
            command.current_dir(directory);
        }
        command
            .spawn()
            .map_err(|error| format!("无法启动网易云：{error}"))?;

        let deadline = Instant::now() + PORT_WAIT;
        while Instant::now() < deadline {
            if get(PORT, "/json/version", Duration::from_secs(1)).is_ok() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        Err("网易云已重新启动，但调试端口没有响应".into())
    }

    fn session(pid: u32) -> Option<u32> {
        let mut session = 0;
        unsafe { ProcessIdToSessionId(pid, &mut session) }
            .ok()
            .map(|_| session)
    }

    /// Ids of the `cloudmusic.exe` processes in this Windows session. Another signed-in
    /// user's NetEase is neither closed nor waited for.
    fn processes() -> Vec<u32> {
        let mut pids = Vec::new();
        let own = session(unsafe { GetCurrentProcessId() });
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return pids;
            };
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    let name = &entry.szExeFile;
                    let length = name.iter().position(|c| *c == 0).unwrap_or(name.len());
                    if String::from_utf16_lossy(&name[..length])
                        .eq_ignore_ascii_case("cloudmusic.exe")
                        && own.is_some()
                        && session(entry.th32ProcessID) == own
                    {
                        pids.push(entry.th32ProcessID);
                    }
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }
        pids
    }

    fn image_path(pid: u32) -> Option<String> {
        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let result = QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
            );
            let _ = CloseHandle(process);
            result.ok()?;
        }
        let path = String::from_utf16(buffer.get(..length as usize)?).ok()?;
        is_cloudmusic_path(&path).then_some(path)
    }

    /// The executable NetEase's installer registered for the `orpheus:` protocol.
    fn registered_exe() -> Option<String> {
        let mut buffer = [0u16; 1024];
        let mut bytes = std::mem::size_of_val(&buffer) as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                w!("Software\\Classes\\orpheus\\shell\\open\\command"),
                PCWSTR::null(),
                RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
                None,
                Some(buffer.as_mut_ptr().cast()),
                Some(&mut bytes),
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let units = &buffer[..(bytes as usize / 2).min(buffer.len())];
        let length = units.iter().position(|c| *c == 0).unwrap_or(units.len());
        exe_from_command(&String::from_utf16(&units[..length]).ok()?)
    }

    /// `taskkill /PID … /T` for the given processes, with `/F` when `force`. Its exit code
    /// is not used; the caller checks which processes remain.
    fn taskkill(pids: &[u32], force: bool) -> Result<(), String> {
        if pids.is_empty() {
            return Ok(());
        }
        let tool = std::env::var_os("SystemRoot")
            .map(|root| Path::new(&root).join("System32").join("taskkill.exe"))
            .filter(|path| path.is_absolute() && path.is_file())
            .ok_or("未找到 Windows 的 taskkill.exe")?;
        let mut command = Command::new(tool);
        for pid in pids {
            command.arg("/PID").arg(pid.to_string());
        }
        command.arg("/T");
        if force {
            command.arg("/F");
        }
        command
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|_| ())
            .map_err(|error| format!("无法关闭网易云：{error}"))
    }

    fn wait_closed() -> bool {
        let deadline = Instant::now() + CLOSE_WAIT;
        loop {
            if processes().is_empty() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    const PAGE: &str = "5F0C3E1A-page";

    fn targets() -> Value {
        json!([
            { "id": "worker-1", "type": "service_worker", "url": "orpheus://orpheus/pub/app.html" },
            { "id": "other", "type": "page", "url": "orpheus://orpheus/pub/desktop_lyrics.html" },
            { "id": PAGE, "type": "page", "url": "orpheus://orpheus/pub/app.html#/m/playlist",
              "webSocketDebuggerUrl": "ws://example.com/devtools/page/elsewhere" },
        ])
    }

    /// A DevTools stand-in on an ephemeral loopback port: serves `list` at `/json/*` and
    /// answers each evaluate call on a page socket with `value`, after one event.
    /// Returns the port and the expressions it received.
    fn fake_devtools(list: Value, value: Value) -> (u16, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let expressions = Arc::new(Mutex::new(Vec::new()));
        let seen = expressions.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut start = [0u8; 10];
                let mut peeked = 0;
                while peeked < start.len() {
                    match stream.peek(&mut start) {
                        Ok(count) if count > 0 => peeked = count,
                        _ => break,
                    }
                }
                if &start == b"GET /json/" {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                        head.push(byte[0]);
                    }
                    let body = list.to_string();
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    continue;
                }
                let Ok(mut socket) = tungstenite::accept(stream) else { continue };
                while let Ok(message) = socket.read() {
                    let Message::Text(text) = message else { continue };
                    let request: Value = serde_json::from_str(text.as_str()).unwrap();
                    assert_eq!(request["method"], "Runtime.evaluate");
                    assert_eq!(request["params"]["returnByValue"], true);
                    seen.lock().unwrap().push(request["params"]["expression"].as_str().unwrap().into());
                    let event = json!({ "method": "Runtime.consoleAPICalled", "params": {} });
                    let reply = json!({ "id": request["id"], "result": { "result": { "type": "object", "value": value } } });
                    let _ = socket.send(Message::text(event.to_string()));
                    let _ = socket.send(Message::text(reply.to_string()));
                }
            }
        });
        (port, expressions)
    }

    fn closed_port() -> u16 {
        TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap().local_addr().unwrap().port()
    }

    #[test]
    fn track_ids_are_short_plain_tokens() {
        for id in ["1", "1234567890", "A_b-9", &"7".repeat(64)] {
            assert!(valid_track_id(id), "{id}");
        }
        for id in ["", "1 2", "1\"", "1';alert(1)//", "１２", "a.b", &"7".repeat(65)] {
            assert!(!valid_track_id(id), "{id}");
        }
        assert_eq!(play_at(closed_port(), "1\");//").unwrap_err(), ERR_ID);
    }

    #[test]
    fn only_the_netease_player_page_is_picked_and_its_address_is_rebuilt() {
        let body = targets().to_string();
        assert_eq!(pick_page(body.as_bytes()).unwrap().as_deref(), Some(PAGE));
        assert_eq!(
            ws_url(9233, PAGE).as_deref(),
            Some("ws://127.0.0.1:9233/devtools/page/5F0C3E1A-page")
        );
        let unusable = json!([
            { "id": "a", "type": "page", "url": "https://example.com/orpheus://orpheus/pub/app.html" },
            { "id": "b", "type": "iframe", "url": "orpheus://orpheus/pub/app.html" },
            { "id": "c/../d", "type": "page", "url": "orpheus://orpheus/pub/app.html" },
            { "type": "page", "url": "orpheus://orpheus/pub/app.html" },
        ]);
        assert_eq!(pick_page(unusable.to_string().as_bytes()).unwrap(), None);
        assert_eq!(pick_page(b"[]").unwrap(), None);
        assert!(pick_page(b"{}").is_err() && pick_page(b"<html>").is_err());
        for id in ["", "a/b", "a?b", "a@example.com", &"a".repeat(65)] {
            assert_eq!(ws_url(9233, id), None, "{id}");
        }
    }

    #[test]
    fn evaluate_replies_yield_the_script_value_or_a_protocol_error() {
        let reply = json!({ "id": 1, "result": { "result": { "type": "string", "value": "sent" } } });
        assert_eq!(evaluated(&reply).unwrap(), json!("sent"));
        let undefined = json!({ "id": 1, "result": { "result": { "type": "undefined" } } });
        assert_eq!(evaluated(&undefined).unwrap(), Value::Null);
        for reply in [
            json!({ "id": 1, "error": { "code": -32000, "message": "Cannot find context" } }),
            json!({ "id": 1, "result": { "result": { "type": "object" }, "exceptionDetails": { "text": "Uncaught" } } }),
            json!({ "id": 1, "result": {} }),
            json!({ "id": 1 }),
        ] {
            assert_eq!(evaluated(&reply).unwrap_err(), ERR_PROTOCOL, "{reply}");
        }
    }

    #[test]
    fn state_replies_map_to_playback_fields() {
        let state = map_state(&json!({ "store": true, "trackId": "1234567890", "state": 2,
            "mode": "playRandom", "duration": 215.4, "position": 27 }))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&state).unwrap(),
            json!({ "available": true, "trackId": "1234567890", "playback": "playing",
                    "mode": "playRandom", "duration": 215.4, "position": 27.0 })
        );
        for position in [json!(null), json!(-1), json!(90_000), json!("27")] {
            let state = map_state(&json!({ "store": true, "state": 2, "position": position })).unwrap();
            assert_eq!(state.position, None, "{position}");
        }
        assert_eq!(map_state(&json!({ "store": true, "position": 0 })).unwrap().position, Some(0.0));
        for (code, playback) in [(1, "paused"), (0, "stopped"), (-1, "stopped")] {
            let state = map_state(&json!({ "store": true, "trackId": 7, "state": code })).unwrap();
            assert_eq!(state.playback.as_deref(), Some(playback));
            assert_eq!(state.track_id.as_deref(), Some("7"));
        }
        let empty = map_state(&json!({ "store": true, "trackId": null, "state": 9, "mode": 3, "duration": 0 })).unwrap();
        assert_eq!(serde_json::to_value(&empty).unwrap(), json!({ "available": true }));
        assert_eq!(
            serde_json::to_value(DebugState::default()).unwrap(),
            json!({ "available": false })
        );
        assert_eq!(map_state(&json!({ "store": false })).unwrap_err(), ERR_STORE);
        assert_eq!(map_state(&json!("sent")).unwrap_err(), ERR_PROTOCOL);
        assert_eq!(map_state(&Value::Null).unwrap_err(), ERR_PROTOCOL);
    }

    #[test]
    fn jump_results_map_to_the_messages_shown_to_the_user() {
        assert!(play_outcome(&json!("sent")).is_ok() && play_outcome(&json!("current")).is_ok());
        assert_eq!(play_outcome(&json!("missing")).unwrap_err(), "这首歌已不在网易云的播放队列中");
        assert_eq!(play_outcome(&json!("fm")).unwrap_err(), "私人 FM 模式下不能切换到队列歌曲");
        assert_eq!(
            play_outcome(&json!("store")).unwrap_err(),
            "无法找到网易云的播放状态，可能是客户端版本已变化"
        );
        assert_eq!(play_outcome(&json!({ "store": true })).unwrap_err(), ERR_PROTOCOL);
    }

    #[test]
    fn seeks_are_validated_and_sent_for_the_shown_song_only() {
        for position in [f64::NAN, f64::INFINITY, -0.5, MAX_POSITION + 1.0] {
            assert_eq!(seek_at(closed_port(), "42", position).unwrap_err(), ERR_POSITION, "{position}");
        }
        assert_eq!(seek_at(closed_port(), "4 2", 10.0).unwrap_err(), ERR_ID);
        assert_eq!(seek_at(closed_port(), "42", 10.0).unwrap_err(), ERR_PORT);

        let (port, expressions) = fake_devtools(targets(), json!(80));
        assert_eq!(seek_at(port, "1234567890", 83.5).unwrap(), 80.0, "the position NetEase was sent to");
        let expressions = expressions.lock().unwrap();
        assert_eq!(expressions.len(), 1);
        assert!(expressions[0].contains("const id = \"1234567890\";"));
        assert!(expressions[0].contains("const seconds = 83.5;"));
        assert!(expressions[0].contains("type: 'playing/setPlayingPosition'"));
        assert!(!expressions[0].contains("playing/resume") && !expressions[0].contains("playOneTrackInPlayingList"));
        drop(expressions);

        assert_eq!(seek_outcome(&json!(12.5)).unwrap(), 12.5);
        for reply in [json!("sent"), json!(-1), json!(90_000), json!(null)] {
            assert_eq!(seek_outcome(&reply).unwrap_err(), ERR_PROTOCOL, "{reply}");
        }
        assert_eq!(seek_outcome(&json!("changed")).unwrap_err(), "网易云已经换歌，没有调整进度");
        assert_eq!(seek_outcome(&json!("unloaded")).unwrap_err(), "这首歌还没有加载，暂时不能调整进度");
        assert_eq!(seek_outcome(&json!("store")).unwrap_err(), ERR_STORE);
        assert_eq!(seek_outcome(&json!(true)).unwrap_err(), ERR_PROTOCOL);
    }

    #[test]
    fn scripts_touch_only_the_player_state_and_the_queue_action() {
        let play = play_script("1234567890");
        assert!(play.contains("const id = \"1234567890\";"));
        assert!(play.contains("type: 'playing/playOneTrackInPlayingList'"));
        assert!(play.contains("switchType: 'call', flag: 0, triggerScene: 'playingList'"));
        assert!(!state_script().contains("dispatch({"));
        for script in [play, state_script(), seek_script("1234567890", 12.0), playlist_script(770077, 1234567890, "List"), lyrics_script("1234567890", true)] {
            for word in ["cookie", "localStorage", "sessionStorage", "window.", "globalThis", "fetch("] {
                assert!(!script.contains(word), "{word}");
            }
        }
    }

    #[test]
    fn the_executable_comes_from_the_first_quoted_path_of_the_protocol_command() {
        assert_eq!(
            exe_from_command(r#""C:\Program Files\Netease\CloudMusic\cloudmusic.exe"--webcmd="%1""#).as_deref(),
            Some(r"C:\Program Files\Netease\CloudMusic\cloudmusic.exe")
        );
        assert_eq!(
            exe_from_command(r#" "D:\Apps\CloudMusic\CloudMusic.EXE" --webcmd="%1""#).as_deref(),
            Some(r"D:\Apps\CloudMusic\CloudMusic.EXE")
        );
        for command in [
            r#"C:\Program Files\Netease\CloudMusic\cloudmusic.exe --webcmd="%1""#,
            r#""C:\Windows\System32\cmd.exe" /c "C:\CloudMusic\cloudmusic.exe""#,
            r#""C:\CloudMusic\notcloudmusic.exe" "%1""#,
            r#""cloudmusic.exe" "%1""#,
            r#""\\server\share\cloudmusic.exe" "%1""#,
            r#""C:\CloudMusic\cloudmusic.exe"#,
            "",
        ] {
            assert_eq!(exe_from_command(command), None, "{command}");
        }
    }

    #[test]
    fn state_is_read_through_the_page_socket() {
        let value = json!({ "store": true, "trackId": "1234567890", "state": 1, "mode": "playOrder", "duration": 180 });
        let (port, expressions) = fake_devtools(targets(), value);
        let state = state_at(port).unwrap();
        assert_eq!(
            state,
            DebugState {
                available: true,
                track_id: Some("1234567890".into()),
                playback: Some("paused".into()),
                mode: Some("playOrder".into()),
                duration: Some(180.0),
                position: None,
            }
        );
        let expressions = expressions.lock().unwrap();
        assert_eq!(expressions.len(), 1);
        assert!(expressions[0].contains("resourceTrackId") && !expressions[0].contains("dispatch({"));
        assert!(expressions[0].contains("播放进度调节"), "the position comes from the progress slider");
    }

    #[test]
    fn play_sends_the_queue_action_with_the_json_encoded_id() {
        let (port, expressions) = fake_devtools(targets(), json!("sent"));
        play_at(port, "1234567890").unwrap();
        let expressions = expressions.lock().unwrap();
        assert_eq!(expressions.len(), 1);
        assert!(expressions[0].contains("const id = \"1234567890\";"));
        assert!(expressions[0].contains("playing/playOneTrackInPlayingList"));
        drop(expressions);

        let (port, _) = fake_devtools(targets(), json!("missing"));
        assert_eq!(play_at(port, "42").unwrap_err(), ERR_MISSING);
        let (port, _) = fake_devtools(targets(), json!("fm"));
        assert_eq!(play_at(port, "42").unwrap_err(), ERR_FM);
    }

    #[test]
    fn playlist_ids_are_exact_javascript_numbers() {
        assert_eq!(script_id("1"), Some(1));
        assert_eq!(script_id("2463839102"), Some(2_463_839_102));
        assert_eq!(script_id("9007199254740991"), Some(9_007_199_254_740_991));
        for id in ["", "0", "9007199254740992", "12345678901234567", "1 2", "12a", "-1", "1.5", "１２", "1\";alert(1)//"] {
            assert_eq!(script_id(id), None, "{id}");
        }
        // Nothing is tried for an id that is not one, not even a connection.
        assert_eq!(play_playlist_at(closed_port(), "77", "1\");//", "x").unwrap_err(), ERR_PLAYLIST_ID);
        assert_eq!(play_playlist_at(closed_port(), "list", "42", "x").unwrap_err(), ERR_PLAYLIST_ID);
        assert_eq!(play_playlist_at(closed_port(), "77", "42", "x").unwrap_err(), ERR_PORT);
    }

    #[test]
    fn a_playlist_plays_through_netease_own_play_all_from_the_chosen_song() {
        let (port, expressions) = fake_devtools(targets(), json!("sent"));
        play_playlist_at(port, "770077", "1234567890", "  A \"fictional\" list\u{2028}</script>  ").unwrap();
        let expressions = expressions.lock().unwrap();
        assert_eq!(expressions.len(), 1);
        let script = &expressions[0];
        assert!(script.contains("const playlist = 770077;\n  const track = 1234567890;"), "checked numbers");
        assert!(script.contains("const name = \"A \\\"fictional\\\" list\u{2028}</script>\";"), "a JSON string, trimmed");
        assert!(script.contains("type: 'async:action/doAction'"));
        assert!(script.contains("actionId: 'playAll',"));
        assert!(script.contains("resource: { id: playlist },\n        resourceType: 'playlist',"));
        assert!(script.contains(
            "from: { scene: 'playlist', text: name, href: '/playlist/' + playlist, sourceData: { id: playlist, name }, assignedPlayId: start },"
        ));
        // The song to start with in the type of NetEase's own song ids (it compares them strictly).
        assert!(script.contains(
            "const sample = first ? (first.track && first.track.id != null ? first.track.id : first.resourceId) : playing.resourceTrackId;\n  const start = typeof sample === 'number' ? track : String(track);"
        ));
        assert!(script.contains("if (playing.playingMode === 'playFm') return 'fm';"));
        assert!(!script.contains("playOneTrackInPlayingList") && !script.contains("setPlayingPosition"));
        drop(expressions);
        let long = "名".repeat(400);
        assert!(playlist_script(1, 2, &long).contains(&format!("const name = \"{}\";", "名".repeat(MAX_NAME))));

        let (port, _) = fake_devtools(targets(), json!("fm"));
        assert_eq!(play_playlist_at(port, "77", "42", "x").unwrap_err(), "私人 FM 模式下不能播放歌单");
        let (port, _) = fake_devtools(targets(), json!("store"));
        assert_eq!(play_playlist_at(port, "77", "42", "x").unwrap_err(), ERR_STORE);
        for reply in [json!("current"), json!("missing"), json!(null)] {
            assert_eq!(playlist_outcome(&reply).unwrap_err(), ERR_PROTOCOL, "{reply}");
        }
    }

    #[test]
    fn lyrics_replies_keep_lines_translations_and_words_within_their_limits() {
        let reply = json!({ "status": "ready", "offset": -1.5,
            "lines": [[0, "作词 : 虚构"], [12.5, "第一行"], [-0.3, "提前"], [null, "无时间"], ["7", "坏时间"], [90_000, "太晚"]],
            "translations": ["", "line one", "", "", "", ""],
            "words": "[12500,2000](12500,500,0)第(13000,500,0)一",
            "wordsTranslation": "[00:12.50]line one" });
        let lyrics = map_lyrics(&reply).unwrap();
        assert_eq!(lyrics.status, "ready");
        let times: Vec<_> = lyrics.lines.iter().map(|(time, _)| *time).collect();
        assert_eq!(times, [Some(0.0), Some(12.5), Some(0.0), None, None, None]);
        assert_eq!(lyrics.lines[1].1, "第一行");
        assert_eq!(lyrics.translations[1], "line one");
        assert!(lyrics.words.starts_with("[12500,2000]") && lyrics.words_translation == "[00:12.50]line one");
        let shown = serde_json::to_value(&lyrics).unwrap();
        assert_eq!(shown["lines"][3], json!([null, "无时间"]));
        assert_eq!(shown["wordsTranslation"], "[00:12.50]line one");
        assert_eq!(shown["offset"], -1.5);
        for offset in [json!(90), json!("1"), json!(null)] {
            let reply = json!({ "status": "ready", "offset": offset, "lines": [[1, "a"]] });
            let shown = serde_json::to_value(map_lyrics(&reply).unwrap()).unwrap();
            assert!(shown.get("offset").is_none(), "{offset}: no offset (0) is not sent");
        }

        // Over the limits the lines stop; a translation or word timing over its own is left out whole.
        let many: Vec<Value> = (0..MAX_LYRIC_LINES + 10).map(|second| json!([second, "a"])).collect();
        let lyrics = map_lyrics(&json!({ "status": "ready", "lines": many, "translations": [] })).unwrap();
        assert_eq!(lyrics.lines.len(), MAX_LYRIC_LINES);
        assert!(lyrics.translations.is_empty());
        let long = "字".repeat(MAX_LYRIC_LINE + 50);
        let lyrics = map_lyrics(&json!({ "status": "ready", "lines": [[1, long]],
            "words": "x".repeat(MAX_LYRIC_WORDS + 1), "wordsTranslation": "[00:01.00]y" })).unwrap();
        assert_eq!(lyrics.lines[0].1.chars().count(), MAX_LYRIC_LINE);
        assert_eq!((lyrics.words.as_str(), lyrics.words_translation.as_str()), ("", ""));
        let full: Vec<Value> = (0..400).map(|second| json!([second, "字".repeat(200)])).collect();
        assert_eq!(map_lyrics(&json!({ "status": "ready", "lines": full })).unwrap().lines.len(), MAX_LYRIC_TEXT / 200);
        let lyrics = map_lyrics(&json!({ "status": "ready", "lines": [[1, "a"], [2, "b"]], "translations": ["x"] })).unwrap();
        assert!(lyrics.translations.is_empty(), "translations not aligned with the lines");
        let lyrics = map_lyrics(&json!({ "status": "ready", "lines": [[1, "a"]], "translations": [""] })).unwrap();
        assert!(lyrics.translations.is_empty(), "no translation at all");

        // Nothing to show is none; the other states carry nothing.
        assert_eq!(map_lyrics(&json!({ "status": "ready", "lines": [[1, " "]], "words": "" })).unwrap().status, "none");
        for status in ["loading", "asked", "failed", "none", "changed"] {
            let reply = map_lyrics(&json!({ "status": status, "lines": [[1, "a"]], "words": "x" })).unwrap();
            assert_eq!(serde_json::to_value(reply).unwrap(), json!({ "status": status }));
        }
        assert_eq!(map_lyrics(&json!({ "status": "store" })).unwrap_err(), ERR_STORE);
        for reply in [json!("ready"), json!({ "status": "sent" }), json!({ "status": "ready" }),
            json!({ "status": "ready", "lines": [[1]] }), json!({ "status": "ready", "lines": [[1, 2]] })] {
            assert_eq!(map_lyrics(&reply).unwrap_err(), ERR_PROTOCOL, "{reply}");
        }
    }

    #[test]
    fn lyrics_are_read_for_the_playing_song_and_loaded_by_netease_own_action_only_when_asked() {
        // Nothing is tried for an id that is not one, not even a connection.
        assert_eq!(lyrics_at(closed_port(), "1\");//", true).unwrap_err(), ERR_ID);
        assert_eq!(lyrics_at(closed_port(), "42", true).unwrap_err(), ERR_PORT);

        let (port, asked) = fake_devtools(targets(), json!({ "status": "asked" }));
        assert_eq!(lyrics_at(port, "1234567890", true).unwrap().status, "asked");
        let (port, read) = fake_devtools(targets(), json!({ "status": "ready", "lines": [[3.5, "虚构的一行"]] }));
        assert_eq!(lyrics_at(port, "1234567890", false).unwrap().lines, [(Some(3.5), "虚构的一行".to_string())]);
        assert!(read.lock().unwrap()[0].contains("const id = \"1234567890\";\n  const load = false;"));
        let asked = asked.lock().unwrap();
        assert_eq!(asked.len(), 1);
        let script = &asked[0];
        assert!(script.contains("const id = \"1234567890\";\n  const load = true;"));
        // Only for the song that plays, only while NetEase holds none of its lyrics and loads none, and
        // only the action NetEase's playing page dispatches when it opens.
        assert!(script.contains("if (playing.resourceTrackId == null || String(playing.resourceTrackId) !== id) return { status: 'changed' };"));
        assert!(script.contains("if (owner === '' || (owner !== id && owner !== online)) {\n    if (lyric.isLoading) return { status: 'loading' };\n    if (!load) return { status: lyric.isLyricFetchFailed === true ? 'failed' : 'none' };"));
        assert!(script.contains("store.dispatch({ type: 'async:lyric/fetchLyric', payload: { force: true } });"));
        assert_eq!(script.matches("dispatch(").count(), 1);
        assert!(script.contains("if (lyric.displayType !== 'default') return { status: 'none' };"));
        for other in ["playOneTrackInPlayingList", "setPlayingPosition", "doAction", "curPlayingList", "localTrack", "filename"] {
            assert!(!script.contains(other), "{other}");
        }
    }

    #[test]
    fn a_missing_store_is_an_error_not_an_unavailable_port() {
        let (port, _) = fake_devtools(targets(), json!({ "store": false }));
        assert_eq!(state_at(port).unwrap_err(), ERR_STORE);
        let (port, _) = fake_devtools(targets(), json!("store"));
        assert_eq!(play_at(port, "42").unwrap_err(), ERR_STORE);
    }

    #[test]
    fn a_closed_port_is_unavailable_quickly() {
        let port = closed_port();
        let started = Instant::now();
        assert_eq!(state_at(port).unwrap(), DebugState::default());
        assert!(started.elapsed() < STATE_BUDGET, "{:?}", started.elapsed());
        assert_eq!(
            play_at(port, "42").unwrap_err(),
            "未检测到网易云调试端口（9233），请以调试端口启动网易云"
        );
    }

    #[test]
    fn a_peer_that_feeds_bytes_slowly_cannot_hold_a_call_past_its_budget() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let dripped = Arc::new(Mutex::new(0usize));
        let drips = dripped.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut start = [0u8; 10];
                let mut peeked = 0;
                while peeked < start.len() {
                    match stream.peek(&mut start) {
                        Ok(count) if count > 0 => peeked = count,
                        _ => break,
                    }
                }
                if &start == b"GET /json/" {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                        head.push(byte[0]);
                    }
                    let body = targets().to_string();
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    continue;
                }
                // The page socket: one byte of a handshake reply every 200 ms, never finishing.
                let drips = drips.clone();
                std::thread::spawn(move || {
                    let reply = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nX-Pad: ";
                    for byte in reply.iter().chain(std::iter::repeat(&b'a')).take(600) {
                        if stream.write_all(&[*byte]).is_err() {
                            break;
                        }
                        *drips.lock().unwrap() += 1;
                        std::thread::sleep(Duration::from_millis(200));
                    }
                });
            }
        });
        let started = Instant::now();
        assert_eq!(state_at(port).unwrap(), DebugState::default());
        let elapsed = started.elapsed();
        // The whole budget was spent waiting on the dripping handshake, and not much more.
        assert!(*dripped.lock().unwrap() >= 4, "the page socket was never reached");
        assert!(elapsed >= Duration::from_millis(1000), "{elapsed:?}");
        assert!(elapsed < STATE_BUDGET + Duration::from_millis(700), "{elapsed:?}");
    }

    #[test]
    fn a_port_without_the_netease_page_is_unavailable() {
        let list = json!([{ "id": "tab", "type": "page", "url": "https://example.com/",
            "webSocketDebuggerUrl": "ws://127.0.0.1:1/devtools/page/tab" }]);
        let (port, expressions) = fake_devtools(list, json!("sent"));
        assert_eq!(state_at(port).unwrap(), DebugState::default());
        assert_eq!(play_at(port, "42").unwrap_err(), ERR_PORT);
        assert!(expressions.lock().unwrap().is_empty());
    }
}
