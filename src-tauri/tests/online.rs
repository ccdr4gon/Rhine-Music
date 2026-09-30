//! Network-free behavior checks against the legacy Node online providers.
use rhine_music::{
    library::{array, text, SharedStore, Store},
    online::{
        assess_candidate, begin_enrich_with_provider, begin_introductions_with_provider,
        name_aliases, normalize_name, Provider,
    },
};
use serde_json::{json, Value};
use std::{
    fs,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use url::Url;

const RELEASE: &str = "11111111-1111-4111-8111-111111111111";
const GROUP: &str = "22222222-2222-4222-8222-222222222222";
fn album() -> Value {
    json!({"id":"album-test","title":"夜航(Night Flight)","artist":"测试歌手","year":2001,
        "tracks":[{"id":"track-1"}],"online":{"status":"unqueried"}})
}
fn page() -> Value {
    json!({"pageid":10,"title":"夜航","language":"zh","pageprops":{},
        "extract":"《夜航》是測試歌手於2001年發行的錄音室專輯。此文字僅為測試資料。"})
}
fn claim(value: Value) -> Value {
    json!({"rank":"normal","mainsnak":{"datavalue":{"value":value}}})
}
fn provider(fetcher: impl Fn(&Url) -> Result<Value, String> + Send + Sync + 'static) -> Provider {
    Provider::with_fetcher(Arc::new(fetcher), Duration::ZERO)
}
fn fixture(count: usize) -> (tempfile::TempDir, SharedStore) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("音乐");
    fs::create_dir(&root).unwrap();
    let mut s = Store::open(temp.path().join("index")).unwrap();
    s.update_config(
        &json!({"roots":[root],"musicBrainzContact":"https://example.invalid/rhine-test"}),
    )
    .unwrap();
    s.index["albums"] = json!((0..count)
        .map(|i| {
            let mut a = album();
            a["id"] = json!(format!("album-{i}"));
            a["_root"] = s.config["roots"][0].clone();
            a
        })
        .collect::<Vec<_>>());
    (temp, Arc::new(Mutex::new(s)))
}
fn wait(shared: &SharedStore, task: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let running = {
            let s = shared.lock().unwrap();
            if task == "introductions" {
                s.introductions["running"] == true
            } else {
                s.enrich["running"] == true
            }
        };
        if !running {
            return;
        }
        assert!(Instant::now() < deadline, "{task} worker did not finish");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn count_provider(calls: Arc<AtomicUsize>) -> Provider {
    provider(move |_| {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"query":{"pages":[page()]}}))
    })
}

#[test]
fn matching_preserves_script_marks_and_requires_title_artist_year_and_album_evidence() {
    assert_eq!(normalize_name("陳奕迅"), normalize_name("陈奕迅"));
    assert_eq!(normalize_name("68’29”"), normalize_name("68'29\""));
    assert_ne!(
        normalize_name("กา"),
        normalize_name("ก่า"),
        "tone marks are not punctuation"
    );
    assert_eq!(
        name_aliases("夜航(Night Flight)"),
        vec!["夜航(Night Flight)", "夜航", "Night Flight"]
    );
    let empty = json!({});
    assert!(assess_candidate(&album(), &page(), &empty, &empty).is_ok());
    let mut bilingual = album();
    bilingual["artist"] = json!("测试歌手 Test Singer");
    assert!(assess_candidate(&bilingual, &page(), &empty, &empty).is_ok());
    let mut wrong_title = page();
    wrong_title["title"] = json!("夜航现场版");
    assert_eq!(
        assess_candidate(&album(), &wrong_title, &empty, &empty),
        Err("title")
    );
    let wrong_year = json!({"claims":{"P577":[claim(json!({"time":"+2000-01-01T00:00:00Z"}))]}});
    assert_eq!(
        assess_candidate(&album(), &page(), &wrong_year, &empty),
        Err("year")
    );
    let wrong_artist = json!({"claims":{"P175":[claim(json!({"id":"Q2"}))]}});
    assert_eq!(
        assess_candidate(
            &album(),
            &page(),
            &wrong_artist,
            &json!({"Q2":{"labels":{"en":{"value":"Different Artist"}}}})
        ),
        Err("artist")
    );
    let mut incidental = page();
    incidental["extract"] = json!("《夜航》是錄音室專輯。\n \n測試歌手於2001年發行其他作品。");
    assert_eq!(
        assess_candidate(&album(), &incidental, &empty, &empty),
        Err("insufficient-evidence")
    );
}

#[test]
fn provider_attributes_formal_extract_reuses_entities_and_sends_no_local_paths_or_year() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let mut p = provider(move |url| {
        recorded.lock().unwrap().push(url.clone());
        assert_eq!(url.scheme(), "https");
        if url.host_str() == Some("zh.wikipedia.org") {
            let mut p = page();
            p["pageprops"]["wikibase_item"] = json!("Q100");
            return Ok(json!({"query":{"pages":[p]}}));
        }
        let ids = url.query_pairs().find(|(k, _)| k == "ids").unwrap().1;
        Ok(match ids.as_ref() {
            "Q100" => {
                json!({"entities":{"Q100":{"labels":{"en":{"value":"Night Flight"}},"claims":{
                "P175":[claim(json!({"id":"Q200"}))],"P577":[claim(json!({"time":"+2001-03-10T00:00:00Z"}))]}}}})
            }
            "Q200" => json!({"entities":{"Q200":{"labels":{"zh":{"value":"測試歌手"}}}}}),
            other => panic!("unexpected entity {other}"),
        })
    });
    let mut a = album();
    a["folder"] = json!("C:/private/do-not-send");
    a["localNote"] = json!("PRIVATE-NOTE");
    for _ in 0..2 {
        let result = p.lookup(&a);
        assert_eq!(result["status"], "matched");
        assert_eq!(result["description"], page()["extract"]);
        assert_eq!(result["descriptionSource"]["name"], "维基百科");
        assert_eq!(
            result["descriptionSource"]["url"],
            "https://zh.wikipedia.org/wiki/%E5%A4%9C%E8%88%AA"
        );
        assert!(!text(&result["descriptionSource"]["license"]).is_empty());
    }
    let requests = requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        4,
        "Wikidata entities are cached within a provider"
    );
    assert!(requests.iter().all(|url| {
        let sent = percent_encoding::percent_decode_str(url.as_str()).decode_utf8_lossy();
        !sent.contains("private") && !sent.contains("PRIVATE-NOTE") && !sent.contains("2001")
    }));
}

#[test]
fn provider_distinguishes_ambiguity_partial_source_failure_and_absence() {
    let mut all_failed = provider(|_| Err("fixture timeout".into()));
    assert_eq!(all_failed.lookup(&album())["status"], "error");
    let mut partial = provider(|url| {
        if url.host_str() == Some("zh.wikipedia.org") {
            Err("fixture unavailable".into())
        } else {
            Ok(json!({"query":{"pages":[]}}))
        }
    });
    let result = partial.lookup(&album());
    assert_eq!(result["status"], "not-found");
    assert!(text(&result["error"]).starts_with("部分来源无法访问"));
    let mut ambiguous = provider(|_| {
        let mut other = page();
        other["pageid"] = json!(11);
        other["title"] = json!("Night Flight (album)");
        Ok(json!({"query":{"pages":[page(),other]}}))
    });
    assert_eq!(ambiguous.lookup(&album())["status"], "uncertain");
    let mut no_extract = provider(|_| {
        let mut p = page();
        p["extract"] = json!("  ");
        Ok(json!({"query":{"pages":[p]}}))
    });
    let result = no_extract.lookup(&album());
    assert_eq!(result["status"], "uncertain");
    assert!(text(&result["error"]).contains("没有可读取的导言"));
    let mut search = provider(|url| {
        let mut p = page();
        p["snippet"] = json!("NEVER SAVE SEARCH SNIPPETS");
        Ok(
            json!({"query":{"pages":if url.query_pairs().any(|(k,_)|k=="generator"){vec![p]}else{vec![]}}}),
        )
    });
    assert_eq!(search.lookup(&album())["description"], page()["extract"]);
}

#[test]
fn batch_coalesces_persists_and_preserves_successful_introduction_on_failure() {
    let (_temp, shared) = fixture(1);
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let gate = Mutex::new(release_rx);
    begin_introductions_with_provider(
        &shared,
        &json!({}),
        provider(move |_| {
            started_tx.send(()).unwrap();
            gate.lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            Ok(json!({"query":{"pages":[page()]}}))
        }),
    )
    .unwrap();
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    begin_introductions_with_provider(
        &shared,
        &json!({"force":true}),
        count_provider(calls.clone()),
    )
    .unwrap();
    release_tx.send(()).unwrap();
    wait(&shared, "introductions");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let dir = {
        let s = shared.lock().unwrap();
        assert_eq!(s.introductions["updated"], 1);
        assert_eq!(s.index["albums"][0]["description"], page()["extract"]);
        s.data_dir.clone()
    };
    let reloaded = Arc::new(Mutex::new(Store::open(dir).unwrap()));
    begin_introductions_with_provider(&reloaded, &json!({}), count_provider(calls.clone()))
        .unwrap();
    wait(&reloaded, "introductions");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "attributed success stays cached across restarts"
    );
    begin_introductions_with_provider(
        &reloaded,
        &json!({"force":true}),
        provider(|_| Err("fixture timeout".into())),
    )
    .unwrap();
    wait(&reloaded, "introductions");
    let s = reloaded.lock().unwrap();
    assert_eq!(s.introductions["failed"], 1);
    assert_eq!(s.introductions["updated"], 0);
    assert_eq!(s.index["albums"][0]["description"], page()["extract"]);
    assert_eq!(s.index["albums"][0]["introduction"]["status"], "error");
}

#[test]
fn batch_retries_errors_expires_negative_cache_after_seven_days_and_filters_roots() {
    let (_temp, shared) = fixture(5);
    {
        let mut s = shared.lock().unwrap();
        let current = chrono::Utc::now();
        for (i, days, status) in [
            (0, 1, "not-found"),
            (1, 8, "uncertain"),
            (2, 1, "error"),
            (3, 8, "not-found"),
        ] {
            s.index["albums"][i]["introduction"] = json!({"status":status,"checkedAt":(current-chrono::Duration::days(days)).to_rfc3339()});
        }
        s.index["albums"][3]["_root"] = json!("removed-root");
    }
    let calls = Arc::new(AtomicUsize::new(0));
    begin_introductions_with_provider(
        &shared,
        &json!({"albumIds":["album-0","album-1","album-2","album-3"]}),
        count_provider(calls.clone()),
    )
    .unwrap();
    wait(&shared, "introductions");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let s = shared.lock().unwrap();
    assert_eq!(s.introductions["total"], 2);
    assert_eq!(s.index["albums"][0]["introduction"]["status"], "not-found");
    assert_eq!(s.index["albums"][1]["introduction"]["status"], "matched");
    assert_eq!(s.index["albums"][2]["introduction"]["status"], "matched");
    assert!(s.index["albums"][4].get("introduction").is_none());
}

#[test]
fn batch_stops_after_three_consecutive_failures_and_keeps_unprocessed_albums_retryable() {
    let (_temp, shared) = fixture(6);
    let calls = Arc::new(AtomicUsize::new(0));
    let recorded = calls.clone();
    begin_introductions_with_provider(
        &shared,
        &json!({}),
        provider(move |_| {
            recorded.fetch_add(1, Ordering::SeqCst);
            Err("fixture timeout".into())
        }),
    )
    .unwrap();
    wait(&shared, "introductions");
    let s = shared.lock().unwrap();
    assert_eq!(
        calls.load(Ordering::SeqCst),
        6,
        "two source attempts per album"
    );
    assert_eq!(s.introductions["completed"], 3);
    assert_eq!(s.introductions["total"], 6);
    assert_eq!(s.introductions["failed"], 3);
    assert!(text(&s.introductions["error"]).contains("剩余 3 张"));
    assert_eq!(
        array(&s.index["albums"])
            .iter()
            .filter(|a| a.get("introduction").is_none())
            .count(),
        3
    );
}

#[test]
fn in_flight_introduction_targets_current_scan_record_and_ignores_changed_album_identity() {
    for changed_identity in [false, true] {
        let (_temp, shared) = fixture(1);
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let gate = Mutex::new(release_rx);
        begin_introductions_with_provider(
            &shared,
            &json!({}),
            provider(move |_| {
                started_tx.send(()).unwrap();
                gate.lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
                Ok(json!({"query":{"pages":[page()]}}))
            }),
        )
        .unwrap();
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        {
            let mut s = shared.lock().unwrap();
            // A scan replaces records and can add tracks while lookup is running.
            let mut replacement = s.index["albums"][0].clone();
            replacement["tracks"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":"track-new"}));
            if changed_identity {
                replacement["title"] = json!("不同专辑");
            }
            s.index["albums"] = json!([replacement]);
            let mut rules = s.rules.clone();
            rules["albumOverrides"]["album-0"] = json!("jazz");
            s.update_rules(rules).unwrap();
        }
        release_tx.send(()).unwrap();
        wait(&shared, "introductions");
        let s = shared.lock().unwrap();
        assert_eq!(s.introductions["completed"], 1);
        assert_eq!(
            s.introductions["updated"],
            if changed_identity { 0 } else { 1 }
        );
        assert_eq!(
            s.index["albums"][0].get("description").is_some(),
            !changed_identity
        );
        let reloaded = Store::open(s.data_dir.clone()).unwrap();
        assert_eq!(
            reloaded.index["albums"][0].get("description").is_some(),
            !changed_identity
        );
        assert_eq!(reloaded.snapshot()["albums"][0]["genreId"], "jazz");
    }
}

fn enrichment_response(url: &Url) -> Result<Value, String> {
    match url.path() {
        "/ws/2/release" => Ok(
            json!({"releases":[{"id":RELEASE,"title":"夜航(Night Flight)","artist-credit":[{"name":"测试歌手"}],"track-count":"1","date":"2001-02-03","score":"100"}]}),
        ),
        p if p == format!("/ws/2/release/{RELEASE}") => Ok(json!({"release-group":{"id":GROUP},
            "genres":[{"name":"rock","count":1},{"name":"jazz","count":3}],
            "relations":[{"type":"producer","artist":{"id":"person-1","name":"制作人"}}],
            "media":[{"tracks":[{"title":"曲目","recording":{"relations":[{"type":"co-producer","artist":{"id":"person-2","name":"单曲制作人"}}]}}]}]})),
        p if p == format!("/ws/2/release-group/{GROUP}") => Ok(json!({
            "genres":[{"name":"jazz","count":5},{"name":"ambient","count":2}],
            "relations":[{"type":"producer","artist":{"id":"different-person-id","name":"制作人"}},
                {"type":"wikidata","url":{"resource":"https://www.wikidata.org/wiki/Q100"}}]})),
        "/wiki/Special:EntityData/Q100.json" => Ok(
            json!({"entities":{"Q100":{"sitelinks":{"zhwiki":{"title":"夜航"},"enwiki":{"title":"Night Flight"}}}}}),
        ),
        "/w/api.php" => {
            assert_eq!(url.host_str(), Some("zh.wikipedia.org"));
            assert_eq!(
                url.query_pairs()
                    .filter(|(k, _)| k == "exchars")
                    .map(|(_, v)| v.to_string())
                    .collect::<Vec<_>>(),
                ["800"]
            );
            Ok(json!({"query":{"pages":[page()]}}))
        }
        other => panic!("unexpected request {other}"),
    }
}

#[test]
fn musicbrainz_retains_genre_order_producer_roles_and_attributed_linked_introduction() {
    let mut a = album();
    a["producers"] = json!([{"name":"本地制作人","role":"producer","source":"local"},{"name":"过期制作人","source":"MusicBrainz"}]);
    let result = provider(enrichment_response).enrich(&a).unwrap();
    assert_eq!(result["online"]["status"], "matched");
    assert_eq!(result["online"]["releaseId"], RELEASE);
    assert_eq!(
        result["online"]["sourceUrl"],
        format!("https://musicbrainz.org/release/{RELEASE}")
    );
    assert_eq!(result["_onlineGenres"], json!(["jazz", "ambient", "rock"]));
    assert_eq!(
        array(&result["producers"]).len(),
        3,
        "same role/name/track/source is deduplicated even with differing URL IDs"
    );
    assert_eq!(result["producers"][2]["trackTitle"], "曲目");
    assert_eq!(result["online"]["descriptionStatus"], "available");
    assert_eq!(result["description"], page()["extract"]);
    assert_eq!(result["descriptionSource"]["name"], "维基百科");
}

#[test]
fn musicbrainz_multiple_pressings_stay_uncertain_and_link_failure_does_not_erase_credits() {
    let mut a = album();
    a["online"]["releaseGroupId"] = json!(GROUP);
    let result = provider(|url| {
        let mut data = enrichment_response(url)?;
        if let Some(releases) = data["releases"].as_array_mut() {
            releases.push(releases[0].clone());
        }
        Ok(data)
    })
    .enrich(&a)
    .unwrap();
    assert_eq!(result["online"]["status"], "uncertain");
    assert_eq!(result["online"]["releaseGroupId"], GROUP);
    assert!(result.get("description").is_none());
    let result = provider(|url| {
        if url.host_str() == Some("www.wikidata.org") {
            Err("linked source timeout".into())
        } else {
            enrichment_response(url)
        }
    })
    .enrich(&a)
    .unwrap();
    assert_eq!(result["online"]["status"], "matched");
    assert_eq!(result["online"]["descriptionStatus"], "error");
    assert!(!array(&result["producers"]).is_empty());
    assert!(result.get("description").is_none());
    a["online"]["releaseId"] = json!(RELEASE.replace('-', ""));
    assert!(provider(|_| panic!("malformed MBID must not be requested"))
        .enrich(&a)
        .is_err());
}

#[test]
fn linked_wikipedia_prefers_chinese_and_preserves_article_typography_but_rejects_disambiguation() {
    for disambiguation in [false, true] {
        let result = provider(move |url| {
            if url.path() == format!("/ws/2/release-group/{GROUP}") {
                return Ok(json!({"relations":[
                    {"type":"wikipedia","url":{"resource":"https://en.wikipedia.org/wiki/Night_Flight"}},
                    {"type":"wikipedia","url":{"resource":"https://zh.wikipedia.org/wiki/%E5%A4%9C%E8%88%AA"}},
                    {"type":"wikipedia","url":{"resource":"https://zh.wikipedia.org.example.invalid/wiki/Untrusted"}}
                ]}));
            }
            if url.path() == "/w/api.php" {
                assert_eq!(url.host_str(), Some("zh.wikipedia.org"));
                let mut p = page();
                p["extract"] = json!("《夜航》‘ＡＢＣ’ ① — 原始排版。");
                if disambiguation { p["pageprops"]["disambiguation"] = json!(""); }
                return Ok(json!({"query":{"pages":[p]}}));
            }
            enrichment_response(url)
        }).enrich(&album()).unwrap();
        assert_eq!(result["online"]["status"], "matched");
        assert_eq!(
            result["online"]["descriptionStatus"],
            if disambiguation {
                "not-found"
            } else {
                "available"
            }
        );
        if disambiguation {
            assert!(result.get("description").is_none());
        } else {
            assert_eq!(result["description"], "《夜航》‘ＡＢＣ’ ① — 原始排版。");
        }
    }
}

#[test]
fn enrichment_batch_coalesces_and_merges_current_local_credits_after_scan() {
    let (_temp, shared) = fixture(1);
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let gate = Mutex::new(release_rx);
    begin_enrich_with_provider(
        &shared,
        &json!({}),
        false,
        provider(move |url| {
            if url.path() == "/ws/2/release" {
                started_tx.send(()).unwrap();
                gate.lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
            }
            enrichment_response(url)
        }),
    )
    .unwrap();
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    begin_enrich_with_provider(
        &shared,
        &json!({}),
        true,
        provider(|_| panic!("coalesced batch must not run")),
    )
    .unwrap();
    {
        let mut s = shared.lock().unwrap();
        s.index["albums"][0]["producers"] =
            json!([{"name":"扫描更新的本地制作人","source":"local","role":"producer"}]);
    }
    release_tx.send(()).unwrap();
    wait(&shared, "enrich");
    let s = shared.lock().unwrap();
    assert_eq!(s.enrich["completed"], 1);
    assert_eq!(
        s.index["albums"][0]["producers"][0]["name"],
        "扫描更新的本地制作人"
    );
    assert_eq!(s.index["albums"][0]["online"]["status"], "matched");
    assert_eq!(s.index["albums"][0]["description"], page()["extract"]);
    let reloaded = Store::open(s.data_dir.clone()).unwrap();
    assert_eq!(reloaded.index["albums"][0], s.index["albums"][0]);
}
