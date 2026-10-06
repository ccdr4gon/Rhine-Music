//! NetEase without a media session of its own (its "开启SMTC" switch is off by default): the
//! song and artist from the title of its window, found through its process (`cloudmusic.exe`),
//! and global media keys for play / pause, previous and next. The keys are offered only while
//! no other media session exists, and each connection needs the user's explicit consent.
//! Called by the shared media-session worker (`crate::media::windows_media`).
use super::parse_title;
use crate::media::{windows_media::win_error, Action, Capabilities, Source};
use std::{collections::HashSet, time::Instant};
use windows::{
    core::BOOL,
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        UI::{
            Input::KeyboardAndMouse::{
                SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
                KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE,
                VK_MEDIA_PREV_TRACK,
            },
            WindowsAndMessaging::{
                EnumWindows, GetClassNameW, GetWindowTextLengthW, GetWindowTextW,
                GetWindowThreadProcessId,
            },
        },
    },
};

type Outcome<T> = Result<T, String>;

/// The NetEase window found by the last snapshot, under a source id that lasts as long as
/// the same window of the same process.
#[derive(Default)]
pub(crate) struct WindowFallback {
    netease: Option<(String, NeteaseWindow)>,
}
impl WindowFallback {
    /// A control request for the fallback source (its ids are not media-session ids).
    pub(crate) fn owns(id: &str) -> bool {
        id.starts_with("netease-")
    }
    pub(crate) fn refresh(&mut self) -> Outcome<()> {
        let current = match observe_netease() {
            Ok(current) => current,
            Err(error) => {
                self.netease = None;
                return Err(error);
            }
        };
        self.netease = current.map(|window| {
            let id = self
                .netease
                .as_ref()
                .filter(|(_, old)| old.pid == window.pid && old.hwnd == window.hwnd)
                .map(|(id, _)| id.clone())
                .unwrap_or_else(|| format!("netease-{}", uuid::Uuid::new_v4()));
            (id, window)
        });
        Ok(())
    }
    /// The fallback source, while a NetEase window shows a song. `no_competitor`: the media
    /// sessions were read and there are none, so a global key can only reach NetEase.
    pub(crate) fn source(&self, no_competitor: bool) -> Option<Source> {
        let (id, window) = self.netease.as_ref()?;
        Some(Source {
            id: id.clone(), name: "网易云音乐（窗口标题）".into(), kind: "netease".into(),
            title: window.title.clone(), artist: window.artist.clone(), album: String::new(),
            cover_url: None, playback: "unknown".into(), position: None, duration: None,
            capabilities: Capabilities { toggle: no_competitor, previous: no_competitor, next: no_competitor, ..Capabilities::default() },
            warning: Some(if no_competitor { "仅有曲名与歌手，播放状态、封面和进度不可用。控制需要允许系统媒体键，不能保证只发送给网易云。" }
                else { "仅有曲名与歌手。检测到其它媒体会话或无法确认系统会话，已禁用系统媒体键以免控制其它播放器。" }.into()),
            player: Some(crate::netease_music::PLAYER.into()),
            // Remembered as NetEase (its module), never by the window: no app id.
            app: None,
        })
    }
    /// A global media key for the fallback source `id`, refused unless it is still the same
    /// window, the user allowed global keys for this connection and no other media session
    /// (`other_sessions`) could receive the key instead.
    pub(crate) fn control(
        &mut self,
        id: &str,
        action: Action,
        global_keys: bool,
        other_sessions: bool,
        deadline: Instant,
    ) -> Outcome<()> {
        self.refresh()?;
        if self
            .netease
            .as_ref()
            .is_none_or(|(current, _)| current != id)
        {
            return Err("选中的网易云来源已断开，请重新选择".into());
        }
        if !global_keys {
            return Err("网易云回退控制需要明确允许系统媒体键".into());
        }
        if other_sessions {
            return Err("发现其它系统媒体会话，已拒绝全局媒体键以免控制错误播放器".into());
        }
        if Instant::now() >= deadline {
            return Err("媒体控制请求已过期，未发送操作".into());
        }
        send_global_key(action)
    }
}

#[derive(Clone)]
struct NeteaseWindow {
    pid: u32,
    hwnd: usize,
    title: String,
    artist: String,
    priority: u8,
}
struct WindowContext {
    pids: HashSet<u32>,
    candidates: Vec<NeteaseWindow>,
}
fn observe_netease() -> Outcome<Option<NeteaseWindow>> {
    let mut context = WindowContext {
        pids: HashSet::new(),
        candidates: Vec::new(),
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(win_error)?;
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                if wide(&entry.szExeFile).eq_ignore_ascii_case("cloudmusic.exe") {
                    context.pids.insert(entry.th32ProcessID);
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
        if context.pids.is_empty() {
            return Ok(None);
        }
        EnumWindows(
            Some(enum_window),
            LPARAM((&mut context as *mut WindowContext) as isize),
        )
        .map_err(win_error)?;
    }
    context
        .candidates
        .sort_by_key(|window| (window.priority, window.pid, window.hwnd));
    Ok(context.candidates.into_iter().next())
}
unsafe extern "system" fn enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let context = unsafe { &mut *(lparam.0 as *mut WindowContext) };
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    if !context.pids.contains(&pid) {
        return true.into();
    }
    let mut class = [0u16; 256];
    let count = unsafe { GetClassNameW(hwnd, &mut class) }.max(0) as usize;
    let priority = match String::from_utf16_lossy(&class[..count]).as_str() {
        "OrpheusBrowserHost" => 0,
        "icon" => 1,
        _ => return true.into(),
    };
    let length = unsafe { GetWindowTextLengthW(hwnd) }.clamp(0, 8192) as usize;
    let mut title = vec![0; length + 1];
    let count = unsafe { GetWindowTextW(hwnd, &mut title) }.max(0) as usize;
    if let Some((title, artist)) = parse_title(&String::from_utf16_lossy(&title[..count])) {
        context.candidates.push(NeteaseWindow {
            pid,
            hwnd: hwnd.0 as usize,
            title,
            artist,
            priority,
        });
    }
    true.into()
}
fn wide(s: &[u16]) -> String {
    String::from_utf16_lossy(&s[..s.iter().position(|c| *c == 0).unwrap_or(s.len())])
}
fn send_global_key(action: Action) -> Outcome<()> {
    let key = match action {
        Action::Toggle => VK_MEDIA_PLAY_PAUSE,
        Action::Previous => VK_MEDIA_PREV_TRACK,
        Action::Next => VK_MEDIA_NEXT_TRACK,
        _ => return Err("网易云窗口模式不支持停止或跳转进度".into()),
    };
    let event = |flags: KEYBD_EVENT_FLAGS| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                dwFlags: flags,
                ..Default::default()
            },
        },
    };
    let inputs = [
        event(KEYEVENTF_EXTENDEDKEY),
        event(KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP),
    ];
    if unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) } != 2 {
        return Err("Windows 未接收完整媒体键，播放结果未确认".into());
    }
    Ok(())
}
