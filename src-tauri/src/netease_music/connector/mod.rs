//! The running NetEase: recognising its media session, the window-title fallback with global
//! media keys while it has none (Windows only; every connection needs the user's consent to
//! the keys), and its local debugging port.
pub mod debug_port;
#[cfg(target_os = "windows")]
pub(crate) mod window;

/// NetEase's media session, however Windows names it (its app id may be `cloudmusic.exe`).
pub fn is_app(app: &str) -> bool {
    let app = app.to_lowercase();
    app.contains("cloudmusic") || app.contains("netease") || app.contains("网易云")
}

/// The song and artist in NetEase's window title ("Song - Artist", split at the last " - ");
/// nothing while the title is only NetEase's own name.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn parse_title(title: &str) -> Option<(String, String)> {
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
            parse_title("Song - Live - Artist"),
            Some(("Song - Live".into(), "Artist".into()))
        );
        for title in ["网易云音乐", " - Artist", "Song - "] {
            assert_eq!(parse_title(title), None);
        }
    }
    #[test]
    fn netease_is_recognised_by_any_of_its_app_ids() {
        for app in ["cloudmusic.exe", "CloudMusic.exe", "NetEase.CloudMusic", "网易云音乐"] {
            assert!(is_app(app), "{app}");
        }
        for app in ["QQMusic.exe", "Chrome", "Spotify.exe", ""] {
            assert!(!is_app(app), "{app}");
        }
    }
}
