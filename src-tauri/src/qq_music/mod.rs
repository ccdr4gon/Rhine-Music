//! QQ Music (QQ音乐). The owner (2026-10-06): "for qq music, you can just use the SMTC".
//! Connected only through the Windows media session it publishes, like any other player
//! there: the song it shows, play / pause and previous / next, and its position, seeking and
//! stop only when the session reports them. No file, database, port, COM interface, window
//! title or process memory of QQ Music is read, and it is sent nothing but the media session's
//! own controls. It is connected by itself only once the user has picked it (the page then
//! remembers it by this module's `PLAYER`, as it remembers any source, 2026-10-06; NetEase is
//! the default link while nothing was ever connected), and it has no queue, playlist columns or
//! global media keys. Anything more needs the owner's consent first, field by field and action
//! by action, as NetEase's has.
//!
//! `connector` recognises its session; `data` is the song that session shows, in memory only.
pub mod connector;
pub mod data;

/// The `player` a QQ Music media session carries in the media snapshot.
pub const PLAYER: &str = "qqmusic";
/// QQ Music's name in the list of players. Windows knows its session only by the app id
/// (`QQMusic.exe`): an unpackaged program has no display name there.
pub const NAME: &str = "QQ音乐";
