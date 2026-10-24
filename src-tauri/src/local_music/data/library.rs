use super::metadata;
use chrono::Utc;
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};
use unicode_normalization::UnicodeNormalization;

pub type SharedStore = Arc<Mutex<Store>>;
pub type Result<T> = std::result::Result<T, String>;
const METADATA_VERSION: u32 = 1002;
pub fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("").trim()
}
pub fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn omit_null_fields(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            fields.retain(|_, value| !value.is_null());
            for value in fields.values_mut() {
                omit_null_fields(value);
            }
        }
        Value::Array(items) => {
            for value in items {
                omit_null_fields(value);
            }
        }
        _ => {}
    }
}
pub fn hash(data: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(data.as_ref()))[..24].into()
}
pub fn unique(items: impl IntoIterator<Item = Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    items
        .into_iter()
        .filter(|v| !v.is_null() && v != "" && seen.insert(v.to_string()))
        .collect()
}
pub fn normalized(value: &str) -> String {
    static IGNORED: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let value = value.nfkc().collect::<String>().to_lowercase();
    // Match the existing JS normalization: remove spacing, punctuation and
    // symbols, but retain combining marks used by real genre/artist names.
    IGNORED
        .get_or_init(|| Regex::new(r"[\s\p{P}\p{S}\u{FEFF}]").unwrap())
        .replace_all(&value, "")
        .into_owned()
}
pub fn write_json(file: &Path, data: &Value) -> Result<()> {
    write_file(file, data, false)
}
/// As `write_json`, and on the disk before it takes the name, so that a power cut cannot leave
/// the name holding data that never got there (it reads as zeros): for the settings and the genre
/// rules, small and written when the user changes them. The index (written under the store's lock
/// after every scan) and the preferences (on the window's thread, at every change) keep the plain
/// write; a damaged index is set aside at the next start (`load`).
fn write_json_synced(file: &Path, data: &Value) -> Result<()> {
    write_file(file, data, true)
}
fn write_file(file: &Path, data: &Value, synced: bool) -> Result<()> {
    fs::create_dir_all(file.parent().ok_or("无效数据位置")?).map_err(|e| e.to_string())?;
    let temporary = file.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let outcome = (|| {
        let bytes = serde_json::to_vec_pretty(data).map_err(|e| e.to_string())?;
        let mut written = fs::File::create(&temporary).map_err(|e| e.to_string())?;
        written.write_all(&bytes).map_err(|e| e.to_string())?;
        if synced {
            written.sync_all().map_err(|e| e.to_string())?;
        }
        drop(written);
        fs::rename(&temporary, file).map_err(|e| e.to_string())
    })();
    let _ = fs::remove_file(&temporary);
    outcome
}
/// JSON text without a UTF-8 byte order mark, which an editor may put before it.
fn without_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)
}
fn read_json(file: &Path, fallback: Value) -> Result<Value> {
    match fs::read(file) {
        Ok(bytes) => serde_json::from_slice(without_bom(&bytes))
            .map_err(|e| format!("无法读取 {}：{e}；已保留原文件", file.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(fallback),
        Err(e) => Err(e.to_string()),
    }
}
/// One of the store's data files as read at a start, if it is there and `valid` takes it. A file
/// this version cannot read (not JSON, say after a power cut, or of a shape it does not know, say
/// written by a newer version) is set aside beside it as `<name>.unreadable-<UTC time>`, never
/// deleted or written over, and the start goes on without it (None): one damaged file must not
/// keep the client, and every source with it, from starting. Only an error reading the data
/// folder itself does.
fn load(file: &Path, valid: impl Fn(&Value) -> bool, set_aside: &mut Vec<String>) -> Result<Option<Value>> {
    let bytes = match fs::read(file) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("无法读取 {}：{e}", file.display())),
    };
    if let Some(value) = serde_json::from_slice::<Value>(without_bom(&bytes)).ok().filter(&valid) {
        return Ok(Some(value));
    }
    let name = file.file_name().unwrap_or_default().to_string_lossy();
    let stamp = Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let mut aside = format!("{name}.unreadable-{stamp}");
    for n in 2.. {
        if !file.with_file_name(&aside).exists() {
            break;
        }
        aside = format!("{name}.unreadable-{stamp}-{n}");
    }
    fs::rename(file, file.with_file_name(&aside))
        .map_err(|e| format!("无法另存 {}：{e}", file.display()))?;
    set_aside.push(aside);
    Ok(None)
}

/// The saved folders, cleaned. The first one is the main folder (the owner, 2026-10-06: "Local
/// music means choosing a main folder, and each playlist will be a subfolder"): it is always kept,
/// first. A later folder that is the same, lies inside a kept one or contains the main folder is
/// dropped, and a later folder replaces the ones inside it, as before. Folders after the main one
/// come only from earlier versions, which scanned several: they stay saved, unused.
pub fn safe_roots(value: &Value) -> Result<Vec<String>> {
    let roots = value
        .as_array()
        .filter(|v| v.len() <= 64)
        .ok_or("音乐目录必须是绝对路径数组（最多 64 个）")?;
    let mut output: Vec<String> = Vec::new();
    for value in roots {
        let root = value
            .as_str()
            .filter(|r| !r.contains('\0'))
            .ok_or("音乐目录必须是文本")?;
        let path = Path::new(root);
        if !path.is_absolute() {
            return Err("音乐目录必须是绝对路径；Windows 请包含盘符".into());
        }
        let mut clean = PathBuf::new();
        for component in path.components() {
            match component {
                Component::CurDir => {}
                Component::ParentDir => {
                    clean.pop();
                }
                _ => clean.push(component.as_os_str()),
            }
        }
        let root = clean.to_string_lossy().into_owned();
        let key = path_key(&root);
        if output.iter().any(|p| contains_path(&path_key(p), &key))
            || output
                .first()
                .is_some_and(|main| contains_path(&key, &path_key(main)))
        {
            continue;
        }
        output.retain(|p| !contains_path(&key, &path_key(p)));
        output.push(root);
    }
    Ok(output)
}
fn path_key(path: &str) -> String {
    if cfg!(windows) {
        path.replace('/', "\\").to_lowercase()
    } else {
        path.into()
    }
}
fn contains_path(parent: &str, child: &str) -> bool {
    Path::new(child).starts_with(parent)
}
/// Said when a new main folder is asked for while a scan runs (the routes answer 409).
pub const SCANNING: &str = "正在扫描，请完成后再更改根目录";
/// Whether a new main folder is a folder that is there: a mistyped one neither replaces the chosen
/// one nor is scanned as an empty library. It asks the disk, which for a folder on a network host
/// that does not answer takes as long as Windows waits for it (about 21 s): never with the store
/// locked, or every /api request (a playing song's audio too) would wait as long
/// (`Store::checked_main_folder`).
pub fn check_main_folder(main: &str) -> Result<()> {
    match fs::metadata(main) {
        Ok(found) if found.is_dir() => Ok(()),
        Ok(_) => Err(format!("不是文件夹：{main}。音乐主文件夹保持不变。")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("找不到文件夹：{main}。音乐主文件夹保持不变。"))
        }
        Err(e) => Err(format!(
            "无法打开文件夹 {main}：{e}。音乐主文件夹保持不变。"
        )),
    }
}

pub fn default_rules() -> Value {
    json!({"version":1,"genres":[
        {"id":"mandopop","name":"华语流行","aliases":["Mandopop","国语流行音乐","华语流行音乐","华语流行","国语流行","Chinese Pop"]},
        {"id":"pop","name":"流行","aliases":["Pop","流行音乐"]},
        {"id":"rock","name":"摇滚","aliases":["Rock","摇滚音乐"]},
        {"id":"jazz","name":"爵士","aliases":["Jazz","爵士乐"]},
        {"id":"classical","name":"古典","aliases":["Classical","古典音乐"]},
        {"id":"electronic","name":"电子","aliases":["Electronic","Electronica","电子音乐"]},
        {"id":"ambient","name":"氛围","aliases":["Ambient","氛围音乐"]},
        {"id":"soundtrack","name":"原声","aliases":["Soundtrack","OST","原声音乐","电影原声"]},
        {"id":"unclassified","name":"未分类","aliases":[]}],"albumOverrides":{}})
}
pub fn validate_rules(mut value: Value) -> Result<Value> {
    if value["version"] != 1 || !value["albumOverrides"].is_object() {
        return Err("流派规则格式无效".into());
    }
    let genres = value["genres"]
        .as_array_mut()
        .filter(|g| g.len() <= 1000)
        .ok_or("genres 必须为数组")?;
    let valid = Regex::new(r"^[a-zA-Z0-9_-]{1,100}$").unwrap();
    let mut ids = HashSet::new();
    for genre in genres.iter_mut() {
        if !genre["id"].as_str().is_some_and(|id| valid.is_match(id))
            || text(&genre["name"]).is_empty()
            || !ids.insert(text(&genre["id"]).to_owned())
        {
            return Err("流派 ID 必须唯一，名称必须为文本".into());
        }
        if genre.get("aliases").is_some()
            && (!genre["aliases"].is_array()
                || array(&genre["aliases"]).iter().any(|a| !a.is_string()))
        {
            return Err("流派别名必须是文本数组".into());
        }
        genre["aliases"] = json!(unique(
            array(&genre["aliases"]).iter().map(|v| json!(text(v)))
        ));
        genre["name"] = json!(text(&genre["name"]));
    }
    if ids.insert("unclassified".into()) {
        genres.push(json!({"id":"unclassified","name":"未分类","aliases":[]}));
    }
    if value["albumOverrides"]
        .as_object()
        .unwrap()
        .values()
        .any(|v| !v.as_str().is_some_and(|id| ids.contains(id)))
    {
        return Err("人工流派不存在".into());
    }
    Ok(value)
}
pub fn genre_for(album: &Value, rules: &Value) -> String {
    let override_id = text(&rules["albumOverrides"][text(&album["id"])]);
    if !override_id.is_empty()
        && array(&rules["genres"])
            .iter()
            .any(|g| g["id"] == override_id)
    {
        return override_id.into();
    }
    let inputs = unique(
        array(&album["_onlineGenres"])
            .iter()
            .chain(array(&album["_localGenres"]))
            .cloned(),
    );
    for input in &inputs {
        let normalized = normalized(text(input));
        for genre in array(&rules["genres"]) {
            if [&genre["id"], &genre["name"]]
                .into_iter()
                .chain(array(&genre["aliases"]))
                .any(|v| self::normalized(text(v)) == normalized)
            {
                return text(&genre["id"]).into();
            }
        }
    }
    inputs
        .first()
        .map(|v| format!("source-{}", hash(normalized(text(v)))))
        .unwrap_or_else(|| "unclassified".into())
}

#[derive(Clone)]
pub struct Store {
    pub data_dir: PathBuf,
    pub config: Value,
    pub index: Value,
    pub rules: Value,
    pub scan: Value,
    pub enrich: Value,
    pub introductions: Value,
    /// The names the data files this start could not read were set aside under (`load`).
    pub set_aside: Vec<String>,
    /// Bumped whenever the index is saved (every change to it is): the library's tag (library_tag).
    revision: u64,
}
// A file the library may serve (its real path must stay inside `root`), and the media types of
// served files: shared with the page's server (crate::http), under their earlier paths here.
pub use crate::http::{mime, AllowedFile};
impl Store {
    pub fn open(data_dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        // A data folder that cannot be written stops the start, which says why (main.rs): a start
        // on one that already holds valid data writes nothing else here, and would go on unable
        // to save the settings, the index or the preferences. A file of its own, removed again.
        let probe = data_dir.join(format!(".write-test-{}.tmp", uuid::Uuid::new_v4()));
        let written = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
            .and_then(|mut file| file.write_all(b"\n"));
        let _ = fs::remove_file(&probe);
        written.map_err(|e| e.to_string())?;
        let roots = std::env::var_os("MUSIC_ROOTS")
            .map(|s| {
                std::env::split_paths(&s)
                    .map(|p| json!(p.to_string_lossy()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut set_aside = Vec::new();
        let saved = load(
            &data_dir.join("config.json"),
            |config| config.is_object() && safe_roots(&config["roots"]).is_ok(),
            &mut set_aside,
        )?;
        let mut config = saved.clone().unwrap_or_else(
            || json!({"version":1,"roots":roots,"onlineEnabled":false,"foobarBaseUrl":null}),
        );
        config["roots"] = json!(safe_roots(&config["roots"])?);
        let index = load(
            &data_dir.join("library-index.json"),
            |index| {
                index["version"] == 1
                    && index["albums"].is_array()
                    && array(&index["albums"]).iter().all(|album| {
                        album.is_object()
                            && album["tracks"].is_array()
                            && array(&album["tracks"]).iter().all(Value::is_object)
                    })
            },
            &mut set_aside,
        )?
        .unwrap_or_else(|| json!({"version":1,"albums":[],"roots":[],"scannedAt":null}));
        let rules = validate_rules(
            load(
                &data_dir.join("genre-rules.json"),
                |rules| validate_rules(rules.clone()).is_ok(),
                &mut set_aside,
            )?
            .unwrap_or_else(default_rules),
        )?;
        if !data_dir.join("genre-rules.json").exists() {
            write_json_synced(&data_dir.join("genre-rules.json"), &rules)?;
        }
        // Written when it is new or was cleaned, not at every start.
        if saved.as_ref() != Some(&config) {
            write_json_synced(&data_dir.join("config.json"), &config)?;
        }
        Ok(Self {
            data_dir,
            config,
            index,
            rules,
            scan: json!({"running":false}),
            enrich: json!({"running":false,"completed":0,"total":0}),
            introductions: json!({"running":false,"completed":0,"total":0,"updated":0,"notFound":0,"failed":0}),
            set_aside,
            // Its own start for each run, so that a tag from before a restart is not taken for one now.
            revision: std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |since| since.as_nanos() as u64),
        })
    }
    pub fn contact(&self) -> String {
        let saved = text(&self.config["musicBrainzContact"]);
        if saved.is_empty() {
            std::env::var("MUSICBRAINZ_CONTACT").unwrap_or_default()
        } else {
            saved.into()
        }
    }
    pub fn config_snapshot(&self) -> Value {
        let mut c = self.config.clone();
        c["musicBrainzConfigured"] = json!(!self.contact().is_empty());
        c
    }
    /// The main folder: the first saved folder (see `safe_roots`). Only it is scanned, shown
    /// and served; folders saved after it by earlier versions are kept but not used.
    pub fn main_folder(&self) -> Option<&str> {
        array(&self.config["roots"]).first().and_then(Value::as_str)
    }
    /// Whether an indexed album lies in the main folder.
    pub fn in_library(&self, album: &Value) -> bool {
        self.main_folder()
            .is_some_and(|main| album["_root"].as_str() == Some(main))
    }
    pub fn save_index(&mut self) -> Result<()> {
        self.revision = self.revision.wrapping_add(1);
        write_json(&self.data_dir.join("library-index.json"), &self.index)
    }
    /// A tag for what `snapshot` shows (the ETag of /api/library): the index's revision and the
    /// small state the snapshot reads beside it. The albums are neither copied nor serialized for
    /// it, so a page polling an unchanged library is answered 304 at once (a large library's
    /// snapshot is megabytes and took 0.4 s to build).
    pub fn library_tag(&self) -> String {
        let state = json!([
            self.revision,
            self.rules,
            self.config["roots"],
            self.config["onlineEnabled"],
            self.scan,
            self.enrich,
            self.introductions
        ]);
        format!(
            "\"{}\"",
            hash(serde_json::to_vec(&state).unwrap_or_default())
        )
    }
    pub fn reload_rules(&mut self) -> Result<()> {
        self.rules = validate_rules(read_json(
            &self.data_dir.join("genre-rules.json"),
            default_rules(),
        )?)?;
        Ok(())
    }
    pub fn update_rules(&mut self, value: Value) -> Result<Value> {
        let rules = validate_rules(value)?;
        let path = self.data_dir.join("genre-rules.json");
        if path.exists() {
            fs::copy(&path, self.data_dir.join("genre-rules.json.backup"))
                .map_err(|e| e.to_string())?;
        }
        write_json_synced(&path, &rules)?;
        self.rules = rules;
        Ok(self.rules.clone())
    }
    /// The folder `roots` would make the new main folder: their first, when it is not the main
    /// folder now. Text only: nothing is read from the disk.
    fn new_main_folder(&self, roots: &Value) -> Result<Option<String>> {
        Ok(safe_roots(roots)?
            .into_iter()
            .next()
            .filter(|main| self.main_folder().map(path_key) != Some(path_key(main))))
    }
    /// The new main folder `roots` name, if any, found on the disk (check_main_folder) with the
    /// store's lock released: the lock is held only for the checks that need no disk (no new main
    /// folder during a scan, the folders' text). Its answer goes to `update_config_checked`.
    pub fn checked_main_folder(shared: &SharedStore, roots: &Value) -> Result<Option<String>> {
        let new = {
            let store = shared.lock().unwrap();
            if store.scan["running"] == true {
                return Err(SCANNING.into());
            }
            store.new_main_folder(roots)?
        };
        if let Some(main) = &new {
            check_main_folder(main)?;
        }
        Ok(new)
    }
    pub fn update_config(&mut self, value: &Value) -> Result<Value> {
        self.update_config_checked(value, None)
    }
    /// As `update_config`, for a new main folder `checked_main_folder` has already found on the
    /// disk (`checked`): it is not looked for again under the lock.
    pub fn update_config_checked(&mut self, value: &Value, checked: Option<&str>) -> Result<Value> {
        if !value.is_object() {
            return Err("配置必须是 JSON 对象".into());
        }
        let mut next = self.config.clone();
        if let Some(roots) = value.get("roots") {
            if self.scan["running"] == true {
                return Err(SCANNING.into());
            }
            let roots = safe_roots(roots)?;
            // A new main folder has to be a folder that is there (check_main_folder). The chosen
            // one may be away (a drive not connected): saved again, it keeps its index, offline.
            if let Some(main) = roots
                .first()
                .filter(|main| self.main_folder().map(path_key) != Some(path_key(main)))
                .filter(|main| checked.map(path_key) != Some(path_key(main)))
            {
                check_main_folder(main)?;
            }
            next["roots"] = json!(roots);
        }
        if let Some(enabled) = value.get("onlineEnabled") {
            if !enabled.is_boolean() {
                return Err("onlineEnabled 必须为布尔值".into());
            }
            next["onlineEnabled"] = enabled.clone();
        }
        if let Some(contact) = value.get("musicBrainzContact") {
            let contact = contact.as_str().ok_or("MusicBrainz 联系方式必须是文本")?;
            if contact.len() > 500 || contact.contains(['\r', '\n']) {
                return Err("无效 MusicBrainz 联系方式".into());
            }
            let contact = contact.trim();
            let email = Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").unwrap();
            if !contact.is_empty()
                && !email.is_match(contact)
                && !url::Url::parse(contact)
                    .is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some())
            {
                return Err("请输入有效的邮箱或 http(s) 项目网址".into());
            }
            next["musicBrainzContact"] = json!(contact);
        }
        if let Some(base) = value.get("foobarBaseUrl") {
            if base.is_null() || base == "" {
                next["foobarBaseUrl"] = Value::Null;
            } else {
                let u = url::Url::parse(text(base)).map_err(|_| "无效 foobar 地址")?;
                if u.scheme() != "http"
                    || !matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
                    || !u.username().is_empty()
                    || u.password().is_some()
                    || u.query().is_some()
                    || u.fragment().is_some()
                {
                    return Err("foobar 仅允许本机 HTTP 地址".into());
                }
                next["foobarBaseUrl"] = json!(u.origin().ascii_serialization());
            }
        }
        write_json_synced(&self.data_dir.join("config.json"), &next)?;
        self.config = next;
        Ok(self.config_snapshot())
    }
    pub fn snapshot(&self) -> Value {
        let roots = array(&self.config["roots"]);
        let mut counts: HashMap<String, usize> = HashMap::new();
        let mut generated = Vec::new();
        let library: Vec<_> = array(&self.index["albums"])
            .iter()
            .filter(|a| self.in_library(a))
            .collect();
        let albums: Vec<_> = library.iter().map(|&album| {
            let id = genre_for(album, &self.rules);
            if !counts.contains_key(&id) && id.starts_with("source-") {
                generated.push(json!({"id":id,"name":array(&album["_onlineGenres"]).first().or_else(|| array(&album["_localGenres"]).first()).unwrap_or(&Value::Null)}));
            }
            *counts.entry(id.clone()).or_default() += 1;
            let mut public = album.clone();
            public.as_object_mut().unwrap().retain(|k,_| !k.starts_with('_'));
            public["genreId"] = json!(id);
            public["rawGenres"] = json!(unique(array(&album["_onlineGenres"]).iter().chain(array(&album["_localGenres"])).cloned()));
            public["tracks"] = json!(array(&album["tracks"]).iter().map(public_track).collect::<Vec<_>>());
            if album["_cover"].is_object() { public["coverUrl"] = json!(format!("/api/artwork/{}?v={}", text(&album["id"]), text(&album["_cover"]["version"]))); }
            if text(&public["descriptionSource"]["url"]).is_empty() { public.as_object_mut().unwrap().remove("description"); public.as_object_mut().unwrap().remove("descriptionSource"); }
            if text(&public["localNote"]).is_empty() { public.as_object_mut().unwrap().remove("localNote"); }
            public
        }).collect();
        let genres: Vec<_> = array(&self.rules["genres"])
            .iter()
            .chain(&generated)
            .filter_map(|g| {
                counts.get(text(&g["id"])).map(|count| {
                    let mut g = g.clone();
                    g["albumCount"] = json!(count);
                    g
                })
            })
            .collect();
        let roots: Vec<_> = roots
            .iter()
            .map(|root| {
                array(&self.index["roots"])
                    .iter()
                    .find(|r| r["path"] == *root)
                    .cloned()
                    .unwrap_or_else(|| json!({"path":root,"status":"unscanned"}))
            })
            .collect();
        let playlists = self
            .main_folder()
            .map(|main| playlists(main, &library))
            .unwrap_or_default();
        let mut public = json!({"version":1,"albums":albums,"genres":genres,"playlists":playlists,"roots":roots,"scan":self.scan,"onlineEnabled":self.config["onlineEnabled"] == true,"enrich":self.enrich,"introductions":self.introductions});
        if !self.set_aside.is_empty() {
            public["setAside"] = json!(self.set_aside);
        }
        // TypeScript optional fields must be absent, not null. Apply this only
        // to the cloned public snapshot; config and private index retain their
        // existing representation (including foobarBaseUrl: null).
        omit_null_fields(&mut public);
        public
    }
    pub fn file(&self, id: &str, artwork: bool) -> Option<AllowedFile> {
        for album in array(&self.index["albums"])
            .iter()
            .filter(|a| self.in_library(a))
        {
            if artwork && album["id"] == id && album["_cover"].is_object() {
                return Some(AllowedFile {
                    path: text(&album["_cover"]["path"]).into(),
                    root: if album["_cover"]["embedded"] == true {
                        self.data_dir.clone()
                    } else {
                        text(&album["_root"]).into()
                    },
                    mime: text(&album["_cover"]["mime"]).into(),
                });
            }
            if !artwork {
                if let Some(track) = array(&album["tracks"]).iter().find(|t| t["id"] == id) {
                    return Some(AllowedFile {
                        path: text(&track["_path"]).into(),
                        root: text(&album["_root"]).into(),
                        mime: mime(Path::new(text(&track["_path"]))).into(),
                    });
                }
            }
        }
        None
    }
    pub fn begin_scan(shared: &SharedStore, roots: Option<&Value>) -> Result<()> {
        // A new main folder is looked for on the disk before the store is locked.
        let checked = match roots {
            Some(roots) => Self::checked_main_folder(shared, roots)?,
            None => None,
        };
        let mut copy = {
            let mut store = shared.lock().unwrap();
            // A new main folder is refused while a scan runs (update_config), not dropped.
            if let Some(roots) = roots {
                store.update_config_checked(&json!({"roots":roots}), checked.as_deref())?;
            }
            if store.scan["running"] == true {
                return Ok(());
            }
            store.scan = json!({"running":true,"startedAt":now()});
            store.clone()
        };
        let shared = shared.clone();
        std::thread::spawn(move || {
            // A panic while reading (a damaged file a reader cannot take) ends this scan with an
            // error: the index stays as it was, and the next scan can run.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| copy.scan_sync()))
                .unwrap_or_else(|_| Err("扫描时读取出错，原索引已保留".into()));
            let online = {
                let mut store = shared.lock().unwrap();
                // Without a main folder nothing was scanned (scan_sync): the index is not written.
                if result.is_ok() && copy.main_folder().is_some() {
                    {
                        // The albums as they are now (an online lookup may have finished), by id.
                        let mut current: HashMap<&str, &Value> = HashMap::new();
                        for album in array(&store.index["albums"]) {
                            if let Some(id) = album["id"].as_str() {
                                current.entry(id).or_insert(album);
                            }
                        }
                        for album in copy.index["albums"].as_array_mut().unwrap() {
                            if let Some(current) = album["id"].as_str().and_then(|id| current.get(id)) {
                                merge_online(current, album);
                            }
                        }
                    }
                    store.index = copy.index;
                    if let Err(e) = store.save_index() {
                        store.scan["error"] = json!(e);
                    }
                } else if let Err(e) = result {
                    store.scan["error"] = json!(e);
                }
                store.scan["running"] = json!(false);
                store.scan["finishedAt"] = json!(now());
                store.config["onlineEnabled"] == true
            };
            if online {
                let _ = super::online::begin_enrich(&shared, &json!({}), false);
            }
        });
        Ok(())
    }
    pub fn scan_sync(&mut self) -> Result<()> {
        self.reload_rules()?;
        let mut albums = Vec::new();
        let mut roots = Vec::new();
        // Only the main folder: the folders earlier versions saved after it are not scanned.
        for root in array(&self.config["roots"]).iter().take(1) {
            let previous: Vec<_> = array(&self.index["albums"])
                .iter()
                .filter(|a| a["_root"] == *root)
                .collect();
            // By id, once: looked up for each album the walk finds.
            let mut previous_by_id: HashMap<&str, &Value> = HashMap::new();
            for album in &previous {
                if let Some(id) = album["id"].as_str() {
                    previous_by_id.entry(id).or_insert(album);
                }
            }
            let mut skipped = Skipped::default();
            let scanned = (|| {
                let entries = walk(Path::new(text(root)), &mut skipped)?;
                let mut found = Vec::new();
                for entry in entries {
                    let id = format!(
                        "album-{}",
                        hash(
                            entry
                                .single
                                .as_ref()
                                .unwrap_or(&entry.folder)
                                .to_string_lossy()
                                .as_bytes()
                        )
                    );
                    let old = previous_by_id.get(id.as_str()).copied();
                    found.extend(self.read_album(
                        Path::new(text(root)),
                        entry,
                        &id,
                        old,
                        &mut skipped.unreadable,
                    )?);
                }
                Ok::<_, String>(found)
            })();
            match scanned {
                Ok(mut found) => {
                    // The albums in a folder that could not be read this time stay as the last
                    // scan found them, offline: an unreadable folder is not a deleted one.
                    let ids: HashSet<&str> = found.iter().filter_map(|a| a["id"].as_str()).collect();
                    let kept: Vec<_> = previous
                        .iter()
                        .filter(|a| {
                            !a["id"].as_str().is_some_and(|id| ids.contains(id))
                                && skipped
                                    .folders
                                    .iter()
                                    .any(|folder| Path::new(text(&a["folder"])).starts_with(folder))
                        })
                        .map(|a| {
                            let mut a = (*a).clone();
                            a["offline"] = json!(true);
                            a
                        })
                        .collect();
                    found.extend(kept);
                    albums.extend(found);
                    let mut status = json!({"path":root,"status":"online"});
                    if skipped.encrypted > 0 {
                        status["encrypted"] = json!(skipped.encrypted);
                    }
                    if skipped.unreadable > 0 {
                        status["unreadable"] = json!(skipped.unreadable);
                    }
                    roots.push(status);
                }
                Err(e) => {
                    albums.extend(previous.into_iter().map(|a| {
                        let mut a = a.clone();
                        a["offline"] = json!(true);
                        a
                    }));
                    roots.push(json!({"path":root,"status":"offline","error":e}));
                }
            }
        }
        // Without a main folder (none chosen yet, or config.json set aside at a start) the index
        // stays as it is: shown and served to no one (in_library), and when the same folder is
        // chosen again its albums are found (`previous`) with their tags, covers and online data.
        // Another folder chosen leaves them out.
        if self.main_folder().is_some() {
            self.index = json!({"version":1,"albums":albums,"roots":roots,"scannedAt":now()});
        }
        Ok(())
    }
    /// An album record from what the walk found (None when none of its songs could be taken).
    /// A song or cover that cannot be read now is counted in `unreadable` (`keep`).
    fn read_album(
        &self,
        root: &Path,
        entry: Entry,
        id: &str,
        previous: Option<&Value>,
        unreadable: &mut usize,
    ) -> Result<Option<Value>> {
        let file_cover = match &entry.cover {
            None => None,
            Some(p) => match fingerprint(p) {
                Ok(fingerprint) => Some(
                    json!({"path":path_text(p)?,"mime":mime(p),"version":hash(fingerprint),"embedded":false}),
                ),
                // An image that cannot be read now keeps the cover the last scan found in it.
                Err(e) => {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        *unreadable += 1;
                    }
                    previous
                        .map(|a| &a["_cover"])
                        .filter(|c| c["embedded"] == false && c["path"].as_str() == p.to_str())
                        .cloned()
                }
            },
        };
        let mut cover = if entry.single.is_none() {
            file_cover.clone()
        } else {
            None
        };
        let mut tracks = Vec::new();
        static DISC_PREFIX: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
        let disc_prefix = DISC_PREFIX
            .get_or_init(|| Regex::new(r"^(\d{1,2})[-_](\d{1,3})(?:[\s._-]|$)").unwrap());
        // The last scan's songs of this album, by path: one look-up per song.
        let mut old_tracks: HashMap<&str, &Value> = HashMap::new();
        for track in previous.map(|a| array(&a["tracks"])).unwrap_or_default() {
            if let Some(path) = track["_path"].as_str() {
                old_tracks.entry(path).or_insert(track);
            }
        }
        for file in entry.tracks {
            let path = path_text(&file)?;
            let old = old_tracks.get(path).copied();
            let fingerprint = match fingerprint(&file) {
                Ok(fingerprint) => fingerprint,
                Err(e) => {
                    keep(e, old, &mut tracks, &mut cover, unreadable);
                    continue;
                }
            };
            if let Some(old) = old.filter(|t| {
                t["_fingerprint"] == fingerprint
                    && t["_metadataVersion"] == METADATA_VERSION
                    && (cover.is_some() || t.get("_embeddedCover").is_some())
                    && (cover.is_some()
                        || !t["_embeddedCover"].is_object()
                        || Path::new(text(&t["_embeddedCover"]["path"])).is_file())
            }) {
                tracks.push(old.clone());
                if cover.is_none() && old["_embeddedCover"].is_object() {
                    cover = Some(old["_embeddedCover"].clone());
                }
                continue;
            }
            let had_cover = cover.is_some();
            // A permission/sharing failure is not a missing tag: the song keeps its record (`keep`).
            if let Err(e) = fs::File::open(&file) {
                keep(e, old, &mut tracks, &mut cover, unreadable);
                continue;
            }
            let mut parsed = match metadata::read(&file, !had_cover) {
                Ok(m) => m,
                Err(e) => {
                    let mut m = metadata::Metadata::default();
                    m.common["metadataError"] = json!(e);
                    m
                }
            };
            let mut embedded = None;
            if let Some((mime, bytes)) = parsed.picture.take() {
                let extension = match mime.as_str() {
                    "image/png" => Some("png"),
                    "image/jpeg" | "image/jpg" => Some("jpg"),
                    "image/webp" => Some("webp"),
                    _ => None,
                };
                if let Some(extension) = extension {
                    let version = hash(&bytes);
                    let target = self
                        .data_dir
                        .join("artwork")
                        .join(format!("{version}.{extension}"));
                    fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
                    if !target.exists() {
                        fs::write(&target, bytes).map_err(|e| e.to_string())?;
                    }
                    embedded = Some(
                        json!({"path":path_text(&target)?,"mime":if mime=="image/jpg"{"image/jpeg"}else{&mime},"version":version,"embedded":true}),
                    );
                    cover = embedded.clone();
                }
            }
            let mut track = parsed.track;
            // The old service omits zero/invalid optional values. In particular,
            // a tag containing track 0 must not suppress the filename fallback.
            for name in [
                "trackNumber",
                "discNumber",
                "bitsPerSample",
                "sampleRate",
                "bitrate",
                "numberOfChannels",
            ] {
                if !track[name]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n > 0.0)
                {
                    track.as_object_mut().unwrap().remove(name);
                }
            }
            for name in ["year", "discTotal"] {
                if !parsed.common[name]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n > 0.0)
                {
                    parsed.common.as_object_mut().unwrap().remove(name);
                }
            }
            for name in ["title", "artist"] {
                if let Some(value) = track[name].as_str() {
                    track[name] = json!(value.trim());
                }
            }
            for name in ["album", "albumartist", "releaseId", "releaseGroupId"] {
                if let Some(value) = parsed.common[name].as_str() {
                    parsed.common[name] = json!(value.trim());
                }
            }
            let tagged_disc = track["discNumber"].is_number();
            if text(&track["title"]).is_empty() {
                track["title"] = json!(file.file_stem().unwrap_or_default().to_string_lossy());
            }
            if text(&track["artist"]).is_empty() {
                track["artist"] = json!(if text(&parsed.common["albumartist"]).is_empty() {
                    "未知艺术家"
                } else {
                    text(&parsed.common["albumartist"])
                });
            }
            if let Some(capture) =
                disc_prefix.captures(&file.file_name().unwrap_or_default().to_string_lossy())
            {
                if !track["discNumber"].is_number() {
                    if let Ok(number @ 1..) = capture[1].parse::<u32>() {
                        track["discNumber"] = json!(number);
                    }
                }
                if !track["trackNumber"].is_number() {
                    if let Ok(number @ 1..) = capture[2].parse::<u32>() {
                        track["trackNumber"] = json!(number);
                    }
                }
                parsed.common["discNumberSource"] =
                    json!(if tagged_disc { "tag" } else { "filename" });
            } else if tagged_disc {
                parsed.common["discNumberSource"] = json!("tag");
            }
            let ext = extension(&file);
            let track_id = format!("track-{}", hash(file.to_string_lossy().as_bytes()));
            for (key, value) in [
                ("id", json!(track_id)),
                ("albumId", json!(id)),
                ("format", json!(ext.to_uppercase())),
                (
                    "browserPlayable",
                    json!(matches!(
                        ext.as_str(),
                        "flac" | "wav" | "m4a" | "mp4" | "mp3" | "aac" | "ogg" | "opus"
                    )),
                ),
                ("audioUrl", json!(format!("/api/audio/{track_id}"))),
                (
                    "relativePath",
                    json!(path_text(file.strip_prefix(root).unwrap_or(&file))?),
                ),
                ("_path", json!(path)),
                ("_fingerprint", json!(fingerprint)),
                ("_metadataVersion", json!(METADATA_VERSION)),
                ("_common", parsed.common),
            ] {
                track[key] = value;
            }
            if !had_cover {
                track["_embeddedCover"] = embedded.unwrap_or(Value::Null);
            }
            track
                .as_object_mut()
                .unwrap()
                .retain(|key, value| !value.is_null() || key == "_embeddedCover");
            tracks.push(track);
        }
        if cover.is_none() {
            cover = file_cover;
        }
        tracks.sort_by(|a, b| {
            a["discNumber"]
                .as_u64()
                .unwrap_or(1)
                .cmp(&b["discNumber"].as_u64().unwrap_or(1))
                .then(
                    a["trackNumber"]
                        .as_u64()
                        .unwrap_or(9999)
                        .cmp(&b["trackNumber"].as_u64().unwrap_or(9999)),
                )
                .then_with(|| natural_cmp(text(&a["relativePath"]), text(&b["relativePath"])))
        });
        let Some(first) = tracks.first() else {
            return Ok(None);
        };
        let title = if entry.single.is_some() {
            text(&first["title"]).to_owned()
        } else if !text(&first["_common"]["album"]).is_empty() {
            text(&first["_common"]["album"]).into()
        } else {
            entry
                .folder
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        };
        let artist = if entry.single.is_none() && !text(&first["_common"]["albumartist"]).is_empty()
        {
            &first["_common"]["albumartist"]
        } else {
            &first["artist"]
        };
        let genres = unique(
            tracks
                .iter()
                .flat_map(|t| array(&t["_common"]["genres"]).iter().cloned()),
        );
        let comments = unique(
            tracks
                .iter()
                .flat_map(|t| array(&t["_common"]["comments"]).iter().cloned()),
        )
        .iter()
        .map(text)
        .collect::<Vec<_>>()
        .join("\n");
        static MBID: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
        let mbid = MBID.get_or_init(|| {
            Regex::new(r"(?i)^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$").unwrap()
        });
        let release = |key: &str| {
            tracks
                .iter()
                .map(|t| &t["_common"][key])
                .find(|v| mbid.is_match(text(v)))
                .cloned()
                .unwrap_or(Value::Null)
        };
        let mut album = json!({"id":id,"title":title,"artist":artist,"year":first["_common"]["year"],
            "discCount":tracks.iter().map(|t|t["_common"]["discTotal"].as_u64().or(t["discNumber"].as_u64()).unwrap_or(1)).max().unwrap_or(1),
            "localNote":comments,"genreId":"unclassified","rawGenres":genres,"folder":path_text(&entry.folder)?,"tracks":tracks,"offline":false,
            "producers":[],"online":{"status":"unqueried","releaseId":release("releaseId"),"releaseGroupId":release("releaseGroupId")},
            "_root":path_text(root)?,"_cover":cover,"_localGenres":genres,"_onlineGenres":[]});
        if let Some(old) = previous.filter(|old| {
            same_identity(old, &album)
                && (release("releaseId").is_null()
                    || old["online"]["releaseId"] == release("releaseId"))
        }) {
            for key in ["online", "_onlineGenres"] {
                if let Some(value) = old.get(key) {
                    album[key] = value.clone();
                }
            }
            album["producers"] = json!(array(&old["producers"])
                .iter()
                .filter(|p| p["source"] != "local")
                .cloned()
                .collect::<Vec<_>>());
        }
        // Album introductions describe the same title/artist/year even when a
        // later scan finds additional tracks. Production credits still require
        // the stricter release identity above.
        if let Some(old) = previous.filter(|old| same_album(old, &album)) {
            for key in ["description", "descriptionSource", "introduction"] {
                if let Some(value) = old.get(key) {
                    album[key] = value.clone();
                }
            }
        }
        let mut producers = array(&album["producers"]).to_vec();
        for track in &tracks {
            for name in array(&track["_common"]["producers"]) {
                producers.push(json!({"name":name,"role":"producer","source":"local","trackTitle":track["title"]}));
            }
        }
        album["producers"] = json!(unique(producers));
        Ok(Some(album))
    }
}
/// A song that cannot be read now (`error`): in use by another program or not permitted, it keeps
/// the record the last scan made (`old`, read again at the next scan) and a new one waits for the
/// next scan; either way it is counted in `unreadable`. One that is gone was deleted.
fn keep(
    error: std::io::Error,
    old: Option<&Value>,
    tracks: &mut Vec<Value>,
    cover: &mut Option<Value>,
    unreadable: &mut usize,
) {
    if error.kind() == std::io::ErrorKind::NotFound {
        return;
    }
    *unreadable += 1;
    if let Some(old) = old {
        tracks.push(old.clone());
        if cover.is_none() && old["_embeddedCover"].is_object() {
            *cover = Some(old["_embeddedCover"].clone());
        }
    }
}
/// A path as the index keeps it. The walk only finds paths that are valid Unicode; one that is
/// not (the data folder's, say) is an error here rather than a panic of `json!` on the path.
fn path_text(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| format!("路径含有无法识别的字符：{}", path.to_string_lossy()))
}
pub fn same_identity(a: &Value, b: &Value) -> bool {
    same_album(a, b) && array(&a["tracks"]).len() == array(&b["tracks"]).len()
}
fn same_album(a: &Value, b: &Value) -> bool {
    a["title"] == b["title"] && a["artist"] == b["artist"] && a["year"] == b["year"]
}
fn merge_online(current: &Value, album: &mut Value) {
    if !same_album(current, album) {
        return;
    }
    if same_identity(current, album)
        && text(&current["online"]["checkedAt"]) > text(&album["online"]["checkedAt"])
    {
        for field in ["online", "_onlineGenres"] {
            album[field] = current[field].clone();
        }
        album["producers"] = json!(unique(
            array(&album["producers"])
                .iter()
                .filter(|p| p["source"] == "local")
                .chain(
                    array(&current["producers"])
                        .iter()
                        .filter(|p| p["source"] != "local")
                )
                .cloned()
        ));
    }
    if text(&current["introduction"]["checkedAt"]) > text(&album["introduction"]["checkedAt"]) {
        album["introduction"] = current["introduction"].clone();
    }
    // These two providers can finish in either order. The attribution date,
    // rather than either task status date, decides which description is newer.
    if !text(&current["descriptionSource"]["url"]).is_empty()
        && !text(&current["description"]).is_empty()
        && text(&current["descriptionSource"]["checkedAt"])
            > text(&album["descriptionSource"]["checkedAt"])
    {
        album["description"] = current["description"].clone();
        album["descriptionSource"] = current["descriptionSource"].clone();
    }
}
fn fingerprint(file: &Path) -> std::io::Result<String> {
    let s = fs::metadata(file)?;
    Ok(format!(
        "{}:{}",
        s.len(),
        s.modified()?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ))
}
pub fn extension(p: &Path) -> String {
    p.extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase()
}
struct Entry {
    folder: PathBuf,
    tracks: Vec<PathBuf>,
    single: Option<PathBuf>,
    cover: Option<PathBuf>,
}
/// QQ Music's encrypted downloads (`.mflac`, `.mgg`, `.qmc*` and their numbered variants): not
/// audio Rhine can read, never decrypted. They are only counted for the scan's summary.
pub fn is_encrypted_download(path: &Path) -> bool {
    let extension = extension(path);
    ["qmc", "mflac", "mgg"]
        .iter()
        .any(|prefix| extension.starts_with(prefix))
}
/// Files and folders the scan leaves alone: names starting with a dot (macOS's `._` copies
/// included), and on Windows folders marked hidden or system (`$RECYCLE.BIN`, `System Volume
/// Information`, ...) and links (symbolic links and junctions are never followed).
fn hidden(entry: &fs::DirEntry, folder: bool) -> Result<bool> {
    if entry.file_name().to_string_lossy().starts_with('.') {
        return Ok(true);
    }
    #[cfg(windows)]
    if folder {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        const REPARSE_POINT: u32 = 0x400;
        let attributes = entry.metadata().map_err(|e| e.to_string())?.file_attributes();
        return Ok(attributes & (HIDDEN | SYSTEM | REPARSE_POINT) != 0);
    }
    let _ = folder;
    Ok(false)
}
/// What a scan of the main folder left out: QQ Music's encrypted downloads (only counted), and the
/// files and folders it could not read this time (`unreadable`: in use, not permitted, or a name
/// that is not valid Unicode), with the folders among them (`folders`), whose albums the last scan
/// found are kept (scan_sync).
#[derive(Default)]
struct Skipped {
    encrypted: usize,
    unreadable: usize,
    folders: Vec<PathBuf>,
}
fn is_audio(path: &Path) -> bool {
    matches!(
        extension(path).as_str(),
        "flac"
            | "wav"
            | "m4a"
            | "mp4"
            | "alac"
            | "dsf"
            | "dff"
            | "mp3"
            | "aac"
            | "aiff"
            | "aif"
            | "ogg"
            | "opus"
    )
}
/// The folders that hold audio, under the main folder: each folder with audio is an album
/// record (its songs, cover and introduction); audio directly in the main folder is one record
/// per file. The playlists are made from these records' paths (`playlists`). Only the main folder
/// itself failing fails the walk; what else it leaves out is in `skipped`.
fn walk(root: &Path, skipped: &mut Skipped) -> Result<Vec<Entry>> {
    fn visit(root: &Path, folder: &Path, output: &mut Vec<Entry>, skipped: &mut Skipped) -> Result<()> {
        let listed = fs::read_dir(folder).and_then(|entries| entries.collect::<std::io::Result<Vec<_>>>());
        let mut entries = match listed {
            Ok(entries) => entries,
            // The main folder itself: the library is offline, its index kept (scan_sync).
            Err(e) if folder == root => return Err(e.to_string()),
            // Gone since its parent was listed: deleted.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            // A folder inside it that cannot be listed now is not an empty one.
            Err(_) => {
                skipped.unreadable += 1;
                skipped.folders.push(folder.into());
                return Ok(());
            }
        };
        entries.sort_by(|a, b| {
            natural_cmp(
                &a.file_name().to_string_lossy(),
                &b.file_name().to_string_lossy(),
            )
        });
        // Resolve every type once. An entry that cannot be read now is counted and left out, never
        // taken for a deletion (a known song keeps its record, a folder its albums); so is a song
        // or folder whose name is not valid Unicode (a lone UTF-16 surrogate, left by a tool that
        // cut a name in two), which no path in the index can hold.
        let mut files = Vec::new();
        let mut directories = Vec::new();
        for entry in &entries {
            let Ok(kind) = entry.file_type() else {
                skipped.unreadable += 1;
                continue;
            };
            let directory = kind.is_dir() && !kind.is_symlink();
            if !kind.is_file() && !directory {
                continue;
            }
            match hidden(entry, directory) {
                Ok(true) => continue,
                Ok(false) => {}
                Err(_) => {
                    skipped.unreadable += 1;
                    continue;
                }
            }
            if entry.file_name().to_str().is_none() {
                if directory || is_audio(&entry.path()) {
                    skipped.unreadable += 1;
                }
                continue;
            }
            if directory {
                directories.push(entry.path());
            } else if is_encrypted_download(&entry.path()) {
                skipped.encrypted += 1;
            } else {
                files.push(entry.path());
            }
        }
        let tracks: Vec<_> = files.iter().filter(|p| is_audio(p)).cloned().collect();
        let mut images: Vec<_> = files
            .iter()
            .filter(|p| matches!(extension(p).as_str(), "png" | "jpg" | "jpeg" | "webp"))
            .cloned()
            .collect();
        let rank = |p: &PathBuf| {
            ["cover", "folder", "front"]
                .iter()
                .position(|s| {
                    *s == p
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_lowercase()
                })
                .unwrap_or(99)
        };
        images.sort_by(|a, b| {
            rank(a)
                .cmp(&rank(b))
                .then_with(|| natural_cmp(&a.to_string_lossy(), &b.to_string_lossy()))
        });
        if folder == root {
            let stem = |p: &PathBuf| {
                p.file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .nfc()
                    .collect::<String>()
                    .to_lowercase()
            };
            // Each song's own image by name: one look-up per song, the first in the order above.
            let mut covers: HashMap<String, &PathBuf> = HashMap::new();
            for image in &images {
                covers.entry(stem(image)).or_insert(image);
            }
            for track in tracks {
                let cover = covers.get(&stem(&track)).map(|p| (*p).clone());
                output.push(Entry {
                    folder: folder.into(),
                    tracks: vec![track.clone()],
                    single: Some(track),
                    cover,
                });
            }
        } else if !tracks.is_empty() {
            output.push(Entry {
                folder: folder.into(),
                tracks,
                single: None,
                cover: images.first().cloned(),
            });
        }
        for directory in directories {
            visit(root, &directory, output, skipped)?;
        }
        Ok(())
    }
    let mut output = Vec::new();
    visit(root, root, &mut output, skipped)?;
    Ok(output)
}

/// A song's public record: its stored fields without the private ones, plus its own album and
/// year tags (read at scan time, kept in the index) for the song's details.
fn public_track(track: &Value) -> Value {
    let mut public = track.clone();
    public.as_object_mut().unwrap().retain(|k, _| !k.starts_with('_'));
    let album = text(&track["_common"]["album"]);
    if !album.is_empty() {
        public["album"] = json!(album);
    }
    if track["_common"]["year"]
        .as_f64()
        .is_some_and(|n| n.is_finite() && n > 0.0)
    {
        public["year"] = track["_common"]["year"].clone();
    }
    public
}

/// Natural order of two paths inside the main folder, folder by folder (so `Pop/x` comes before
/// `Pop B/y`), whichever separator they use. Equal names in another case keep a fixed order.
pub fn path_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let parts = |path: &str| -> Vec<String> {
        path.split(['/', '\\'])
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect()
    };
    let (a, b) = (parts(a), parts(b));
    for (x, y) in a.iter().zip(&b) {
        let order = natural_cmp(x, y).then_with(|| x.cmp(y));
        if !order.is_eq() {
            return order;
        }
    }
    a.len().cmp(&b.len())
}

/// The main folder's playlists (the owner, 2026-10-06): each direct subfolder that holds audio
/// at any depth is a playlist named after it, its songs in natural order of their paths; audio
/// directly in the main folder is one more playlist, named after the main folder and listed
/// first. Playlists come in natural order of their names. A folder without audio has no songs
/// and so no playlist. Made from the indexed songs' paths: nothing more is read.
pub fn playlists(main: &str, albums: &[&Value]) -> Vec<Value> {
    struct Playlist {
        name: String,
        folder: String,
        main: bool,
        songs: Vec<(String, String)>,
    }
    let mut lists: Vec<Playlist> = Vec::new();
    let mut by_folder: HashMap<String, usize> = HashMap::new();
    for album in albums {
        for track in array(&album["tracks"]) {
            let relative = text(&track["relativePath"]);
            let mut parts = relative.split(['/', '\\']).filter(|part| !part.is_empty());
            let first = parts.next().unwrap_or_default();
            let nested = parts.next().is_some();
            let (name, folder) = if nested {
                (
                    first.to_owned(),
                    Path::new(main).join(first).to_string_lossy().into_owned(),
                )
            } else {
                let name = Path::new(main)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| main.to_owned());
                (name, main.to_owned())
            };
            let song = (relative.to_owned(), text(&track["id"]).to_owned());
            match by_folder.get(&folder) {
                Some(&index) => lists[index].songs.push(song),
                None => {
                    by_folder.insert(folder.clone(), lists.len());
                    lists.push(Playlist {
                        name,
                        folder,
                        main: !nested,
                        songs: vec![song],
                    });
                }
            }
        }
    }
    for list in &mut lists {
        list.songs.sort_by(|a, b| path_cmp(&a.0, &b.0).then_with(|| a.1.cmp(&b.1)));
    }
    lists.sort_by(|a, b| {
        b.main
            .cmp(&a.main)
            .then_with(|| natural_cmp(&a.name, &b.name))
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.folder.cmp(&b.folder))
    });
    lists
        .into_iter()
        .map(|list| {
            json!({
                "id": format!("playlist-{}", hash(list.folder.as_bytes())),
                "name": list.name,
                "folder": list.folder,
                "main": list.main,
                "trackIds": list.songs.into_iter().map(|(_, id)| id).collect::<Vec<_>>(),
            })
        })
        .collect()
}
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek(), b.peek()) {
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut x = String::new();
                let mut y = String::new();
                while a.peek().is_some_and(char::is_ascii_digit) {
                    x.push(a.next().unwrap());
                }
                while b.peek().is_some_and(char::is_ascii_digit) {
                    y.push(b.next().unwrap());
                }
                let (x, y) = (x.trim_start_matches('0'), y.trim_start_matches('0'));
                let order = x.len().cmp(&y.len()).then(x.cmp(y));
                if !order.is_eq() {
                    return order;
                }
            }
            (Some(_), Some(_)) => {
                let order = a.next().cmp(&b.next());
                if !order.is_eq() {
                    return order;
                }
            }
            _ => return a.next().cmp(&b.next()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_preserves_script_marks_and_stable_source_genres() {
        assert_eq!(normalized("  Ｐｏｐ / Rock ★ "), "poprock");
        assert_eq!(normalized("हिन्दी"), "हिन्दी");
        assert_eq!(normalized("İ"), "i\u{307}");
        let album = json!({"id":"x","_localGenres":["हिन्दी"],"_onlineGenres":[]});
        assert_eq!(
            genre_for(&album, &default_rules()),
            format!("source-{}", hash("हिन्दी"))
        );
    }

    #[test]
    fn scan_merge_uses_attribution_time_and_retains_local_credits() {
        let mut album = json!({"title":"Album","artist":"Artist","year":2001,"tracks":[{}],
            "description":"newer source","descriptionSource":{"url":"https://example.com/new","checkedAt":"2026-09-03T00:00:00Z"},
            "online":{"checkedAt":"2026-09-01T00:00:00Z"},
            "producers":[{"name":"local","source":"local"}]});
        let mut current = json!({"title":"Album","artist":"Artist","year":2001,"tracks":[{}],
            "description":"older source","descriptionSource":{"url":"https://example.com/old","checkedAt":"2026-09-02T00:00:00Z"},
            "online":{"checkedAt":"2026-09-04T00:00:00Z"},
            "introduction":{"status":"not-found","checkedAt":"2026-09-05T00:00:00Z"},
            "producers":[{"name":"stale local","source":"local"},{"name":"online","source":"MusicBrainz"}]});
        merge_online(&current, &mut album);
        assert_eq!(album["description"], "newer source");
        assert_eq!(album["introduction"]["status"], "not-found");
        assert_eq!(
            album["producers"],
            json!([{"name":"local","source":"local"},{"name":"online","source":"MusicBrainz"}])
        );
        album["tracks"] = json!([{}, {}]);
        current["description"] = json!("latest introduction");
        current["descriptionSource"]["checkedAt"] = json!("2026-09-06T00:00:00Z");
        merge_online(&current, &mut album);
        assert_eq!(
            album["description"], "latest introduction",
            "adding a track does not change album introduction identity"
        );
        current["artist"] = json!("different artist");
        current["description"] = json!("unrelated");
        current["descriptionSource"]["checkedAt"] = json!("2026-09-07T00:00:00Z");
        merge_online(&current, &mut album);
        assert_eq!(album["description"], "latest introduction");
    }

    #[test]
    fn a_song_or_cover_gone_since_the_folder_was_listed_was_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("data")).unwrap();
        let folder = dir.path().join("music").join("歌单");
        fs::create_dir_all(&folder).unwrap();
        let entry = Entry {
            folder: folder.clone(),
            tracks: vec![folder.join("gone.wav")],
            single: None,
            cover: Some(folder.join("gone.png")),
        };
        let mut unreadable = 0;
        let album = store.read_album(&dir.path().join("music"), entry, "album-x", None, &mut unreadable);
        assert_eq!(album, Ok(None));
        assert_eq!(unreadable, 0, "gone is not unreadable");
    }
}
