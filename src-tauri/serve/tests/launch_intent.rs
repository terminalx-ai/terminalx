//! A cloud workspace's launch intent (PRO-21, terminalx-saas contract §19)
//! against the real runtime: `terminalx-serve` claims it from the fake API,
//! puts every repository on the workspace's own work branch, starts the
//! fake Claude Code in the primary repository and sends the first prompt
//! exactly once, across a restart.

#![cfg(unix)]

mod common;

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use common::agent::{count, texts, wait_until, AgentWorld, Serve};
use common::mailbox::FakeMailbox;
use serde_json::json;

const BRANCH: &str = "terminalx/fix-login-3f9a2c1b7d4e";
const PROMPT: &str = "echo:launched from the intent";

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main"])
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A checkout of a remote with `main` and `feature`, as an Environment image
/// holds it under `/home/repos/<owner>/<name>`.
fn checkout(root: &Path, name: &str) -> std::path::PathBuf {
    let remote = root.join(format!("{name}.git"));
    let seed = root.join(format!("{name}-seed"));
    std::fs::create_dir_all(&seed).unwrap();
    git(root, &["init", "-q", "--bare", remote.to_str().unwrap()]);
    git(&seed, &["init", "-q"]);
    std::fs::write(seed.join("README.md"), format!("{name}\n")).unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-qm", "init"]);
    git(&seed, &["switch", "-qc", "feature"]);
    std::fs::write(seed.join("FEATURE.md"), "feature\n").unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-qm", "feature"]);
    git(&seed, &["push", "-q", remote.to_str().unwrap(), "main", "feature"]);
    let path = root.join("repos").join("acme").join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    git(root, &["clone", "-q", "-b", "main", remote.to_str().unwrap(), path.to_str().unwrap()]);
    std::fs::canonicalize(path).unwrap()
}

#[test]
fn the_first_prompt_reaches_the_agent_once_on_the_work_branch() {
    if Command::new("python3").arg("--version").output().is_err() {
        eprintln!("skipped: python3 is not installed");
        return;
    }
    let world = AgentWorld::new();
    let repos = tempfile::tempdir().unwrap();
    let app = checkout(repos.path(), "app");
    let lib = checkout(repos.path(), "lib");
    let mailbox = FakeMailbox::start(7);
    mailbox.set_launch(json!({
        "launchId": "launch_test",
        "workBranch": BRANCH,
        "title": "Fix the login",
        "agent": "claude",
        "mode": "manual",
        "prompt": PROMPT,
        "repositories": [
            { "owner": "acme", "name": "app", "path": app, "ref": "feature" },
            { "owner": "acme", "name": "lib", "path": lib },
        ],
    }));
    // No relay to reach: the launch needs only the API. The runtime keeps
    // trying the director in the background.
    let link_dir = tempfile::tempdir().unwrap();
    let link = link_dir.path().join("link.json");
    std::fs::write(
        &link,
        json!({
            "v": 1, "hostSecretB64": STANDARD.encode([7u8; 32]), "relayToken": "unused", "directorUrl": "http://127.0.0.1:1",
            "attachments": [], "mailbox": mailbox.link_section(),
        })
        .to_string(),
    )
    .unwrap();
    let start = || {
        let mut command = world.command();
        command.args(["--runtime-kind", "cloud-workspace", "--relay-link"]).arg(&link);
        Serve::start(command, &world.data)
    };

    let serve = start();
    let launch = wait_until("the launch to settle", || Some(mailbox.launch()).filter(|launch| launch.state != "pending" && launch.state != "claimed"));
    assert_eq!(launch.state, "started", "{:?}", launch.completions);
    assert_eq!(launch.phases, ["syncing-repository", "starting-agent"]);
    let completion = &launch.completions[0];
    let tab = completion["tabId"].as_str().expect("the tab holding the prompt").to_string();
    let events = serve.wait_events(&tab, "the first turn", |events| count(events, "turn_completed") >= 1);
    assert_eq!(texts(&events, "user_message"), vec![PROMPT]);
    assert_eq!(texts(&events, "assistant_text"), vec!["launched from the intent"]);

    // Both repositories are on the work branch: from `feature` in the
    // primary one, from the default branch in the other.
    assert_eq!(git(&app, &["branch", "--show-current"]), BRANCH);
    assert_eq!(git(&app, &["rev-parse", "HEAD"]), git(&app, &["rev-parse", "origin/feature"]));
    assert_eq!(git(&lib, &["branch", "--show-current"]), BRANCH);
    assert_eq!(git(&lib, &["rev-parse", "HEAD"]), git(&lib, &["rev-parse", "origin/main"]));
    let branches = completion["branches"].as_array().unwrap();
    assert_eq!(branches.len(), 2);
    assert_eq!(branches[0]["head"], git(&app, &["rev-parse", "HEAD"]));
    // The agent ran in the primary repository.
    let sessions = serve.control("sessions.list", json!({}));
    assert!(sessions.to_string().contains(app.to_str().unwrap()), "{sessions}");

    // A restart claims again and finds it settled: no second tab or prompt.
    drop(serve);
    let claims = mailbox.launch().claims;
    let serve = start();
    wait_until("the restarted runtime to claim", || (mailbox.launch().claims > claims).then_some(()));
    std::thread::sleep(Duration::from_secs(2));
    let launch = mailbox.launch();
    assert_eq!(launch.state, "started");
    assert_eq!(launch.completions.len(), 1, "{:?}", launch.completions);
    assert_eq!(texts(&serve.events(&tab), "user_message"), vec![PROMPT]);
}

#[test]
fn an_agent_that_is_not_installed_fails_the_launch_without_sending() {
    let world = AgentWorld::new();
    let mailbox = FakeMailbox::start(7);
    mailbox.set_launch(json!({
        "launchId": "launch_missing", "workBranch": BRANCH, "agent": "codex", "prompt": "hello", "repositories": [],
    }));
    let link_dir = tempfile::tempdir().unwrap();
    let link = link_dir.path().join("link.json");
    std::fs::write(
        &link,
        json!({
            "v": 1, "hostSecretB64": STANDARD.encode([9u8; 32]), "relayToken": "unused", "directorUrl": "http://127.0.0.1:1",
            "attachments": [], "mailbox": mailbox.link_section(),
        })
        .to_string(),
    )
    .unwrap();
    let mut command = world.command();
    // Nothing but the fake `claude` on PATH, so `codex` is not installed.
    command.env("PATH", format!("{}:/usr/bin:/bin", world.bin.display()));
    command.args(["--runtime-kind", "cloud-workspace", "--relay-link"]).arg(&link);
    let serve = Serve::start(command, &world.data);
    let launch = wait_until("the launch to settle", || Some(mailbox.launch()).filter(|launch| launch.state != "pending" && launch.state != "claimed"));
    assert_eq!((launch.state.as_str(), launch.category.as_deref()), ("failed", Some("agent-unavailable")));
    assert_eq!(serve.control("sessions.list", json!({}))["sessions"].as_array().map(Vec::len).unwrap_or(0), 0);
}
