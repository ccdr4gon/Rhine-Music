//! Read-only metadata extraction. The playback engine remains HTMLAudioElement.
use lofty::{
    config::ParseOptions,
    file::{AudioFile, FileType, TaggedFile, TaggedFileExt},
    prelude::{Accessor, ItemKey},
    probe::Probe,
};
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

pub struct Metadata {
    pub track: Value,
    pub common: Value,
    pub picture: Option<(String, Vec<u8>)>,
}

impl Default for Metadata {
    fn default() -> Self {
        Self {
            track: json!({"duration":0}),
            common: json!({"genres":[],"comments":[],"producers":[]}),
            picture: None,
        }
    }
}

pub fn read(path: &Path, covers: bool) -> Result<Metadata, String> {
    let extension = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    if extension == "dsf" || extension == "dff" {
        return dsd(path, &extension, covers);
    }
    let mut options = ParseOptions::new().read_cover_art(covers);
    let probe = Probe::open(path)
        .map_err(|e| e.to_string())?
        .guess_file_type()
        .map_err(|e| e.to_string())?;
    // Preserve the format-specific properties before converting to TaggedFile.
    // Container extensions alone cannot distinguish PCM, AAC, ALAC or Opus.
    let kind = probe.file_type();
    let mut format_properties = None;
    let (parsed, codec, lossless): (TaggedFile, Option<String>, Option<bool>) = match kind {
        Some(FileType::Wav) => {
            use lofty::iff::wav::{WavFile, WavFormat};
            let mut reader = probe.into_inner();
            let wav = match WavFile::read_from(&mut reader, options) {
                Ok(wav) => wav,
                Err(original) => {
                    // Lofty currently rejects 4-bit ADPCM properties, although
                    // its tag reader supports these valid WAVE files. Read only
                    // the bounded fmt/fact/data headers, then retain its tags.
                    format_properties =
                        Some(adpcm_wave_properties(&mut reader).map_err(|_| original.to_string())?);
                    reader.rewind().map_err(|e| e.to_string())?;
                    WavFile::read_from(&mut reader, options.read_properties(false))
                        .map_err(|e| e.to_string())?
                }
            };
            let (codec, lossless) = match wav.properties().format() {
                WavFormat::PCM => ("PCM".into(), Some(true)),
                WavFormat::IEEE_FLOAT => ("IEEE Float".into(), Some(true)),
                WavFormat::Other(2) => ("Microsoft ADPCM".into(), Some(false)),
                WavFormat::Other(6) => ("ITU G.711 A-law".into(), Some(false)),
                WavFormat::Other(7) => ("ITU G.711 mu-law".into(), Some(false)),
                WavFormat::Other(17) => ("IMA ADPCM".into(), Some(false)),
                WavFormat::Other(85) => ("MPEG Layer 3".into(), Some(false)),
                WavFormat::Other(value) => (format!("WAVE format 0x{value:04X}"), None),
            };
            (wav.into(), Some(codec), lossless)
        }
        Some(FileType::Aiff) => {
            use lofty::iff::aiff::{AiffCompressionType as C, AiffFile};
            let aiff =
                AiffFile::read_from(&mut probe.into_inner(), options).map_err(|e| e.to_string())?;
            let (codec, lossless) = match aiff.properties().compression_type() {
                None | Some(C::None | C::sowt) => ("PCM".into(), Some(true)),
                Some(C::fl32 | C::fl64 | C::FL32) => ("IEEE Float".into(), Some(true)),
                Some(C::Other {
                    compression_type,
                    compression_name,
                }) => (
                    if compression_name.trim().is_empty() {
                        String::from_utf8_lossy(compression_type).into_owned()
                    } else {
                        compression_name.clone()
                    },
                    None,
                ),
                Some(compression) => (compression.compression_name().into_owned(), Some(false)),
            };
            (aiff.into(), Some(codec), lossless)
        }
        Some(FileType::Mp4) => {
            use lofty::mp4::{Mp4Codec, Mp4File};
            let mp4 =
                Mp4File::read_from(&mut probe.into_inner(), options).map_err(|e| e.to_string())?;
            let codec = mp4.properties().codec();
            let lossless = codec.map(|c| matches!(c, Mp4Codec::ALAC | Mp4Codec::FLAC));
            (mp4.into(), codec.map(|c| format!("MPEG-4/{c:?}")), lossless)
        }
        Some(FileType::Mpeg) => {
            let mpeg = lofty::mpeg::MpegFile::read_from(&mut probe.into_inner(), options)
                .map_err(|e| e.to_string())?;
            let codec = format!("MPEG Layer {}", *mpeg.properties().layer() as u8);
            (mpeg.into(), Some(codec), Some(false))
        }
        _ => {
            let (codec, lossless) = match kind {
                Some(FileType::Flac) => (Some("FLAC".into()), Some(true)),
                Some(FileType::Aac) => (Some("AAC".into()), Some(false)),
                Some(FileType::Vorbis) => (Some("Vorbis".into()), Some(false)),
                Some(FileType::Opus) => (Some("Opus".into()), Some(false)),
                Some(FileType::Speex) => (Some("Speex".into()), Some(false)),
                _ => (None, None),
            };
            (
                probe.options(options).read().map_err(|e| e.to_string())?,
                codec,
                lossless,
            )
        }
    };
    let properties = parsed.properties();
    let mut output = Metadata::default();
    output.track = json!({"duration":properties.duration().as_secs_f64(),
        "sampleRate":properties.sample_rate(), "numberOfChannels":properties.channels(),
        "bitsPerSample":properties.bit_depth(), "bitrate":properties.audio_bitrate().map(|n| n as u64 * 1000)});
    if let Some(codec) = codec {
        output.track["codec"] = json!(codec);
    }
    if let Some(lossless) = lossless {
        output.track["lossless"] = json!(lossless);
    }
    if let Some(properties) = format_properties {
        output.track = properties;
    }
    let primary = parsed.primary_tag().or_else(|| parsed.first_tag());
    if let Some(tag) = primary {
        output.track["title"] = json!(tag.title());
        output.track["artist"] = json!(tag.artist());
        output.track["trackNumber"] = json!(tag.track());
        output.track["discNumber"] = json!(tag.disk());
        output.common["album"] = json!(tag.album());
        output.common["albumartist"] = json!(tag.get_string(ItemKey::AlbumArtist));
        output.common["year"] = json!(tag.date().map(|date| date.year));
        // Some existing ID3v2.4 files still contain the legacy TYER frame.
        // Preserve the year exposed by the previous music-metadata parser.
        if output.common["year"].is_null() {
            use id3::TagLike;
            if let Ok(raw) = id3::Tag::read_from_path(path) {
                output.common["year"] =
                    json!(raw.year().or_else(|| raw.date_recorded().map(|d| d.year)));
            }
        }
        output.common["discTotal"] = json!(tag.disk_total());
        output.common["releaseId"] = json!(tag.get_string(ItemKey::MusicBrainzReleaseId));
        output.common["releaseGroupId"] = json!(tag.get_string(ItemKey::MusicBrainzReleaseGroupId));
        for (name, key) in [
            ("genres", ItemKey::Genre),
            ("comments", ItemKey::Comment),
            ("producers", ItemKey::Producer),
        ] {
            output.common[name] = json!(tag
                .get_strings(key)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>());
        }
    }
    if covers {
        let pictures: Vec<_> = parsed
            .tags()
            .iter()
            .flat_map(|tag| tag.pictures())
            .collect();
        if let Some(picture) = pictures
            .iter()
            .find(|p| p.pic_type() == lofty::picture::PictureType::CoverFront)
            .or(pictures.first())
        {
            if picture.data().len() < 30 * 1024 * 1024 {
                if let Some(mime) = picture.mime_type() {
                    output.picture = Some((mime.to_string(), picture.data().to_vec()));
                }
            }
        }
    }
    Ok(output)
}

fn adpcm_wave_properties(reader: &mut (impl Read + Seek)) -> Result<Value, String> {
    let length = reader.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
    reader.rewind().map_err(|e| e.to_string())?;
    let mut header = [0; 12];
    reader.read_exact(&mut header).map_err(|e| e.to_string())?;
    if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" {
        return Err("无效 WAVE 文件头".into());
    }
    let end = u64::from(u32::from_le_bytes(header[4..8].try_into().unwrap())) + 8;
    if end > length {
        return Err("WAVE 区块越界".into());
    }
    let (mut format, mut channels, mut rate, mut bytes_per_second, mut bits) =
        (0u16, 0u16, 0u32, 0u32, 0u16);
    let (mut sample_count, mut audio_bytes) = (0u32, 0u32);
    let mut position = 12u64;
    while position + 8 <= end {
        reader
            .seek(SeekFrom::Start(position))
            .map_err(|e| e.to_string())?;
        let mut chunk = [0; 8];
        reader.read_exact(&mut chunk).map_err(|e| e.to_string())?;
        let size = u32::from_le_bytes(chunk[4..].try_into().unwrap());
        let next = position + 8 + u64::from(size);
        if next > end {
            return Err("WAVE 区块越界".into());
        }
        match &chunk[..4] {
            b"fmt " if size >= 16 => {
                let mut fmt = [0; 16];
                reader.read_exact(&mut fmt).map_err(|e| e.to_string())?;
                format = u16::from_le_bytes(fmt[..2].try_into().unwrap());
                channels = u16::from_le_bytes(fmt[2..4].try_into().unwrap());
                rate = u32::from_le_bytes(fmt[4..8].try_into().unwrap());
                bytes_per_second = u32::from_le_bytes(fmt[8..12].try_into().unwrap());
                bits = u16::from_le_bytes(fmt[14..16].try_into().unwrap());
            }
            b"fact" if size >= 4 => {
                let mut fact = [0; 4];
                reader.read_exact(&mut fact).map_err(|e| e.to_string())?;
                sample_count = u32::from_le_bytes(fact);
            }
            b"data" => audio_bytes = size,
            _ => {}
        }
        position = next + u64::from(size % 2);
    }
    let codec = match format {
        2 => "Microsoft ADPCM",
        17 => "IMA ADPCM",
        _ => return Err("不是受支持的 ADPCM WAVE".into()),
    };
    if rate == 0 || channels == 0 || bytes_per_second == 0 || bits == 0 || audio_bytes == 0 {
        return Err("无效 ADPCM WAVE 属性".into());
    }
    let duration = if sample_count > 0 {
        f64::from(sample_count) / f64::from(rate)
    } else {
        f64::from(audio_bytes) / f64::from(bytes_per_second)
    };
    Ok(
        json!({"codec":codec,"lossless":false,"duration":duration,"sampleRate":rate,
        "numberOfChannels":channels,"bitsPerSample":bits,"bitrate":u64::from(bytes_per_second)*8}),
    )
}

fn id3_at(file: &mut File, offset: u64, available: u64, output: &mut Metadata, covers: bool) {
    use id3::TagLike;
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return;
    }
    // Bound the parser to the tag length rather than reading a DSD audio payload.
    let mut header = [0u8; 10];
    if available < 10
        || file.read_exact(&mut header).is_err()
        || &header[..3] != b"ID3"
        || header[6..10].iter().any(|b| b & 0x80 != 0)
    {
        return;
    }
    let size = header[6..10]
        .iter()
        .fold(0u64, |n, &b| (n << 7) | (b & 0x7f) as u64)
        + 10;
    if size > 32 * 1024 * 1024 || size > available {
        return;
    }
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return;
    }
    let Ok(tag) = id3::Tag::read_from2(file.take(size)) else {
        return;
    };
    output.track["title"] = json!(tag.title());
    output.track["artist"] = json!(tag.artist());
    output.track["trackNumber"] = json!(tag.track());
    output.track["discNumber"] = json!(tag.disc());
    output.common["album"] = json!(tag.album());
    output.common["albumartist"] = json!(tag.album_artist());
    output.common["year"] = json!(tag.year().or_else(|| tag.date_recorded().map(|d| d.year)));
    output.common["discTotal"] = json!(tag.total_discs());
    output.common["genres"] = json!(tag.genres_parsed());
    output.common["comments"] = json!(tag.comments().map(|c| c.text.clone()).collect::<Vec<_>>());
    let mut producers: Vec<_> = tag
        .involved_people_lists()
        .flat_map(|list| &list.items)
        .filter(|person| person.involvement.eq_ignore_ascii_case("producer"))
        .map(|person| person.involvee.trim().to_owned())
        .filter(|name| !name.is_empty())
        .collect();
    for text in tag.extended_texts() {
        let key = match text.description.to_lowercase().as_str() {
            "musicbrainz album id" | "musicbrainz_albumid" => "releaseId",
            "musicbrainz release group id" | "musicbrainz_releasegroupid" => "releaseGroupId",
            "producer" => {
                producers.extend(
                    text.value
                        .split('\0')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned),
                );
                continue;
            }
            _ => continue,
        };
        output.common[key] = json!(text.value);
    }
    output.common["producers"] = json!(producers);
    if covers {
        if let Some(picture) = tag
            .pictures()
            .find(|p| p.picture_type == id3::frame::PictureType::CoverFront)
            .or_else(|| tag.pictures().next())
        {
            if picture.data.len() < 30 * 1024 * 1024 {
                output.picture = Some((picture.mime_type.clone(), picture.data.clone()));
            }
        }
    }
}

fn dsd(path: &Path, extension: &str, covers: bool) -> Result<Metadata, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    let mut output = Metadata::default();
    output.track["codec"] = json!("DSD");
    output.track["lossless"] = json!(true);
    output.track["bitsPerSample"] = json!(1);
    if extension == "dsf" {
        let mut header = [0u8; 80];
        file.read_exact(&mut header).map_err(|e| e.to_string())?;
        if &header[..4] != b"DSD "
            || &header[28..32] != b"fmt "
            || u64::from_le_bytes(header[4..12].try_into().unwrap()) != 28
            || u64::from_le_bytes(header[32..40].try_into().unwrap()) < 52
        {
            return Err("无效 DSF 文件头".into());
        }
        let rate = u32::from_le_bytes(header[56..60].try_into().unwrap());
        let channels = u32::from_le_bytes(header[52..56].try_into().unwrap());
        let samples = u64::from_le_bytes(header[64..72].try_into().unwrap());
        output.track["sampleRate"] = json!(rate);
        output.track["numberOfChannels"] = json!(channels);
        output.track["bitrate"] = json!(rate as u64 * channels as u64);
        output.track["duration"] = json!(if rate > 0 {
            samples as f64 / rate as f64
        } else {
            0.0
        });
        let offset = u64::from_le_bytes(header[20..28].try_into().unwrap());
        if offset > 0 && offset < length {
            id3_at(&mut file, offset, length - offset, &mut output, covers);
        }
    } else {
        let mut header = [0u8; 16];
        file.read_exact(&mut header).map_err(|e| e.to_string())?;
        if &header[..4] != b"FRM8" || &header[12..] != b"DSD " {
            return Err("无效 DFF 文件头".into());
        }
        let (mut rate, mut channels, mut audio_bytes) = (0u32, 0u16, 0u64);
        let mut position = 16u64;
        while position.checked_add(12).is_some_and(|n| n <= length) {
            file.seek(SeekFrom::Start(position))
                .map_err(|e| e.to_string())?;
            let mut chunk = [0u8; 12];
            file.read_exact(&mut chunk).map_err(|e| e.to_string())?;
            let size = u64::from_be_bytes(chunk[4..12].try_into().unwrap());
            let start = position + 12;
            let end = start
                .checked_add(size)
                .filter(|n| *n <= length)
                .ok_or("DFF 区块越界")?;
            match &chunk[..4] {
                b"PROP" if size >= 4 && size <= 1024 * 1024 => {
                    let mut prop = vec![0; size as usize];
                    file.read_exact(&mut prop).map_err(|e| e.to_string())?;
                    if &prop[..4] != b"SND " {
                        return Err("无效 DFF 声音属性".into());
                    }
                    let mut at = 4usize;
                    while at + 12 <= prop.len() {
                        let count = u64::from_be_bytes(prop[at + 4..at + 12].try_into().unwrap());
                        let Some(next) = usize::try_from(count)
                            .ok()
                            .and_then(|count| (at + 12).checked_add(count))
                            .filter(|n| *n <= prop.len())
                        else {
                            return Err("DFF 属性区块越界".into());
                        };
                        if &prop[at..at + 4] == b"FS  " && count >= 4 {
                            rate = u32::from_be_bytes(prop[at + 12..at + 16].try_into().unwrap());
                        }
                        if &prop[at..at + 4] == b"CHNL" && count >= 2 {
                            channels =
                                u16::from_be_bytes(prop[at + 12..at + 14].try_into().unwrap());
                        }
                        at = next + (count % 2) as usize;
                    }
                }
                b"DSD " => audio_bytes = size,
                b"ID3 " => id3_at(&mut file, start, size, &mut output, covers),
                b"DST " if size >= 18 => {
                    let mut frame = [0u8; 18];
                    file.read_exact(&mut frame).map_err(|e| e.to_string())?;
                    if &frame[..4] == b"FRTE" {
                        let frames = u32::from_be_bytes(frame[12..16].try_into().unwrap());
                        let frequency = u16::from_be_bytes(frame[16..18].try_into().unwrap());
                        if frequency > 0 {
                            output.track["duration"] = json!(frames as f64 / frequency as f64);
                        }
                        output.track["codec"] = json!("DST");
                    }
                }
                _ => {}
            }
            position = end.checked_add(size % 2).ok_or("DFF 区块越界")?;
        }
        if rate > 0 && channels > 0 {
            output.track["sampleRate"] = json!(rate);
            output.track["numberOfChannels"] = json!(channels);
            output.track["bitrate"] = json!(rate as u64 * channels as u64);
            if audio_bytes > 0 {
                output.track["duration"] =
                    json!(audio_bytes as f64 * 8.0 / rate as f64 / channels as f64);
            }
        }
    }
    Ok(output)
}
