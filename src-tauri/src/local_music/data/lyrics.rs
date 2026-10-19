//! A local song's lyrics, only read (the owner, 2026-10-17: ".lrc files and song tags"): a `.lrc`
//! file of the same name beside the song, inside the folder the song may be served from, else the
//! lyrics in the song's own tags (`metadata::lyrics`). The page decodes and parses them
//! (src/lyrics.ts): an .lrc goes as its own bytes, in whatever encoding it was saved in, and tag
//! text as UTF-8. Nothing is written, kept or sent anywhere else.
use crate::{http::AllowedFile, local_music::data::metadata};
use std::{fs::File, io::Read, path::Path};

/// An .lrc larger than this is not lyrics (ordinary ones have a few kilobytes).
pub const MAX_BYTES: u64 = 512 * 1024;

/// The lyrics of an indexed song (`song` as `Store::file` gives it for its audio), or None when it
/// has none. An error is the song's own: its file is gone, or no longer inside its folder.
pub fn read(song: &AllowedFile) -> Result<Option<Vec<u8>>, (u16, String)> {
    let failure = |e: std::io::Error| {
        (
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) {
                404
            } else {
                400
            },
            e.to_string(),
        )
    };
    let root = dunce::canonicalize(&song.root).map_err(failure)?;
    let path = dunce::canonicalize(&song.path).map_err(failure)?;
    if !path.starts_with(&root) {
        return Err((403, "文件已移出允许的目录".into()));
    }
    if let Some(bytes) = sidecar(&path, &root) {
        return Ok(Some(bytes));
    }
    // A tag's lyrics have the .lrc's limit too.
    Ok(metadata::lyrics(&path)
        .filter(|text| text.len() as u64 <= MAX_BYTES)
        .map(String::into_bytes))
}

/// `<song>.lrc` beside the song: on its real path inside `root`, a file, not empty and not over
/// MAX_BYTES.
fn sidecar(song: &Path, root: &Path) -> Option<Vec<u8>> {
    let path = dunce::canonicalize(song.with_extension("lrc")).ok()?;
    if !path.starts_with(root) || !path.is_file() {
        return None;
    }
    let file = File::open(&path).ok()?;
    if file.metadata().ok()?.len() > MAX_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes).ok()?;
    (!bytes.is_empty() && bytes.len() as u64 <= MAX_BYTES).then_some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use id3::{
        frame::{Lyrics, SynchronisedLyrics, SynchronisedLyricsType, TimestampFormat},
        Tag, TagLike, Version,
    };
    use std::{fs, path::PathBuf};

    fn song(root: &Path, name: &str) -> AllowedFile {
        let path = root.join(name);
        fs::write(&path, b"").unwrap();
        AllowedFile { path, root: root.to_path_buf(), mime: "audio/mpeg".into() }
    }

    fn tagged(path: &PathBuf, frames: impl FnOnce(&mut Tag)) {
        let mut tag = Tag::new();
        frames(&mut tag);
        tag.write_to_path(path, Version::Id3v24).unwrap();
    }

    fn synced(content: Vec<(u32, &str)>) -> SynchronisedLyrics {
        SynchronisedLyrics {
            lang: "zho".into(),
            timestamp_format: TimestampFormat::Ms,
            content_type: SynchronisedLyricsType::Lyrics,
            description: String::new(),
            content: content.into_iter().map(|(time, text)| (time, text.to_owned())).collect(),
        }
    }

    #[test]
    fn a_same_named_lrc_beside_the_song_comes_first_as_its_own_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let file = song(dir.path(), "虚构 - 一首歌.flac");
        assert_eq!(read(&file).unwrap(), None, "no lyrics anywhere");
        // GBK bytes stay as they are: the page decodes them.
        let gbk = b"[00:01.00]\xd0\xe9\xb9\xb9".to_vec();
        fs::write(dir.path().join("虚构 - 一首歌.lrc"), &gbk).unwrap();
        assert_eq!(read(&file).unwrap(), Some(gbk));
        // Empty or too large: not lyrics.
        fs::write(dir.path().join("虚构 - 一首歌.lrc"), b"").unwrap();
        assert_eq!(read(&file).unwrap(), None);
        fs::write(dir.path().join("虚构 - 一首歌.lrc"), vec![b'a'; MAX_BYTES as usize + 1]).unwrap();
        assert_eq!(read(&file).unwrap(), None);
        // A folder of that name is no file.
        let other = song(dir.path(), "other.mp3");
        fs::create_dir(dir.path().join("other.lrc")).unwrap();
        assert_eq!(read(&other).unwrap(), None);
    }

    #[test]
    fn a_song_outside_its_folder_or_gone_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let inside = dir.path().join("library");
        fs::create_dir(&inside).unwrap();
        let mut file = song(dir.path(), "outside.mp3");
        fs::write(dir.path().join("outside.lrc"), b"[00:01.00]x").unwrap();
        file.root = inside.clone();
        assert_eq!(read(&file).unwrap_err().0, 403);
        let gone = AllowedFile { path: inside.join("gone.mp3"), root: inside, mime: "audio/mpeg".into() };
        assert_eq!(read(&gone).unwrap_err().0, 404);
    }

    #[test]
    fn id3_synchronised_lyrics_become_lrc_lines_and_plain_lyrics_text_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        // A frame with a line per part, as most taggers write it.
        let file = song(dir.path(), "lines.mp3");
        tagged(&file.path, |tag| {
            tag.add_frame(synced(vec![(1_500, "第一行"), (65_250, "第二行 "), (3_600_000, "")]));
        });
        assert_eq!(
            String::from_utf8(read(&file).unwrap().unwrap()).unwrap(),
            "[00:01.50]第一行\n[01:05.25]第二行\n[60:00.00]"
        );
        // Parts that start a line with a break (the ID3v2 way): the others are timed words.
        let file = song(dir.path(), "words.mp3");
        tagged(&file.path, |tag| {
            tag.add_frame(synced(vec![(1_000, "Hel"), (1_400, "lo "), (2_000, "\nworld"), (2_600, "\r\nagain")]));
        });
        assert_eq!(
            String::from_utf8(read(&file).unwrap().unwrap()).unwrap(),
            "[00:01.00]<00:01.00>Hel<00:01.40>lo\n[00:02.00]world\n[00:02.60]again"
        );
        // A line of timed parts without words is a pause, not stamps alone.
        let file = song(dir.path(), "empty-parts.mp3");
        tagged(&file.path, |tag| {
            tag.add_frame(synced(vec![(1_000, "One"), (3_000, "\n"), (3_500, ""), (5_000, "\nTwo")]));
        });
        assert_eq!(
            String::from_utf8(read(&file).unwrap().unwrap()).unwrap(),
            "[00:01.00]One\n[00:03.00]\n[00:05.00]Two"
        );
        // Unsynchronised lyrics text (often LRC itself), when there is no synchronised frame.
        let file = song(dir.path(), "plain.mp3");
        tagged(&file.path, |tag| {
            tag.add_frame(Lyrics { lang: "zho".into(), description: String::new(), text: "[00:03.00]虚构的歌词".into() });
        });
        assert_eq!(read(&file).unwrap().unwrap(), "[00:03.00]虚构的歌词".as_bytes());
        // A frame timed in MPEG frames cannot be placed: the plain text, if any, is used instead.
        let file = song(dir.path(), "mpeg.mp3");
        tagged(&file.path, |tag| {
            let mut frames = synced(vec![(10, "x")]);
            frames.timestamp_format = TimestampFormat::Mpeg;
            tag.add_frame(frames);
        });
        assert_eq!(read(&file).unwrap(), None);
        // Lyrics text over the .lrc's limit is not lyrics.
        let file = song(dir.path(), "huge.mp3");
        tagged(&file.path, |tag| {
            tag.add_frame(Lyrics { lang: "eng".into(), description: String::new(), text: "a".repeat(MAX_BYTES as usize + 1) });
        });
        assert_eq!(read(&file).unwrap(), None);
        // An .lrc beside the song still comes first.
        fs::write(dir.path().join("lines.lrc"), b"[00:09.00]beside").unwrap();
        assert_eq!(read(&song_at(dir.path(), "lines.mp3")).unwrap().unwrap(), b"[00:09.00]beside");
    }

    fn song_at(root: &Path, name: &str) -> AllowedFile {
        AllowedFile { path: root.join(name), root: root.to_path_buf(), mime: "audio/mpeg".into() }
    }

    #[test]
    fn dsd_files_are_only_indexed() {
        let dir = tempfile::tempdir().unwrap();
        let file = song(dir.path(), "track.dsf");
        assert_eq!(read(&file).unwrap(), None);
    }
}
