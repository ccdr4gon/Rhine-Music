//! The local library: the store (settings, chosen folders, the scan and its index, genre
//! rules, covers and the boundary of files that may be served), the tag reader (tags are
//! only read, never rewritten), a song's lyrics (read from its .lrc or its tags) and the album
//! introductions looked up online on request.
pub mod library;
pub mod lyrics;
pub mod metadata;
pub mod online;
