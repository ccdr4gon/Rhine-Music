//! NetEase Cloud Music (网易云音乐) as the current source. What may be read from it or sent to it
//! is listed in AGENTS.md, each with the date the owner allowed it.
//!
//! `data` reads what NetEase saved on this PC, each only after its switch is on: the play
//! queue (`playingList`, display fields only) and the playlists the user created
//! (`webdb.dat`, opened read-only). `connector` talks to the running NetEase: its local
//! debugging port (127.0.0.1:9233: a fixed set of fields and two of its own actions).
pub mod connector;
pub mod data;

/// The `player` a NetEase source carries in the media snapshot.
pub const PLAYER: &str = "netease";
/// NetEase's name in the list of players (the owner, 2026-10-06: "show 网易云音乐 instead").
/// Windows knows its media session only by the app id (`cloudmusic.exe`), as it does QQ Music's.
pub const NAME: &str = "网易云音乐";
