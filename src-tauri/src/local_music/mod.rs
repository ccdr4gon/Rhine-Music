//! Local music: the folders the user chose, indexed and played by Rhine itself.
//!
//! `data` holds what is known about the music: the library store (settings, folders, the
//! scan and its index, genre rules, covers), the read-only tag reader and the optional
//! online introductions. `connector` is the service on 127.0.0.1 that the page talks to
//! (`/api/*`, audio and artwork). That service also serves the page itself in every mode,
//! the player skin included, until the UI server is split from the local routes.
pub mod connector;
pub mod data;
