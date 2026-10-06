//! How the page reaches the local music: its routes under `/api/` on the page's server
//! (`app_server`, which checks Host and Origin first); music files are only read.
pub mod api;
