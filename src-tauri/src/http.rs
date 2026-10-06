//! The HTTP plumbing shared by the page server (`app_server`) and the local music's routes
//! (`local_music::connector::api`): headers, JSON replies and request bodies, the media types of
//! served files, and files streamed with single byte ranges inside the folder they may come from.
use serde_json::Value;
use std::{
    fs::File,
    io::{Cursor, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};
use tiny_http::{Header, Request, Response, StatusCode};

/// A file that may be served, and the folder it has to stay inside (checked on its real path).
pub struct AllowedFile {
    pub path: PathBuf,
    pub root: PathBuf,
    pub mime: String,
}

pub fn header(name: &str, value: impl AsRef<str>) -> Header {
    Header::from_bytes(name, value.as_ref()).unwrap()
}
pub fn get_header(request: &Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.to_string())
}
pub fn json_response(request: Request, status: u16, value: Value) {
    let response = Response::from_data(serde_json::to_vec(&value).unwrap())
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json; charset=utf-8"))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("X-Content-Type-Options", "nosniff"));
    let _ = request.respond(response);
}
/// A POST's JSON object (at most 128 KiB).
pub fn body(request: &mut Request) -> Result<Value, (u16, String)> {
    if !get_header(request, "Content-Type")
        .unwrap_or_default()
        .to_lowercase()
        .starts_with("application/json")
    {
        return Err((415, "请使用 application/json 请求体".into()));
    }
    let mut bytes = Vec::new();
    request
        .as_reader()
        .take(128 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| (400, e.to_string()))?;
    if bytes.len() > 128 * 1024 {
        return Err((413, "请求体过大".into()));
    }
    let value: Value = serde_json::from_slice(if bytes.is_empty() { b"{}" } else { &bytes })
        .map_err(|e| (400, e.to_string()))?;
    if !value.is_object() {
        return Err((400, "JSON 请求体必须是对象".into()));
    }
    Ok(value)
}

/// The media type of a served file, by its extension: the page's assets and the local music's
/// audio and covers alike.
pub fn mime(p: &Path) -> &'static str {
    match p
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase()
        .as_str()
    {
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" | "mp4" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" | "opus" => "audio/ogg",
        "aiff" | "aif" => "audio/aiff",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "txt" => "text/plain; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        _ => "application/octet-stream",
    }
}

/// Inclusive, single byte ranges, including suffix requests used by audio decoders.
pub fn parse_range(header: Option<&str>, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(header) = header else {
        return Ok(None);
    };
    if size == 0 {
        return Err(());
    }
    let content = header.strip_prefix("bytes=").ok_or(())?;
    let (a, b) = content.split_once('-').ok_or(())?;
    if !a.bytes().all(|c| c.is_ascii_digit()) || !b.bytes().all(|c| c.is_ascii_digit()) {
        return Err(());
    }
    if a.is_empty() {
        let suffix = b.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        return Ok(Some((size.saturating_sub(suffix), size - 1)));
    }
    let start = a.parse::<u64>().map_err(|_| ())?;
    let end = if b.is_empty() {
        size - 1
    } else {
        b.parse::<u64>().map_err(|_| ())?
    };
    if start >= size || end < start {
        return Err(());
    }
    Ok(Some((start, end.min(size - 1))))
}
pub fn serve_file(request: Request, file: AllowedFile, cache: &str) {
    let resolved = (|| -> Result<_, (u16, String)> {
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
        let root = dunce::canonicalize(&file.root).map_err(failure)?;
        let path = dunce::canonicalize(&file.path).map_err(failure)?;
        if !path.starts_with(&root) {
            return Err((403, "文件已移出允许的目录".into()));
        }
        let metadata = std::fs::metadata(&path).map_err(failure)?;
        if !metadata.is_file() {
            return Err((404, "文件不存在".into()));
        }
        let size = metadata.len();
        let range = parse_range(get_header(&request, "Range").as_deref(), size);
        let mut headers = vec![
            header("Content-Type", &file.mime),
            header("Accept-Ranges", "bytes"),
            header("Cache-Control", cache),
            header("X-Content-Type-Options", "nosniff"),
            header("Referrer-Policy", "same-origin"),
        ];
        if let Ok(modified) = metadata.modified() {
            let date: chrono::DateTime<chrono::Utc> = modified.into();
            headers.push(header(
                "Last-Modified",
                date.format("%a, %d %b %Y %H:%M:%S GMT").to_string(),
            ));
        }
        if range.is_err() {
            headers.push(header("Content-Range", format!("bytes */{size}")));
            return Ok((
                416,
                headers,
                Box::new(Cursor::new(Vec::<u8>::new())) as Box<dyn Read + Send>,
                0,
            ));
        }
        let mut source = File::open(path).map_err(failure)?;
        let (status, length) = if let Some((start, end)) = range.unwrap() {
            source.seek(SeekFrom::Start(start)).map_err(failure)?;
            headers.push(header(
                "Content-Range",
                format!("bytes {start}-{end}/{size}"),
            ));
            (206, end - start + 1)
        } else {
            (200, size)
        };
        Ok((
            status,
            headers,
            Box::new(source.take(length)) as Box<dyn Read + Send>,
            length as usize,
        ))
    })();
    match resolved {
        Ok((status, headers, reader, length)) => {
            let _ = request.respond(
                Response::new(StatusCode(status), headers, reader, Some(length), None)
                    .with_chunked_threshold(usize::MAX),
            );
        }
        Err((status, error)) => json_response(request, status, serde_json::json!({"error":error})),
    }
}
