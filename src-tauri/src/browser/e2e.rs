//! End-to-end exercise of the bridge against a real agent-browser and a
//! real Chromium, driving a static site served from a temp dir. Ignored by
//! default: it needs the runtime (bundled, on PATH, or named by
//! `TERMINALX_AGENT_BROWSER_BIN`) and a browser to launch.
//!
//! ```text
//! cd src-tauri && cargo test --lib browser::e2e -- --ignored --nocapture
//! ```

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use super::{binary, ops, sweep, BrowserRuntime};

const INDEX: &str = r#"<!doctype html><title>Smoke Page</title><h1>Hello</h1>
<a href="second.html" id="go">Go second</a>
<input id="name" placeholder="Name">
<select id="sel"><option value="a">A</option><option value="b">B</option></select>
<input type="checkbox" id="cb" aria-label="Agree">
<button onclick="document.title='Clicked'">Press</button>
<script>console.log('hello console'); fetch('/data.json').then(() => {});</script>"#;
const SECOND: &str = r#"<!doctype html><title>Second</title><p>Second page</p><a href="index.html">Home</a>"#;

/// A one-thread static server: enough HTTP for Chromium to fetch a page,
/// so cookies and the network log behave like a real site.
fn serve(dir: PathBuf) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let dir = dir.clone();
            std::thread::spawn(move || {
                let mut stream = stream;
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let path = request.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
                let rel = path.trim_start_matches('/').split('?').next().unwrap_or("");
                let file = dir.join(if rel.is_empty() { "index.html" } else { rel });
                let (status, body, kind) = match std::fs::read(&file) {
                    Ok(bytes) => ("200 OK", bytes, if rel.ends_with(".json") { "application/json" } else { "text/html; charset=utf-8" }),
                    Err(_) => ("404 Not Found", b"missing".to_vec(), "text/plain"),
                };
                let head = format!("HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            });
        }
    });
    format!("http://127.0.0.1:{port}")
}

fn refs_of(snapshot: &Value) -> Vec<(String, String)> {
    snapshot["refs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["ref"].as_str().unwrap().to_string(), r["name"].as_str().unwrap_or("").to_string()))
        .collect()
}

fn ref_named<'a>(refs: &'a [(String, String)], name: &str) -> &'a str {
    &refs.iter().find(|(_, n)| n == name).unwrap_or_else(|| panic!("no ref named {name} in {refs:?}")).0
}

#[test]
#[ignore = "needs agent-browser and a Chromium; run with --ignored"]
fn live_agent_browser_round_trip() {
    let Some(bin) = binary::locate() else {
        eprintln!("agent-browser not found; skipping");
        return;
    };
    eprintln!("agent-browser at {}", bin.display());
    let _home = crate::store::temp_home();
    let site = tempfile::tempdir().unwrap();
    std::fs::write(site.path().join("index.html"), INDEX).unwrap();
    std::fs::write(site.path().join("second.html"), SECOND).unwrap();
    std::fs::write(site.path().join("data.json"), "{\"ok\":true}").unwrap();
    let base = serve(site.path().to_path_buf());
    let workspace = tempfile::tempdir().unwrap();
    let ws = super::control::canonical(&workspace.path().to_string_lossy());

    let rt = Arc::new(BrowserRuntime::open().unwrap());

    // tab create → a page in the workspace's browser, returned with its id.
    let created = ops::tab_create(&rt, &ws, Some(&format!("{base}/index.html")), "default").unwrap();
    let page_id = created["browserPageId"].as_str().unwrap().to_string();
    assert!(page_id.starts_with("bp-"));
    assert_eq!(rt.pages.active_for(&ws).unwrap().id, page_id);
    let target = rt.target(rt.pages.get(&page_id).unwrap()).unwrap();

    // snapshot → refs; click → navigation; stale refs are named as such.
    let snapshot = ops::snapshot(&rt, &target, &json!({})).unwrap();
    assert_eq!(snapshot["title"], "Smoke Page");
    let refs = refs_of(&snapshot);
    let go = ref_named(&refs, "Go second").to_string();
    let name_box = ref_named(&refs, "Name").to_string();
    ops::element_verb(&rt, &target, "click", &json!({"element": go})).unwrap();
    ops::wait(&rt, &target, &json!({"url": "second.html"})).unwrap();
    let url = ops::get(&rt, &target, &json!({"what": "url"})).unwrap();
    assert!(url["url"].as_str().unwrap().ends_with("/second.html"));
    let stale = ops::fill(&rt, &target, &json!({"element": name_box, "value": "x"})).unwrap_err();
    assert_eq!(stale.code, "browser_stale_ref", "{stale:?}");

    // back, then the whole interaction set on the form.
    let back = ops::history(&rt, &target, "back").unwrap();
    assert!(back["url"].as_str().unwrap().ends_with("/index.html"));
    assert_eq!(rt.pages.get(&page_id).unwrap().title, "Smoke Page");
    let snapshot = ops::snapshot(&rt, &target, &json!({"interactive": true})).unwrap();
    let refs = refs_of(&snapshot);
    let name_box = ref_named(&refs, "Name").to_string();
    let select = refs.iter().find(|(r, _)| snapshot["snapshot"].as_str().unwrap().contains(&format!("combobox [expanded=false, ref={}]", r.trim_start_matches('@')))).map(|(r, _)| r.clone()).expect("combobox ref");
    let checkbox = ref_named(&refs, "Agree").to_string();
    let button = ref_named(&refs, "Press").to_string();
    ops::fill(&rt, &target, &json!({"element": name_box, "value": "hello"})).unwrap();
    ops::type_text(&rt, &target, &json!({"input": " world"})).unwrap();
    let value = ops::get(&rt, &target, &json!({"what": "value", "element": name_box})).unwrap();
    assert_eq!(value["value"], "hello world");
    ops::select(&rt, &target, &json!({"element": select, "value": "b"})).unwrap();
    ops::element_verb(&rt, &target, "check", &json!({"element": checkbox})).unwrap();
    let checked = ops::is(&rt, &target, &json!({"what": "checked", "element": checkbox})).unwrap();
    assert_eq!(checked["checked"], true);
    ops::element_verb(&rt, &target, "hover", &json!({"element": button})).unwrap();
    ops::keypress(&rt, &target, &json!({"key": "Tab"})).unwrap();
    ops::scroll(&rt, &target, &json!({"direction": "down", "amount": "100"})).unwrap();
    ops::wait(&rt, &target, &json!({"text": "Hello"})).unwrap();
    ops::wait(&rt, &target, &json!({"load": "networkidle"})).unwrap();
    ops::element_verb(&rt, &target, "click", &json!({"element": button})).unwrap();
    let title = ops::eval(&rt, &target, &json!({"expression": "document.title"})).unwrap();
    assert_eq!(title["result"], "Clicked");

    // captures land as files.
    let shot = ops::screenshot(&rt, &target, &json!({}), false).unwrap();
    assert!(Path::new(shot["path"].as_str().unwrap()).exists());
    assert!(shot["bytes"].as_u64().unwrap() > 0);
    let full = ops::screenshot(&rt, &target, &json!({"format": "jpeg"}), true).unwrap();
    assert!(full["path"].as_str().unwrap().ends_with(".jpeg"));
    let pdf = ops::pdf(&rt, &target, &json!({})).unwrap();
    assert!(Path::new(pdf["path"].as_str().unwrap()).exists());

    // console, network, cookies.
    let console = ops::console(&rt, &target, &json!({"limit": "50"})).unwrap();
    assert!(console["messages"].as_array().unwrap().iter().any(|m| m["text"] == "hello console"));
    let network = ops::network(&rt, &target, &json!({"limit": "50"})).unwrap();
    assert!(network["requests"].as_array().unwrap().iter().any(|r| r["url"].as_str().unwrap().ends_with("/data.json")));
    ops::cookie_set(&rt, &target, &json!({"name": "smoke", "value": "yes"})).unwrap();
    let cookies = ops::cookie_get(&rt, &target, &json!({})).unwrap();
    assert!(cookies["cookies"].as_array().unwrap().iter().any(|c| c["name"] == "smoke"));
    ops::cookie_delete(&rt, &target, &json!({"name": "smoke"})).unwrap();
    let cookies = ops::cookie_get(&rt, &target, &json!({})).unwrap();
    assert!(!cookies["cookies"].as_array().unwrap().iter().any(|c| c["name"] == "smoke"));

    // the live preview: find the page over DevTools, stream frames, follow
    // a navigation, stop cleanly.
    rt.screencasts.start(rt.clone(), &page_id).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while rt.screencasts.frame_count(&page_id) == 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(rt.screencasts.frame_count(&page_id) > 0, "no screencast frame arrived");
    assert!(rt.screencasts.is_live(&page_id));
    let before = rt.screencasts.frame_count(&page_id);
    ops::goto(&rt, &target, &json!({"url": format!("{base}/second.html")})).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while (rt.screencasts.frame_count(&page_id) <= before || rt.pages.get(&page_id).unwrap().title != "Second") && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(rt.screencasts.frame_count(&page_id) > before, "no frame after navigation");
    assert_eq!(rt.pages.get(&page_id).unwrap().title, "Second");
    rt.screencasts.stop(&page_id);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while rt.screencasts.is_live(&page_id) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(!rt.screencasts.is_live(&page_id));
    ops::history(&rt, &target, "back").unwrap();

    // a second tab, listing, switching, and closing.
    let second = ops::tab_create(&rt, &ws, None, "default").unwrap();
    let second_id = second["browserPageId"].as_str().unwrap().to_string();
    assert_ne!(second_id, page_id);
    let listed = ops::tab_list(&rt, Some(&ws)).unwrap();
    let tabs = listed["tabs"].as_array().unwrap();
    assert_eq!(tabs.len(), 2);
    assert!(tabs.iter().any(|t| t["browserPageId"] == second_id && t["active"] == true));
    ops::tab_switch(&rt, &target, false).unwrap();
    assert_eq!(rt.pages.active_for(&ws).unwrap().id, page_id);
    let second_target = rt.target(rt.pages.get(&second_id).unwrap()).unwrap();
    let closed = ops::tab_close(&rt, &second_target).unwrap();
    assert_eq!(closed["closedBrowser"], false);
    assert_eq!(ops::tab_list(&rt, Some(&ws)).unwrap()["tabs"].as_array().unwrap().len(), 1);

    // exec passthrough is guarded, but plain page commands pass.
    let exec = ops::exec(&rt, &target, &json!({"command": "get title"})).unwrap();
    assert_eq!(exec["title"], "Smoke Page");
    assert_eq!(ops::exec(&rt, &target, &json!({"command": "close"})).unwrap_err().code, "invalid_arguments");

    // the last tab takes the browser with it, and nothing is left listening.
    let closed = ops::tab_close(&rt, &target).unwrap();
    assert_eq!(closed["closedBrowser"], true);
    assert!(rt.pages.infos(Some(&ws)).is_empty());
    assert!(rt.bridge.live_session_names().is_empty());

    // a crashed run's daemon is swept on the next start.
    ops::tab_create(&rt, &ws, Some(&format!("{base}/second.html")), "default").unwrap();
    assert_eq!(rt.bridge.live_session_names(), vec!["terminalx-default".to_string()]);
    let swept = sweep::sweep(&bin, &rt.bridge.env, |_| false);
    assert_eq!(swept, vec!["terminalx-default".to_string()]);
    // `close` returns before the daemon has fully gone; give it a moment.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let after = super::process::run(&bin, &["session", "list", "--json"], &rt.bridge.env, super::process::RunOptions { timeout: std::time::Duration::from_secs(5), stdin: None }).unwrap();
        if sweep::parse_session_names(&after.stdout).is_empty() {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "daemon still listed after sweep: {}", after.stdout);
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    rt.shutdown();
}
