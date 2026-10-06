//! QQ Music's data is what its media session publishes (`crate::media::Source`), held in memory
//! while it is shown. Nothing of QQ Music is read from disk, and nothing about it is saved.
//! A future reader (its queue, its playlists) goes here with its exact list of fields, as in
//! `crate::netease_music::data`, and only after the owner allows it.
use crate::media::Source;

/// QQ Music's now-playing model: the source the shared worker read from QQ Music's media
/// session, under QQ Music's own name and mark (`super::NAME`, `super::PLAYER`). Everything
/// else is the session's own reading, unchanged: nothing is added or guessed. QQ Music keeps
/// an idle session open while no song is loaded; then the song fields stay empty. Position,
/// seeking and stop are there only when the session offers them. It lives for one snapshot.
pub fn now_playing(source: Source) -> Source {
    Source {
        name: super::NAME.into(),
        player: Some(super::PLAYER.into()),
        ..source
    }
}

#[cfg(test)]
mod tests {
    use super::now_playing;
    use crate::media::{Capabilities, Source};
    // A made-up session, as Windows would list QQ Music's: under its app id, no display name.
    fn session() -> Source {
        Source {
            id: "smtc-fixture".into(),
            name: "QQMusic.exe".into(),
            kind: "smtc".into(),
            title: "Fictional Song".into(),
            artist: "Fictional Artist".into(),
            album: String::new(),
            cover_url: None,
            playback: "paused".into(),
            position: None,
            duration: None,
            capabilities: Capabilities {
                toggle: true,
                previous: true,
                next: true,
                stop: false,
                seek: false,
            },
            warning: None,
            player: None,
            app: Some("QQMusic.exe".into()),
        }
    }
    #[test]
    fn the_session_is_shown_under_qq_musics_name_and_mark_and_otherwise_as_read() {
        let shown = now_playing(session());
        assert_eq!(shown.name, "QQ音乐");
        assert_eq!(shown.player.as_deref(), Some("qqmusic"));
        let without_name_and_mark = |source: Source| {
            let mut value = serde_json::to_value(source).unwrap();
            let fields = value.as_object_mut().unwrap();
            fields.remove("name");
            fields.remove("player");
            value
        };
        assert_eq!(
            without_name_and_mark(shown),
            without_name_and_mark(session()),
            "the song, its state and the controls are the session's own"
        );
    }
    #[test]
    fn an_idle_session_stays_empty() {
        let idle = Source {
            title: String::new(),
            artist: String::new(),
            playback: "stopped".into(),
            ..session()
        };
        let shown = now_playing(idle);
        assert!(shown.title.is_empty() && shown.artist.is_empty() && shown.album.is_empty());
        assert!(shown.cover_url.is_none() && shown.position.is_none() && shown.duration.is_none());
        assert_eq!(shown.playback, "stopped");
    }
}
