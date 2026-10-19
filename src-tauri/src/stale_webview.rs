//! The WebView2 processes the last Rhine Music left behind. After its window closes, WebView2 takes
//! about half a minute to shut its browser, GPU, renderer and utility processes down; a window opened
//! meanwhile on the same data folder stayed blank until they were gone (35-44 s measured on
//! 2026-10-10, against 1.7-1.9 s without them). At start-up, before it creates its own webview, Rhine
//! ends the `msedgewebview2.exe` processes of this Windows session that still run on its WebView2
//! data folder (their `--user-data-dir`); no other program's WebView2 runs on that folder.
//!
//! Only once it holds the folder's claim: a named mutex for the folder, in this session, that each
//! Rhine takes before it creates its webview and keeps until it exits. Another Rhine on the folder
//! that still runs holds it, so its WebView2 is never ended. That is normally a second start the
//! single-instance plugin has already passed on to the first, but the plugin lets a start through
//! when two race, or beside an elevated one. A Rhine that is exiting releases the claim as it exits
//! (release_claim), and one that ended without doing so leaves it abandoned, which counts as free; a
//! start waits for it at most CLAIM_WAIT_MS, then leaves the processes alone.
use std::path::Path;

/// The folder WebView2 keeps its profile in, under the data directory Rhine gives it.
const PROFILE: &str = "EBWebView";

fn normalize(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

/// Whether a WebView2 command line runs on the profile folder `folder` (already normalized): its
/// `--user-data-dir` value, quoted or not, compared without case and with either kind of slash. The
/// crash reporter quotes the whole argument (`"--user-data-dir=C:\a b\EBWebView"`).
pub fn runs_on(line: &str, folder: &str) -> bool {
    const FLAG: &str = "--user-data-dir=";
    let mut rest = line;
    while let Some(at) = rest.find(FLAG) {
        let value = &rest[at + FLAG.len()..];
        let whole = rest[..at].ends_with('"');
        let path = match value.strip_prefix('"') {
            Some(quoted) => quoted.split('"').next().unwrap_or(""),
            None if whole => value.split('"').next().unwrap_or(""),
            None => value.split(' ').next().unwrap_or(""),
        };
        if normalize(path) == folder {
            return true;
        }
        rest = &rest[at + FLAG.len()..];
    }
    false
}

/// The profile folder WebView2 makes in `user_data`, normalized for runs_on.
pub fn profile_folder(user_data: &Path) -> String {
    normalize(&user_data.join(PROFILE).to_string_lossy())
}

/// The name of the claim on a profile folder (normalized): one per folder, in this Windows session.
/// The folder is hashed (64-bit FNV-1a of its UTF-8), so the name is short and the same in every
/// build of Rhine.
pub fn claim_name(folder: &str) -> String {
    let hash = folder.bytes().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ byte as u64).wrapping_mul(0x0000_0100_0000_01b3)
    });
    format!("Local\\io.github.ccdr4gon.rhine-music.webview-{hash:016x}")
}

/// How long a start waits for the claim of a Rhine that is still exiting.
#[cfg(windows)]
const CLAIM_WAIT_MS: u32 = 3000;

/// This process's claim on its WebView2 folder, from end_leftovers until release_claim.
#[cfg(windows)]
static CLAIM: std::sync::Mutex<Option<imp::Claim>> = std::sync::Mutex::new(None);

/// Takes the claim on the WebView2 folder in `user_data`, then ends the WebView2 processes left on it
/// (see the module) and waits a little for them to be gone. Returns how many were ended; none without
/// the claim. Called on the thread that later calls release_claim (the main thread).
#[cfg(windows)]
pub fn end_leftovers(user_data: &Path) -> usize {
    let folder = profile_folder(user_data);
    let Some(claim) = imp::claim(&folder, CLAIM_WAIT_MS) else {
        return 0;
    };
    let ended = imp::end_leftovers(&folder);
    if let Ok(mut held) = CLAIM.lock() {
        if let Some(earlier) = held.replace(claim) {
            earlier.release();
        }
    }
    ended
}
#[cfg(not(windows))]
pub fn end_leftovers(_user_data: &Path) -> usize {
    0
}

/// Ends what is left on `user_data` again (see end_leftovers), only while this process holds its claim:
/// for a webview that could not be created yet.
#[cfg(windows)]
pub fn end_more(user_data: &Path) -> usize {
    if !CLAIM.lock().map(|held| held.is_some()).unwrap_or(false) {
        return 0;
    }
    imp::end_leftovers(&profile_folder(user_data))
}
#[cfg(not(windows))]
pub fn end_more(_user_data: &Path) -> usize {
    0
}

/// Gives the claim back as Rhine exits, so that a start right after need not wait for this process.
#[cfg(windows)]
pub fn release_claim() {
    if let Some(claim) = CLAIM.lock().ok().and_then(|mut held| held.take()) {
        claim.release();
    }
}
#[cfg(not(windows))]
pub fn release_claim() {}

#[cfg(windows)]
mod imp {
    use super::runs_on;
    use windows::{
        Wdk::System::Threading::{NtQueryInformationProcess, PROCESSINFOCLASS},
        Win32::{
            Foundation::{CloseHandle, HANDLE, UNICODE_STRING, WAIT_ABANDONED, WAIT_OBJECT_0},
            System::{
                Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                    TH32CS_SNAPPROCESS,
                },
                RemoteDesktop::ProcessIdToSessionId,
                Threading::{
                    CreateMutexW, GetCurrentProcessId, OpenProcess, ReleaseMutex, TerminateProcess,
                    WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
                    PROCESS_TERMINATE,
                },
            },
        },
        core::PCWSTR,
    };

    /// A claim on a folder (claim_name), owned by the thread that took it.
    pub struct Claim(HANDLE);
    // Only a handle; ReleaseMutex itself checks the owning thread.
    unsafe impl Send for Claim {}
    impl Claim {
        /// Released on the thread that took it; from another thread only the handle is closed, and
        /// the claim is freed when that thread ends.
        pub fn release(self) {
            unsafe {
                let _ = ReleaseMutex(self.0);
                let _ = CloseHandle(self.0);
            }
        }
    }

    /// Takes the claim on `folder`, waiting at most `wait_ms` for a Rhine that holds it. None while
    /// another process holds it, or when it cannot be opened (an elevated Rhine's).
    pub fn claim(folder: &str, wait_ms: u32) -> Option<Claim> {
        let name: Vec<u16> = super::claim_name(folder).encode_utf16().chain(Some(0)).collect();
        unsafe {
            let mutex = CreateMutexW(None, false, PCWSTR(name.as_ptr())).ok()?;
            let waited = WaitForSingleObject(mutex, wait_ms);
            if waited == WAIT_OBJECT_0 || waited == WAIT_ABANDONED {
                Some(Claim(mutex))
            } else {
                let _ = CloseHandle(mutex);
                None
            }
        }
    }

    /// ProcessCommandLineInformation (Windows 8.1 and later).
    const COMMAND_LINE: PROCESSINFOCLASS = PROCESSINFOCLASS(60);
    /// How long all of them together may take to end.
    const WAIT_MS: u32 = 3000;

    fn session(pid: u32) -> Option<u32> {
        let mut session = 0;
        unsafe { ProcessIdToSessionId(pid, &mut session) }
            .ok()
            .map(|_| session)
    }

    /// The `msedgewebview2.exe` processes of this session.
    fn webview_processes() -> Vec<u32> {
        let mut pids = Vec::new();
        let own = session(unsafe { GetCurrentProcessId() });
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return pids;
            };
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    let name = &entry.szExeFile;
                    let length = name.iter().position(|c| *c == 0).unwrap_or(name.len());
                    if String::from_utf16_lossy(&name[..length])
                        .eq_ignore_ascii_case("msedgewebview2.exe")
                        && own.is_some()
                        && session(entry.th32ProcessID) == own
                    {
                        pids.push(entry.th32ProcessID);
                    }
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }
        pids
    }

    /// A process's command line, as Windows keeps it for the process.
    fn command_line(process: HANDLE) -> Option<String> {
        unsafe {
            let mut needed = 0u32;
            let _ = NtQueryInformationProcess(process, COMMAND_LINE, std::ptr::null_mut(), 0, &mut needed);
            if needed as usize <= std::mem::size_of::<UNICODE_STRING>() || needed > 1 << 20 {
                return None;
            }
            // A UNICODE_STRING followed by its characters: u64 words keep it aligned.
            let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
            NtQueryInformationProcess(
                process,
                COMMAND_LINE,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
            .ok()
            .ok()?;
            let text = &*(buffer.as_ptr() as *const UNICODE_STRING);
            if text.Buffer.is_null() || text.Length == 0 {
                return None;
            }
            let characters = std::slice::from_raw_parts(text.Buffer.0, text.Length as usize / 2);
            Some(String::from_utf16_lossy(characters))
        }
    }

    pub fn end_leftovers(folder: &str) -> usize {
        let mut ended = Vec::new();
        for pid in webview_processes() {
            unsafe {
                let Ok(process) = OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                    false,
                    pid,
                ) else {
                    continue;
                };
                let ours = command_line(process).is_some_and(|line| runs_on(&line, folder));
                if ours && TerminateProcess(process, 1).is_ok() {
                    ended.push(process);
                } else {
                    let _ = CloseHandle(process);
                }
            }
        }
        let count = ended.len();
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(WAIT_MS as u64);
        for process in ended {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            unsafe {
                let _ = WaitForSingleObject(process, left.as_millis() as u32);
                let _ = CloseHandle(process);
            }
        }
        count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_this_profile_folder_only() {
        let folder = profile_folder(Path::new(r"D:\Apps\Rhine Music\data\webview"));
        assert_eq!(folder, r"d:\apps\rhine music\data\webview\ebwebview");
        let quoted = r#""C:\Program Files (x86)\Microsoft\EdgeWebView\Application\154.0\msedgewebview2.exe" --embedded-browser-webview=1 --webview-exe-name="Rhine Music.exe" --user-data-dir="D:\Apps\Rhine Music\data\webview\EBWebView" --noerrdialogs"#;
        assert!(runs_on(quoted, &folder));
        // Either slash, any case, a trailing separator.
        assert!(runs_on(r#"x --user-data-dir="d:/apps/RHINE MUSIC/data/webview/EBWebView/" y"#, &folder));
        // Unquoted, as a path without spaces is given.
        let plain = profile_folder(Path::new(r"C:\Rhine\data\webview"));
        assert!(runs_on(r"x --type=renderer --user-data-dir=C:\Rhine\data\webview\EBWebView --lang=zh-CN", &plain));
        // Another program's WebView2, another copy of Rhine, a folder that only starts the same.
        assert!(!runs_on(r#"x --user-data-dir="C:\Users\u\AppData\Local\Packages\Search\EBWebView""#, &folder));
        assert!(!runs_on(r#"x --user-data-dir="D:\Apps\Rhine Music Copy\data\webview\EBWebView""#, &folder));
        assert!(!runs_on(r#"x --user-data-dir="D:\Apps\Rhine Music\data\webview\EBWebView2""#, &folder));
        assert!(!runs_on(r#"x --user-data-dir="D:\Apps\Rhine Music\data\webview""#, &folder));
        // No flag, or an empty one.
        assert!(!runs_on("msedgewebview2.exe --type=gpu-process", &folder));
        assert!(!runs_on("x --user-data-dir= --type=renderer", &folder));
        // The crash reporter quotes the whole argument, the path with its spaces.
        assert!(runs_on(r#""C:\EdgeWebView\154.0\msedgewebview2.exe" --type=crashpad-handler "--user-data-dir=D:\Apps\Rhine Music\data\webview\EBWebView" /prefetch:4"#, &folder));
        assert!(!runs_on(r#"x "--user-data-dir=D:\Apps\Rhine Music Copy\data\webview\EBWebView""#, &folder));
        // The value is read up to its own end: a later flag cannot make it match.
        assert!(!runs_on(r#"x --user-data-dir="C:\Other\EBWebView" --note=D:\Apps\Rhine Music\data\webview\EBWebView"#, &folder));
    }

    #[test]
    fn names_one_claim_per_folder() {
        let prefix = "Local\\io.github.ccdr4gon.rhine-music.webview-";
        let folder = profile_folder(Path::new(r"D:\Apps\Rhine Music\data\webview"));
        let name = claim_name(&folder);
        assert!(name.starts_with(prefix));
        assert_eq!(name.len(), prefix.len() + 16);
        // The same folder however it is written; another folder, another claim.
        assert_eq!(claim_name(&profile_folder(Path::new("d:/apps/RHINE MUSIC/data/webview/"))), name);
        assert_ne!(claim_name(&profile_folder(Path::new(r"D:\Apps\Rhine Music Copy\data\webview"))), name);
        // FNV-1a's published value for "a": the name is the same in every build.
        assert_eq!(claim_name("a"), format!("{prefix}af63dc4c8601ec8c"));
    }

    #[cfg(windows)]
    #[test]
    fn ends_nothing_on_a_folder_no_process_uses() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(end_leftovers(dir.path()), 0);
        release_claim();
    }

    #[cfg(windows)]
    #[test]
    fn leaves_a_folder_another_rhine_holds_alone() {
        use std::sync::mpsc::channel;
        let dir = tempfile::tempdir().unwrap();
        let folder = profile_folder(dir.path());
        // Another Rhine on the folder, still running: it holds the claim.
        let (held, holding) = channel();
        let (finish, finished) = channel::<()>();
        let other = {
            let folder = folder.clone();
            std::thread::spawn(move || {
                let claim = imp::claim(&folder, 0);
                held.send(claim.is_some()).unwrap();
                let _ = finished.recv();
                // Ends without releasing it, as a Rhine that crashed: the claim is abandoned.
                std::mem::forget(claim);
            })
        };
        assert!(holding.recv().unwrap());
        let started = std::time::Instant::now();
        assert!(imp::claim(&folder, 100).is_none(), "not while the other holds it");
        assert!(started.elapsed() >= std::time::Duration::from_millis(90));
        finish.send(()).unwrap();
        other.join().unwrap();
        // Abandoned with its thread: free.
        let claim = imp::claim(&folder, 1000).expect("free once the other has ended");
        claim.release();
        // Released: free at once.
        imp::claim(&folder, 0).expect("free after release").release();
    }
}
