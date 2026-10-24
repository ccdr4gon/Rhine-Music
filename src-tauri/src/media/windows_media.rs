use super::{player_source, Action, Capabilities, Snapshot, Source};
use crate::netease_music::connector::{self as netease, window::WindowFallback};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    collections::HashMap,
    sync::{
        mpsc::{self, SyncSender},
        OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows::{
    core::{Interface, RuntimeType, HSTRING},
    ApplicationModel::AppInfo,
    Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionMediaProperties as Properties,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Playback,
    },
    Storage::Streams::DataReader,
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
};
use windows_future::{AsyncStatus, IAsyncOperation};

const MAX_COVER_BYTES: u64 = 2 * 1024 * 1024;
const ASYNC_TIMEOUT: Duration = Duration::from_secs(2);
/// How long a song is new for its cover (cover_due): a player may publish the title first and the
/// picture a moment later, or leave the previous song's picture up until its own has downloaded.
const COVER_SETTLE: Duration = Duration::from_secs(10);
/// The shortest step between two reads of a new song's cover.
const COVER_STEP: Duration = Duration::from_millis(500);
/// After that, the cover of the same song is read again this often.
const COVER_RECHECK: Duration = Duration::from_secs(30);
/// How long a new song's timeline may still be the previous song's (Clock::read): QQ Music writes
/// it about 1–1.3 s after the title. A player that never writes one for the new song (or sent the
/// song in two parts) gets its timeline back after this, as before.
const TIMELINE_SETTLE: Duration = Duration::from_secs(5);
type Outcome<T> = Result<T, String>;
enum Request {
    Snapshot {
        /// The cover revision of each source the reader holds (`media::snapshot_known`).
        known: HashMap<String, u64>,
        deadline: Instant,
        reply: mpsc::Sender<Outcome<Snapshot>>,
    },
    Control {
        id: String,
        action: Action,
        position: Option<f64>,
        global_keys: bool,
        deadline: Instant,
        reply: mpsc::Sender<Outcome<()>>,
    },
}
static WORKER: OnceLock<SyncSender<Request>> = OnceLock::new();

fn worker() -> &'static SyncSender<Request> {
    WORKER.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel(4);
        std::thread::Builder::new()
            .name("rhine-media".into())
            .spawn(move || {
                let apartment = Apartment::new();
                let mut state = State::default();
                for request in receiver {
                    match request {
                        Request::Snapshot {
                            known,
                            deadline,
                            reply,
                        } => {
                            let _ = reply.send(if Instant::now() >= deadline {
                                Err("媒体读取请求已过期".into())
                            } else {
                                match &apartment {
                                    Ok(_) => state.snapshot(&known),
                                    Err(error) => Err(error.clone()),
                                }
                            });
                        }
                        Request::Control {
                            id,
                            action,
                            position,
                            global_keys,
                            deadline,
                            reply,
                        } => {
                            let _ = reply.send(if Instant::now() >= deadline {
                                Err("媒体控制请求已过期，未发送操作".into())
                            } else {
                                match &apartment {
                                    Ok(_) => {
                                        state.control(&id, action, position, global_keys, deadline)
                                    }
                                    Err(error) => Err(error.clone()),
                                }
                            });
                        }
                    }
                }
                // Release the manager/session COM objects before uninitialization.
                drop(state);
                drop(apartment);
            })
            .expect("start media worker");
        sender
    })
}
pub(super) fn snapshot(known: HashMap<String, u64>) -> Outcome<Snapshot> {
    let (reply, receive) = mpsc::channel();
    worker()
        .try_send(Request::Snapshot {
            known,
            deadline: Instant::now() + Duration::from_secs(15),
            reply,
        })
        .map_err(|_| "媒体来源正在刷新，请稍后重试".to_string())?;
    receive
        .recv_timeout(Duration::from_secs(15))
        .map_err(|_| "读取媒体来源超时".to_string())?
}
pub(super) fn control(
    id: &str,
    action: Action,
    position: Option<f64>,
    global_keys: bool,
) -> Outcome<()> {
    let (reply, receive) = mpsc::channel();
    worker()
        .try_send(Request::Control {
            id: id.into(),
            action,
            position,
            global_keys,
            deadline: Instant::now() + Duration::from_secs(15),
            reply,
        })
        .map_err(|_| "媒体来源正在刷新，请稍后重试".to_string())?;
    receive
        .recv_timeout(Duration::from_secs(15))
        .map_err(|_| "媒体控制超时，未确认播放结果".to_string())?
}

pub(crate) fn win_error(error: windows::core::Error) -> String {
    format!("Windows 媒体服务：{error}")
}
fn wait<T: RuntimeType>(operation: IAsyncOperation<T>) -> Outcome<T> {
    let deadline = Instant::now() + ASYNC_TIMEOUT;
    while operation.Status().map_err(win_error)? == AsyncStatus::Started {
        if Instant::now() >= deadline {
            let _ = operation.Cancel();
            return Err("媒体来源响应超时".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    operation.GetResults().map_err(win_error)
}
struct Apartment;
impl Apartment {
    fn new() -> Outcome<Self> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(win_error)?;
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

struct Entry {
    id: String,
    session: Session,
    app: String,
    name: String,
    cover_key: String,
    cover: Option<String>,
    /// When the song of `cover_key` was first seen, and when its cover was last read (cover_due).
    cover_since: Option<Instant>,
    cover_checked: Option<Instant>,
    /// `Source::cover_rev`: one more at every change of `cover`.
    cover_rev: u64,
    /// The title, artist and album last read: what a read that fails goes out with (keep_song).
    song: Option<[String; 3]>,
    /// What the session's timeline readings are judged by (Clock::read).
    clock: Clock,
}
impl Entry {
    fn set_cover(&mut self, cover: Option<String>) {
        if self.cover != cover {
            self.cover = cover;
            self.cover_rev += 1;
        }
    }
}
#[derive(Default)]
struct State {
    manager: Option<Manager>,
    entries: Vec<Entry>,
    /// NetEase without a media session of its own (netease_music/connector/window.rs).
    netease: WindowFallback,
}
fn app_counts<'a>(apps: impl IntoIterator<Item = &'a str>) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for app in apps {
        *counts.entry(app.to_owned()).or_default() += 1;
    }
    counts
}
/// Match exact COM identity first. Only a one-to-one official application ID
/// may replace its session; neither display names nor media text participate.
fn match_session(
    app: &str,
    canonical: Option<usize>,
    old_apps: &[&str],
    old_counts: &HashMap<String, usize>,
    new_counts: &HashMap<String, usize>,
) -> Option<(usize, bool)> {
    if let Some(index) = canonical.filter(|index| old_apps.get(*index) == Some(&app)) {
        return Some((index, false));
    }
    if app.is_empty() || old_counts.get(app) != Some(&1) || new_counts.get(app) != Some(&1) {
        return None;
    }
    old_apps
        .iter()
        .position(|old| *old == app)
        .map(|index| (index, true))
}
impl State {
    fn refresh_sessions(&mut self) -> Outcome<()> {
        if self.manager.is_none() {
            self.manager = Some(wait(Manager::RequestAsync().map_err(win_error)?)?);
        }
        let found = match self.manager.as_ref().unwrap().GetSessions() {
            Ok(sessions) => sessions,
            Err(error) => {
                // A failed enumeration, like the ones below: the sessions' ids and covers stay
                // (snapshot offers them with no control) for the next manager to match, and the
                // page does not take them for gone.
                self.manager = None;
                return Err(win_error(error));
            }
        };
        // Enumeration is transactional: another app can close between GetAt
        // and SourceAppUserModelId. Do not discard unrelated identity/cache
        // entries unless the complete new list was successfully observed.
        let mut observed = Vec::new();
        for index in 0..found.Size().map_err(win_error)? {
            let session = found.GetAt(index).map_err(win_error)?;
            let app =
                if let Some(entry) = self.entries.iter().find(|entry| entry.session == session) {
                    entry.app.clone()
                } else {
                    session
                        .SourceAppUserModelId()
                        .map_err(win_error)?
                        .to_string_lossy()
                };
            observed.push((session, app));
        }
        // Windows may rebuild the COM session when the same player changes or
        // loops a track. A unique official AppUserModelID can preserve the
        // user's player selection; shared IDs must never guess between tabs or
        // instances. Counts are from the complete lists, before any removals.
        let old_counts = app_counts(self.entries.iter().map(|entry| entry.app.as_str()));
        let new_counts = app_counts(observed.iter().map(|(_, app)| app.as_str()));
        let mut old = std::mem::take(&mut self.entries);
        let mut next = Vec::new();
        for (session, app) in observed {
            let canonical = old.iter().position(|entry| entry.session == session);
            let old_apps: Vec<_> = old.iter().map(|entry| entry.app.as_str()).collect();
            if let Some((index, replaced)) =
                match_session(&app, canonical, &old_apps, &old_counts, &new_counts)
            {
                let mut entry = old.remove(index);
                if replaced {
                    entry.session = session;
                    entry.cover_key.clear();
                    entry.set_cover(None);
                    entry.cover_since = None;
                    entry.cover_checked = None;
                    entry.song = None;
                    entry.clock = Clock::default();
                }
                next.push(entry);
            } else {
                let name = AppInfo::GetFromAppUserModelId(&HSTRING::from(&app))
                    .and_then(|info| info.DisplayInfo())
                    .and_then(|info| info.DisplayName())
                    .map(|name| name.to_string_lossy())
                    .ok()
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| app.clone());
                next.push(Entry {
                    id: format!("smtc-{}", uuid::Uuid::new_v4()),
                    session,
                    app,
                    name,
                    cover_key: String::new(),
                    cover: None,
                    cover_since: None,
                    cover_checked: None,
                    cover_rev: 0,
                    song: None,
                    clock: Clock::default(),
                });
            }
        }
        self.entries = next;
        Ok(())
    }
    fn snapshot(&mut self, known: &HashMap<String, u64>) -> Outcome<Snapshot> {
        let discovery = self.refresh_sessions();
        let mut warnings = Vec::new();
        if let Err(error) = &discovery {
            warnings.push(error.clone());
        }
        let mut sources: Vec<_> = self
            .entries
            .iter_mut()
            .map(|entry| read_source(entry, known))
            .collect();
        if discovery.is_err() {
            // The cached ID is retained for retry, not authorization. Control
            // also re-enumerates and returns the error before sending anything.
            for source in &mut sources {
                source.capabilities = Capabilities::default();
            }
        }
        if let Err(error) = self.netease.refresh() {
            warnings.push(error);
        }
        let netease_smtc = self.entries.iter().any(|entry| netease::is_app(&entry.app));
        if !netease_smtc {
            let no_competitor = discovery.is_ok() && self.entries.is_empty();
            if let Some(source) = self.netease.source(no_competitor) {
                sources.push(source);
            }
        }
        Ok(Snapshot {
            sources,
            warning: (!warnings.is_empty()).then(|| warnings.join("；")),
        })
    }
    fn control(
        &mut self,
        id: &str,
        action: Action,
        position: Option<f64>,
        global_keys: bool,
        deadline: Instant,
    ) -> Outcome<()> {
        // Refresh before every action. Only the selected canonical session, or
        // the unambiguous same official app identity, can receive the action.
        // An observed disappearance removes the old ID before any later return.
        self.refresh_sessions()?;
        if WindowFallback::owns(id) {
            let other_sessions = !self.entries.is_empty();
            return self.netease.control(id, action, global_keys, other_sessions, deadline);
        }
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.id == id)
            .ok_or("选中的媒体来源已断开，请重新选择")?;
        let playback = entry.session.GetPlaybackInfo().map_err(win_error)?;
        let controls = playback.Controls().map_err(win_error)?;
        let native_toggle = controls.IsPlayPauseToggleEnabled().unwrap_or(false);
        let playing = playback.PlaybackStatus().map_err(win_error)?;
        let enabled = match action {
            Action::Toggle => Ok(can_toggle(
                playing,
                native_toggle,
                controls.IsPlayEnabled().unwrap_or(false),
                controls.IsPauseEnabled().unwrap_or(false),
            )),
            Action::Previous => controls.IsPreviousEnabled(),
            Action::Next => controls.IsNextEnabled(),
            Action::Stop => controls.IsStopEnabled(),
            Action::Seek => controls.IsPlaybackPositionEnabled(),
        }
        .map_err(win_error)?;
        if !enabled {
            return Err("当前来源不支持此操作".into());
        }
        if Instant::now() >= deadline {
            return Err("媒体控制请求已过期，未发送操作".into());
        }
        let operation = match action {
            Action::Toggle if native_toggle => entry.session.TryTogglePlayPauseAsync(),
            Action::Toggle if playing == Playback::Playing => entry.session.TryPauseAsync(),
            Action::Toggle => entry.session.TryPlayAsync(),
            Action::Previous => entry.session.TrySkipPreviousAsync(),
            Action::Next => entry.session.TrySkipNextAsync(),
            Action::Stop => entry.session.TryStopAsync(),
            Action::Seek => {
                let timeline = entry.session.GetTimelineProperties().map_err(win_error)?;
                let start = timeline.StartTime().map_err(win_error)?.Duration;
                let target = start as f64 + position.ok_or("缺少跳转秒数")? * 10_000_000.0;
                let min = timeline
                    .MinSeekTime()
                    .map_err(win_error)?
                    .Duration
                    .max(start);
                let max = timeline
                    .MaxSeekTime()
                    .map_err(win_error)?
                    .Duration
                    .min(timeline.EndTime().map_err(win_error)?.Duration);
                if !target.is_finite() || target < min as f64 || target > max as f64 || max <= min {
                    return Err("跳转位置超出当前来源可用范围".into());
                }
                entry
                    .session
                    .TryChangePlaybackPositionAsync(target.round() as i64)
            }
        }
        .map_err(win_error)?;
        if wait(operation)? {
            Ok(())
        } else {
            Err("来源未接受此操作，播放状态未确认".into())
        }
    }
}

/// When a session's cover is read again. A song just seen (`same_song` false) is read at once.
/// While it is new (COVER_SETTLE), a player may still be putting its picture up, so it is read
/// again at doubling steps (about 0.5, 1, 2, 4 and 8 s into the song, at the polls nearest them);
/// then every COVER_RECHECK. A read that failed waits for the same steps, so a player that keeps
/// failing slows no snapshot down for longer than one read in each step.
fn cover_due(same_song: bool, song_age: Duration, since_check: Option<Duration>) -> bool {
    let Some(since_check) = since_check.filter(|_| same_song) else {
        return true;
    };
    if song_age < COVER_SETTLE {
        since_check >= COVER_STEP.max(song_age / 2)
    } else {
        since_check > COVER_RECHECK
    }
}

/// `known`: the cover revision of each source the reader holds; a cover still at that revision is
/// not copied into the snapshot (`Source::cover_rev`).
fn read_source(entry: &mut Entry, known: &HashMap<String, u64>) -> Source {
    let mut source = blank_source(&entry.id, &entry.name, &entry.app);
    let mut read_song = false;
    let result = (|| -> Outcome<()> {
        let media = wait(
            entry
                .session
                .TryGetMediaPropertiesAsync()
                .map_err(win_error)?,
        )?;
        source.title = media.Title().map_err(win_error)?.to_string_lossy();
        source.artist = media.Artist().map_err(win_error)?.to_string_lossy();
        source.album = media.AlbumTitle().map_err(win_error)?.to_string_lossy();
        entry.song = Some([
            source.title.clone(),
            source.artist.clone(),
            source.album.clone(),
        ]);
        read_song = true;
        let cover_key = format!("{}\0{}\0{}", source.title, source.artist, source.album);
        let now = Instant::now();
        let same_song = entry.cover_key == cover_key;
        if !same_song || entry.cover_since.is_none() {
            entry.cover_since = Some(now);
        }
        let age = |at: Option<Instant>| at.map(|at| now.saturating_duration_since(at));
        if cover_due(
            same_song,
            age(entry.cover_since).unwrap_or_default(),
            age(entry.cover_checked),
        ) {
            match read_cover(&media) {
                Ok(cover) => entry.set_cover(cover),
                // A read that failed keeps the cover this song had.
                Err(_) if same_song => {}
                Err(_) => entry.set_cover(None),
            }
            entry.cover_key.clone_from(&cover_key);
            entry.cover_checked = Some(now);
        }
        source.cover_rev = entry.cover_rev;
        if known.get(&entry.id) != Some(&entry.cover_rev) {
            source.cover_url = entry.cover.clone();
        }
        let playback = entry.session.GetPlaybackInfo().map_err(win_error)?;
        let state = playback.PlaybackStatus().map_err(win_error)?;
        source.playback = playback_name(state).into();
        let flags = playback.Controls().map_err(win_error)?;
        source.capabilities = Capabilities {
            toggle: can_toggle(
                state,
                flags.IsPlayPauseToggleEnabled().unwrap_or(false),
                flags.IsPlayEnabled().unwrap_or(false),
                flags.IsPauseEnabled().unwrap_or(false),
            ),
            previous: flags.IsPreviousEnabled().unwrap_or(false),
            next: flags.IsNextEnabled().unwrap_or(false),
            stop: flags.IsStopEnabled().unwrap_or(false),
            seek: false,
        };
        let playing = state == Playback::Playing;
        let mut read = None;
        let mut seekable = false;
        if let Ok(timeline) = entry.session.GetTimelineProperties() {
            let start = timeline.StartTime().map_err(win_error)?.Duration;
            let end = timeline.EndTime().map_err(win_error)?.Duration;
            if end > start && start >= 0 {
                read = Some(Timeline {
                    start,
                    end,
                    position: timeline.Position().map_err(win_error)?.Duration,
                    // Only a time after 1970 is one the player wrote.
                    updated: timeline
                        .LastUpdatedTime()
                        .ok()
                        .map(|at| at.UniversalTime)
                        .filter(|at| *at > 116_444_736_000_000_000)
                        .map(|at| at as f64 / 10_000_000.0),
                    rate: if playing {
                        playback
                            .PlaybackRate()
                            .and_then(|r| r.Value())
                            .unwrap_or(1.0)
                    } else {
                        1.0
                    },
                });
                seekable = flags.IsPlaybackPositionEnabled().unwrap_or(false)
                    && timeline.MaxSeekTime().map(|t| t.Duration).unwrap_or(0)
                        > timeline.MinSeekTime().map(|t| t.Duration).unwrap_or(0);
            }
        }
        if let Some((position, duration)) =
            entry.clock.read(windows_now(), &cover_key, playing, read)
        {
            source.duration = Some(duration);
            source.position = Some(position);
            source.capabilities.seek = seekable;
        }
        Ok(())
    })();
    if let Err(error) = result {
        if let Some(song) = entry.song.as_ref().filter(|_| !read_song) {
            keep_song(&mut source, song, &entry.cover, entry.cover_rev, known);
        }
        source.warning = Some(error);
    }
    // Marked (and, for QQ Music and NetEase, named) by the module of the player it belongs to, if any.
    player_source(&entry.app, source)
}

/// A session's source before anything is read from it.
fn blank_source(id: &str, name: &str, app: &str) -> Source {
    Source {
        id: id.into(),
        name: name.into(),
        kind: "smtc".into(),
        title: String::new(),
        artist: String::new(),
        album: String::new(),
        cover_url: None,
        cover_rev: 0,
        playback: "unknown".into(),
        position: None,
        duration: None,
        capabilities: Capabilities::default(),
        warning: None,
        player: None,
        // The session's app id: how a player Rhine does not know is remembered (never its id).
        app: (!app.is_empty()).then(|| app.into()),
    }
}

/// A read that failed before it reached the song is no new song: the source goes out with the
/// song last read and its cover (`known` as in read_source), still with no playback state,
/// timeline or controls. The page would otherwise take the gap for another song and build its
/// card twice.
fn keep_song(
    source: &mut Source,
    song: &[String; 3],
    cover: &Option<String>,
    cover_rev: u64,
    known: &HashMap<String, u64>,
) {
    [source.title, source.artist, source.album] = song.clone();
    source.cover_rev = cover_rev;
    if known.get(&source.id) != Some(&cover_rev) {
        source.cover_url = cover.clone();
    }
}

/// Opened is a song loaded and not started (QQ Music restores its last song so on launch; Play on,
/// Pause off): not playing, as can_toggle takes it. Changing is unknown.
fn playback_name(state: Playback) -> &'static str {
    match state {
        Playback::Playing => "playing",
        Playback::Paused => "paused",
        Playback::Stopped | Playback::Closed | Playback::Opened => "stopped",
        _ => "unknown",
    }
}

/// The time now as Windows writes it (LastUpdatedTime): seconds since 1601.
fn windows_now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        + 11_644_473_600.0
}

/// One reading of a session's timeline: start, end and position in 100 ns ticks; `updated` is its
/// LastUpdatedTime in seconds since 1601, when the player gave one.
#[derive(Clone, Copy)]
struct Timeline {
    start: i64,
    end: i64,
    position: i64,
    updated: Option<f64>,
    rate: f64,
}

/// What a session's past readings say about its timeline (times in seconds since 1601).
#[derive(Default)]
struct Clock {
    /// The song (title, artist, album) last read, and the EndTime last read.
    song: Option<String>,
    end: Option<i64>,
    /// When the song changed from one read before (never at a session's first sighting), and the
    /// EndTime last read before that.
    song_since: Option<f64>,
    previous_end: Option<i64>,
    /// The last reading that was not Playing, and the first Playing reading after it.
    idle_seen: Option<f64>,
    playing_since: Option<f64>,
}
impl Clock {
    /// The position and duration (seconds) a reading at `now` gives, or none while its timeline
    /// is not this song's. QQ Music reports Playing, and a new song's title, about 1 s before it
    /// writes the timeline, so:
    /// - a timeline written before the song changed, with the EndTime read before, is still the
    ///   previous song's: nothing is sent until the player writes one for this song (or
    ///   TIMELINE_SETTLE has passed). One with another EndTime was written for this song first.
    /// - while playing, a timeline written before the last reading that was not Playing is the
    ///   one from before the pause: the position runs on from the first Playing reading, not
    ///   across the pause.
    ///
    /// A session's first sighting is taken as it comes.
    fn read(
        &mut self,
        now: f64,
        song: &str,
        playing: bool,
        timeline: Option<Timeline>,
    ) -> Option<(f64, f64)> {
        if self.song.as_deref() != Some(song) {
            if self.song.is_some() {
                self.song_since = Some(now);
                self.previous_end = self.end;
            }
            self.song = Some(song.into());
        }
        if playing {
            self.playing_since.get_or_insert(now);
        } else {
            self.idle_seen = Some(now);
            self.playing_since = None;
        }
        let timeline = timeline?;
        let previous_song = matches!(
            (timeline.updated, self.song_since),
            (Some(updated), Some(since))
                if updated < since && now - since < TIMELINE_SETTLE.as_secs_f64()
        ) && self.previous_end == Some(timeline.end);
        self.end = Some(timeline.end);
        if previous_song || timeline.end <= timeline.start || timeline.start < 0 {
            return None;
        }
        let duration = (timeline.end - timeline.start) as f64 / 10_000_000.0;
        let mut position = (timeline.position - timeline.start) as f64 / 10_000_000.0;
        if playing {
            let from = match (timeline.updated, self.idle_seen, self.playing_since) {
                (Some(updated), Some(idle), Some(since)) if updated < idle => Some(since),
                (updated, ..) => updated,
            };
            if let Some(elapsed) = from
                .map(|from| now - from)
                .filter(|elapsed| *elapsed >= 0.0)
            {
                if timeline.rate.is_finite() && timeline.rate >= 0.0 {
                    position += elapsed * timeline.rate;
                }
            }
        }
        Some((position.clamp(0.0, duration), duration))
    }
}

fn read_cover(media: &Properties) -> Outcome<Option<String>> {
    let Ok(thumbnail) = media.Thumbnail() else {
        return Ok(None);
    };
    let stream = wait(thumbnail.OpenReadAsync().map_err(win_error)?)?;
    let size = stream.Size().map_err(win_error)?;
    if size == 0 || size > MAX_COVER_BYTES {
        return Ok(None);
    }
    let declared = stream
        .ContentType()
        .map_err(win_error)?
        .to_string_lossy()
        .to_lowercase();
    if !declared_types(&declared).any(|mime| {
        matches!(
            mime,
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        )
    }) {
        return Ok(None);
    }
    let input = stream.GetInputStreamAt(0).map_err(win_error)?;
    let reader = DataReader::CreateDataReader(&input).map_err(win_error)?;
    let operation = reader
        .LoadAsync(size as u32)
        .map_err(win_error)?
        .cast::<IAsyncOperation<u32>>()
        .map_err(win_error)?;
    let count = wait(operation)?;
    if count as u64 != size {
        return Ok(None);
    }
    let mut bytes = vec![0; count as usize];
    reader.ReadBytes(&mut bytes).map_err(win_error)?;
    let Some(mime) = declared_image_type(&declared, &bytes) else {
        return Ok(None);
    };
    Ok(Some(format!(
        "data:{mime};base64,{}",
        STANDARD.encode(bytes)
    )))
}
/// Players may declare one type or a list; NetEase sends "image/jpeg,image/jpe,image/jpg".
fn declared_types(declared: &str) -> impl Iterator<Item = &str> + '_ {
    declared.split([',', ';']).map(str::trim)
}
/// Only a declared raster type whose signature the bytes actually carry is accepted.
fn declared_image_type<'a>(declared: &'a str, bytes: &[u8]) -> Option<&'a str> {
    declared_types(declared).find(|mime| valid_image(mime, bytes))
}
fn valid_image(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    }
}
fn can_toggle(state: Playback, toggle: bool, play: bool, pause: bool) -> bool {
    toggle
        || (state == Playback::Playing && pause)
        || (matches!(
            state,
            Playback::Paused | Playback::Stopped | Playback::Opened
        ) && play)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn thumbnails_require_matching_raster_signature() {
        assert!(valid_image("image/png", b"\x89PNG\r\n\x1a\nfixture"));
        assert!(!valid_image("image/png", b"<svg onload='alert(1)'>"));
        assert!(!valid_image("image/svg+xml", b"<svg/>"));
        assert!(!valid_image("image/webp", b"RIFF"));
    }
    #[test]
    fn declared_type_lists_accept_only_the_type_the_bytes_carry() {
        let jpeg = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
        assert_eq!(
            declared_image_type("image/jpeg,image/jpe,image/jpg", &jpeg),
            Some("image/jpeg")
        );
        assert_eq!(
            declared_image_type("image/png; charset=binary", b"\x89PNG\r\n\x1a\nfixture"),
            Some("image/png")
        );
        assert_eq!(declared_image_type("image/png,image/gif", &jpeg), None);
        assert_eq!(
            declared_image_type("image/svg+xml,image/png", b"<svg onload='alert(1)'>"),
            None
        );
        assert_eq!(declared_image_type("", &jpeg), None);
    }
    #[test]
    fn a_new_songs_cover_is_read_again_while_the_player_may_still_be_putting_it_up() {
        let ms = Duration::from_millis;
        // Another song, or a cover never read: at once.
        assert!(cover_due(false, ms(0), Some(ms(100))));
        assert!(cover_due(true, ms(40_000), None));
        // The polls of the first seconds (about every 1.1 s): read at doubling steps, so a picture
        // published a moment after the title is shown within a poll or two, not 30 s later.
        let mut read = Vec::new();
        let mut checked = ms(0);
        for poll in 1..=40u64 {
            let at = ms(poll * 1100);
            if cover_due(true, at, Some(at - checked)) {
                read.push(at.as_millis());
                checked = at;
            }
        }
        assert_eq!(read[..4], [1100, 2200, 4400, 8800], "{read:?}");
        // Then every 30 s, as before.
        assert!(read[4..].iter().all(|at| *at > 30_000), "{read:?}");
        assert!(!cover_due(true, ms(20_000), Some(ms(29_000))));
        assert!(cover_due(true, ms(60_000), Some(ms(30_001))));
        // The quick reads after a control (every 150 ms) are not each a read of the picture.
        assert!(!cover_due(true, ms(300), Some(ms(150))));
    }
    #[test]
    fn toggle_uses_explicit_play_or_pause_only_for_a_known_playback_state() {
        assert!(can_toggle(Playback::Playing, false, false, true));
        assert!(can_toggle(Playback::Paused, false, true, false));
        assert!(!can_toggle(Playback::Changing, false, true, true));
        assert!(!can_toggle(Playback::Playing, false, true, false));
    }
    #[test]
    fn session_matching_prefers_canonical_identity_even_with_a_shared_app_id() {
        let apps = ["Browser.Shared", "Browser.Shared"];
        let counts = app_counts(apps);
        assert_eq!(
            match_session("Browser.Shared", Some(1), &apps, &counts, &counts),
            Some((1, false))
        );
    }
    #[test]
    fn unique_official_app_id_retains_selection_after_track_session_recreation() {
        let apps = ["Player.Unique", "Other.Player"];
        let counts = app_counts(apps);
        assert_eq!(
            match_session("Player.Unique", None, &apps, &counts, &counts),
            Some((0, true))
        );
        // Two players may have an identical display name or song. Only their
        // distinct official app IDs are inputs to matching, so no remap occurs.
        assert_eq!(
            match_session(
                "Different.Player",
                None,
                &apps,
                &counts,
                &app_counts(["Different.Player"])
            ),
            None
        );
        assert_eq!(
            match_session(
                "Different.Player",
                Some(0),
                &apps,
                &counts,
                &app_counts(["Different.Player"])
            ),
            None
        );
    }
    #[test]
    fn ambiguous_old_or_new_app_groups_never_guess_a_replacement() {
        let single = app_counts(["Shared"]);
        let multiple = app_counts(["Shared", "Shared"]);
        for (old, new) in [
            (&single, &multiple),
            (&multiple, &single),
            (&multiple, &multiple),
        ] {
            // Counts remain from the original full list even if a canonical
            // match already removed another entry from the working list.
            assert_eq!(match_session("Shared", None, &["Shared"], old, new), None);
        }
    }
    #[test]
    fn an_observed_disappearance_or_missing_app_id_cannot_reconnect_an_old_selection() {
        assert_eq!(
            match_session(
                "Player.Unique",
                None,
                &[],
                &app_counts([]),
                &app_counts(["Player.Unique"])
            ),
            None
        );
        assert_eq!(
            match_session("", None, &[""], &app_counts([""]), &app_counts([""])),
            None
        );
    }
    #[test]
    fn opened_is_a_loaded_song_that_is_not_playing() {
        // QQ Music on launch: its last song restored, Play on, Pause off.
        assert_eq!(playback_name(Playback::Opened), "stopped");
        assert_eq!(playback_name(Playback::Stopped), "stopped");
        assert_eq!(playback_name(Playback::Closed), "stopped");
        assert_eq!(playback_name(Playback::Playing), "playing");
        assert_eq!(playback_name(Playback::Paused), "paused");
        assert_eq!(playback_name(Playback::Changing), "unknown");
    }
    #[test]
    fn a_failed_read_goes_out_with_the_last_song_and_its_cover() {
        let song = [
            "Fictional Song".to_string(),
            "Fictional Artist".into(),
            "Fictional Album".into(),
        ];
        let cover = Some("data:image/png;base64,AAAA".to_string());
        let failed = |known: &HashMap<String, u64>| {
            let mut source = blank_source("smtc-fixture", "Fictional Player", "Fictional.Player!App");
            keep_song(&mut source, &song, &cover, 3, known);
            source
        };
        let shown = failed(&HashMap::new());
        assert_eq!(
            [&shown.title, &shown.artist, &shown.album],
            [&song[0], &song[1], &song[2]]
        );
        assert_eq!((shown.cover_rev, &shown.cover_url), (3, &cover));
        // Still no playback state, timeline or controls.
        assert_eq!(shown.playback, "unknown");
        assert!(shown.position.is_none() && shown.duration.is_none());
        let controls = &shown.capabilities;
        assert!(!(controls.toggle || controls.previous || controls.next));
        assert!(!(controls.stop || controls.seek));
        // A reader that holds that cover gets only its revision, as after a good read.
        let held = failed(&HashMap::from([("smtc-fixture".to_string(), 3)]));
        assert_eq!((held.cover_rev, held.cover_url), (3, None));
        assert_eq!(held.title, song[0]);
    }

    const A: &str = "Fictional Song A\0Fictional Artist\0";
    const B: &str = "Fictional Song B\0Fictional Artist\0";
    /// A timeline as a player writes it: seconds into the song, its length, and when it was
    /// written (seconds since 1601).
    fn timeline(position: f64, length: f64, updated: f64) -> Option<Timeline> {
        let ticks = |seconds: f64| (seconds * 10_000_000.0).round() as i64;
        Some(Timeline {
            start: 0,
            end: ticks(length),
            position: ticks(position),
            updated: Some(updated),
            rate: 1.0,
        })
    }
    #[track_caller]
    fn shows(read: Option<(f64, f64)>, position: f64, length: f64) {
        let (at, of) = read.expect("a timeline");
        assert!(
            (at - position).abs() < 1e-6 && (of - length).abs() < 1e-6,
            "{at} / {of}, not {position} / {length}"
        );
    }
    #[test]
    fn a_first_sighting_and_steady_playing_run_on_from_the_players_time() {
        // First sighting while playing: a timeline written 76 s ago runs on, as before.
        let mut clock = Clock::default();
        shows(
            clock.read(1076.0, A, true, timeline(20.0, 206.1, 1000.0)),
            96.0,
            206.1,
        );
        shows(
            clock.read(1077.0, A, true, timeline(20.0, 206.1, 1000.0)),
            97.0,
            206.1,
        );
        // The player writes again: from that.
        shows(
            clock.read(1078.0, A, true, timeline(97.5, 206.1, 1077.5)),
            98.0,
            206.1,
        );
        // First sighting while paused: as written.
        let mut clock = Clock::default();
        shows(
            clock.read(1000.0, A, false, timeline(96.08, 206.1, 900.0)),
            96.08,
            206.1,
        );
    }
    #[test]
    fn a_resume_after_a_long_pause_does_not_add_the_pause() {
        let mut clock = Clock::default();
        shows(
            clock.read(1000.0, A, true, timeline(10.0, 206.1, 990.0)),
            20.0,
            206.1,
        );
        // Paused at 96.08 s for 76 s.
        for at in 1087..=1162 {
            clock.read(at as f64, A, false, timeline(96.08, 206.1, 1086.5));
        }
        // QQ Music reports Playing about 1.3 s before it writes the timeline again: the position
        // runs on from the first Playing reading (before, 172.08 s).
        shows(
            clock.read(1162.5, A, true, timeline(96.08, 206.1, 1086.5)),
            96.08,
            206.1,
        );
        shows(
            clock.read(1163.5, A, true, timeline(96.08, 206.1, 1086.5)),
            97.08,
            206.1,
        );
        // Then from the timeline it writes.
        shows(
            clock.read(1164.5, A, true, timeline(97.4, 206.1, 1163.8)),
            98.1,
            206.1,
        );
    }
    #[test]
    fn a_new_song_never_shows_the_previous_songs_timeline() {
        // 下一首 while playing A (3:26) at 15 s: the new title and Playing come first, with A's
        // timeline written at the press.
        let mut clock = Clock::default();
        shows(
            clock.read(1000.0, A, true, timeline(14.0, 206.1, 999.0)),
            15.0,
            206.1,
        );
        assert_eq!(
            clock.read(1001.0, B, true, timeline(15.7, 206.1, 1000.7)),
            None
        );
        assert_eq!(
            clock.read(1002.0, B, true, timeline(15.7, 206.1, 1000.7)),
            None
        );
        // QQ Music writes B's own (4:00) about 1.3 s later.
        shows(
            clock.read(1003.0, B, true, timeline(1.23, 240.0, 1002.3)),
            1.93,
            240.0,
        );
        // 下一首 after a 3 min pause at 44 s.
        let mut clock = Clock::default();
        clock.read(1000.0, A, false, timeline(44.44, 206.1, 990.0));
        clock.read(1180.0, A, false, timeline(44.44, 206.1, 990.0));
        assert_eq!(
            clock.read(1180.3, B, true, timeline(44.44, 206.1, 990.0)),
            None
        );
        shows(
            clock.read(1181.6, B, true, timeline(0.2, 240.0, 1181.5)),
            0.3,
            240.0,
        );
        // A player that never writes one for the new song gets its timeline back, as before.
        let mut clock = Clock::default();
        clock.read(1000.0, A, false, timeline(44.44, 206.1, 990.0));
        assert_eq!(
            clock.read(1001.0, B, false, timeline(44.44, 206.1, 990.0)),
            None
        );
        let late = 1001.0 + TIMELINE_SETTLE.as_secs_f64();
        shows(
            clock.read(late, B, false, timeline(44.44, 206.1, 990.0)),
            44.44,
            206.1,
        );
    }
    #[test]
    fn a_timeline_written_before_the_new_title_is_the_new_songs() {
        let mut clock = Clock::default();
        clock.read(1000.0, A, true, timeline(100.0, 206.1, 999.0));
        // B's timeline is written at 1000.4 and its title a moment later; Rhine reads at 1001.
        shows(
            clock.read(1001.0, B, true, timeline(0.0, 240.0, 1000.4)),
            0.6,
            240.0,
        );
        shows(
            clock.read(1002.0, B, true, timeline(0.0, 240.0, 1000.4)),
            1.6,
            240.0,
        );
    }
}
