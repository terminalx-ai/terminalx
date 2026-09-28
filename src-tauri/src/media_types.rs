//! The media formats the file pane previews instead of editing, shared by
//! the desktop's media server and the cloud runtime's `fs/1`.

use std::{
    collections::HashMap,
    path::Path,
    sync::LazyLock,
};

use serde::Deserialize;

#[derive(Deserialize)]
pub struct MediaType {
    pub mime: String,
}

pub fn media_type(path: &Path) -> Option<&'static MediaType> {
    static TYPES: LazyLock<HashMap<String, MediaType>> = LazyLock::new(|| {
        serde_json::from_str(include_str!("../../src/lib/mediaTypes.json"))
            .expect("valid media format table")
    });
    TYPES.get(&path.extension()?.to_str()?.to_ascii_lowercase())
}
