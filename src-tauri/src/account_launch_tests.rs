//! Tabs and terminals started on an agent account (#980,
//! `docs/AGENT-ACCOUNTS.md`): a Claude Code tab on an added account runs
//! with that account's directory as `CLAUDE_CONFIG_DIR`, a Codex tab with
//! that account's managed home as `CODEX_HOME`; what would outrank the
//! account is unset; the session's terminals carry the same variables;
//! folder trust goes in the account's `.claude.json`; the provider sandbox
//! check reads the account's settings. A tab that asks for nothing, or a
//! runtime that predates accounts, starts on This Mac's login as before.
//!
//! Real panes and stand-ins for the CLIs that write down what they were
//! given, as in `session_agent_key_tests`. One rig per test, each with its
//! own session id: an agent from one test exiting late must not write into
//! the next one's store.
use crate::paths::Canonical;
#[cfg(unix)]
use std::io::{BufRead, BufReader, Write};
use std::time::Duration;

use serde_json::json;

use super::*;
use crate::agent_keys::Agent;

const TAB: &str = "agent";

struct Rig {
    manager: SessionManager,
    session: &'static str,
    dir: tempfile::TempDir,
    checkout: PathBuf,
    _claude: Option<claude::pty::TestProgram>,
    _codex: Option<codex::pty::TestProgram>,
    _home: store::TempHome,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.manager.closing();
        self.manager.terminals.kill_all();
    }
}

fn executable(path: &Path, text: &str) {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, text).unwrap();
    #[cfg(unix)]
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// Writes, once, what it ran with: its arguments, and each variable an
/// account launch sets or unsets, as `NAME=value` (empty when unset).
const RECORD: &str = r#"{ printf 'ARGS=%s\n' "$*"; for name in CLAUDE_CONFIG_DIR CODEX_HOME CLAUDE_SECURESTORAGE_CONFIG_DIR; do printf '%s=%s\n' "$name" "$(printenv "$name")"; done; } > "$0.tmp" && mv "$0.tmp" "$0.env""#;

impl Rig {
    /// A session `session` with one `harness` tab, whose CLI is a stand-in.
    fn new(session: &'static str, harness: &str) -> Self {
        let home = store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join(harness);
        let (claude, codex) = match harness {
            "claude" => {
                executable(&program, &format!("#!/bin/sh\n{RECORD}\nprintf 'ready\\n'\nstty -icanon\nexec cat\n"));
                (Some(claude::pty::claude_program_for_tests(program.clone())), None)
            }
            _ => {
                #[cfg(unix)]
                let launcher = {
                    executable(&program, &format!(r#"#!/bin/sh
case "$1" in
  --help) printf '  --no-daemon  Run without the daemon\n'; exit 0;;
  app-server) exit 0;;
esac
{RECORD}
stty raw -echo
exec cat
"#));
                    program.clone()
                };
                // Codex is asked things directly as well as launched in a pane: on
                // Windows the stand-in has the shape npm installs, a `.cmd` starting node.
                #[cfg(windows)]
                let launcher = {
                    std::fs::write(program.with_extension("js"), r#"
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--help") { console.log("  --no-daemon  Run without the daemon"); process.exit(0); }
if (args[0] === "app-server") process.exit(0);
const names = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_SECURESTORAGE_CONFIG_DIR"];
const record = process.argv[1].replace(/\.js$/, ".env");
fs.writeFileSync(record + ".tmp", [`ARGS=${args.join(" ")}`, ...names.map((name) => `${name}=${process.env[name] ?? ""}`)].join("\n") + "\n");
fs.renameSync(record + ".tmp", record);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (data) => process.stdout.write(data));
"#).unwrap();
                    let launcher = program.with_extension("cmd");
                    std::fs::write(&launcher, "@ECHO off\r\nSET dp0=%~dp0\r\nnode \"%dp0%\\codex.js\" %*\r\n").unwrap();
                    launcher
                };
                (None, Some(codex::pty::codex_program_for_tests(launcher)))
            }
        };
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
        let checkout = checkout.canonical().unwrap();
        let entry = json!({
            "id": session, "projectPath": checkout, "cwd": checkout, "title": "Accounts",
            "created": index::now(), "modified": index::now(),
            "tabs": [{ "id": TAB, "harness": harness, "permissionMode": "default", "created": index::now() }],
        });
        index::save(&[serde_json::from_value(entry).unwrap()]).unwrap();
        Self { manager, session, dir, checkout, _claude: claude, _codex: codex, _home: home }
    }

    fn program(&self, harness: &str) -> PathBuf {
        self.dir.path().join(harness)
    }

    /// What the stand-in for `harness` last ran with, once it has.
    fn ran(&self, harness: &str) -> HashMap<String, String> {
        let path = self.program(harness).with_extension("env");
        wait("the agent to start", || path.is_file());
        std::fs::read_to_string(&path).unwrap().lines().filter_map(|line| line.split_once('=')).map(|(name, value)| (name.to_string(), value.to_string())).collect()
    }

    fn start(&self, harness: &str) -> HashMap<String, String> {
        let _ = std::fs::remove_file(self.program(harness).with_extension("env"));
        self.manager.ensure_started(self.session, TAB).unwrap();
        self.ran(harness)
    }

    fn stop(&self) {
        self.manager.stop(self.session, TAB).unwrap();
        wait("the agent to stop", || !self.manager.is_running(self.session, TAB));
    }

    fn tab(&self) -> TabEntry {
        index::get(self.session).unwrap().tab(TAB).unwrap().clone()
    }

    fn checkout(&self) -> &str {
        self.checkout.to_str().unwrap()
    }
}

fn wait(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(60);
    while !done() {
        assert!(Instant::now() < deadline, "never happened: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// An added subscription account of `agent`, signed in as `email`, its
/// directory made as sign-in leaves it.
fn added_account(agent: Agent, email: &str) -> String {
    let store = crate::agent_keys::store().unwrap();
    let id = crate::agent_accounts::new_id();
    let dir = crate::agent_accounts::account_dir(&store.root, agent, &id);
    match agent {
        Agent::Claude => crate::agent_accounts::create_private(&dir).unwrap(),
        Agent::Codex => crate::agent_accounts::prepare_codex_dir(&dir).unwrap(),
    }
    let identity = crate::agent_accounts::Identity { email: Some(email.into()), plan: Some("Max".into()), ..Default::default() };
    assert_eq!(crate::agent_accounts::add_signed_in(&store, agent, &id, &identity, None, false).unwrap(), crate::agent_accounts::Added::New(id.clone()));
    id
}

fn account_dir(agent: Agent, id: &str) -> PathBuf {
    crate::agent_accounts::account_dir(&store::root().unwrap(), agent, id)
}

/// The tab's `name` field among those a build without accounts keeps unread.
fn field<'t>(tab: &'t TabEntry, name: &str) -> Option<&'t str> {
    tab.unknown.get(name).and_then(Value::as_str)
}

fn running_account(harness: &str, session: &str) -> Option<String> {
    crate::agent_keys::running(harness).into_iter().find(|tab| tab.session_id == session).and_then(|tab| tab.account)
}

/// A variable that would point Claude Code's Keychain lookup at another
/// directory, in this process and so in every pane it starts. Only account
/// launches unset it. Set once, before any test here reads it.
fn outranking() {
    static SET: std::sync::Once = std::sync::Once::new();
    SET.call_once(|| std::env::set_var("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/outranks/the/account"));
}

/// What a variable is in this process: what a tab on This Mac's login is left.
fn ours(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

#[test]
fn a_claude_tab_on_an_added_account_runs_in_its_directory_trusts_there_and_switches_back() {
    let rig = Rig::new("account-claude", "claude");
    outranking();
    let account = added_account(Agent::Claude, "ada@example.com");
    let dir = account_dir(Agent::Claude, &account);

    // A tab added on the account: the request's path, as the window takes it.
    let tab = rig.manager.add_tab_on(rig.session, &crate::session_ops::NewTab { harness: "claude".into(), transport: Default::default(), model: String::new(), effort: None, permission_mode: None }, Some(&account)).unwrap();
    assert_eq!(field(&tab, "account"), Some(account.as_str()));
    // The first tab asks the same way, which is what the launch reads.
    index::update_tab(rig.session, TAB, |t| {
        crate::session_ops::set_tab_account(t, Some(&account));
        Ok(())
    }).unwrap();

    let ran = rig.start("claude");
    assert_eq!(ran["CLAUDE_CONFIG_DIR"], dir.to_string_lossy(), "the CLI runs in the account's directory");
    assert_eq!(ran["CLAUDE_SECURESTORAGE_CONFIG_DIR"], "", "what would outrank the account is unset");
    assert_eq!(running_account("claude", rig.session).as_deref(), Some(account.as_str()), "the launch is recorded on its account");
    let tab = rig.tab();
    assert_eq!(field(&tab, "launchedAccount"), Some(account.as_str()));
    let provider_id = tab.provider_session_id.clone().expect("the conversation has its id");

    // Trust in the account's own `.claude.json`, not the person's.
    let config: Value = serde_json::from_slice(&std::fs::read(dir.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(config["projects"][rig.checkout()]["hasTrustDialogAccepted"], true);
    let person = PathBuf::from(store::state_home_env().unwrap()).join("test-user-home/.claude.json");
    let theirs: Value = std::fs::read(&person).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    assert!(theirs["projects"][rig.checkout()].is_null(), "the person's config is not given the account's trust");

    // The conversation is followed where this CLI writes it.
    {
        let rt = rig.manager.runtime(rig.session, TAB).unwrap();
        let rt = rt.lock().unwrap();
        let Engine::Cli(cli) = &rt.engine else { panic!("a CLI runs") };
        assert!(cli.origin.transcript_root.starts_with(dir.join("projects")), "{:?}", cli.origin.transcript_root);
    }

    // The provider sandbox check reads the account's settings first.
    let (claude_dir, codex_home) = account_dirs(CliKind::Claude, Some(&tab));
    assert_eq!((claude_dir.as_deref(), codex_home), (Some(dir.as_path()), None));
    let sources = crate::harness::provider_sandbox::Sources::from_env_on(None, Some(&dir), None);
    assert_eq!(sources.claude_config.first(), Some(&dir));
    // `settings.local.json` is the account's own; `settings.json` is the person's, linked.
    std::fs::write(dir.join("settings.local.json"), r#"{"sandbox":{"enabled":true}}"#).unwrap();
    assert!(provider_may_restrict(CliKind::Claude, rig.session, TAB, &rig.checkout, None), "the account's sandbox counts");

    // Switch account: back to This Mac's login, the same conversation.
    let _ = std::fs::remove_file(rig.program("claude").with_extension("env"));
    assert!(rig.manager.switch_account(rig.session, TAB, crate::agent_accounts::LOCAL).unwrap(), "a running agent is restarted");
    let ran = rig.ran("claude");
    assert_eq!(ran["CLAUDE_CONFIG_DIR"], ours("CLAUDE_CONFIG_DIR"), "This Mac's login: the variable is left as it was");
    assert!(ran["ARGS"].contains(&provider_id), "it goes on with the same conversation: {}", ran["ARGS"]);
    let tab = rig.tab();
    assert_eq!(field(&tab, "account"), Some(crate::agent_accounts::LOCAL));
    assert_eq!(field(&tab, "launchedAccount"), Some(crate::agent_accounts::LOCAL));
    assert_eq!(running_account("claude", rig.session).as_deref(), Some(crate::agent_accounts::LOCAL));

    // An account the agent does not list is refused, and changes nothing.
    assert!(rig.manager.switch_account(rig.session, TAB, "0123456789abcdef").is_err());
    assert!(rig.manager.switch_account(rig.session, TAB, "../elsewhere").is_err());
    assert_eq!(field(&rig.tab(), "account"), Some(crate::agent_accounts::LOCAL));
    rig.stop();
}

#[test]
fn a_codex_tab_on_an_added_account_runs_in_its_managed_home() {
    let rig = Rig::new("account-codex", "codex");
    let account = added_account(Agent::Codex, "ada@example.com");
    index::update_tab(rig.session, TAB, |t| {
        crate::session_ops::set_tab_account(t, Some(&account));
        Ok(())
    }).unwrap();
    let root = store::root().unwrap();
    let (login, home) = codex::home::account_paths(&root, &account);

    let ran = rig.start("codex");
    assert_eq!(ran["CODEX_HOME"], home.to_string_lossy(), "Codex runs in the account's managed home");
    assert_eq!(std::fs::read_link(home.join("auth.json")).unwrap(), login.join("auth.json"), "signed in as the account");
    assert_eq!(std::fs::read_link(home.join("sessions")).unwrap(), root.join("codex/sessions"), "its conversations are shared");
    assert_eq!(running_account("codex", rig.session).as_deref(), Some(account.as_str()));
    assert_eq!(field(&rig.tab(), "launchedAccount"), Some(account.as_str()));
    {
        let rt = rig.manager.runtime(rig.session, TAB).unwrap();
        let rt = rt.lock().unwrap();
        let Engine::Cli(cli) = &rt.engine else { panic!("a CLI runs") };
        assert_eq!(cli.origin.transcript_root, home.join("sessions"));
    }
    // Its sandbox settings are the account home's.
    let (claude_dir, codex_home) = account_dirs(CliKind::Codex, Some(&rig.tab()));
    assert_eq!((claude_dir, codex_home.as_deref()), (None, Some(home.as_path())));
    rig.stop();
}

#[test]
fn terminal_tabs_of_a_session_carry_its_accounts_variables() {
    let rig = Rig::new("account-terminal", "claude");
    let claude = added_account(Agent::Claude, "ada@example.com");
    let codex = added_account(Agent::Codex, "ada@example.com");
    let entry = index::get(rig.session).unwrap();
    assert!(crate::session_ops::session_account_env(&entry).is_empty(), "on This Mac's login a terminal is what it always was");

    index::update_tab(rig.session, TAB, |t| {
        crate::session_ops::set_tab_account(t, Some(&claude));
        Ok(())
    }).unwrap();
    rig.manager.add_tab_on(rig.session, &crate::session_ops::NewTab { harness: "codex".into(), transport: Default::default(), model: String::new(), effort: None, permission_mode: None }, Some(&codex)).unwrap();
    let claude_dir = account_dir(Agent::Claude, &claude);
    let codex_home = codex::home::account_paths(&store::root().unwrap(), &codex).1;

    let out = rig.dir.path().join("terminal.env");
    // A terminal runs the reader's shell: on Windows PowerShell, or the Git Bash it was started from.
    let shell = crate::pty::shell().to_lowercase();
    let command = if cfg!(windows) && (shell.contains("powershell") || shell.contains("pwsh")) {
        format!("Set-Content -LiteralPath '{0}.tmp' -Value @($env:CLAUDE_CONFIG_DIR, $env:CODEX_HOME); Move-Item -LiteralPath '{0}.tmp' -Destination '{0}'", out.display())
    } else if cfg!(windows) {
        format!("printf '%s\\n%s\\n' \"$CLAUDE_CONFIG_DIR\" \"$CODEX_HOME\" > '{0}.tmp' && mv '{0}.tmp' '{0}'", out.display())
    } else {
        format!("/bin/sh -c 'printf \"%s\\n%s\\n\" \"$CLAUDE_CONFIG_DIR\" \"$CODEX_HOME\" > {}.tmp && mv {0}.tmp {0}'", out.display())
    };
    let sink = rig.manager.sink();
    crate::local_runtime::calls::execute(&rig.manager, sink, "runtime.pty.spawn", json!({
        "id": format!("{}:shell-1", rig.session), "cwd": rig.checkout(), "cols": 80, "rows": 24, "command": command,
    })).unwrap();
    wait("the terminal's command to run", || out.is_file());
    let seen = std::fs::read_to_string(&out).unwrap();
    let lines: Vec<&str> = seen.lines().collect();
    assert_eq!(lines, [claude_dir.to_str().unwrap(), codex_home.to_str().unwrap()], "a hand-typed claude or codex signs in as the session's tabs do");
}

#[cfg(unix)]
#[test]
fn a_tab_that_asks_for_no_account_starts_on_this_macs_login_as_before() {
    let rig = Rig::new("account-none", "claude");
    outranking();
    // An added account that is not the default changes nothing for it.
    let _other = added_account(Agent::Claude, "ada@example.com");
    let before = rig.tab();

    let ran = rig.start("claude");
    assert_eq!(ran["CLAUDE_CONFIG_DIR"], ours("CLAUDE_CONFIG_DIR"));
    assert_eq!(ran["CLAUDE_SECURESTORAGE_CONFIG_DIR"], ours("CLAUDE_SECURESTORAGE_CONFIG_DIR"), "nothing is unset for This Mac's login");
    assert_eq!(running_account("claude", rig.session).as_deref(), Some(crate::agent_accounts::LOCAL));
    let tab = rig.tab();
    assert_eq!(field(&tab, "account"), None);
    assert_eq!(field(&tab, "launchedAccount"), None, "nothing is written for This Mac's login");
    assert_eq!(tab.unknown, before.unknown);
    assert!(crate::agent_keys::running("claude").into_iter().find(|tab| tab.session_id == rig.session).unwrap().current, "counted as on the login new tabs get");
    // Trust where it always went.
    let person = PathBuf::from(store::state_home_env().unwrap()).join("test-user-home/.claude.json");
    let config: Value = serde_json::from_slice(&std::fs::read(person).unwrap()).unwrap();
    assert_eq!(config["projects"][rig.checkout()]["hasTrustDialogAccepted"], true);
    assert_eq!(account_dirs(CliKind::Claude, Some(&tab)), (None, None));
    assert!(crate::session_ops::session_account_env(&index::get(rig.session).unwrap()).is_empty());
    rig.stop();
}

// The control socket is a Unix socket here; Windows has its own pipe, tested with it.
#[cfg(unix)]
/// An owner on `socket` that answers each request with `answer`.
fn owner(socket: &Path, answer: impl Fn(&crate::control::ControlRequest) -> crate::control::ControlResponse + Send + Sync + 'static) -> Arc<Mutex<Vec<Value>>> {
    let listener = std::os::unix::net::UnixListener::bind(socket).unwrap();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let seen = asked.clone();
    let answer = Arc::new(answer);
    std::thread::spawn(move || for stream in listener.incoming().flatten() {
        let (seen, answer) = (seen.clone(), answer.clone());
        std::thread::spawn(move || {
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap()).read_line(&mut line).unwrap();
            let request: crate::control::ControlRequest = serde_json::from_str(&line).unwrap();
            seen.lock().unwrap().push(json!({"command": request.command, "params": request.params}));
            let _ = writeln!(&stream, "{}", serde_json::to_string(&answer(&request)).unwrap());
        });
    });
    asked
}

/// A desktop's session adapter for the owner at `dir/unused.sock`.
#[cfg(unix)]
fn desktop(dir: &Path) -> crate::local_runtime::sessions::Sessions {
    crate::local_runtime::sessions::Sessions::new(crate::local_runtime::client::Client::for_stream(dir.join("events.sock"), "token", "epoch"))
}

#[cfg(unix)]
fn new_session(checkout: &Path) -> crate::session_ops::NewSession {
    crate::session_ops::NewSession {
        parent: None, section_id: None, project_path: checkout.to_string_lossy().into_owned(), title: None, use_worktree: false,
        worktree_name: None, base_ref: None, checkout_branch: None, checkout_pr: None, on_main: true, issue: None, automation: None, cwd: None,
        tab: Some(crate::session_ops::NewTab { harness: "claude".into(), transport: Default::default(), model: String::new(), effort: None, permission_mode: None }),
        orchestrate: false,
    }
}

#[cfg(unix)]
#[test]
fn an_older_runtime_starts_the_tab_on_this_macs_login_and_the_desktop_says_so() {
    let _home = store::temp_home();
    let account = added_account(Agent::Claude, "ada@example.com");
    let dir = tempfile::tempdir().unwrap();
    let checkout = dir.path().join("checkout");
    std::fs::create_dir(&checkout).unwrap();

    // A runtime from before accounts: no such operation, and a create that
    // reads the request as it knew it.
    let old = dir.path().join("old");
    std::fs::create_dir(&old).unwrap();
    let asked = owner(&old.join("unused.sock"), |request| match request.command.as_str() {
        "runtime.session.create" => {
            let req: crate::session_ops::NewSession = serde_json::from_value(request.params["req"].clone()).unwrap();
            let entry = crate::session_ops::create_session_blocking(&crate::sink::BroadcastSink::new(8), req).unwrap();
            crate::control::ControlResponse::success(request.id.clone(), serde_json::to_value(entry).unwrap())
        }
        _ => crate::control::ControlResponse::failure(request.id.clone(), crate::control::ControlError::internal("unsupported local session operation")),
    });
    let sessions = desktop(&old);
    assert!(!sessions.supports_accounts().unwrap());
    let entry = sessions.create_on(&new_session(&checkout), Some(&account)).unwrap();
    let tab = &entry.tabs[0];
    assert_eq!(field(tab, crate::session_ops::TAB_ACCOUNT_FALLBACK), Some("olderRuntime"), "the window is told");
    assert_eq!(field(tab, "account"), None);
    let saved = index::get(&entry.id).unwrap();
    assert!(saved.tabs[0].unknown.is_empty(), "an older runtime saves the tab as it always did, so it starts on This Mac's login");
    let error = sessions.switch_account(&entry.id, &tab.id, &account).unwrap_err();
    assert_eq!(error.to_string(), crate::platform_profile::localize(crate::local_runtime::sessions::OLDER_RUNTIME));
    assert!(asked.lock().unwrap().iter().all(|request| request["params"]["req"].get("account").is_none()), "nothing it would misread is sent");

    // This runtime knows accounts: the request carries it to the tab.
    let new = dir.path().join("new");
    std::fs::create_dir(&new).unwrap();
    let rig = Arc::new(SessionManager::new(
        Arc::new(crate::sink::BroadcastSink::new(64)),
        Arc::new(crate::sink::NoObserver),
        Arc::new(Host::new()),
        Arc::new(pty::Terminals::new()),
        Arc::new(Default::default()),
        Arc::new(Default::default()),
        crate::hooks::prepare_control().unwrap(),
    ));
    let manager = rig.clone();
    owner(&new.join("unused.sock"), move |request| {
        let sink = manager.sink();
        match crate::local_runtime::calls::execute(&manager, sink, &request.command, request.params.clone()) {
            Ok(result) => crate::control::ControlResponse::success(request.id.clone(), result),
            Err(error) => crate::control::ControlResponse::failure(request.id.clone(), crate::control::ControlError::internal(error)),
        }
    });
    let sessions = desktop(&new);
    assert!(sessions.supports_accounts().unwrap());
    let entry = sessions.create_on(&new_session(&checkout), Some(&account)).unwrap();
    assert_eq!(field(&entry.tabs[0], "account"), Some(account.as_str()));
    assert_eq!(field(&entry.tabs[0], crate::session_ops::TAB_ACCOUNT_FALLBACK), None);
    assert_eq!(field(&index::get(&entry.id).unwrap().tabs[0], "account"), Some(account.as_str()), "saved with the tab");
    // A request with no account is the request it always was.
    let plain = sessions.create_on(&new_session(&checkout), None).unwrap();
    assert!(plain.tabs[0].unknown.is_empty());
    // An id no account could have is refused before anything is made.
    assert!(crate::session_ops::create_session_blocking_on(&crate::sink::BroadcastSink::new(8), new_session(&checkout), Some("../x")).is_err());
    rig.closing();
}

#[test]
fn a_tabs_usage_and_conversation_are_found_where_its_account_wrote_them() {
    let _home = store::temp_home();
    let account = added_account(Agent::Claude, "ada@example.com");
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("checkout");
    std::fs::create_dir(&cwd).unwrap();
    let cwd = cwd.canonical().unwrap();
    let conversation = "33333333-3333-4333-8333-333333333333";
    // Written in the account's own `projects`, which is not the person's.
    let folder = account_dir(Agent::Claude, &account).join("projects").join(claude::transcript::encoded_cwd(&cwd.to_string_lossy()));
    std::fs::create_dir_all(&folder).unwrap();
    let transcript = folder.join(format!("{conversation}.jsonl"));
    std::fs::write(&transcript, include_str!("harness/claude/fixtures/interactive_session.jsonl")).unwrap();
    let entry = json!({
        "id": "account-usage", "projectPath": cwd, "cwd": cwd, "title": "Usage",
        "created": index::now(), "modified": index::now(),
        "tabs": [{ "id": TAB, "harness": "claude", "permissionMode": "default", "created": index::now(), "providerSessionId": conversation }],
    });
    index::save(&[serde_json::from_value(entry).unwrap()]).unwrap();

    // On This Mac's login the person's folder holds nothing of it.
    let local = crate::session_usage::read_tab(&cwd.to_string_lossy(), &index::get("account-usage").unwrap().tabs[0], &crate::session_usage::AgentHomes(&index::get("account-usage").unwrap().tabs[0]));
    assert!(local.as_ref().is_none_or(|usage| usage.models.is_empty()), "{local:?}");

    index::update_tab("account-usage", TAB, |t| {
        crate::session_ops::set_tab_account(t, Some(&account));
        Ok(())
    }).unwrap();
    let tab = index::get("account-usage").unwrap().tabs[0].clone();
    assert_eq!(crate::agent_data::locate_claude(&tab, &cwd.to_string_lossy(), conversation), Some(transcript.clone()));
    let updated = crate::session_usage::refresh_tab("account-usage", TAB).unwrap().expect("the account's transcript is read");
    let usage = updated.tabs[0].usage.as_ref().expect("usage kept on the tab");
    assert!(!usage.models.is_empty(), "{usage:?}");
}

#[test]
fn the_cli_names_an_account_by_id_or_label_and_never_guesses() {
    let _home = store::temp_home();
    let ada = added_account(Agent::Claude, "ada@example.com");
    let grace = added_account(Agent::Claude, "grace@example.com");
    let resolve = |selector: &str| crate::control::resolve_account("claude", selector);
    assert_eq!(resolve(&ada).unwrap(), ada);
    // The default label is "email · plan"; case does not matter.
    assert_eq!(resolve("GRACE@example.com · Max").unwrap(), grace);
    assert_eq!(resolve("local").unwrap(), crate::agent_accounts::LOCAL);
    assert_eq!(resolve(&crate::platform_profile::localize("this Mac's login")).unwrap(), crate::agent_accounts::LOCAL);
    let unknown = resolve("nobody").unwrap_err();
    assert!(unknown.message.contains(&ada) && unknown.message.contains(&grace), "the accounts are listed by id and label: {}", unknown.message);
    assert!(resolve("  ").is_err());
    assert!(crate::control::resolve_account("opencode", "local").is_err(), "an agent without accounts has none to choose");
}
