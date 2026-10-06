//! Recognising QQ Music's media session, by the app id Windows reports for it (the shared
//! media-session worker reads it, `crate::media::player_of`). Its controls go through that
//! shared code too, and only those its session enables; QQ Music has no transport of its own
//! here: no global media keys, no window title, no process lookup.

/// The app id of QQ Music's media session: its executable's name (QQ Music 22.71 publishes
/// its session as `QQMusic.exe`), compared whole and ignoring ASCII case, so that its helper
/// processes (`QQMusicExternal.exe`, `QQMusicSvr.exe` ...), other Tencent apps and NetEase
/// are not taken for it.
pub fn is_app(app: &str) -> bool {
    app.eq_ignore_ascii_case("QQMusic.exe")
}

#[cfg(test)]
mod tests {
    use super::is_app;
    #[test]
    fn only_qq_musics_own_session_is_recognised() {
        for app in ["QQMusic.exe", "qqmusic.exe", "QQMUSIC.EXE"] {
            assert!(is_app(app), "{app}");
        }
        for other in [
            "cloudmusic.exe",
            "NetEase.CloudMusic",
            "QQ.exe",
            "QQMusicExternal.exe",
            "QQMusicSvr.exe",
            "QQMusicAgent.exe",
            "QQMusicService.exe",
            "DesktopDynamicLyric.exe",
            "QQMusic",
            "QQMusic.exe.bak",
            " QQMusic.exe",
            "QQMusic.exe ",
            "Tencent.QQMusic",
            "C:\\Program Files (x86)\\Tencent\\QQMusic\\QQMusic.exe",
            "Chrome",
            "",
        ] {
            assert!(!is_app(other), "{other}");
        }
    }
}
