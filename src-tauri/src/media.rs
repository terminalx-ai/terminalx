//! Revocable, per-viewer file grants. HTTP bodies stream with backpressure, including
//! non-range requests; no media bytes cross JSON IPC or enter the text reader.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
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
use serde::Serialize;
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt},
    sync::OnceCell,
};
use tokio_util::{io::ReaderStream, sync::CancellationToken};

pub use crate::media_types::media_type;

struct Grant {
    root: PathBuf,
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

const MAX_MEDIA_GRANTS: usize = 256;

fn is_allowed_origin(origin: &str) -> bool {
    matches!(
        origin,
        "tauri://localhost"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
            | "http://localhost:1420"
            | "http://127.0.0.1:1420"
    )
}

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
        let rel_path = Path::new(rel);
        anyhow::ensure!(
            !rel.is_empty()
                && rel_path
                    .components()
                    .all(|component| matches!(component, std::path::Component::Normal(_))),
            "Media path must be relative to the selected workspace"
        );
        let mime = &media_type(rel_path)
            .ok_or_else(|| anyhow::anyhow!("Unsupported media format"))?
            .mime;
        let root = crate::paths::simplified(&tokio::fs::canonicalize(root).await?).to_path_buf();
        let path = crate::paths::simplified(&tokio::fs::canonicalize(root.join(rel_path)).await?).to_path_buf();
        anyhow::ensure!(
            path.starts_with(&root),
            "Media path is outside the selected workspace"
        );
        let (root_for_open, path_for_open) = (root.clone(), path.clone());
        let file = tokio::task::spawn_blocking(move || crate::workspace_file::open(&root_for_open, &path_for_open))
            .await
            .map_err(|e| anyhow::anyhow!("Media open failed: {e}"))??;
        let file = tokio::fs::File::from_std(file);
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
        {
            let mut grants = self.grants.lock();
            anyhow::ensure!(
                grants.len() < MAX_MEDIA_GRANTS,
                "Too many concurrent open media grants"
            );
            grants.insert(
                token.clone(),
                Grant {
                    root,
                    path,
                    mime: mime.clone(),
                    cancelled: CancellationToken::new(),
                },
            );
        }
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
    let (confined_root, confined_rel) = tokio::task::spawn_blocking(move || {
        crate::files::resolve_confined_media_root(Path::new(&root), &rel)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    server
        .open(&confined_root, &confined_rel)
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
    if let Some(origin) = headers.get(header::ORIGIN) {
        let origin = origin.to_str().map_err(|_| StatusCode::FORBIDDEN)?;
        if !is_allowed_origin(origin) {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    if uuid::Uuid::parse_str(&token).is_err() {
        return Err(StatusCode::NOT_FOUND);
    }
    let (root, path, mime, cancelled) = {
        let grants = grants.lock();
        let grant = grants.get(&token).ok_or(StatusCode::NOT_FOUND)?;
        (
            grant.root.clone(),
            grant.path.clone(),
            grant.mime.clone(),
            grant.cancelled.clone(),
        )
    };
    // An authorized path cannot later be replaced with a symlink to another file.
    if crate::paths::simplified(&tokio::fs::canonicalize(&path).await.map_err(|_| StatusCode::NOT_FOUND)?)
        != path
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let (root_for_open, path_for_open) = (root.clone(), path.clone());
    let opened = tokio::task::spawn_blocking(move || crate::workspace_file::open(&root_for_open, &path_for_open))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut file = match opened {
        Ok(std_file) => tokio::fs::File::from_std(std_file),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(StatusCode::NOT_FOUND),
        Err(_) => return Err(StatusCode::FORBIDDEN),
    };
    let metadata = file.metadata().await.map_err(|_| StatusCode::NOT_FOUND)?;
    if !metadata.is_file() || cancelled.is_cancelled() {
        return Err(StatusCode::NOT_FOUND);
    }
    let len = metadata.len();
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Content-Security-Policy", "default-src 'none'; sandbox");
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

    #[tokio::test]
    async fn media_server_rejects_absolute_and_parent_traversal_rel_paths() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_img = outside.path().join("secret.png");
        std::fs::write(&outside_img, b"png").unwrap();
        let server = MediaServer::default();
        assert!(server.open(dir.path(), &outside_img.to_string_lossy()).await.is_err());
        assert!(server.open(dir.path(), "../secret.png").await.is_err());
        assert!(server.open(dir.path(), "").await.is_err());
    }

    #[tokio::test]
    async fn media_server_sets_sandbox_csp_and_rejects_untrusted_origin_or_bad_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pic.png");
        std::fs::write(&path, b"\x89PNG\r\n\x1a\n").unwrap();
        let server = MediaServer::default();
        let grant = server.open(dir.path(), "pic.png").await.unwrap();

        let mut evil_headers = HeaderMap::new();
        evil_headers.insert(header::ORIGIN, "https://evil.example".parse().unwrap());
        let err = serve(
            State(server.grants.clone()),
            UrlPath(grant.token.clone()),
            Method::GET,
            evil_headers,
        )
        .await
        .unwrap_err();
        assert_eq!(err, StatusCode::FORBIDDEN);

        let err_bad_token = serve(
            State(server.grants.clone()),
            UrlPath("not-a-uuid".into()),
            Method::GET,
            HeaderMap::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(err_bad_token, StatusCode::NOT_FOUND);

        let mut tauri_headers = HeaderMap::new();
        tauri_headers.insert(header::ORIGIN, "tauri://localhost".parse().unwrap());
        let ok = serve(
            State(server.grants.clone()),
            UrlPath(grant.token.clone()),
            Method::GET,
            tauri_headers,
        )
        .await
        .unwrap();
        assert_eq!(
            ok.headers()["content-security-policy"],
            "default-src 'none'; sandbox"
        );
        assert_eq!(ok.headers()["referrer-policy"], "no-referrer");
    }
}
