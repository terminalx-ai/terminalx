//! Revocable, per-viewer file grants. HTTP bodies stream with backpressure, including
//! non-range requests; no media bytes cross JSON IPC or enter the text reader.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock},
};

use axum::{
    body::Body,
    extract::{Path as UrlPath, State},
    http::{header, HeaderMap, Method, Response, StatusCode},
    routing::get,
    Router,
};
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt},
    sync::OnceCell,
};
use tokio_util::{io::ReaderStream, sync::CancellationToken};

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

struct Grant {
    path: PathBuf,
    mime: String,
    cancelled: CancellationToken,
}
impl Drop for Grant {
    fn drop(&mut self) {
        self.cancelled.cancel();
    }
}
type Grants = Arc<Mutex<HashMap<String, Grant>>>;

#[derive(Default)]
pub struct MediaServer {
    grants: Grants,
    port: OnceCell<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile {
    token: String,
    url: String,
    mtime_ms: u64,
}

impl MediaServer {
    async fn open(&self, root: &Path, rel: &str) -> anyhow::Result<MediaFile> {
        let mime = &media_type(Path::new(rel))
            .ok_or_else(|| anyhow::anyhow!("Unsupported media format"))?
            .mime;
        let root = tokio::fs::canonicalize(root).await?;
        let path = tokio::fs::canonicalize(root.join(rel)).await?;
        anyhow::ensure!(
            path.starts_with(&root),
            "Media path is outside the selected workspace"
        );
        anyhow::ensure!(
            tokio::fs::metadata(&path).await?.is_file(),
            "Not a regular media file"
        );
        let file = tokio::fs::File::open(&path).await?;
        let metadata = file.metadata().await?;
        anyhow::ensure!(metadata.is_file(), "Not a regular media file");
        let mtime_ms = metadata
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as u64;
        let port = self
            .port
            .get_or_try_init(|| async {
                let listener =
                    tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
                let port = listener.local_addr()?.port();
                // No directory serving, path-based route, CORS grant, or write endpoint.
                let router = Router::new()
                    .route("/{token}", get(serve))
                    .with_state(self.grants.clone());
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = axum::serve(listener, router).await {
                        log::error!("Media server: {error}");
                    }
                });
                Ok::<_, std::io::Error>(port)
            })
            .await?;
        let token = uuid::Uuid::new_v4().to_string();
        self.grants.lock().insert(
            token.clone(),
            Grant {
                path,
                mime: mime.clone(),
                cancelled: CancellationToken::new(),
            },
        );
        Ok(MediaFile {
            url: format!("http://127.0.0.1:{port}/{token}"),
            token,
            mtime_ms,
        })
    }

    fn close(&self, token: &str) {
        self.grants.lock().remove(token);
    }
}

#[tauri::command]
pub async fn open_media_file(
    server: tauri::State<'_, MediaServer>,
    root: String,
    rel: String,
) -> Result<MediaFile, String> {
    server
        .open(Path::new(&root), &rel)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_media_file(server: tauri::State<'_, MediaServer>, token: String) {
    server.close(&token);
}

async fn serve(
    State(grants): State<Grants>,
    UrlPath(token): UrlPath<String>,
    method: Method,
    headers: HeaderMap,
) -> Result<Response<Body>, StatusCode> {
    let (path, mime, cancelled) = {
        let grants = grants.lock();
        let grant = grants.get(&token).ok_or(StatusCode::NOT_FOUND)?;
        (
            grant.path.clone(),
            grant.mime.clone(),
            grant.cancelled.clone(),
        )
    };
    // An authorized path cannot later be replaced with a symlink to another file.
    if tokio::fs::canonicalize(&path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?
        != path
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let metadata = file.metadata().await.map_err(|_| StatusCode::NOT_FOUND)?;
    if !metadata.is_file() || cancelled.is_cancelled() {
        return Err(StatusCode::NOT_FOUND);
    }
    let len = metadata.len();
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff");
    let range = if method == Method::HEAD {
        None
    } else {
        headers.get(header::RANGE)
    };
    let (start, length) = if let Some(range) = range {
        let ranges = range
            .to_str()
            .ok()
            .and_then(|r| http_range::HttpRange::parse(r, len).ok())
            .filter(|ranges| !ranges.is_empty() && ranges.iter().all(|range| range.length > 0));
        match ranges {
            Some(ranges) if ranges.len() == 1 => {
                let range = &ranges[0];
                response = response.status(StatusCode::PARTIAL_CONTENT).header(
                    header::CONTENT_RANGE,
                    format!(
                        "bytes {}-{}/{len}",
                        range.start,
                        range.start + range.length - 1
                    ),
                );
                (range.start, range.length)
            }
            // Multiple ranges may be ignored and answered with the full representation.
            Some(_) => (0, len),
            None => {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                    .body(Body::empty())
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
            }
        }
    } else {
        (0, len)
    };
    response = response.header(header::CONTENT_LENGTH, length);
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        file.seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        // Dropping the HTTP body or revoking its grant closes the file and ends reads.
        Body::from_stream(
            ReaderStream::with_capacity(file.take(length), 64 * 1024)
                .take_until(cancelled.cancelled_owned()),
        )
    };
    response
        .body(body)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    async fn request(url: &str, method: &str, range: Option<&str>) -> (u16, String, Vec<u8>) {
        let (url, method, range) = (url.to_owned(), method.to_owned(), range.map(str::to_owned));
        tokio::task::spawn_blocking(move || {
            let mut request = ureq::request(&method, &url);
            if let Some(range) = range {
                request = request.set("Range", &range);
            }
            let response = match request.call() {
                Ok(r) | Err(ureq::Error::Status(_, r)) => r,
                Err(e) => panic!("{e}"),
            };
            let status = response.status();
            let mime = response.header("Content-Type").unwrap_or("").to_string();
            let mut bytes = Vec::new();
            response.into_reader().read_to_end(&mut bytes).unwrap();
            (status, mime, bytes)
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn streams_selected_file_ranges_and_revokes_each_grant_independently() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("透明 clip #1.MP4");
        let bytes = b"\0\0\0\x18ftypmp42abcdefghijklmnop";
        std::fs::write(&path, bytes).unwrap();
        let server = MediaServer::default();
        let a = server.open(dir.path(), "透明 clip #1.MP4").await.unwrap();
        let b = server.open(dir.path(), "透明 clip #1.MP4").await.unwrap();
        assert_eq!(
            request(&a.url, "GET", None).await,
            (200, "video/mp4".into(), bytes.to_vec())
        );
        assert_eq!(
            request(&a.url, "GET", Some("bytes=4-11")).await,
            (206, "video/mp4".into(), bytes[4..12].to_vec())
        );
        assert_eq!(
            request(&a.url, "GET", Some("bytes=-4")).await.2,
            bytes[bytes.len() - 4..]
        );
        assert_eq!(
            request(&a.url, "GET", Some("bytes=12-")).await.2,
            bytes[12..]
        );
        assert_eq!(request(&a.url, "GET", Some("bytes=999-")).await.0, 416);
        assert_eq!(request(&a.url, "HEAD", None).await.2, Vec::<u8>::new());
        assert_eq!(request(&a.url, "POST", None).await.0, 405);
        let cancellation = server
            .grants
            .lock()
            .get(&a.token)
            .unwrap()
            .cancelled
            .clone();
        server.close(&a.token);
        assert!(cancellation.is_cancelled());
        assert_eq!(request(&a.url, "GET", None).await.0, 404);
        assert_eq!(request(&b.url, "GET", None).await.0, 200);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(request(&b.url, "GET", None).await.0, 404);
    }

    #[tokio::test]
    async fn large_files_bypass_text_limits_and_paths_cannot_escape() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.wav");
        std::fs::File::create(&path)
            .unwrap()
            .set_len(512 * 1024 * 1024)
            .unwrap();
        let server = MediaServer::default();
        let file = server.open(dir.path(), "large.wav").await.unwrap();
        assert_eq!(
            request(&file.url, "GET", Some("bytes=500000000-500000003")).await,
            (206, "audio/wav".into(), vec![0; 4])
        );
        assert!(server.open(dir.path(), "missing.mp3").await.is_err());
        assert!(server.open(dir.path(), "large.txt").await.is_err());
        std::fs::create_dir(dir.path().join("child")).unwrap();
        assert!(server
            .open(&dir.path().join("child"), "../large.wav")
            .await
            .is_err());
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("secret.mp3"), "secret").unwrap();
            std::os::unix::fs::symlink(
                outside.path().join("secret.mp3"),
                dir.path().join("escape.mp3"),
            )
            .unwrap();
            assert!(server.open(dir.path(), "escape.mp3").await.is_err());
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(outside.path().join("secret.mp3"), &path).unwrap();
            assert_eq!(request(&file.url, "GET", None).await.0, 403);
        }
    }

    #[tokio::test]
    async fn empty_media_ranges_fail_cleanly_and_full_responses_are_bounded_and_cancellable() {
        let dir = tempfile::tempdir().unwrap();
        let server = MediaServer::default();
        let path = dir.path().join("empty.mp4");
        std::fs::write(&path, []).unwrap();
        let empty = server.open(dir.path(), "empty.mp4").await.unwrap();
        assert_eq!(request(&empty.url, "GET", Some("bytes=-1")).await.0, 416);
        assert_eq!(request(&empty.url, "GET", Some("bytes=0-")).await.0, 416);
        assert_eq!(request(&empty.url, "GET", None).await.2, Vec::<u8>::new());

        std::fs::File::create(dir.path().join("large.mp4"))
            .unwrap()
            .set_len(512 * 1024 * 1024)
            .unwrap();
        let large = server.open(dir.path(), "large.mp4").await.unwrap();
        let response = serve(
            State(server.grants.clone()),
            UrlPath(large.token.clone()),
            Method::GET,
            HeaderMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "536870912");
        let mut stream = response.into_body().into_data_stream();
        assert!(stream.next().await.unwrap().unwrap().len() <= 64 * 1024);
        server.close(&large.token);
        assert!(stream.next().await.is_none());
    }

    #[test]
    fn text_save_cannot_overwrite_even_corrupt_media_but_svg_and_code_remain_editable() {
        let dir = tempfile::tempdir().unwrap();
        for extension in ["PNG", "mp3", "wav", "mp4", "psd", "mkv"] {
            let path = dir.path().join(format!("broken.{extension}"));
            std::fs::write(&path, "corrupt but no NULs").unwrap();
            assert!(crate::files::write_text(&path, "overwrite").is_err());
            assert_eq!(
                std::fs::read_to_string(path).unwrap(),
                "corrupt but no NULs"
            );
        }
        for extension in ["svg", "md", "ts", "mts"] {
            assert!(crate::files::write_text(
                &dir.path().join(format!("source.{extension}")),
                "source"
            )
            .is_ok());
        }
    }
}
