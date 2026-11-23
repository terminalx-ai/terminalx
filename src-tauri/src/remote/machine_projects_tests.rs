//! `machine/6` (PRO-351), held to docs/MACHINES.md "As built (PRO-351)":
//! browsing stays under home and names folders only, add and remove leave the
//! folder, and a clone that fails leaves nothing behind.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::sink::{BroadcastSink, EventSink};

/// A store of its own and a home directory of its own (canonical).
struct Home {
    dir: tempfile::TempDir,
    _store: crate::store::TempHome,
}

impl Home {
    fn new() -> Self {
        let store = crate::store::temp_home();
        Self { dir: tempfile::tempdir().unwrap(), _store: store }
    }

    fn path(&self) -> PathBuf {
        crate::paths::canonicalize(self.dir.path()).unwrap()
    }

    fn folder(&self, name: &str) -> PathBuf {
        let path = self.path().join(name);
        std::fs::create_dir_all(&path).unwrap();
        path
    }
}

fn code(result: Result<Value, RpcError>) -> &'static str {
    result.expect_err("expected a refusal").code
}

fn names(listing: &Value) -> Vec<String> {
    listing["entries"].as_array().unwrap().iter().map(|entry| entry["name"].as_str().unwrap().to_string()).collect()
}

fn s(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[test]
fn browse_lists_folder_names_under_home_in_name_order() {
    let home = Home::new();
    home.folder("Beta");
    home.folder("alpha");
    home.folder("alpha/inner");
    home.folder(".secret");
    std::fs::write(home.path().join("notes.txt"), "never listed").unwrap();

    let listing = browse(&home.path(), &json!({})).unwrap();
    assert_eq!(listing["home"], s(&home.path()));
    assert_eq!(listing["path"], s(&home.path()));
    assert_eq!(listing["parent"], Value::Null, "nothing above home");
    assert_eq!(names(&listing), vec!["alpha", "Beta"], "folders only, case folded, no hidden ones: {listing}");
    assert_eq!(listing["truncated"], false);
    let alpha = &listing["entries"][0];
    assert_eq!(alpha["path"], s(&home.path().join("alpha")));
    assert_eq!(alpha["git"], Value::Null);
    assert_eq!(alpha["projectId"], Value::Null);

    let inside = browse(&home.path(), &json!({ "path": s(&home.path().join("alpha")) })).unwrap();
    assert_eq!(names(&inside), vec!["inner"]);
    assert_eq!(inside["parent"], s(&home.path()));
    // A path that is spelled differently is listed by its canonical form.
    let spelled = browse(&home.path(), &json!({ "path": format!("{}/alpha/../Beta/", s(&home.path())) })).unwrap();
    assert_eq!(spelled["path"], s(&home.path().join("Beta")));
}

#[test]
fn browse_never_leaves_home() {
    let home = Home::new();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(outside.path().join("private")).unwrap();
    home.folder("work");

    assert_eq!(code(browse(&home.path(), &json!({ "path": s(outside.path()) }))), "path_forbidden");
    assert_eq!(code(browse(&home.path(), &json!({ "path": format!("{}/..", s(&home.path())) }))), "path_forbidden");
    let root = if cfg!(windows) { "C:\\" } else { "/" };
    assert_eq!(code(browse(&home.path(), &json!({ "path": root }))), "path_forbidden");
    // Outside home, a missing path is refused as one that exists: the answer never says which.
    // At the root, since a temporary folder is under the account's own home on Windows.
    let missing = format!("{root}terminalx-browse-missing-{}", std::process::id());
    assert_eq!(code(browse(&home.path(), &json!({ "path": missing }))), "path_forbidden");
    assert_eq!(code(browse(&home.path(), &json!({ "path": "work" }))), "invalid_params", "relative");
    assert_eq!(code(browse(&home.path(), &json!({ "path": "" }))), "invalid_params");
    assert_eq!(code(browse(&home.path(), &json!({ "path": 7 }))), "invalid_params");
    assert_eq!(code(browse(&home.path(), &json!({ "path": s(&home.path().join("missing")) }))), "not_found");
    std::fs::write(home.path().join("file.txt"), "x").unwrap();
    assert_eq!(code(browse(&home.path(), &json!({ "path": s(&home.path().join("file.txt")) }))), "not_found", "a file is not a folder");
}

#[cfg(unix)]
#[test]
fn a_link_that_leads_out_of_home_is_refused_and_left_out() {
    let home = Home::new();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(outside.path().join("private")).unwrap();
    let work = home.folder("work");
    std::os::unix::fs::symlink(outside.path(), home.path().join("escape")).unwrap();
    std::os::unix::fs::symlink(&work, home.path().join("shortcut")).unwrap();
    std::os::unix::fs::symlink(home.path().join("gone"), home.path().join("dangling")).unwrap();
    std::fs::write(home.path().join("file.txt"), "x").unwrap();
    std::os::unix::fs::symlink(home.path().join("file.txt"), home.path().join("to-a-file")).unwrap();

    assert_eq!(code(browse(&home.path(), &json!({ "path": s(&home.path().join("escape")) }))), "path_forbidden");
    assert_eq!(code(browse(&home.path(), &json!({ "path": s(&home.path().join("escape/private")) }))), "path_forbidden");
    let listing = browse(&home.path(), &json!({})).unwrap();
    assert_eq!(names(&listing), vec!["shortcut", "work"], "{listing}");
    // A link inside home is the folder it leads to.
    assert_eq!(listing["entries"][0]["path"], s(&work));
    assert_eq!(code(add(&home.path(), &json!({ "path": s(&home.path().join("escape")) }))), "path_forbidden");
}

#[test]
fn a_repository_says_its_branch_and_whether_origin_is_on_github_from_its_own_files() {
    let home = Home::new();
    let on_github = home.folder("on-github");
    std::fs::create_dir_all(on_github.join(".git")).unwrap();
    std::fs::write(on_github.join(".git/HEAD"), "ref: refs/heads/feature/x\n").unwrap();
    std::fs::write(on_github.join(".git/config"), "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = https://gitlab.com/a/b.git\n[remote \"origin\"]\n\turl = git@github.com:acme/api.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n").unwrap();

    let detached = home.folder("detached");
    std::fs::create_dir_all(detached.join(".git")).unwrap();
    std::fs::write(detached.join(".git/HEAD"), "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n").unwrap();
    std::fs::write(detached.join(".git/config"), "[remote \"origin\"]\n\turl = https://gitlab.com/acme/api.git\n").unwrap();

    // A linked worktree: `.git` is a file; its config is the repository's.
    let linked = home.folder("linked");
    std::fs::create_dir_all(on_github.join(".git/worktrees/linked")).unwrap();
    std::fs::write(on_github.join(".git/worktrees/linked/HEAD"), "ref: refs/heads/wip\n").unwrap();
    std::fs::write(on_github.join(".git/worktrees/linked/commondir"), "../..\n").unwrap();
    std::fs::write(linked.join(".git"), format!("gitdir: {}\n", s(&on_github.join(".git/worktrees/linked")))).unwrap();

    home.folder("plain");

    let listing = browse(&home.path(), &json!({})).unwrap();
    let git = |name: &str| listing["entries"].as_array().unwrap().iter().find(|entry| entry["name"] == name).unwrap()["git"].clone();
    assert_eq!(git("on-github"), json!({ "branch": "feature/x", "github": true }));
    assert_eq!(git("detached"), json!({ "branch": null, "github": false }));
    assert_eq!(git("linked"), json!({ "branch": "wip", "github": true }));
    assert_eq!(git("plain"), Value::Null);
}

#[test]
fn a_folder_that_already_is_a_project_says_so_archived_too() {
    let home = Home::new();
    let api = home.folder("api");
    let old = home.folder("old");
    home.folder("new");
    crate::store::projects::ensure(&s(&api)).unwrap();
    crate::store::projects::ensure(&s(&old)).unwrap();
    crate::store::projects::update(&s(&old), crate::store::projects::ProjectPatch { archived: Some(true), ..Default::default() }).unwrap();

    let listing = browse(&home.path(), &json!({})).unwrap();
    let id = |name: &str| listing["entries"].as_array().unwrap().iter().find(|entry| entry["name"] == name).unwrap()["projectId"].clone();
    assert_eq!(id("api"), json!(machine::project_id(&s(&api))));
    assert_eq!(id("old"), json!(machine::project_id(&s(&old))));
    assert_eq!(id("new"), Value::Null);
}

#[test]
fn at_most_500_folders_are_listed_and_the_rest_are_said_to_be_left_out() {
    let home = Home::new();
    let many = home.folder("many");
    for index in 0..(MAX_ENTRIES + 1) {
        std::fs::create_dir(many.join(format!("f{index:04}"))).unwrap();
    }
    let listing = browse(&home.path(), &json!({ "path": s(&many) })).unwrap();
    let listed = names(&listing);
    assert_eq!(listed.len(), MAX_ENTRIES);
    assert_eq!(listing["truncated"], true);
    assert_eq!(listed.first().map(String::as_str), Some("f0000"));
    assert_eq!(listed.last().map(String::as_str), Some("f0499"), "the first 500 in name order");

    std::fs::remove_dir(many.join("f0500")).unwrap();
    assert_eq!(browse(&home.path(), &json!({ "path": s(&many) })).unwrap()["truncated"], false);
}

#[test]
fn add_then_remove_leaves_the_folder_and_an_added_folder_keeps_its_id() {
    let home = Home::new();
    let api = home.folder("api");
    std::fs::write(api.join("README.md"), "api\n").unwrap();

    let added = add(&home.path(), &json!({ "path": s(&api) })).unwrap();
    let id = machine::project_id(&s(&api));
    assert_eq!(added["project"]["projectId"], id.as_str());
    assert_eq!(added["project"]["path"], s(&api));
    assert_eq!(added["project"]["name"], "api");
    assert_eq!(added["project"]["kind"], "folder");
    assert_eq!(added["project"]["archived"], false);
    // The same shape as a row of `machine.projects`.
    assert_eq!(machine::projects().unwrap()["projects"][0], added["project"]);
    // A folder that already is a project comes back as it is.
    assert_eq!(add(&home.path(), &json!({ "path": format!("{}/", s(&api)) })).unwrap(), added);
    assert_eq!(crate::store::projects::list().unwrap().0.len(), 1);

    assert_eq!(remove(&json!({ "projectId": id })).unwrap(), json!({ "removed": true }));
    assert!(crate::store::projects::list().unwrap().0.is_empty());
    assert_eq!(std::fs::read_to_string(api.join("README.md")).unwrap(), "api\n", "the folder stays");
    assert_eq!(code(remove(&json!({ "projectId": id }))), "not_found");
    assert_eq!(code(remove(&json!({}))), "invalid_params");

    // Added again, it gets its old id back.
    assert_eq!(add(&home.path(), &json!({ "path": s(&api) })).unwrap()["project"]["projectId"], id.as_str());

    let outside = tempfile::tempdir().unwrap();
    assert_eq!(code(add(&home.path(), &json!({ "path": s(outside.path()) }))), "path_forbidden");
    assert_eq!(code(add(&home.path(), &json!({ "path": "api" }))), "invalid_params");
    assert_eq!(code(add(&home.path(), &json!({}))), "invalid_params");
    assert_eq!(code(add(&home.path(), &json!({ "path": s(&home.path().join("missing")) }))), "not_found");
}

/// The sink a clone reports `projects_changed` on, and how often it did.
fn counting_sink() -> (Arc<dyn EventSink>, Arc<AtomicUsize>) {
    let sink: Arc<dyn EventSink> = Arc::new(BroadcastSink::new(16));
    let changed = Arc::new(AtomicUsize::new(0));
    let counter = changed.clone();
    sink.listen("projects_changed", Box::new(move |_| {
        counter.fetch_add(1, Ordering::SeqCst);
    }));
    (sink, changed)
}

/// Ask `machine.cloneStatus` until the clone ends.
fn ended(clones: &Clones, id: &str) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    loop {
        let clone = clones.status(&json!({ "cloneId": id })).unwrap()["clone"].clone();
        if clone["state"] != "cloning" {
            return clone;
        }
        assert!(std::time::Instant::now() < deadline, "the clone never ended: {clone}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn staging_left(parent: &Path) -> Vec<String> {
    std::fs::read_dir(parent).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).filter(|name| name.starts_with(".terminalx-clone-")).collect()
}

#[test]
fn a_clone_that_fails_leaves_nothing_at_its_destination() {
    let home = Home::new();
    let code_dir = home.folder("code");
    let sources = tempfile::tempdir().unwrap();
    let missing = url::Url::from_file_path(sources.path().join("missing-repo")).unwrap().to_string();
    let (sink, changed) = counting_sink();
    let clones = Arc::new(Clones::default());

    let started = clones.start(&home.path(), &json!({ "repository": missing, "parent": s(&code_dir) }), sink.clone()).unwrap()["clone"].clone();
    assert_eq!(started["state"], "cloning", "answered at once: {started}");
    assert_eq!(started["repository"], missing.as_str());
    assert_eq!(started["path"], s(&code_dir.join("missing-repo")));
    for field in ["stage", "percent", "project", "error"] {
        assert_eq!(started[field], Value::Null, "{field}");
    }
    let id = started["cloneId"].as_str().unwrap().to_string();

    let clone = ended(&clones, &id);
    assert_eq!(clone["state"], "failed", "{clone}");
    assert!(clone["error"]["code"].is_string() && clone["error"]["message"].is_string(), "{clone}");
    assert_eq!(clone["project"], Value::Null);
    assert!(!code_dir.join("missing-repo").exists(), "nothing at the destination");
    assert!(staging_left(&code_dir).is_empty(), "no staging folder left: {:?}", staging_left(&code_dir));
    assert!(crate::store::projects::list().unwrap().0.is_empty());
    assert_eq!(changed.load(Ordering::SeqCst), 0);
    // The status stays readable after it ended; a cancel then changes nothing.
    assert_eq!(clones.cancel(&json!({ "cloneId": id })).unwrap()["clone"], clone);
}

#[test]
fn a_clone_into_a_folder_that_holds_something_else_is_destination_exists() {
    let home = Home::new();
    let code_dir = home.folder("code");
    let occupied = home.folder("code/occupied");
    std::fs::write(occupied.join("mine.txt"), "keep me").unwrap();
    let sources = tempfile::tempdir().unwrap();
    let (sink, _) = counting_sink();
    let clones = Arc::new(Clones::default());

    let repository = url::Url::from_file_path(sources.path().join("occupied")).unwrap().to_string();
    let started = clones.start(&home.path(), &json!({ "repository": repository, "parent": s(&code_dir) }), sink).unwrap()["clone"].clone();
    let clone = ended(&clones, started["cloneId"].as_str().unwrap());
    assert_eq!(clone["state"], "failed");
    assert_eq!(clone["error"]["code"], crate::project_start::DESTINATION_EXISTS, "{clone}");
    assert_eq!(std::fs::read_to_string(occupied.join("mine.txt")).unwrap(), "keep me", "a folder in the way is never touched");
    assert!(staging_left(&code_dir).is_empty());
}

#[test]
fn a_clone_is_refused_outside_home_and_a_bad_source_fails_at_once() {
    let home = Home::new();
    let outside = tempfile::tempdir().unwrap();
    let (sink, _) = counting_sink();
    let clones = Arc::new(Clones::default());
    let start = |params: Value| clones.start(&home.path(), &params, sink.clone());

    assert_eq!(code(start(json!({ "repository": "acme/api", "parent": s(outside.path()) }))), "path_forbidden");
    assert_eq!(code(start(json!({ "repository": "acme/api", "parent": "code" }))), "invalid_params");
    assert_eq!(code(start(json!({ "repository": "acme/api", "parent": s(&home.path().join("missing")) }))), "not_found");
    assert_eq!(code(start(json!({ "parent": s(&home.path()) }))), "invalid_params");

    let bad = start(json!({ "repository": "ext::sh", "parent": s(&home.path()) })).unwrap()["clone"].clone();
    assert_eq!(bad["state"], "failed");
    assert_eq!(bad["error"]["code"], crate::project_start::INVALID_SOURCE);
    assert_eq!(clones.status(&json!({ "cloneId": bad["cloneId"] })).unwrap()["clone"], bad);

    assert_eq!(code(clones.status(&json!({ "cloneId": "clone-unknown" }))), "not_found");
    assert_eq!(code(clones.cancel(&json!({ "cloneId": "clone-unknown" }))), "not_found");
}

#[test]
fn a_whole_clone_is_added_as_a_project_and_announced() {
    let home = Home::new();
    let code_dir = home.folder("code");
    let sources = tempfile::tempdir().unwrap();
    let origin = sources.path().join("tool");
    crate::cloud_agents::launch::init_blank_repository(&origin, "main").unwrap();
    let (sink, changed) = counting_sink();
    let clones = Arc::new(Clones::default());

    let repository = url::Url::from_file_path(&origin).unwrap().to_string();
    let started = clones.start(&home.path(), &json!({ "repository": repository, "parent": s(&code_dir) }), sink).unwrap()["clone"].clone();
    let clone = ended(&clones, started["cloneId"].as_str().unwrap());
    assert_eq!(clone["state"], "done", "{clone}");
    assert_eq!(clone["error"], Value::Null);
    let path = s(&code_dir.join("tool"));
    assert_eq!(clone["path"], path.as_str());
    assert_eq!(clone["project"]["projectId"], machine::project_id(&path).as_str());
    assert_eq!(clone["project"]["kind"], "git");
    assert!(code_dir.join("tool/.git").is_dir());
    assert!(staging_left(&code_dir).is_empty());
    assert_eq!(changed.load(Ordering::SeqCst), 1, "projects_changed once");
    assert_eq!(machine::projects().unwrap()["projects"][0], clone["project"]);
}
