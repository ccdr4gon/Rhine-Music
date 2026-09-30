//! Opt-in Windows media-session fixture. This is not bundled with Rhine Music.
//! All controls target the synthetic sessions created by this executable.
//! Usage: media_fixture --probe
//!        media_fixture --probe-native (only field availability, no song names)
//!        media_fixture --serve --audio <synthetic.mp3> --cover <fixture.png>
//!                      --state <temporary.json> --label <unique-label> [--lifetime 600]
//!        media_fixture --check --audio <synthetic.mp3> --cover <fixture.png>
//!                      --evidence <temporary-directory> [--observe-seconds 30]
//!                      [--distinct-app-ids] [--require-loop]
//!        media_fixture --check-loop --audio <5-second-synthetic.mp3> --cover <fixture.png>
//!                      --evidence <temporary-directory>
//! Stop a provider by creating <temporary.stop>; the default lifetime is 180 seconds.
//! The check creates two independently controlled providers with the same AppID,
//! records command callbacks, and closes both before returning. A replaced Windows
//! session must reject its old identifier and require an explicit new selection.

#[cfg(not(windows))]
fn main() {
    eprintln!("This fixture requires Windows.");
}

#[cfg(windows)]
fn main() {
    if let Err(error) = fixture::run() {
        eprintln!("media fixture: {error}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
mod fixture {
    use serde_json::json;
    use std::{
        fs,
        path::{Path, PathBuf},
        process::{Child, Command, Stdio},
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };
    use windows::{
        core::{HSTRING, PCWSTR},
        Foundation::{TimeSpan, TypedEventHandler, Uri},
        Media::{
            Control::GlobalSystemMediaTransportControlsSessionManager, Core::MediaSource,
            MediaPlaybackStatus, MediaPlaybackType, Playback::MediaPlayer,
            PlaybackPositionChangeRequestedEventArgs, SystemMediaTransportControls,
            SystemMediaTransportControlsButton, SystemMediaTransportControlsButtonPressedEventArgs,
            SystemMediaTransportControlsTimelineProperties,
        },
        Storage::{StorageFile, Streams::RandomAccessStreamReference},
        Win32::{
            System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
            UI::Shell::SetCurrentProcessExplicitAppUserModelID,
        },
    };

    type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { RoUninitialize() };
        }
    }

    #[derive(Default)]
    struct State {
        track: u32,
        playing: bool,
        events: Vec<String>,
        error: Option<String>,
        last_position: Option<f64>,
        last_control: Option<Instant>,
        natural_loops: Vec<serde_json::Value>,
    }

    #[derive(Clone)]
    struct Provider {
        player: MediaPlayer,
        controls: SystemMediaTransportControls,
        state: Arc<Mutex<State>>,
        file: PathBuf,
        label: String,
        source: MediaSource,
        thumbnail: RandomAccessStreamReference,
    }

    impl Provider {
        fn title(&self, state: &State) -> String {
            format!(
                "Rhine fixture {} {}",
                self.label,
                if state.track == 0 { "A" } else { "B" }
            )
        }

        fn display(&self, state: &State) -> windows::core::Result<()> {
            let display = self.controls.DisplayUpdater()?;
            display.SetType(MediaPlaybackType::Music)?;
            display.SetThumbnail(&self.thumbnail)?;
            let music = display.MusicProperties()?;
            music.SetTitle(&HSTRING::from(self.title(state)))?;
            music.SetArtist(&HSTRING::from("Rhine synthetic artist"))?;
            music.SetAlbumTitle(&HSTRING::from("Rhine synthetic album"))?;
            display.Update()?;
            Ok(())
        }

        fn timeline(&self) -> windows::core::Result<(f64, f64)> {
            let session = self.player.PlaybackSession()?;
            let duration = session.NaturalDuration()?;
            let position = session.Position()?;
            let timeline = SystemMediaTransportControlsTimelineProperties::new()?;
            timeline.SetStartTime(TimeSpan { Duration: 0 })?;
            timeline.SetMinSeekTime(TimeSpan { Duration: 0 })?;
            timeline.SetEndTime(duration)?;
            timeline.SetMaxSeekTime(duration)?;
            timeline.SetPosition(position)?;
            self.controls.UpdateTimelineProperties(&timeline)?;
            Ok((
                position.Duration as f64 / 10_000_000.0,
                duration.Duration as f64 / 10_000_000.0,
            ))
        }

        fn record(&self, state: &mut State) {
            let (position, duration) = self.timeline().unwrap_or_default();
            if state.playing
                && duration > 1.0
                && state
                    .last_control
                    .is_none_or(|at| at.elapsed() > Duration::from_millis(750))
                && state
                    .last_position
                    .is_some_and(|previous| previous >= duration - 0.4 && position <= 0.4)
            {
                state.natural_loops.push(json!({"positionBefore":state.last_position,
                    "positionAfter":position,"duration":duration,
                    "millisecondsSinceLastControl":state.last_control.map(|at| at.elapsed().as_millis())}));
            }
            state.last_position = Some(position);
            let value = json!({"pid":std::process::id(),"label":self.label,
                "title":self.title(state),"track":state.track,"playing":state.playing,
                "position":position,"duration":duration,"events":state.events,"error":state.error,
                "naturalLoopCount":state.natural_loops.len(),"naturalLoops":state.natural_loops});
            if let Err(error) = fs::write(&self.file, serde_json::to_vec_pretty(&value).unwrap()) {
                eprintln!("fixture evidence write failed: {error}");
            }
        }

        fn button(&self, button: SystemMediaTransportControlsButton) -> windows::core::Result<()> {
            let mut state = self.state.lock().unwrap();
            let event = match button {
                SystemMediaTransportControlsButton::Play => {
                    self.player.Play()?;
                    state.playing = true;
                    "play"
                }
                SystemMediaTransportControlsButton::Pause => {
                    self.player.Pause()?;
                    state.playing = false;
                    "pause"
                }
                SystemMediaTransportControlsButton::Stop => {
                    self.player.Pause()?;
                    self.player
                        .PlaybackSession()?
                        .SetPosition(TimeSpan { Duration: 0 })?;
                    state.playing = false;
                    "stop"
                }
                SystemMediaTransportControlsButton::Next
                | SystemMediaTransportControlsButton::Previous => {
                    state.track = 1 - state.track;
                    self.player.SetSource(&self.source)?;
                    if state.playing {
                        self.player.Play()?;
                    }
                    self.display(&state)?;
                    if button == SystemMediaTransportControlsButton::Next {
                        "next"
                    } else {
                        "previous"
                    }
                }
                _ => return Ok(()),
            };
            self.controls.SetPlaybackStatus(
                if button == SystemMediaTransportControlsButton::Stop {
                    MediaPlaybackStatus::Stopped
                } else if state.playing {
                    MediaPlaybackStatus::Playing
                } else {
                    MediaPlaybackStatus::Paused
                },
            )?;
            state.events.push(event.into());
            state.last_control = Some(Instant::now());
            self.record(&mut state);
            Ok(())
        }

        fn seek(&self, position: TimeSpan) -> windows::core::Result<()> {
            let mut state = self.state.lock().unwrap();
            self.player.PlaybackSession()?.SetPosition(position)?;
            state.events.push("seek".into());
            state.last_control = Some(Instant::now());
            self.record(&mut state);
            Ok(())
        }
    }

    fn probe() -> Result<()> {
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.join()?;
        let sessions = manager.GetSessions()?;
        let mut output = Vec::new();
        for session in sessions {
            // Deliberately never request media properties: no private song name,
            // artist, cover or timeline is read by this diagnostic mode.
            let info = session.GetPlaybackInfo()?;
            let caps = info.Controls()?;
            output.push(json!({"appId":session.SourceAppUserModelId()?.to_string(),
                "capabilities":{"play":caps.IsPlayEnabled()?,"pause":caps.IsPauseEnabled()?,
                "toggle":caps.IsPlayPauseToggleEnabled()?,"next":caps.IsNextEnabled()?,
                "previous":caps.IsPreviousEnabled()?,"stop":caps.IsStopEnabled()?,
                "seek":caps.IsPlaybackPositionEnabled()?}}));
        }
        println!(
            "{}",
            serde_json::to_string_pretty(
                &json!({"mode":"read-only-source-probe","sources":output})
            )?
        );
        Ok(())
    }

    fn probe_native() -> Result<()> {
        let snapshot = rhine_music::media::snapshot().map_err(|e| format!("native probe: {e}"))?;
        let sources: Vec<_> = snapshot.sources.into_iter().map(|source| json!({
            "kind":source.kind,"name":source.name,"titlePresent":!source.title.is_empty(),
            "artistPresent":!source.artist.is_empty(),"albumPresent":!source.album.is_empty(),
            "coverAvailable":source.cover_url.is_some(),"positionAvailable":source.position.is_some(),
            "durationAvailable":source.duration.is_some(),"playback":source.playback,
            "capabilities":source.capabilities,"warning":source.warning
        })).collect();
        println!(
            "{}",
            serde_json::to_string_pretty(
                &json!({"mode":"read-only-native-redacted-probe","sources":sources,"warningPresent":snapshot.warning.is_some()})
            )?
        );
        Ok(())
    }

    fn argument(args: &[String], key: &str) -> Result<String> {
        args.windows(2)
            .find(|pair| pair[0] == key)
            .map(|pair| pair[1].clone())
            .ok_or_else(|| format!("missing {key}").into())
    }

    fn file_uri(path: &Path) -> Result<Uri> {
        let url = url::Url::from_file_path(dunce::canonicalize(path)?)
            .map_err(|_| "invalid fixture path")?;
        Ok(Uri::CreateUri(&HSTRING::from(url.as_str()))?)
    }

    fn serve(args: &[String]) -> Result<()> {
        let audio = PathBuf::from(argument(args, "--audio")?);
        let cover = PathBuf::from(argument(args, "--cover")?);
        let file = PathBuf::from(argument(args, "--state")?);
        let label = argument(args, "--label")?;
        if !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') || label.len() > 70 {
            return Err("label must be a short ASCII fixture identifier".into());
        }
        let app_id = argument(args, "--app-id")
            .unwrap_or_else(|_| format!("RhineMusic.TestFixture.{label}"));
        if !app_id.starts_with("RhineMusic.TestFixture.")
            || !app_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        {
            return Err("app-id must be an isolated RhineMusic.TestFixture identifier".into());
        }
        let lifetime = argument(args, "--lifetime")
            .unwrap_or_else(|_| "180".into())
            .parse::<u64>()?;
        if !(10..=3600).contains(&lifetime) {
            return Err("lifetime must be 10..3600 seconds".into());
        }
        let wide: Vec<_> = app_id.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            SetCurrentProcessExplicitAppUserModelID(PCWSTR(wide.as_ptr()))?;
        }
        let player = MediaPlayer::new()?;
        player.SetIsMuted(true)?;
        player.SetIsLoopingEnabled(true)?;
        player.SetAutoPlay(false)?;
        player.CommandManager()?.SetIsEnabled(false)?;
        let controls = player.SystemMediaTransportControls()?;
        controls.SetIsEnabled(true)?;
        controls.SetIsPlayEnabled(true)?;
        controls.SetIsPauseEnabled(true)?;
        controls.SetIsStopEnabled(true)?;
        controls.SetIsNextEnabled(true)?;
        controls.SetIsPreviousEnabled(true)?;
        let cover = StorageFile::GetFileFromPathAsync(&HSTRING::from(
            dunce::canonicalize(cover)?.to_string_lossy().as_ref(),
        ))?
        .join()?;
        let provider = Provider {
            player,
            controls,
            file,
            label,
            source: MediaSource::CreateFromUri(&file_uri(&audio)?)?,
            thumbnail: RandomAccessStreamReference::CreateFromFile(&cover)?,
            state: Arc::new(Mutex::new(State {
                playing: true,
                ..Default::default()
            })),
        };
        let button_provider = provider.clone();
        let button_token = provider.controls.ButtonPressed(&TypedEventHandler::<
            SystemMediaTransportControls,
            SystemMediaTransportControlsButtonPressedEventArgs,
        >::new(move |_, args| {
            if let Some(args) = args.as_ref() {
                if let Err(error) = button_provider.button(args.Button()?) {
                    let mut state = button_provider.state.lock().unwrap();
                    state.error = Some(error.to_string());
                    button_provider.record(&mut state);
                    return Err(error);
                }
            }
            Ok(())
        }))?;
        let seek_provider = provider.clone();
        let seek_token =
            provider
                .controls
                .PlaybackPositionChangeRequested(&TypedEventHandler::<
                    SystemMediaTransportControls,
                    PlaybackPositionChangeRequestedEventArgs,
                >::new(move |_, args| {
                    if let Some(args) = args.as_ref() {
                        seek_provider.seek(args.RequestedPlaybackPosition()?)?;
                    }
                    Ok(())
                }))?;
        provider.player.SetSource(&provider.source)?;
        provider.player.Play()?;
        provider
            .controls
            .SetPlaybackStatus(MediaPlaybackStatus::Playing)?;
        provider.display(&provider.state.lock().unwrap())?;
        println!(
            "{}",
            json!({"fixtureReady":true,"pid":std::process::id(),"appId":app_id,"label":provider.label})
        );
        let deadline = Instant::now() + Duration::from_secs(lifetime);
        while Instant::now() < deadline && !provider.file.with_extension("stop").exists() {
            provider.record(&mut provider.state.lock().unwrap());
            std::thread::sleep(Duration::from_millis(200));
        }
        provider.controls.RemoveButtonPressed(button_token)?;
        provider
            .controls
            .RemovePlaybackPositionChangeRequested(seek_token)?;
        provider.controls.SetIsEnabled(false)?;
        provider.player.Close()?;
        Ok(())
    }

    struct ChildProvider {
        child: Child,
        state: PathBuf,
    }

    impl ChildProvider {
        fn stop(&mut self) -> Result<()> {
            fs::write(
                self.state.with_extension("stop"),
                b"stop owned test provider",
            )?;
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if self.child.try_wait()?.is_some() {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            self.child.kill()?;
            self.child.wait()?;
            Ok(())
        }
    }
    impl Drop for ChildProvider {
        fn drop(&mut self) {
            let _ = self.stop();
        }
    }

    fn state_file(path: &Path) -> Option<serde_json::Value> {
        serde_json::from_slice(&fs::read(path).ok()?).ok()
    }

    fn until<T>(label: &str, mut task: impl FnMut() -> Option<T>) -> Result<T> {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if let Some(value) = task() {
                return Ok(value);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(
            format!("timed out waiting for {label}; inspect the owned fixture state/log files")
                .into(),
        )
    }

    fn start_provider(
        directory: &Path,
        audio: &str,
        cover: &str,
        label: &str,
        app_id: &str,
    ) -> Result<ChildProvider> {
        use std::os::windows::process::CommandExt;
        let state = directory.join(format!("{label}.json"));
        let stdout = fs::File::create(directory.join(format!("{label}.stdout.log")))?;
        let stderr = fs::File::create(directory.join(format!("{label}.stderr.log")))?;
        let child = Command::new(std::env::current_exe()?)
            .args([
                "--serve", "--audio", audio, "--cover", cover, "--label", label, "--app-id",
                app_id, "--state",
            ])
            .arg(&state)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .creation_flags(0x08000000)
            .spawn()?;
        Ok(ChildProvider { child, state })
    }

    fn own_source(label: &str) -> Option<rhine_music::media::Source> {
        rhine_music::media::snapshot()
            .ok()?
            .sources
            .into_iter()
            .find(|source| source.title.starts_with(&format!("Rhine fixture {label} ")))
    }

    fn observe(
        directory: &Path,
        seconds: u64,
        primary_id: &str,
        guard_id: &str,
        primary_label: &str,
        guard_label: &str,
        seek_position: f64,
    ) -> Result<serde_json::Value> {
        use rhine_music::media::{self, Action};
        let start = Instant::now();
        let mut samples = Vec::new();
        let mut commands = Vec::new();
        let mut id_changed = false;
        let mut absent_samples = 0usize;
        let mut warning_samples = 0usize;
        let mut command_failures = 0usize;
        let primary_prefix = format!("Rhine fixture {primary_label} ");
        let guard_prefix = format!("Rhine fixture {guard_label} ");
        for second in 0..=seconds {
            if let Some(wait) = Duration::from_secs(second).checked_sub(start.elapsed()) {
                std::thread::sleep(wait);
            }
            let command = match second {
                6 => Some((Action::Next, None)),
                12 => Some((Action::Toggle, None)),
                18 => Some((Action::Seek, Some(seek_position))),
                24 => Some((Action::Toggle, None)),
                _ => None,
            };
            if let Some((action, position)) = command {
                let result = media::control(primary_id, action.clone(), position, false);
                command_failures += usize::from(result.is_err());
                commands.push(json!({"second":second,"action":action,"position":position,"accepted":result.is_ok(),"error":result.err()}));
            }
            let sample = match media::snapshot() {
                Ok(snapshot) => {
                    let primary = snapshot.sources.iter().find(|source| {
                        source.id == primary_id || source.title.starts_with(&primary_prefix)
                    });
                    let guard = snapshot.sources.iter().find(|source| {
                        source.id == guard_id || source.title.starts_with(&guard_prefix)
                    });
                    id_changed |= primary.is_some_and(|source| source.id != primary_id)
                        || guard.is_some_and(|source| source.id != guard_id);
                    absent_samples += usize::from(primary.is_none() || guard.is_none());
                    warning_samples += usize::from(
                        snapshot.warning.is_some()
                            || primary.is_some_and(|source| source.warning.is_some())
                            || guard.is_some_and(|source| source.warning.is_some()),
                    );
                    // Only identities and state of owned fixtures are recorded.
                    // Never include other applications' metadata in evidence.
                    let safe = |source: Option<&media::Source>| {
                        source.map(|source| json!({
                        "id":source.id,"playback":source.playback,"position":source.position,
                        "capabilities":source.capabilities,"warning":source.warning
                    }))
                    };
                    json!({"second":second,"elapsedMs":start.elapsed().as_millis(),"primary":safe(primary),"guard":safe(guard),"warning":snapshot.warning})
                }
                Err(error) => {
                    warning_samples += 1;
                    absent_samples += 1;
                    json!({"second":second,"elapsedMs":start.elapsed().as_millis(),"error":error})
                }
            };
            samples.push(sample);
            fs::write(
                directory.join("observation.json"),
                serde_json::to_vec_pretty(&json!({
                    "requestedSeconds":seconds,"primaryOriginalId":primary_id,"guardOriginalId":guard_id,
                    "sourceIdChanged":id_changed,"absentSamples":absent_samples,"warningSamples":warning_samples,
                    "commandFailures":command_failures,"commands":commands,"samples":samples
                }))?,
            )?;
        }
        Ok(
            json!({"seconds":seconds,"sampleCount":samples.len(),"sourceIdChanged":id_changed,
            "absentSamples":absent_samples,"warningSamples":warning_samples,"commandFailures":command_failures}),
        )
    }

    fn check(args: &[String]) -> Result<()> {
        use rhine_music::media::{self, Action};
        let directory = PathBuf::from(argument(args, "--evidence")?);
        fs::create_dir_all(&directory)?;
        let audio = argument(args, "--audio")?;
        let cover = argument(args, "--cover")?;
        let require_loop = args
            .iter()
            .any(|arg| matches!(arg.as_str(), "--require-loop" | "--check-loop"));
        let distinct_app_ids = require_loop || args.iter().any(|arg| arg == "--distinct-app-ids");
        let observe_seconds = argument(args, "--observe-seconds")
            .unwrap_or_else(|_| if require_loop { "30" } else { "0" }.into())
            .parse::<u64>()?;
        if observe_seconds > 120 {
            return Err("observation is limited to 120 seconds".into());
        }
        if require_loop && observe_seconds < 25 {
            return Err(
                "loop checks require at least 25 seconds for all scheduled commands".into(),
            );
        }
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let primary_label = format!("primary-{}", &suffix[..8]);
        let guard_label = format!("guard-{}", &suffix[..8]);
        let shared_app_id = format!("RhineMusic.TestFixture.shared-{}", &suffix[..8]);
        let primary_app_id = if distinct_app_ids {
            format!("RhineMusic.TestFixture.{primary_label}")
        } else {
            shared_app_id.clone()
        };
        let guard_app_id = if distinct_app_ids {
            format!("RhineMusic.TestFixture.{guard_label}")
        } else {
            shared_app_id
        };
        let mut primary =
            start_provider(&directory, &audio, &cover, &primary_label, &primary_app_id)?;
        let mut guard = start_provider(&directory, &audio, &cover, &guard_label, &guard_app_id)?;
        let source = until("primary fixture session with metadata", || {
            let snapshot = media::snapshot().ok()?;
            let fixture_sources: Vec<_> = snapshot.sources.iter()
                .filter(|source| source.title.starts_with(&format!("Rhine fixture {primary_label} ")) || source.title.starts_with(&format!("Rhine fixture {guard_label} ")))
                .map(|source| json!({"id":source.id,"duration":source.duration,"coverPresent":source.cover_url.is_some(),"warning":source.warning})).collect();
            let _ = fs::write(
                directory.join("readiness.json"),
                serde_json::to_vec_pretty(
                    &json!({"ownSources":fixture_sources,"warning":snapshot.warning}),
                )
                .unwrap(),
            );
            snapshot
                .sources
                .into_iter()
                .find(|source| {
                    source
                        .title
                        .starts_with(&format!("Rhine fixture {primary_label} "))
                })
                .filter(|source| {
                    source.duration.is_some_and(|duration| {
                        duration > if observe_seconds > 0 { 1.0 } else { 20.0 }
                    }) && (observe_seconds > 0 || source.cover_url.is_some())
                })
        })?;
        let guard_source = until("second independent guard session", || {
            own_source(&guard_label)
        })?;
        if observe_seconds > 0 {
            // Select both identities from the same successful enumeration, then
            // preserve them for the entire observation. Record churn/rejections
            // rather than aborting before the requested diagnostic interval.
            let (source, guard_source) = until("both fixture sources in one snapshot", || {
                let snapshot = media::snapshot().ok()?;
                let primary = snapshot.sources.iter().find(|source| {
                    source
                        .title
                        .starts_with(&format!("Rhine fixture {primary_label} "))
                })?;
                let guard = snapshot.sources.iter().find(|source| {
                    source
                        .title
                        .starts_with(&format!("Rhine fixture {guard_label} "))
                })?;
                Some((primary.clone(), guard.clone()))
            })?;
            let observation = observe(
                &directory,
                observe_seconds,
                &source.id,
                &guard_source.id,
                &primary_label,
                &guard_label,
                (source.duration.ok_or("fixture duration missing")? / 2.0).min(12.0),
            )?;
            let primary_state = state_file(&primary.state).ok_or("primary evidence missing")?;
            let guard_state = state_file(&guard.state).ok_or("guard evidence missing")?;
            primary.stop()?;
            guard.stop()?;
            let loop_verified = primary_state["naturalLoopCount"]
                .as_u64()
                .unwrap_or_default()
                > 0
                && guard_state["naturalLoopCount"].as_u64().unwrap_or_default() > 0;
            let passed = observation["sourceIdChanged"] == false
                && observation["commandFailures"] == 0
                && observation["absentSamples"] == 0
                && guard_state["events"] == json!([])
                && (!require_loop
                    || (loop_verified
                        && primary_state["events"] == json!(["next", "pause", "seek", "play"])));
            let evidence = json!({"passed":passed,"observation":observation,"primaryState":primary_state,"guardState":guard_state,
                "distinctAppIds":distinct_app_ids,"loopRequired":require_loop,"naturalLoopVerified":loop_verified,
                "primaryAppId":primary_app_id,"guardAppId":guard_app_id});
            fs::write(
                directory.join("result.json"),
                serde_json::to_vec_pretty(&evidence)?,
            )?;
            println!("{}", serde_json::to_string_pretty(&evidence)?);
            return if passed {
                Ok(())
            } else {
                Err("observation failed identity, control, presence or natural-loop checks; see result.json and observation.json".into())
            };
        }
        if source.id == guard_source.id {
            return Err("independent providers received the same source identifier".into());
        }
        for _ in 0..5 {
            if own_source(&primary_label).map(|s| s.id) != Some(source.id.clone())
                || own_source(&guard_label).map(|s| s.id) != Some(guard_source.id.clone())
            {
                return Err("fixture source identifiers changed across snapshot refreshes".into());
            }
        }
        if source.artist != "Rhine synthetic artist" || source.album != "Rhine synthetic album" {
            return Err("synthetic artist/album was not preserved".into());
        }
        if !source
            .cover_url
            .as_ref()
            .is_some_and(|url| url.starts_with("data:image/"))
        {
            return Err("fixture cover did not arrive as an image".into());
        }
        if !(source.capabilities.toggle
            && source.capabilities.next
            && source.capabilities.previous
            && source.capabilities.stop
            && source.capabilities.seek)
        {
            return Err("fixture did not advertise all registered controls".into());
        }
        let mut checks = vec![
            "two distinct system sessions",
            "stable identifiers across repeated snapshots",
            "metadata and image",
            "capabilities and duration",
        ];
        media::control(&source.id, Action::Toggle, None, false)
            .map_err(|e| format!("pause: {e}"))?;
        until("pause response", || {
            own_source(&primary_label).filter(|s| s.playback == "paused")
        })?;
        until("pause callback on selected provider", || {
            state_file(&primary.state).filter(|s| {
                s["events"]
                    .as_array()
                    .is_some_and(|events| events.contains(&json!("pause")))
            })
        })?;
        checks.push("pause");
        media::control(&source.id, Action::Toggle, None, false)
            .map_err(|e| format!("play: {e}"))?;
        until("play response", || {
            own_source(&primary_label).filter(|s| s.playback == "playing")
        })?;
        checks.push("play");
        media::control(&source.id, Action::Next, None, false).map_err(|e| format!("next: {e}"))?;
        until("next metadata", || {
            own_source(&primary_label).filter(|s| s.title.ends_with(" B"))
        })?;
        checks.push("next");
        media::control(&source.id, Action::Seek, Some(12.0), false)
            .map_err(|e| format!("seek: {e}"))?;
        until("seek callback and position", || {
            let state = state_file(&primary.state)?;
            let source = own_source(&primary_label)?;
            (state["events"].as_array()?.contains(&json!("seek"))
                && source
                    .position
                    .is_some_and(|position| (12.0..16.0).contains(&position)))
            .then_some(())
        })?;
        checks.push("seek");
        media::control(&source.id, Action::Previous, None, false)
            .map_err(|e| format!("previous: {e}"))?;
        until("previous metadata", || {
            own_source(&primary_label).filter(|s| s.title.ends_with(" A"))
        })?;
        checks.push("previous");
        media::control(&source.id, Action::Stop, None, false).map_err(|e| format!("stop: {e}"))?;
        until("stop callback", || {
            state_file(&primary.state).filter(|s| {
                s["playing"] == false
                    && s["events"]
                        .as_array()
                        .is_some_and(|events| events.contains(&json!("stop")))
            })
        })?;
        checks.push("stop");
        let primary_state = state_file(&primary.state).ok_or("fixture state missing")?;
        primary.stop()?;
        until("disconnected primary disappearance", || {
            own_source(&primary_label).is_none().then_some(())
        })?;
        if media::control(&source.id, Action::Next, None, false).is_ok() {
            return Err("disconnected source unexpectedly accepted a command".into());
        }
        let guard_after = own_source(&guard_label).ok_or("guard source disappeared")?;
        let guard_state = state_file(&guard.state).ok_or("guard fixture state missing")?;
        if guard_state["events"] != json!([]) {
            return Err("controls escaped the selected fixture source".into());
        }
        let guard_requires_reselection = guard_after.id != guard_source.id;
        if guard_requires_reselection {
            // Windows can replace even a surviving COM session after the list
            // topology changes. Never rebind by AppID/title: an obsolete guard
            // ID must fail, and the freshly observed session must be selectable.
            if media::control(&guard_source.id, Action::Next, None, false).is_ok() {
                return Err("obsolete guard identifier unexpectedly accepted control".into());
            }
            let reselected = own_source(&guard_label).ok_or("guard cannot be reselected")?;
            if reselected.id != guard_after.id || !reselected.capabilities.toggle {
                return Err("fresh guard source is not stable and selectable".into());
            }
            checks.push("replaced OS session requires explicit reselection; obsolete ID rejected");
        }
        checks.extend(["disconnected source rejected", "guard received no commands"]);
        guard.stop()?;
        let evidence = json!({"passed":true,"checks":checks,"primaryId":source.id,"guardId":guard_source.id,
            "coverDataUrlLength":source.cover_url.as_ref().map(String::len),"duration":source.duration,
            "primaryState":primary_state,"guardState":guard_state,
            "guardIdAfterDisconnect":guard_after.id,"guardRequiresReselection":guard_requires_reselection});
        fs::write(
            directory.join("result.json"),
            serde_json::to_vec_pretty(&evidence)?,
        )?;
        println!("{}", serde_json::to_string_pretty(&evidence)?);
        Ok(())
    }

    pub fn run() -> Result<()> {
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED)?;
        }
        let _apartment = Apartment;
        let args: Vec<_> = std::env::args().skip(1).collect();
        if args == ["--probe"] {
            probe()
        } else if args == ["--probe-native"] {
            probe_native()
        } else if args
            .first()
            .is_some_and(|arg| matches!(arg.as_str(), "--check" | "--check-loop"))
        {
            check(&args)
        } else if args.first().is_some_and(|arg| arg == "--serve") {
            serve(&args)
        } else {
            Err(
                "expected --probe or --serve --audio ... --cover ... --state ... --label ..."
                    .into(),
            )
        }
    }
}
