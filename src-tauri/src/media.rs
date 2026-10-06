//! Read and control sources that already play music. This never logs in to a
//! service or represents the current track as a library. The only files of a
//! player that are read are NetEase Cloud Music's saved queue and, from its local
//! database, the playlists the user created; `netease_music::data::queue` and
//! `netease_music::data::playlists` state exactly which fields.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Toggle,
    Previous,
    Next,
    Stop,
    Seek,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub toggle: bool,
    pub previous: bool,
    pub next: bool,
    pub stop: bool,
    pub seek: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_url: Option<String>,
    pub playback: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    pub capabilities: Capabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    /// The player the source belongs to (`player_of`): "netease" for NetEase Cloud Music,
    /// whose saved play queue the user may choose to show, "qqmusic" for QQ Music (its media
    /// session only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player: Option<String>,
    /// The app id Windows reports for a media session (its AppUserModelId), when it has one: the
    /// same for every session of that player and across restarts, unlike `id`. The page remembers
    /// a player it does not know by it (`playerLink` in its preferences, the owner's 2026-10-06
    /// request); nothing the player plays is ever saved with it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub sources: Vec<Source>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[cfg(target_os = "windows")]
pub(crate) mod windows_media;

/// The player a media session belongs to, by the app id it reports: the source list of the
/// native side. Any other player is still listed, as a source of its own.
pub fn player_of(app: &str) -> Option<&'static str> {
    if crate::netease_music::connector::is_app(app) {
        Some(crate::netease_music::PLAYER)
    } else if crate::qq_music::connector::is_app(app) {
        Some(crate::qq_music::PLAYER)
    } else {
        None
    }
}

/// A media session's source as its player's module shows it: marked with `player_of`, and
/// QQ Music's and NetEase's own program's under their own names (QQ Music's now-playing model,
/// `qq_music::data`; `netease_music::NAME` for `cloudmusic.exe`). Every other source, another
/// session taken for NetEase included, keeps the name Windows gives it.
pub fn player_source(app: &str, source: Source) -> Source {
    match player_of(app) {
        Some(crate::qq_music::PLAYER) => crate::qq_music::data::now_playing(source),
        Some(crate::netease_music::PLAYER) => Source {
            name: if crate::netease_music::connector::is_program(app) {
                crate::netease_music::NAME.into()
            } else {
                source.name.clone()
            },
            player: Some(crate::netease_music::PLAYER.into()),
            ..source
        },
        player => Source {
            player: player.map(Into::into),
            ..source
        },
    }
}

/// Blocking native operations are serialized on their own initialized WinRT
/// thread. The Tauri command should call this through spawn_blocking.
pub fn snapshot() -> Result<Snapshot, String> {
    #[cfg(target_os = "windows")]
    {
        windows_media::snapshot()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("unsupported：本机播放器连接目前仅支持 Windows".into())
    }
}

pub fn control(
    source_id: &str,
    action: Action,
    position: Option<f64>,
    allow_global_media_keys: bool,
) -> Result<(), String> {
    if source_id.is_empty() || source_id.len() > 200 {
        return Err("无效媒体来源".into());
    }
    if action == Action::Seek && !position.is_some_and(|p| p.is_finite() && p >= 0.0) {
        return Err("跳转位置必须是非负的有限秒数".into());
    }
    #[cfg(target_os = "windows")]
    {
        windows_media::control(source_id, action, position, allow_global_media_keys)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (action, position, allow_global_media_keys);
        Err("unsupported：本机播放器连接目前仅支持 Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sessions_belong_to_the_player_their_app_id_names() {
        assert_eq!(player_of("cloudmusic.exe"), Some("netease"));
        assert_eq!(player_of("QQMusic.exe"), Some("qqmusic"));
        assert_eq!(player_of("qqmusic.exe"), Some("qqmusic"));
        for other in ["QQMusicExternal.exe", "QQ.exe", "Chrome", "Spotify.exe", ""] {
            assert_eq!(player_of(other), None, "{other}");
        }
    }
    // A made-up session under the name Windows gives it (its app id: no display name).
    fn listed(app: &str) -> Source {
        Source {
            id: "smtc-fixture".into(),
            name: app.into(),
            kind: "smtc".into(),
            title: "Fictional Song".into(),
            artist: "Fictional Artist".into(),
            album: String::new(),
            cover_url: None,
            playback: "playing".into(),
            position: Some(12.0),
            duration: Some(180.0),
            capabilities: Capabilities {
                toggle: true,
                next: true,
                ..Capabilities::default()
            },
            warning: None,
            player: None,
            app: Some(app.into()),
        }
    }
    #[test]
    fn qq_music_and_netease_sessions_get_their_names_others_keep_windows_names() {
        let qq = player_source("QQMusic.exe", listed("QQMusic.exe"));
        assert_eq!((qq.name.as_str(), qq.player.as_deref()), ("QQ音乐", Some("qqmusic")));
        assert_eq!((qq.title.as_str(), qq.playback.as_str()), ("Fictional Song", "playing"));
        assert!(qq.capabilities.toggle && qq.capabilities.next);
        assert!(!qq.capabilities.previous && !qq.capabilities.stop && !qq.capabilities.seek);
        // Its app id stays with it: what a remembered source is recognised by after a restart.
        assert_eq!(qq.app.as_deref(), Some("QQMusic.exe"));
        // NetEase is listed as 网易云音乐 (2026-10-06), not by its app id; its mark is what
        // gates its features, and the song, state and controls stay the session's own.
        let netease = player_source("cloudmusic.exe", listed("cloudmusic.exe"));
        assert_eq!(
            (netease.name.as_str(), netease.player.as_deref()),
            ("网易云音乐", Some("netease"))
        );
        assert_eq!(netease.app.as_deref(), Some("cloudmusic.exe"));
        assert_eq!(
            (netease.title.as_str(), netease.playback.as_str()),
            ("Fictional Song", "playing")
        );
        assert!(netease.capabilities.toggle && netease.capabilities.next);
        // Another session taken for NetEase is marked, but keeps the name Windows gives it.
        let other = player_source("NetEase.CloudMusic", listed("NetEase.CloudMusic"));
        assert_eq!(
            (other.name.as_str(), other.player.as_deref()),
            ("NetEase.CloudMusic", Some("netease"))
        );
        // A helper process or any other player is neither named nor marked.
        for app in ["QQMusicExternal.exe", "Chrome"] {
            let other = player_source(app, listed(app));
            assert_eq!(other.app.as_deref(), Some(app), "{app}");
            assert_eq!((other.name.as_str(), other.player), (app, None), "{app}");
        }
    }
    #[test]
    fn invalid_seek_is_rejected_before_contacting_any_player() {
        for position in [None, Some(-1.0), Some(f64::NAN), Some(f64::INFINITY)] {
            assert!(control("not-a-session", Action::Seek, position, false)
                .unwrap_err()
                .contains("有限"));
        }
    }
}
