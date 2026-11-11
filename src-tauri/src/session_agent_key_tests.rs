//! A Claude Code tab launched while an API key is saved for it in Settings
//! (PRO-306): the agent's process gets the key, its command line never
//! does, nothing under the TerminalX home holds it, and the tab is counted
//! as keeping an older login once the key changes.
//!
//! Real panes and a stand-in for Claude Code that writes down what it was
//! given, as in `session_idle_tests`.
use std::time::Duration;

use serde_json::json;

use super::*;

/// Not `idle`: idle-test agents exiting late write into the next store under it.
const SESSION: &str = "agent-key";
const TAB: &str = "agent";
const KEY: &str = "sk-ant-api03-LaunchedAgentKey0123456789abcdefABCDEF-launch-7c1d";
const NEWER: &str = "sk-ant-api03-ANewerKeySavedLater0123456789abcdef-later-91be";

struct Rig {
    manager: SessionManager,
    program: PathBuf,
    _dir: tempfile::TempDir,
    _claude: claude::pty::TestProgram,
    _home: store::TempHome,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.manager.closing();
        self.manager.terminals.kill_all();
    }
}

impl Rig {
    fn new() -> Self {
        let home = store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("claude");
        // What it ran with, written beside it: its arguments, the saved key's
        // variable and whatever ANTHROPIC_API_KEY it was left.
        std::fs::write(&program, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.ran\"\nprintenv TERMINALX_AGENT_API_KEY > \"$0.key\"\nprintenv ANTHROPIC_API_KEY > \"$0.anthropic\"\nprintf 'ready\\n'\nstty -icanon\nexec cat\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let claude = claude::pty::claude_program_for_tests(program.clone());
        let manager = SessionManager::new(
            Arc::new(crate::sink::BroadcastSink::new(1024)),
            Arc::new(crate::sink::NoObserver),
            Arc::new(Host::new()),
            Arc::new(pty::Terminals::new()),
            Arc::new(Default::default()),
            Arc::new(Default::default()),
            crate::hooks::prepare_control().unwrap(),
        );
        manager.follow_pane_exits();
        let checkout = dir.path().join("checkout");
        std::fs::create_dir(&checkout).unwrap();
        let entry = json!({
            "id": SESSION, "projectPath": checkout, "cwd": checkout, "title": "Keys",
            "created": index::now(), "modified": index::now(),
            "tabs": [{ "id": TAB, "harness": "claude", "permissionMode": "default", "created": index::now() }],
        });
        index::save(&[serde_json::from_value(entry).unwrap()]).unwrap();
        Self { manager, program, _dir: dir, _claude: claude, _home: home }
    }

    fn wrote(&self, what: &str) -> Option<String> {
        std::fs::read_to_string(self.program.with_extension(what)).ok()
    }

    fn wait(&self, what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(60);
        while !done() {
            assert!(Instant::now() < deadline, "never happened: {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn written_under(root: &Path) -> String {
    let mut text = String::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() { dirs.push(path) } else { text.push_str(&String::from_utf8_lossy(&std::fs::read(&path).unwrap_or_default())) }
        }
    }
    text
}

#[test]
fn a_claude_tab_starts_with_the_saved_key_and_keeps_it_until_restarted() {
    let rig = Rig::new();
    let secrets = crate::keychain::testing::MemorySecrets::default();
    crate::agent_keys::save_for_test("claude", KEY, &secrets);

    rig.manager.ensure_started(SESSION, TAB).unwrap();
    rig.wait("the agent to start", || rig.wrote("anthropic").is_some());
    assert_eq!(rig.wrote("key").unwrap().trim(), KEY, "the agent's process has the key");
    // ANTHROPIC_API_KEY would stop the CLI on its "use this key?" question.
    assert_eq!(rig.wrote("anthropic").unwrap().trim(), "");
    let argv = rig.wrote("ran").unwrap();
    let settings = argv.lines().skip_while(|line| *line != "--settings").nth(1).expect("--settings is passed");
    let settings: serde_json::Value = serde_json::from_str(settings).unwrap();
    assert_eq!(settings["apiKeyHelper"], "/usr/bin/printenv TERMINALX_AGENT_API_KEY");
    assert_eq!(settings["env"]["ANTHROPIC_BASE_URL"], "https://api.anthropic.com");
    assert!(!argv.contains(KEY) && !argv.contains(&KEY[13..40]), "the command line, which other processes can read, holds the key");

    let tabs = crate::agent_keys::running("claude");
    let ours: Vec<_> = tabs.iter().filter(|tab| tab.session_id == SESSION).collect();
    assert_eq!(ours.len(), 1);
    assert!(ours[0].current);

    // A newer key: the running tab keeps the one it started with.
    crate::agent_keys::save_for_test("claude", NEWER, &secrets);
    let ours = crate::agent_keys::running("claude").into_iter().find(|tab| tab.session_id == SESSION).unwrap();
    assert!(!ours.current, "it is counted among the tabs to restart");
    assert_eq!(rig.wrote("key").unwrap().trim(), KEY);

    // Restarted, it gets the newer key and counts as current.
    std::fs::remove_file(rig.program.with_extension("anthropic")).unwrap();
    rig.manager.stop(SESSION, TAB).unwrap();
    rig.wait("the agent to stop", || !rig.manager.is_running(SESSION, TAB));
    assert!(crate::agent_keys::running("claude").iter().all(|tab| tab.session_id != SESSION), "a stopped agent is not running");
    rig.manager.ensure_started(SESSION, TAB).unwrap();
    rig.wait("the agent to start again", || rig.wrote("anthropic").is_some());
    assert_eq!(rig.wrote("key").unwrap().trim(), NEWER);
    assert!(crate::agent_keys::running("claude").into_iter().find(|tab| tab.session_id == SESSION).unwrap().current);

    // Its transcript, event log, diagnostics and settings: none holds a key.
    let written = written_under(&store::root().unwrap());
    for secret in [KEY, &KEY[13..40], NEWER, &NEWER[13..40]] {
        assert!(!written.contains(secret), "{secret} was written under the TerminalX home");
    }
}
