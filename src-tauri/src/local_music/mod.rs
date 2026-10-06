//! Local music: the main folder the user chose, indexed and played by Rhine itself.
//!
//! `data` holds what is known about the music: the library store (settings, folders, the
//! scan and its index, genre rules, covers), the read-only tag reader and the optional
//! online introductions. `connector` is its routes under `/api/` (the library, the scan, the
//! settings, audio and artwork), which the page's server (`app_server`, outside the source
//! modules) hands it; that server serves the page itself for every source.
pub mod connector;
pub mod data;
