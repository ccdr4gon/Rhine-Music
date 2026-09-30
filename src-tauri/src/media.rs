//! Read and control sources that already play music. This never logs in to a
//! service, reads its databases, or represents the current track as a library.
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
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub sources: Vec<Source>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[cfg(target_os = "windows")]
mod windows_media;

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

fn parse_netease_title(title: &str) -> Option<(String, String)> {
    let (title, artist) = title.trim().rsplit_once(" - ")?;
    if title.trim().is_empty() || artist.trim().is_empty() {
        return None;
    }
    Some((title.trim().into(), artist.trim().into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn title_preserves_song_separators_and_rejects_unavailable_metadata() {
        assert_eq!(
            parse_netease_title("Song - Live - Artist"),
            Some(("Song - Live".into(), "Artist".into()))
        );
        for title in ["网易云音乐", " - Artist", "Song - "] {
            assert_eq!(parse_netease_title(title), None);
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
