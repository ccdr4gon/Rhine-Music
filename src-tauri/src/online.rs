//! Attributed online metadata. Only album text and public IDs leave the machine.
use crate::library::{array, normalized, now, text, unique, Result, SharedStore};
use ferrous_opencc::{config::BuiltinConfig, OpenCC};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use unicode_normalization::UnicodeNormalization;
use url::Url;

fn simplified(s: &str) -> String {
    static CC: OnceLock<OpenCC> = OnceLock::new();
    CC.get_or_init(|| OpenCC::from_config(BuiltinConfig::Hk2s).expect("embedded OpenCC dictionary"))
        .convert(s)
}
fn traditional(s: &str) -> String {
    static CC: OnceLock<OpenCC> = OnceLock::new();
    CC.get_or_init(|| OpenCC::from_config(BuiltinConfig::S2tw).expect("embedded OpenCC dictionary"))
        .convert(s)
}
fn clean(s: &str) -> String {
    s.trim()
        .nfkc()
        .collect::<String>()
        .replace(['‘', '’', '′'], "'")
        .replace(['“', '”'], "\"")
}
pub fn normalize_name(s: &str) -> String {
    // Preserve letters' combining marks. Dropping every non-alphanumeric
    // character makes distinct Thai and other non-Latin names compare equal.
    static IGNORED: OnceLock<Regex> = OnceLock::new();
    IGNORED
        .get_or_init(|| Regex::new(r"[\s\p{P}\p{S}]").unwrap())
        .replace_all(&simplified(&clean(s)).to_lowercase(), "")
        .into_owned()
}
fn unique_text(items: impl IntoIterator<Item = String>) -> Vec<String> {
    unique(items.into_iter().map(Value::String))
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}
pub fn name_aliases(s: &str) -> Vec<String> {
    let name = clean(s);
    let brackets = Regex::new(r"[（(]([^()（）]+)[)）]").unwrap();
    let generic = Regex::new(
        r"(?i)^(?:(?:19|20)\d{2}\s*)?(?:album|EP|single|compilation|專輯|专辑|唱片|單曲|单曲)$",
    )
    .unwrap();
    let suffix = Regex::new(r"(?i)\s*-\s*(?:EP|Single)$").unwrap();
    let mut aliases = vec![name.clone(), brackets.replace_all(&name, "").trim().into()];
    aliases.extend(
        brackets
            .captures_iter(&name)
            .map(|c| clean(&c[1]))
            .filter(|s| !generic.is_match(s)),
    );
    unique_text(
        aliases
            .into_iter()
            .flat_map(|s| vec![s.clone(), suffix.replace(&s, "").trim().into()])
            .filter(|s| normalize_name(s).chars().count() > 1),
    )
}
fn artist_aliases(album: &Value) -> Vec<String> {
    let mut names = name_aliases(text(&album["artist"]));
    let bilingual = Regex::new(r"^([\p{Han}·\s]+?)\s+([A-Za-z][A-Za-z\s.'-]+)$").unwrap();
    for name in names.clone() {
        if let Some(c) = bilingual.captures(&name) {
            names.push(c[1].trim().into());
            names.push(c[2].trim().into());
        }
    }
    unique_text(names.into_iter().filter(|n| {
        !Regex::new(r"(?i)未知|unknown|various artists")
            .unwrap()
            .is_match(n)
    }))
}
fn album_aliases(album: &Value) -> Vec<String> {
    let artists = artist_aliases(album);
    let mut names = name_aliases(text(&album["title"]));
    for name in names.clone() {
        for artist in &artists {
            let normalized = normalize_name(&name);
            if let Some(rest) = normalized.strip_prefix(&normalize_name(artist)) {
                if rest.chars().count() >= 3 {
                    names.push(rest.into());
                }
            }
        }
    }
    unique_text(names)
}
fn entity_names(entity: &Value) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(labels) = entity["labels"].as_object() {
        names.extend(labels.values().map(|v| text(&v["value"]).into()));
    }
    if let Some(aliases) = entity["aliases"].as_object() {
        for entries in aliases.values() {
            names.extend(array(entries).iter().map(|v| text(&v["value"]).into()));
        }
    }
    unique_text(names)
}
fn claims<'a>(entity: &'a Value, key: &str) -> Vec<&'a Value> {
    array(&entity["claims"][key])
        .iter()
        .filter(|c| c["rank"] != "deprecated")
        .map(|c| &c["mainsnak"]["datavalue"]["value"])
        .filter(|v| !v.is_null())
        .collect()
}
pub fn assess_candidate(
    album: &Value,
    page: &Value,
    entity: &Value,
    performers: &Value,
) -> std::result::Result<(), &'static str> {
    if page["missing"] == true || page["pageprops"].get("disambiguation").is_some() {
        return Err("disambiguation");
    }
    let mut names = entity_names(entity);
    names.push(text(&page["title"]).into());
    let suffix = Regex::new(
        r"(?i)\s*\((?:[^()]*\s)?(?:album|EP|compilation|專輯|专辑|唱片|精選輯|精选辑)\)\s*$",
    )
    .unwrap();
    names.push(suffix.replace(&clean(text(&page["title"])), "").into());
    let titles: Vec<_> = album_aliases(album)
        .iter()
        .map(|s| normalize_name(s))
        .collect();
    if !names
        .iter()
        .flat_map(|s| name_aliases(s))
        .any(|s| titles.contains(&normalize_name(&s)))
    {
        return Err("title");
    }
    let artists: Vec<_> = artist_aliases(album)
        .iter()
        .map(|s| normalize_name(s))
        .collect();
    if artists.is_empty() {
        return Err("missing-artist");
    }
    let ids: Vec<_> = claims(entity, "P175")
        .into_iter()
        .filter_map(|v| v["id"].as_str())
        .collect();
    let years: Vec<_> = claims(entity, "P577")
        .into_iter()
        .filter_map(|v| {
            text(&v["time"])
                .strip_prefix('+')
                .and_then(|s| s.get(..4))
                .and_then(|s| s.parse::<u64>().ok())
        })
        .collect();
    let year = album["year"].as_u64().unwrap_or(0);
    let extract = clean(text(&page["extract"]));
    let paragraphs = Regex::new(r"\n\s*\n").unwrap();
    let intro = paragraphs.split(&extract).next().unwrap_or("");
    let sentence = intro.split(['。', '\n']).next().unwrap_or("");
    let is_album =
        Regex::new(r"(?i)专辑|專輯|唱片|精选辑|精選輯|合辑|合輯|\balbum\b|\bEP\b|\bcompilation\b")
            .unwrap()
            .is_match(sentence);
    let is_song = Regex::new(
        r"(?i)(?:是|為|为)[^。]{0,60}(?:一首|歌曲)|\bis (?:an? |the )?[^.]{0,35}\bsong\b",
    )
    .unwrap()
    .is_match(sentence);
    if !is_album || is_song {
        return Err("work-type");
    }
    if !ids.is_empty()
        && !ids.iter().any(|id| {
            entity_names(&performers[*id])
                .iter()
                .any(|n| artists.contains(&normalize_name(n)))
        })
    {
        return Err("artist");
    }
    if year > 0 && !years.is_empty() && !years.contains(&year) {
        return Err("year");
    }
    if !ids.is_empty() && year > 0 && years.contains(&year) {
        return Ok(());
    }
    let mentions_artist = artists.iter().any(|a| normalize_name(intro).contains(a));
    let publication=Regex::new(&format!(r"(?i)(?:{year}[^。.!?\n]{{0,90}}(?:发[行佈布]|發[行佈布]|推出|出版|released|published)|(?:发行|發行|推出|出版|released|published)[^。.!?\n]{{0,90}}{year})")).unwrap();
    if year > 0 && mentions_artist && publication.is_match(intro) {
        Ok(())
    } else {
        Err(if year == 0 {
            "missing-year"
        } else {
            "insufficient-evidence"
        })
    }
}

pub type Fetcher = Arc<dyn Fn(&Url) -> Result<Value> + Send + Sync>;
pub struct Provider {
    fetcher: Fetcher,
    interval: Duration,
    last: Option<Instant>,
    entities: HashMap<String, Value>,
}
impl Provider {
    pub fn new(contact: &str) -> Result<Self> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(format!(
                "RhineLocalMusic/0.3 (personal music library metadata client; {contact})"
            ))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self::with_fetcher(
            Arc::new(move |url| {
                let response = client
                    .get(url.clone())
                    .timeout(Duration::from_secs(
                        if url.host_str() == Some("musicbrainz.org") {
                            15
                        } else {
                            8
                        },
                    ))
                    .header("Accept", "application/json")
                    .send()
                    .map_err(|e| format!("{} 连接失败或超时：{e}", url.host_str().unwrap_or("")))?;
                if !response.status().is_success() {
                    return Err(format!(
                        "{} HTTP {}",
                        url.host_str().unwrap_or(""),
                        response.status()
                    ));
                }
                response.json().map_err(|e| e.to_string())
            }),
            Duration::from_millis(1100),
        ))
    }
    pub fn with_fetcher(fetcher: Fetcher, interval: Duration) -> Self {
        Self {
            fetcher,
            interval,
            last: None,
            entities: HashMap::new(),
        }
    }
    fn request(&mut self, url: Url) -> Result<Value> {
        if url.scheme() != "https"
            || !matches!(
                url.host_str(),
                Some(
                    "zh.wikipedia.org"
                        | "en.wikipedia.org"
                        | "www.wikidata.org"
                        | "musicbrainz.org"
                )
            )
        {
            return Err("不支持的在线资料来源".into());
        }
        if let Some(last) = self.last {
            let elapsed = last.elapsed();
            if elapsed < self.interval {
                std::thread::sleep(self.interval - elapsed);
            }
        }
        self.last = Some(Instant::now());
        let data = (self.fetcher)(&url)?;
        if data.get("error").is_some() {
            return Err(format!(
                "{}: {}",
                url.host_str().unwrap_or(""),
                data["error"]
            ));
        }
        Ok(data)
    }
    fn entities(&mut self, ids: &[String]) -> Result<Value> {
        let missing: Vec<_> = unique_text(
            ids.iter()
                .filter(|id| {
                    Regex::new(r"^Q\d+$").unwrap().is_match(id) && !self.entities.contains_key(*id)
                })
                .cloned(),
        )
        .into_iter()
        .take(30)
        .collect();
        if !missing.is_empty() {
            let mut url = Url::parse("https://www.wikidata.org/w/api.php").unwrap();
            url.query_pairs_mut().extend_pairs([
                ("action", "wbgetentities"),
                ("format", "json"),
                ("ids", &missing.join("|")),
                ("props", "labels|aliases|claims|sitelinks"),
                ("languages", "zh|zh-hans|zh-hant|zh-cn|zh-tw|en"),
                ("languagefallback", "1"),
            ]);
            let result = self.request(url)?;
            for id in missing {
                self.entities
                    .insert(id.clone(), result["entities"][&id].clone());
            }
        }
        Ok(Value::Object(
            ids.iter()
                .map(|id| {
                    (
                        id.clone(),
                        self.entities.get(id).cloned().unwrap_or(Value::Null),
                    )
                })
                .collect(),
        ))
    }
    fn pages(&mut self, language: &str, params: &[(&str, String)]) -> Result<Vec<Value>> {
        let mut url = Url::parse(&format!("https://{language}.wikipedia.org/w/api.php")).unwrap();
        url.query_pairs_mut()
            .extend_pairs(
                [
                    ("action", "query"),
                    ("format", "json"),
                    ("formatversion", "2"),
                    ("prop", "extracts|pageprops|info"),
                    ("exintro", "1"),
                    ("explaintext", "1"),
                    ("exchars", "1000"),
                    ("inprop", "url"),
                    ("redirects", "1"),
                    ("converttitles", "1"),
                ]
                .into_iter()
                .filter(|(key, _)| !params.iter().any(|(given, _)| key == given)),
            )
            .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
        let data = self.request(url)?;
        Ok(array(&data["query"]["pages"])
            .iter()
            .filter(|p| p["pageid"].as_i64().unwrap_or(0) > 0 && p["missing"] != true)
            .map(|p| {
                let mut p = p.clone();
                p["language"] = json!(language);
                p
            })
            .collect())
    }
    fn candidates(&mut self, album: &Value, pages: &[Value]) -> Value {
        let existing: Vec<_> = pages
            .iter()
            .filter(|p| p["pageprops"].get("disambiguation").is_none())
            .collect();
        let possible: Vec<_> = existing
            .iter()
            .copied()
            .filter(|p| !text(&p["extract"]).is_empty())
            .collect();
        let ids: Vec<_> = possible
            .iter()
            .filter_map(|p| p["pageprops"]["wikibase_item"].as_str().map(str::to_owned))
            .collect();
        let (mut entities, mut performers, mut structured_error) = (json!({}), json!({}), None);
        if !ids.is_empty() {
            match self.entities(&ids) {
                Ok(e) => {
                    entities = e;
                    let ids: Vec<_> = entities
                        .as_object()
                        .unwrap()
                        .values()
                        .flat_map(|e| claims(e, "P175"))
                        .filter_map(|v| v["id"].as_str().map(str::to_owned))
                        .collect();
                    match self.entities(&ids) {
                        Ok(p) => performers = p,
                        Err(e) => structured_error = Some(e),
                    }
                }
                Err(e) => structured_error = Some(e),
            }
        }
        let matched: Vec<_> = possible
            .iter()
            .copied()
            .filter(|p| {
                assess_candidate(
                    album,
                    p,
                    &entities[text(&p["pageprops"]["wikibase_item"])],
                    &performers,
                )
                .is_ok()
            })
            .collect();
        let identities = unique_text(matched.iter().map(|p| {
            if p["pageprops"]["wikibase_item"].is_string() {
                text(&p["pageprops"]["wikibase_item"]).into()
            } else {
                format!("{}:{}", p["language"], p["pageid"])
            }
        }));
        if identities.len() > 1 {
            return json!({"status":"uncertain","error":"存在多个名称、歌手和年份均符合的百科条目，未自动采用"});
        }
        if let Some(page) = matched.first() {
            return attributed(page);
        }
        if let Some(error) = structured_error {
            return json!({"status":"error","error":error});
        }
        let mut result = json!({"status":if existing.is_empty(){"not-found"}else{"uncertain"}});
        if !existing.is_empty() && possible.is_empty() {
            result["error"] = json!("百科条目存在，但没有可读取的导言");
        }
        if let Some(page) = possible.first() {
            result["candidateUrl"] = json!(page_url(page));
        }
        result
    }
    pub fn lookup(&mut self, album: &Value) -> Value {
        if text(&album["title"]).is_empty()
            || artist_aliases(album).is_empty()
            || album["year"].as_u64().unwrap_or(0) == 0
        {
            return json!({"status":"uncertain","checkedAt":now(),"error":"本地专辑名称、歌手或年份不完整，无法可靠匹配"});
        }
        let aliases = album_aliases(album);
        let titles: Vec<_> = unique_text(
            aliases
                .iter()
                .flat_map(|s| vec![s.clone(), simplified(s), traditional(s)]),
        )
        .into_iter()
        .take(12)
        .collect();
        let (mut failures, mut uncertain, mut succeeded) = (Vec::new(), None, false);
        for language in ["zh", "en"] {
            let pass = (|| -> Result<Value> {
                let mut pages = self.pages(language, &[("titles", titles.join("|"))])?;
                let result = self.candidates(album, &pages);
                if result["status"] == "matched" {
                    return Ok(result);
                }
                if result["status"] == "error" {
                    failures.push(text(&result["error"]).to_owned());
                }
                if result["status"] == "uncertain" {
                    uncertain = Some(result);
                }
                let han = Regex::new(r"\p{Han}").unwrap();
                let choose = |values: &[String]| {
                    values
                        .iter()
                        .find(|s| {
                            if language == "zh" {
                                han.is_match(s)
                            } else {
                                s.is_ascii()
                            }
                        })
                        .or_else(|| values.first())
                        .cloned()
                        .unwrap_or_default()
                };
                let query = format!(
                    "\"{}\" \"{}\"",
                    choose(&aliases).replace('"', " "),
                    choose(&artist_aliases(album)).replace('"', " ")
                );
                let searched = self.pages(
                    language,
                    &[
                        ("generator", "search".into()),
                        ("gsrsearch", query),
                        ("gsrlimit", "5".into()),
                        ("gsrnamespace", "0".into()),
                    ],
                )?;
                for page in searched {
                    if let Some(old) = pages.iter_mut().find(|p| p["pageid"] == page["pageid"]) {
                        *old = page;
                    } else {
                        pages.push(page);
                    }
                }
                Ok(self.candidates(album, &pages))
            })();
            match pass {
                Ok(mut result) => {
                    if result["status"] == "matched" {
                        result["checkedAt"] = json!(now());
                        return result;
                    }
                    if result["status"] == "error" {
                        failures.push(text(&result["error"]).into());
                    } else {
                        succeeded = true;
                    }
                    if result["status"] == "uncertain" {
                        uncertain = Some(result);
                    }
                }
                Err(e) => failures.push(e),
            }
        }
        if !succeeded && !failures.is_empty() {
            return json!({"status":"error","checkedAt":now(),"error":unique_text(failures).join("；")});
        }
        let mut result = uncertain.unwrap_or_else(|| json!({"status":"not-found"}));
        result["checkedAt"] = json!(now());
        if !failures.is_empty() {
            result["error"] = json!(format!(
                "部分来源无法访问：{}",
                unique_text(failures).join("；")
            ));
        }
        result
    }
    fn musicbrainz(&mut self, endpoint: &str, params: &[(&str, String)]) -> Result<Value> {
        let mut url = Url::parse(&format!("https://musicbrainz.org/ws/2/{endpoint}"))
            .map_err(|e| e.to_string())?;
        url.query_pairs_mut()
            .append_pair("fmt", "json")
            .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
        self.request(url)
    }
    fn linked_introduction(&mut self, group: &Value) -> Result<Option<Value>> {
        let mut selected = None;
        for relation in array(&group["relations"])
            .iter()
            .filter(|relation| relation["type"] == "wikidata")
            .take(1)
        {
            let resource = text(&relation["url"]["resource"]);
            if relation["type"] == "wikidata" {
                if let Some(qid) = Regex::new(r"^https?://(?:www\.)?wikidata\.org/wiki/(Q\d+)/?$")
                    .unwrap()
                    .captures(resource)
                {
                    let data = self.request(
                        Url::parse(&format!(
                            "https://www.wikidata.org/wiki/Special:EntityData/{}.json",
                            &qid[1]
                        ))
                        .unwrap(),
                    )?;
                    let links = &data["entities"][&qid[1]]["sitelinks"];
                    for (language, key) in [("zh", "zhwiki"), ("en", "enwiki")] {
                        if let Some(title) = links[key]["title"].as_str() {
                            selected = Some((language.to_string(), title.to_string()));
                            break;
                        }
                    }
                }
            }
        }
        if selected.is_none() {
            for language in ["zh", "en"] {
                for relation in array(&group["relations"]) {
                    if let Ok(url) = Url::parse(text(&relation["url"]["resource"])) {
                        if url.host_str() == Some(&format!("{language}.wikipedia.org"))
                            && url.path().starts_with("/wiki/")
                        {
                            selected = Some((
                                language.into(),
                                percent_encoding::percent_decode_str(&url.path()[6..])
                                    .decode_utf8_lossy()
                                    .replace('_', " "),
                            ));
                            break;
                        }
                    }
                }
                if selected.is_some() {
                    break;
                }
            }
        }
        if let Some((language, title)) = selected {
            let pages = self.pages(&language, &[("titles", title), ("exchars", "800".into())])?;
            if let Some(page) = pages.iter().find(|p| {
                p["pageprops"].get("disambiguation").is_none() && !text(&p["extract"]).is_empty()
            }) {
                let mut introduction = attributed(page);
                // A MusicBrainz link already identifies the article; retain its
                // original typography like the legacy linked-introduction path.
                introduction["description"] = json!(text(&page["extract"]));
                return Ok(Some(introduction));
            }
        }
        Ok(None)
    }
    pub fn enrich(&mut self, album: &Value) -> Result<Value> {
        let mut release_id = text(&album["online"]["releaseId"]).to_owned();
        if release_id.is_empty() {
            let escape = |s: &str| {
                Regex::new(r#"[+\-&|!(){}\[\]^"~*?:\\/]"#)
                    .unwrap()
                    .replace_all(s, r"\$0")
                    .into_owned()
            };
            let query = format!(
                "release:\"{}\" AND artist:\"{}\"",
                escape(text(&album["title"])),
                escape(text(&album["artist"]))
            );
            let found = self.musicbrainz("release", &[("query", query), ("limit", "5".into())])?;
            let candidates: Vec<_> = array(&found["releases"])
                .iter()
                .filter(|c| {
                    let artist = array(&c["artist-credit"])
                        .iter()
                        .map(|credit| {
                            if credit["name"].is_string() {
                                text(&credit["name"])
                            } else {
                                text(&credit["artist"]["name"])
                            }
                        })
                        .collect::<String>();
                    normalized(text(&c["title"])) == normalized(text(&album["title"]))
                        && normalized(&artist) == normalized(text(&album["artist"]))
                        && number(&c["track-count"]) == Some(array(&album["tracks"]).len() as u64)
                        && (number(&album["year"]).unwrap_or(0) == 0
                            || text(&c["date"]).is_empty()
                            || text(&c["date"])
                                .starts_with(&number(&album["year"]).unwrap_or(0).to_string()))
                        && c["score"]
                            .as_u64()
                            .or_else(|| text(&c["score"]).parse().ok())
                            .unwrap_or(0)
                            >= 95
                })
                .collect();
            if candidates.len() != 1 {
                return Ok({
                    let mut online = album["online"].as_object().cloned().unwrap_or_default();
                    online.insert(
                        "status".into(),
                        json!(if array(&found["releases"]).is_empty() {
                            "not-found"
                        } else {
                            "uncertain"
                        }),
                    );
                    online.insert("checkedAt".into(), json!(now()));
                    json!({"online":online})
                });
            }
            release_id = text(&candidates[0]["id"]).into();
        }
        if !valid_mbid(&release_id) {
            return Err("无效的 MusicBrainz Release ID".into());
        }
        let release = self.musicbrainz(
            &format!("release/{release_id}"),
            &[(
                "inc",
                "artist-credits+recordings+recording-level-rels+artist-rels+release-groups+genres"
                    .into(),
            )],
        )?;
        let group_id = release["release-group"]["id"]
            .as_str()
            .or(album["online"]["releaseGroupId"].as_str());
        let group = if let Some(id) = group_id.filter(|id| valid_mbid(id)) {
            self.musicbrainz(
                &format!("release-group/{id}"),
                &[("inc", "genres+artist-rels+url-rels".into())],
            )?
        } else {
            Value::Null
        };
        let mut genres: Vec<_> = array(&release["genres"])
            .iter()
            .chain(array(&group["genres"]))
            .collect();
        genres.sort_by_key(|g| std::cmp::Reverse(g["count"].as_u64().unwrap_or(0)));
        let mut producers: Vec<Value> = array(&album["producers"])
            .iter()
            .filter(|p| p["source"] != "MusicBrainz")
            .cloned()
            .collect();
        let mut collect = |relations: &Value, title: Option<&Value>| {
            for r in array(relations) {
                if text(&r["type"]).to_lowercase().contains("producer")
                    && !text(&r["artist"]["name"]).is_empty()
                {
                    let mut p = json!({"name":r["artist"]["name"],"role":r["type"],"source":"MusicBrainz","url":format!("https://musicbrainz.org/artist/{}",text(&r["artist"]["id"]))});
                    if let Some(t) = title {
                        p["trackTitle"] = t.clone();
                    }
                    producers.push(p);
                }
            }
        };
        collect(&release["relations"], None);
        collect(&group["relations"], None);
        for medium in array(&release["media"]) {
            for track in array(&medium["tracks"]) {
                collect(
                    &track["recording"]["relations"],
                    track.get("title").or(track["recording"].get("title")),
                );
            }
        }
        let mut result = json!({"_onlineGenres":unique_text(genres.iter().map(|g|text(&g["name"]).into())),"producers":unique_producers(producers),"online":{"status":"matched","releaseId":release_id,"releaseGroupId":group_id,"checkedAt":now(),"sourceUrl":format!("https://musicbrainz.org/release/{release_id}")}});
        match self.linked_introduction(&group) {
            Ok(Some(description)) => {
                result["description"] = description["description"].clone();
                result["descriptionSource"] = description["descriptionSource"].clone();
                result["online"]["descriptionStatus"] = json!("available");
            }
            Ok(None) => result["online"]["descriptionStatus"] = json!("not-found"),
            Err(e) => {
                result["online"]["descriptionStatus"] = json!("error");
                result["online"]["descriptionError"] = json!(e);
            }
        }
        Ok(result)
    }
}
fn number(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| text(value).parse().ok())
}
fn valid_mbid(id: &str) -> bool {
    id.len() == 36 && uuid::Uuid::parse_str(id).is_ok()
}
fn unique_producers(items: impl IntoIterator<Item = Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    items
        .into_iter()
        .filter(|p| {
            seen.insert((
                text(&p["name"]).to_owned(),
                text(&p["role"]).to_owned(),
                text(&p["trackTitle"]).to_owned(),
                text(&p["source"]).to_owned(),
            ))
        })
        .collect()
}
fn same_album(a: &Value, b: &Value) -> bool {
    a["title"] == b["title"] && a["artist"] == b["artist"] && a["year"] == b["year"]
}
fn page_url(page: &Value) -> String {
    format!(
        "https://{}.wikipedia.org/wiki/{}",
        text(&page["language"]),
        percent_encoding::utf8_percent_encode(
            &text(&page["title"]).replace(' ', "_"),
            percent_encoding::NON_ALPHANUMERIC
        )
    )
}
fn attributed(page: &Value) -> Value {
    json!({"status":"matched","description":clean(text(&page["extract"])),"descriptionSource":{"name":if page["language"]=="zh"{"维基百科"}else{"Wikipedia"},"url":page_url(page),"checkedAt":now(),"license":"CC BY-SA（以来源页为准）"}})
}
fn selected(input: &Value) -> Result<Option<Vec<String>>> {
    match input.get("albumIds") {
        None => Ok(None),
        Some(v) => {
            let ids = v
                .as_array()
                .filter(|v| v.len() <= 10000 && v.iter().all(Value::is_string))
                .ok_or("albumIds 必须是专辑 ID 数组")?;
            Ok(Some(ids.iter().map(|v| text(v).into()).collect()))
        }
    }
}
pub fn begin_introductions(shared: &SharedStore, input: &Value) -> Result<()> {
    start_introductions(shared, input, Provider::new)
}
/// Supply a provider for deterministic offline verification of the full batch.
pub fn begin_introductions_with_provider(
    shared: &SharedStore,
    input: &Value,
    provider: Provider,
) -> Result<()> {
    start_introductions(shared, input, |_| Ok(provider))
}
fn start_introductions(
    shared: &SharedStore,
    input: &Value,
    provider: impl FnOnce(&str) -> Result<Provider> + Send + 'static,
) -> Result<()> {
    let ids = selected(input)?;
    let force = match input.get("force") {
        Some(v) => v.as_bool().ok_or("force 必须为布尔值")?,
        None => false,
    };
    let (albums, contact) = {
        let mut s = shared.lock().unwrap();
        if s.introductions["running"] == true {
            return Ok(());
        }
        let albums: Vec<_> = array(&s.index["albums"])
            .iter()
            .filter(|a| {
                array(&s.config["roots"]).contains(&a["_root"])
                    && ids
                        .as_ref()
                        .is_none_or(|ids| ids.iter().any(|id| a["id"] == *id))
            })
            .filter(|a| {
                if force {
                    return true;
                }
                if !text(&a["description"]).is_empty()
                    && !text(&a["descriptionSource"]["url"]).is_empty()
                {
                    return false;
                }
                a["introduction"]["status"] == "error"
                    || chrono::DateTime::parse_from_rfc3339(text(&a["introduction"]["checkedAt"]))
                        .map(|d| {
                            chrono::Utc::now().signed_duration_since(d) > chrono::Duration::days(7)
                        })
                        .unwrap_or(true)
            })
            .cloned()
            .collect();
        s.introductions = json!({"running":true,"completed":0,"total":albums.len(),"updated":0,"notFound":0,"failed":0});
        (albums, s.contact())
    };
    let shared = shared.clone();
    std::thread::spawn(move || {
        let outcome = (|| -> Result<()> {
            let mut provider = provider(&contact)?;
            let mut consecutive = 0;
            for album in albums {
                shared.lock().unwrap().introductions["currentAlbum"] = album["title"].clone();
                let result = provider.lookup(&album);
                let mut s = shared.lock().unwrap();
                let current = s.index["albums"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|a| a["id"] == album["id"] && same_album(a, &album));
                let mut applied = false;
                if let Some(current) = current {
                    let mut status = result.clone();
                    status.as_object_mut().unwrap().remove("description");
                    status.as_object_mut().unwrap().remove("descriptionSource");
                    current["introduction"] = status;
                    if result["status"] == "matched" {
                        current["description"] = result["description"].clone();
                        current["descriptionSource"] = result["descriptionSource"].clone();
                    }
                    applied = true;
                }
                let key = match text(&result["status"]) {
                    "matched" => "updated",
                    "error" => "failed",
                    _ => "notFound",
                };
                if applied {
                    let n = s.introductions[key].as_u64().unwrap_or(0) + 1;
                    s.introductions[key] = json!(n);
                }
                let n = s.introductions["completed"].as_u64().unwrap_or(0) + 1;
                s.introductions["completed"] = json!(n);
                if result["status"] == "error" {
                    consecutive += 1;
                    s.introductions["error"] = result["error"].clone();
                } else {
                    consecutive = 0;
                }
                s.save_index()?;
                if consecutive >= 3 && n < s.introductions["total"].as_u64().unwrap_or(0) {
                    s.introductions["error"] = json!(format!(
                        "百科来源连续 3 次访问失败，已暂停剩余 {} 张，避免重复超时。{}",
                        s.introductions["total"].as_u64().unwrap_or(0) - n,
                        text(&result["error"])
                    ));
                    break;
                }
            }
            Ok(())
        })();
        let mut s = shared.lock().unwrap();
        if let Err(e) = outcome {
            s.introductions["error"] = json!(e);
        }
        s.introductions["running"] = json!(false);
        s.introductions
            .as_object_mut()
            .unwrap()
            .remove("currentAlbum");
    });
    Ok(())
}
pub fn begin_enrich(shared: &SharedStore, input: &Value, force: bool) -> Result<()> {
    start_enrich(shared, input, force, Provider::new)
}
/// Supply a provider without contacting public services during verification.
pub fn begin_enrich_with_provider(
    shared: &SharedStore,
    input: &Value,
    force: bool,
    provider: Provider,
) -> Result<()> {
    start_enrich(shared, input, force, |_| Ok(provider))
}
fn start_enrich(
    shared: &SharedStore,
    input: &Value,
    force: bool,
    provider: impl FnOnce(&str) -> Result<Provider> + Send + 'static,
) -> Result<()> {
    let ids = selected(input)?;
    let (albums, contact) = {
        let mut s = shared.lock().unwrap();
        if s.enrich["running"] == true {
            return Ok(());
        }
        let contact = s.contact();
        if contact.is_empty() {
            return Err(
                "在线资料库尚未配置：请填写自己的联系邮箱或项目网址。音乐仍可本地播放。".into(),
            );
        }
        let albums: Vec<_> = array(&s.index["albums"])
            .iter()
            .filter(|a| {
                a["offline"] != true
                    && array(&s.config["roots"]).contains(&a["_root"])
                    && ids
                        .as_ref()
                        .is_none_or(|ids| ids.iter().any(|id| a["id"] == *id))
                    && (force || text(&a["online"]["checkedAt"]).is_empty())
            })
            .cloned()
            .collect();
        s.enrich = json!({"running":true,"completed":0,"total":albums.len()});
        (albums, contact)
    };
    let shared = shared.clone();
    std::thread::spawn(move || {
        let outcome = (|| -> Result<()> {
            let mut provider = provider(&contact)?;
            for album in albums {
                let result = provider.enrich(&album);
                let mut s = shared.lock().unwrap();
                if let Some(current) = s.index["albums"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|a| a["id"] == album["id"] && same_album(a, &album))
                {
                    match &result {
                        Ok(fields) => {
                            for (key, value) in fields.as_object().unwrap() {
                                if key == "producers" {
                                    current[key] = json!(unique_producers(
                                        array(&current[key])
                                            .iter()
                                            .filter(|p| p["source"] != "MusicBrainz")
                                            .chain(
                                                array(value)
                                                    .iter()
                                                    .filter(|p| p["source"] == "MusicBrainz")
                                            )
                                            .cloned()
                                    ));
                                } else {
                                    current[key] = value.clone();
                                }
                            }
                        }
                        Err(error) => {
                            current["online"]["status"] = json!("error");
                            current["online"]["checkedAt"] = json!(now());
                            current["online"]["error"] = json!(error);
                        }
                    }
                }
                if let Err(e) = result {
                    s.enrich["error"] = json!(e);
                }
                let completed = s.enrich["completed"].as_u64().unwrap_or(0) + 1;
                s.enrich["completed"] = json!(completed);
                s.save_index()?;
            }
            Ok(())
        })();
        let mut s = shared.lock().unwrap();
        if let Err(e) = outcome {
            s.enrich["error"] = json!(e);
        }
        s.enrich["running"] = json!(false);
    });
    Ok(())
}
