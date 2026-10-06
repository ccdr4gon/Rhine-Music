pub mod local_music;
pub mod media;
pub mod netease_music;
pub mod qq_music;

// The local-music modules keep their earlier public paths, which main.rs, the tests and the
// metadata parity check use: `rhine_music::library` is `rhine_music::local_music::data::library`,
// and so on.
pub use local_music::connector::server;
pub use local_music::data::{library, metadata, online};
