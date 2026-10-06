//! The local library: the store (settings, chosen folders, the scan and its index, genre
//! rules, covers and the boundary of files that may be served), the tag reader (tags are
//! only read, never rewritten) and the album introductions looked up online on request.
pub mod library;
pub mod metadata;
pub mod online;
