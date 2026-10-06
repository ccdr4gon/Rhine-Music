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
type Outcome<T> = Result<T, String>;
enum Request {
    Snapshot {
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
                        Request::Snapshot { deadline, reply } => {
                            let _ = reply.send(if Instant::now() >= deadline {
                                Err("媒体读取请求已过期".into())
                            } else {
                                match &apartment {
                                    Ok(_) => state.snapshot(),
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
pub(super) fn snapshot() -> Outcome<Snapshot> {
    let (reply, receive) = mpsc::channel();
    worker()
        .try_send(Request::Snapshot {
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
    cover_checked: Option<Instant>,
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
                self.manager = None;
                self.entries.clear();
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
                    entry.cover = None;
                    entry.cover_checked = None;
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
                    cover_checked: None,
                });
            }
        }
        self.entries = next;
        Ok(())
    }
    fn snapshot(&mut self) -> Outcome<Snapshot> {
        let discovery = self.refresh_sessions();
        let mut warnings = Vec::new();
        if let Err(error) = &discovery {
            warnings.push(error.clone());
        }
        let mut sources: Vec<_> = self.entries.iter_mut().map(read_source).collect();
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

fn read_source(entry: &mut Entry) -> Source {
    let mut source = Source {
        id: entry.id.clone(),
        name: entry.name.clone(),
        kind: "smtc".into(),
        title: String::new(),
        artist: String::new(),
        album: String::new(),
        cover_url: None,
        playback: "unknown".into(),
        position: None,
        duration: None,
        capabilities: Capabilities::default(),
        warning: None,
        player: None,
        // The session's app id: how a player Rhine does not know is remembered (never its id).
        app: (!entry.app.is_empty()).then(|| entry.app.clone()),
    };
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
        let cover_key = format!("{}\0{}\0{}", source.title, source.artist, source.album);
        if entry.cover_key != cover_key
            || entry
                .cover_checked
                .is_none_or(|checked| checked.elapsed() > Duration::from_secs(30))
        {
            entry.cover = read_cover(&media).unwrap_or(None);
            entry.cover_key = cover_key;
            entry.cover_checked = Some(Instant::now());
        }
        source.cover_url = entry.cover.clone();
        let playback = entry.session.GetPlaybackInfo().map_err(win_error)?;
        let state = playback.PlaybackStatus().map_err(win_error)?;
        source.playback = match state {
            Playback::Playing => "playing",
            Playback::Paused => "paused",
            Playback::Stopped | Playback::Closed => "stopped",
            _ => "unknown",
        }
        .into();
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
        if let Ok(timeline) = entry.session.GetTimelineProperties() {
            let start = timeline.StartTime().map_err(win_error)?.Duration;
            let end = timeline.EndTime().map_err(win_error)?.Duration;
            if end > start && start >= 0 {
                let duration = (end - start) as f64 / 10_000_000.0;
                let mut position = (timeline.Position().map_err(win_error)?.Duration - start)
                    as f64
                    / 10_000_000.0;
                if state == Playback::Playing {
                    if let Ok(updated) = timeline.LastUpdatedTime() {
                        let now = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs_f64()
                            + 11_644_473_600.0;
                        let elapsed = now - updated.UniversalTime as f64 / 10_000_000.0;
                        if elapsed >= 0.0 && updated.UniversalTime > 116_444_736_000_000_000 {
                            let rate = playback
                                .PlaybackRate()
                                .and_then(|r| r.Value())
                                .unwrap_or(1.0);
                            if rate.is_finite() && rate >= 0.0 {
                                position += elapsed * rate;
                            }
                        }
                    }
                }
                source.duration = Some(duration);
                source.position = Some(position.clamp(0.0, duration));
                source.capabilities.seek = flags.IsPlaybackPositionEnabled().unwrap_or(false)
                    && timeline.MaxSeekTime().map(|t| t.Duration).unwrap_or(0)
                        > timeline.MinSeekTime().map(|t| t.Duration).unwrap_or(0);
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        source.warning = Some(error);
    }
    // Marked (and, for QQ Music, named) by the module of the player it belongs to, if any.
    player_source(&entry.app, source)
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
}
