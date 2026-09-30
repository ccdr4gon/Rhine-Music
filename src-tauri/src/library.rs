use crate::metadata;
use chrono::Utc;
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
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
    fs::create_dir_all(file.parent().ok_or("无效数据位置")?).map_err(|e| e.to_string())?;
    let temporary = file.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let outcome = (|| {
        fs::write(
            &temporary,
            serde_json::to_vec_pretty(data).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(&temporary, file).map_err(|e| e.to_string())
    })();
    let _ = fs::remove_file(&temporary);
    outcome
}
fn read_json(file: &Path, fallback: Value) -> Result<Value> {
    match fs::read(file) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("无法读取 {}：{e}；已保留原文件", file.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(fallback),
        Err(e) => Err(e.to_string()),
    }
}

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
        if output.iter().any(|p| contains_path(&path_key(p), &key)) {
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
                .any(|v| crate::library::normalized(text(v)) == normalized)
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
}
pub struct AllowedFile {
    pub path: PathBuf,
    pub root: PathBuf,
    pub mime: String,
}
impl Store {
    pub fn open(data_dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let roots = std::env::var_os("MUSIC_ROOTS")
            .map(|s| {
                std::env::split_paths(&s)
                    .map(|p| json!(p))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut config = read_json(
            &data_dir.join("config.json"),
            json!({"version":1,"roots":roots,"onlineEnabled":false,"foobarBaseUrl":null}),
        )?;
        config["roots"] = json!(safe_roots(&config["roots"])?);
        let index = read_json(
            &data_dir.join("library-index.json"),
            json!({"version":1,"albums":[],"roots":[],"scannedAt":null}),
        )?;
        if index["version"] != 1
            || !index["albums"].is_array()
            || array(&index["albums"]).iter().any(|album| {
                !album.is_object()
                    || !album["tracks"].is_array()
                    || array(&album["tracks"])
                        .iter()
                        .any(|track| !track.is_object())
            })
        {
            return Err("曲库索引版本或格式不受支持，已保留原文件".into());
        }
        let rules = validate_rules(read_json(
            &data_dir.join("genre-rules.json"),
            default_rules(),
        )?)?;
        if !data_dir.join("genre-rules.json").exists() {
            write_json(&data_dir.join("genre-rules.json"), &rules)?;
        }
        write_json(&data_dir.join("config.json"), &config)?;
        Ok(Self {
            data_dir,
            config,
            index,
            rules,
            scan: json!({"running":false}),
            enrich: json!({"running":false,"completed":0,"total":0}),
            introductions: json!({"running":false,"completed":0,"total":0,"updated":0,"notFound":0,"failed":0}),
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
    pub fn save_index(&self) -> Result<()> {
        write_json(&self.data_dir.join("library-index.json"), &self.index)
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
        write_json(&path, &rules)?;
        self.rules = rules;
        Ok(self.rules.clone())
    }
    pub fn update_config(&mut self, value: &Value) -> Result<Value> {
        if !value.is_object() {
            return Err("配置必须是 JSON 对象".into());
        }
        let mut next = self.config.clone();
        if let Some(roots) = value.get("roots") {
            if self.scan["running"] == true {
                return Err("正在扫描，请完成后再更改根目录".into());
            }
            next["roots"] = json!(safe_roots(roots)?);
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
        write_json(&self.data_dir.join("config.json"), &next)?;
        self.config = next;
        Ok(self.config_snapshot())
    }
    pub fn snapshot(&self) -> Value {
        let roots = array(&self.config["roots"]);
        let mut counts: HashMap<String, usize> = HashMap::new();
        let mut generated = Vec::new();
        let albums: Vec<_> = array(&self.index["albums"]).iter().filter(|a| roots.contains(&a["_root"])).map(|album| {
            let id = genre_for(album, &self.rules);
            if !counts.contains_key(&id) && id.starts_with("source-") {
                generated.push(json!({"id":id,"name":array(&album["_onlineGenres"]).first().or_else(|| array(&album["_localGenres"]).first()).unwrap_or(&Value::Null)}));
            }
            *counts.entry(id.clone()).or_default() += 1;
            let mut public = album.clone();
            public.as_object_mut().unwrap().retain(|k,_| !k.starts_with('_'));
            public["genreId"] = json!(id);
            public["rawGenres"] = json!(unique(array(&album["_onlineGenres"]).iter().chain(array(&album["_localGenres"])).cloned()));
            public["tracks"] = json!(array(&album["tracks"]).iter().map(|t| { let mut t=t.clone(); t.as_object_mut().unwrap().retain(|k,_| !k.starts_with('_')); t }).collect::<Vec<_>>());
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
        let mut public = json!({"version":1,"albums":albums,"genres":genres,"roots":roots,"scan":self.scan,"onlineEnabled":self.config["onlineEnabled"] == true,"enrich":self.enrich,"introductions":self.introductions});
        // TypeScript optional fields must be absent, not null. Apply this only
        // to the cloned public snapshot; config and private index retain their
        // existing representation (including foobarBaseUrl: null).
        omit_null_fields(&mut public);
        public
    }
    pub fn file(&self, id: &str, artwork: bool) -> Option<AllowedFile> {
        for album in array(&self.index["albums"])
            .iter()
            .filter(|a| array(&self.config["roots"]).contains(&a["_root"]))
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
        let mut copy = {
            let mut store = shared.lock().unwrap();
            if store.scan["running"] == true {
                return Ok(());
            }
            if let Some(roots) = roots {
                store.update_config(&json!({"roots":roots}))?;
            }
            store.scan = json!({"running":true,"startedAt":now()});
            store.clone()
        };
        let shared = shared.clone();
        std::thread::spawn(move || {
            let result = copy.scan_sync();
            let online = {
                let mut store = shared.lock().unwrap();
                if result.is_ok() {
                    for album in copy.index["albums"].as_array_mut().unwrap() {
                        if let Some(current) = array(&store.index["albums"])
                            .iter()
                            .find(|a| a["id"] == album["id"])
                        {
                            merge_online(current, album);
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
                let _ = crate::online::begin_enrich(&shared, &json!({}), false);
            }
        });
        Ok(())
    }
    pub fn scan_sync(&mut self) -> Result<()> {
        self.reload_rules()?;
        let mut albums = Vec::new();
        let mut roots = Vec::new();
        for root in array(&self.config["roots"]) {
            let previous: Vec<_> = array(&self.index["albums"])
                .iter()
                .filter(|a| a["_root"] == *root)
                .collect();
            let scanned = (|| {
                let entries = walk(Path::new(text(root)))?;
                entries
                    .into_iter()
                    .map(|entry| {
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
                        let old = previous.iter().find(|a| a["id"] == id).copied();
                        self.read_album(Path::new(text(root)), entry, &id, old)
                    })
                    .collect::<Result<Vec<_>>>()
            })();
            match scanned {
                Ok(found) => {
                    albums.extend(found);
                    roots.push(json!({"path":root,"status":"online"}));
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
        self.index = json!({"version":1,"albums":albums,"roots":roots,"scannedAt":now()});
        Ok(())
    }
    fn read_album(
        &self,
        root: &Path,
        entry: Entry,
        id: &str,
        previous: Option<&Value>,
    ) -> Result<Value> {
        let file_cover=entry.cover.as_ref().map(|p| -> Result<Value> {Ok(json!({"path":p,"mime":mime(p),"version":hash(fingerprint(p)?),"embedded":false}))}).transpose()?;
        let mut cover = if entry.single.is_none() {
            file_cover.clone()
        } else {
            None
        };
        let mut tracks = Vec::new();
        let disc_prefix = Regex::new(r"^(\d{1,2})[-_](\d{1,3})(?:[\s._-]|$)").unwrap();
        for file in entry.tracks {
            let fingerprint = fingerprint(&file)?;
            let old = previous.and_then(|a| {
                array(&a["tracks"])
                    .iter()
                    .find(|t| t["_path"] == json!(file))
            });
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
            // A permission/sharing failure is not a missing tag. Keep the
            // previous root snapshot instead of replacing its metadata.
            fs::File::open(&file).map_err(|e| e.to_string())?;
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
                        json!({"path":target,"mime":if mime=="image/jpg"{"image/jpeg"}else{&mime},"version":version,"embedded":true}),
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
                    json!(file.strip_prefix(root).unwrap_or(&file)),
                ),
                ("_path", json!(file)),
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
        let first = tracks.first().ok_or("空专辑")?;
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
        let mbid = Regex::new(r"(?i)^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$").unwrap();
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
            "localNote":comments,"genreId":"unclassified","rawGenres":genres,"folder":entry.folder,"tracks":tracks,"offline":false,
            "producers":[],"online":{"status":"unqueried","releaseId":release("releaseId"),"releaseGroupId":release("releaseGroupId")},
            "_root":root,"_cover":cover,"_localGenres":genres,"_onlineGenres":[]});
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
        Ok(album)
    }
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
fn fingerprint(file: &Path) -> Result<String> {
    let s = fs::metadata(file).map_err(|e| e.to_string())?;
    Ok(format!(
        "{}:{}",
        s.len(),
        s.modified()
            .map_err(|e| e.to_string())?
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
pub fn mime(p: &Path) -> &'static str {
    match extension(p).as_str() {
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
struct Entry {
    folder: PathBuf,
    tracks: Vec<PathBuf>,
    single: Option<PathBuf>,
    cover: Option<PathBuf>,
}
fn walk(root: &Path) -> Result<Vec<Entry>> {
    fn visit(root: &Path, folder: &Path, output: &mut Vec<Entry>) -> Result<()> {
        let mut entries = fs::read_dir(folder)
            .map_err(|e| e.to_string())?
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        entries.sort_by(|a, b| {
            natural_cmp(
                &a.file_name().to_string_lossy(),
                &b.file_name().to_string_lossy(),
            )
        });
        // Resolve every type once and propagate failures. Silently dropping an
        // unreadable entry would turn an incomplete scan into apparent deletion.
        let mut files = Vec::new();
        let mut directories = Vec::new();
        for entry in &entries {
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_file() {
                files.push(entry.path());
            } else if kind.is_dir()
                && !kind.is_symlink()
                && !entry.file_name().to_string_lossy().starts_with('.')
            {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if entry
                        .metadata()
                        .map_err(|e| e.to_string())?
                        .file_attributes()
                        & 0x400
                        != 0
                    {
                        continue;
                    }
                }
                directories.push(entry.path());
            }
        }
        let tracks: Vec<_> = files
            .iter()
            .filter(|p| {
                matches!(
                    extension(p).as_str(),
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
            })
            .cloned()
            .collect();
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
            for track in tracks {
                let name = track
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .nfc()
                    .collect::<String>()
                    .to_lowercase();
                let cover = images
                    .iter()
                    .find(|p| {
                        p.file_stem()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .nfc()
                            .collect::<String>()
                            .to_lowercase()
                            == name
                    })
                    .cloned();
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
            visit(root, &directory, output)?;
        }
        Ok(())
    }
    let mut output = Vec::new();
    visit(root, root, &mut output)?;
    Ok(output)
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
}
