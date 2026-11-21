//! Agent accounts (#980): the index, the directories, adding, removing.
//! Sign-ins run real processes: stand-ins for `claude` and `codex` that
//! write a login where the real ones do.

use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};

use super::*;
use crate::agent_keys::{Agent, Store};
use crate::keychain::testing::MemorySecrets;

#[cfg(unix)]
const TOKEN: &str = "sk-ant-oat01-ThisIsTheAccountsOwnAccessToken-0123456789";
#[cfg(unix)]
const REFRESH: &str = "sk-ant-ort01-ThisIsTheAccountsRefreshToken-9876543210";

fn store<'a>(root: &Path, secrets: &'a MemorySecrets) -> Store<'a> {
    Store::new(root.to_path_buf(), secrets)
}

#[cfg(unix)]
fn everything_under(root: &Path) -> String {
    let mut text = String::new();
    for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let path = entry.path();
        let meta = std::fs::symlink_metadata(&path).unwrap();
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            text.push_str(&everything_under(&path));
        } else {
            text.push_str(&String::from_utf8_lossy(&std::fs::read(&path).unwrap_or_default()));
        }
    }
    text
}

/// What the agent's own logout and Keychain deletion were asked to do, and
/// in which order, and what was in the directory when logout ran.
#[derive(Default)]
struct Recorded {
    calls: Mutex<Vec<String>>,
}

impl SignOut for Recorded {
    fn logout(&self, agent: Agent, dir: &Path) -> Result<()> {
        assert!(dir.is_dir(), "logout runs before the directory goes");
        self.calls.lock().unwrap().push(format!("logout {} {}", agent.id(), dir.display()));
        // As the agent's own logout does: the login is gone from the directory.
        let _ = std::fs::remove_file(dir.join(".credentials.json"));
        let _ = std::fs::remove_file(dir.join("auth.json"));
        Ok(())
    }

    fn forget_item(&self, service: &str) -> Result<()> {
        self.calls.lock().unwrap().push(format!("forget {service}"));
        Ok(())
    }
}

/// The person's own Claude Code configuration, in a scratch home.
#[cfg(unix)]
fn person(root: &Path) -> claude_dir::Person {
    let home = root.join("home");
    let person = claude_dir::Person::in_home(&home);
    std::fs::create_dir_all(person.dir.join("skills/review")).unwrap();
    std::fs::create_dir_all(person.dir.join("projects/-work-repo")).unwrap();
    std::fs::create_dir_all(person.dir.join("commands")).unwrap();
    std::fs::write(person.dir.join("settings.json"), r#"{"model":"opus"}"#).unwrap();
    std::fs::write(person.dir.join("CLAUDE.md"), "be brief").unwrap();
    std::fs::write(&person.claude_json, json!({
        "oauthAccount": { "emailAddress": "ada@example.com", "organizationUuid": "org-ada" },
        "mcpServers": { "docs": { "type": "http", "url": "https://docs.example/mcp" } },
        "projects": { "/work/repo": { "hasTrustDialogAccepted": true } },
    }).to_string()).unwrap();
    person
}

/// Write what Claude Code writes into a directory it signed in to.
#[cfg(unix)]
fn claude_signs_in(dir: &Path, email: &str, organization: &str) {
    std::fs::write(dir.join(".credentials.json"), json!({ "claudeAiOauth": { "accessToken": TOKEN, "refreshToken": REFRESH, "expiresAt": 4_000_000_000_000i64 } }).to_string()).unwrap();
    let path = dir.join(".claude.json");
    let mut file: Value = std::fs::read_to_string(&path).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_else(|| json!({}));
    file["oauthAccount"] = json!({ "emailAddress": email, "organizationType": "claude_pro", "organizationName": "Bo's", "organizationUuid": organization });
    std::fs::write(&path, file.to_string()).unwrap();
}

// ------------------------------------------------------------------ the index

#[test]
fn a_file_from_before_accounts_loads_as_this_macs_login_alone_and_keeps_what_it_does_not_know() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = MemorySecrets::default();
    let store = store(dir.path(), &secrets);
    // As PRO-306 wrote it, with what a newer build might add.
    let before = json!({
        "claude": { "mode": "subscription", "shellOffer": "dismissed", "fromTheFuture": { "a": 1 } },
        "codex": { "mode": "api_key", "key": { "revision": "r-1", "savedAt": "2026-11-01T00:00:00Z" }, "baseUrl": "https://llm.example.com/v1" },
        "opencode": { "mode": "default" },
        "version": 7,
    });
    std::fs::write(dir.path().join("agent-logins.json"), serde_json::to_string_pretty(&before).unwrap()).unwrap();

    let claude = list_in(&store, Agent::Claude).unwrap();
    assert_eq!(claude.accounts.iter().map(|account| account.id.as_str()).collect::<Vec<_>>(), [LOCAL]);
    assert_eq!(claude.default_account, LOCAL);
    assert_eq!(claude.accounts[0].label, "This Mac's login");
    let codex = list_in(&store, Agent::Codex).unwrap();
    assert_eq!(codex.accounts.iter().map(|account| (account.id.as_str(), account.kind)).collect::<Vec<_>>(), [(LOCAL, Kind::Subscription), (SAVED_KEY, Kind::ApiKey)]);
    assert_eq!(codex.default_account, SAVED_KEY, "the key in use is still the default");
    assert!(codex.project_defaults.is_empty());

    // Reading changes nothing on disk.
    let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("agent-logins.json")).unwrap()).unwrap();
    assert_eq!(on_disk, before);

    // A save keeps every field it does not know, at every level.
    relabel_in(&store, Agent::Codex, SAVED_KEY, "Company key").unwrap();
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("agent-logins.json")).unwrap()).unwrap();
    assert_eq!(saved["version"], 7);
    assert_eq!(saved["opencode"], json!({ "mode": "default" }));
    assert_eq!(saved["codex"]["baseUrl"], "https://llm.example.com/v1");
    assert_eq!(saved["codex"]["key"]["revision"], "r-1");
    assert_eq!(saved["codex"]["mode"], "api_key");
    assert_eq!(saved["codex"]["keyLabel"], "Company key");
    assert_eq!(saved["claude"], json!({ "mode": "subscription", "shellOffer": "dismissed", "fromTheFuture": { "a": 1 } }));
    set_default_in(&store, Agent::Claude, Some(LOCAL), None).unwrap();
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("agent-logins.json")).unwrap()).unwrap();
    assert_eq!(saved["claude"]["fromTheFuture"], json!({ "a": 1 }));
    assert_eq!(saved["claude"]["defaultAccount"], LOCAL);
}

#[test]
fn no_file_at_all_is_this_macs_login_alone() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = MemorySecrets::default();
    let store = store(dir.path(), &secrets);
    for agent in Agent::ALL {
        let view = list_in(&store, agent).unwrap();
        assert_eq!(view.accounts.len(), 1);
        assert!(view.accounts[0].local && view.accounts[0].is_default);
    }
    assert!(!dir.path().join("agent-logins.json").exists(), "listing writes nothing");
}

#[test]
fn defaults_per_agent_and_per_project_and_labels() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = MemorySecrets::default();
    let store = store(dir.path(), &secrets);
    let identity = Identity { email: Some("bo@example.com".into()), plan: Some("Pro".into()), ..Default::default() };
    let id = new_id();
    create_private(&account_dir(dir.path(), Agent::Claude, &id)).unwrap();
    add_signed_in(&store, Agent::Claude, &id, &identity, None, false).unwrap();

    let view = list_in(&store, Agent::Claude).unwrap();
    let added = view.accounts.iter().find(|account| account.id == id).unwrap();
    assert_eq!(added.label, "bo@example.com · Pro", "the default label is email · plan");
    assert!(!added.missing);
    relabel_in(&store, Agent::Claude, &id, "  Personal  ").unwrap();
    assert_eq!(account_in(&store, Agent::Claude, &id).unwrap().unwrap().label, "Personal");
    relabel_in(&store, Agent::Claude, &id, "").unwrap();
    assert_eq!(account_in(&store, Agent::Claude, &id).unwrap().unwrap().label, "bo@example.com · Pro", "an empty label goes back to the default");
    assert!(relabel_in(&store, Agent::Claude, LOCAL, "Mine").is_err());
    assert!(relabel_in(&store, Agent::Claude, &id, "two\nlines").is_err());

    set_default_in(&store, Agent::Claude, Some(&id), None).unwrap();
    set_default_in(&store, Agent::Claude, Some(LOCAL), Some("project-1")).unwrap();
    let view = list_in(&store, Agent::Claude).unwrap();
    assert_eq!(view.default_account, id);
    assert_eq!(view.project_defaults.get("project-1").map(String::as_str), Some(LOCAL));
    assert_eq!(choose(&store.entry(Agent::Claude).unwrap(), None, Some("project-1")), LOCAL);
    assert_eq!(choose(&store.entry(Agent::Claude).unwrap(), None, Some("project-2")), id);
    assert_eq!(choose(&store.entry(Agent::Claude).unwrap(), Some(LOCAL), None), LOCAL);
    set_default_in(&store, Agent::Claude, None, Some("project-1")).unwrap();
    assert!(list_in(&store, Agent::Claude).unwrap().project_defaults.is_empty());
    assert!(set_default_in(&store, Agent::Claude, Some("nobody00"), None).is_err());
    // Another agent's defaults are its own.
    assert_eq!(list_in(&store, Agent::Codex).unwrap().default_account, LOCAL);

    // Deleted outside the app: listed, and says so.
    std::fs::remove_dir_all(account_dir(dir.path(), Agent::Claude, &id)).unwrap();
    assert!(account_in(&store, Agent::Claude, &id).unwrap().unwrap().missing);
}

// -------------------------------------------------------- Claude's directory

#[cfg(unix)]
#[test]
fn a_claude_account_directory_shares_the_persons_files_and_has_its_own_claude_json() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let person = person(dir.path());
    let before = everything_under(&person.dir) + &std::fs::read_to_string(&person.claude_json).unwrap();
    let account = account_dir(&dir.path().join("terminalx"), Agent::Claude, "aaaa1111");
    claude_dir::prepare(&account, &person).unwrap();

    assert_eq!(std::fs::metadata(&account).unwrap().permissions().mode() & 0o777, 0o700);
    for name in ["settings.json", "CLAUDE.md", "skills", "commands", "agents", "plugins", "projects"] {
        assert_eq!(std::fs::read_link(account.join(name)).unwrap(), person.dir.join(name), "{name}");
    }
    // `agents` and `plugins` do not exist yet: linked anyway, so the first write lands in the shared place.
    assert!(!person.dir.join("agents").exists() && std::fs::symlink_metadata(account.join("agents")).is_ok());
    // A transcript written under the account is in the person's projects.
    std::fs::write(account.join("projects/-work-repo/conversation.jsonl"), "{}\n").unwrap();
    assert!(person.dir.join("projects/-work-repo/conversation.jsonl").is_file());

    let own: Value = serde_json::from_str(&std::fs::read_to_string(account.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(own, json!({ "mcpServers": { "docs": { "type": "http", "url": "https://docs.example/mcp" } } }), "the MCP servers and nothing else of the person's");
    assert!(std::fs::symlink_metadata(account.join(".claude.json")).unwrap().file_type().is_file(), "its own file, not a link");

    // Signed in, and the person's servers changed: mirrored again, the login kept.
    claude_signs_in(&account, "bo@example.com", "org-bo");
    let mut theirs: Value = serde_json::from_str(&std::fs::read_to_string(&person.claude_json).unwrap()).unwrap();
    theirs["mcpServers"]["tracker"] = json!({ "command": "tracker-mcp" });
    std::fs::write(&person.claude_json, theirs.to_string()).unwrap();
    claude_dir::prepare(&account, &person).unwrap();
    let own: Value = serde_json::from_str(&std::fs::read_to_string(account.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(own["mcpServers"]["tracker"]["command"], "tracker-mcp");
    assert_eq!(own["oauthAccount"]["emailAddress"], "bo@example.com");

    // Nothing was written into the person's directory but the transcript.
    let after = everything_under(&person.dir) + &std::fs::read_to_string(&person.claude_json).unwrap().replace(r#","tracker":{"command":"tracker-mcp"}"#, "");
    assert_eq!(after.replace("{}\n", ""), before.replace("{}\n", ""));
    assert!(!person.dir.join(".credentials.json").exists());
}

#[test]
fn the_keychain_entry_of_a_directory_is_never_the_persons_own() {
    let service = claude_dir::keychain_service(Path::new("/Users/ada/.raccoon/agent-accounts/claude/aaaa1111")).unwrap();
    assert!(service.starts_with("Claude Code-credentials-") && service.len() == "Claude Code-credentials-".len() + 8, "{service}");
    assert_ne!(claude_dir::keychain_service(Path::new("/Users/ada/.raccoon/agent-accounts/claude/bbbb2222")).unwrap(), service);
    // The probe's rule: the first 8 hex of sha256 of the directory as given.
    use sha2::{Digest, Sha256};
    let expected = format!("Claude Code-credentials-{}", &format!("{:x}", Sha256::digest(b"/tmp/x"))[..8]);
    assert_eq!(claude_dir::keychain_service(Path::new("/tmp/x")).unwrap(), expected);
}

// ------------------------------------------------------- adding and removing

/// A stand-in `claude` for `auth login` / `auth logout`: it signs in as
/// `$FAKE_EMAIL` into `$CLAUDE_CONFIG_DIR` and records what it was given.
#[cfg(all(unix, feature = "desktop"))]
fn fake_claude(dir: &Path, email: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join(format!("claude-{}", email.replace('@', "-at-")));
    std::fs::write(&script, format!(r#"#!/bin/sh
echo "$* $CLAUDE_CONFIG_DIR ${{ANTHROPIC_API_KEY:-none}}" >> '{record}'
case "$1 $2" in
  "auth login")
    echo "Opening browser to sign in…"
    echo "If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&state=abc"
    sleep 0.3
    printf '%s' '{{"claudeAiOauth":{{"accessToken":"{TOKEN}","refreshToken":"{REFRESH}","expiresAt":4000000000000}}}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"
    printf '%s' '{{"oauthAccount":{{"emailAddress":"{email}","organizationType":"claude_pro","organizationUuid":"org-1"}}}}' > "$CLAUDE_CONFIG_DIR/.claude.json"
    echo "Login successful." ;;
  "auth logout") rm -f "$CLAUDE_CONFIG_DIR/.credentials.json" "$CLAUDE_CONFIG_DIR/.claude.json" ;;
esac
"#, record = dir.join("record").display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script
}

#[cfg(all(unix, feature = "desktop"))]
fn settle(store: &Store<'_>, attempt: &str, sign_out: &dyn SignOut, local: &Identity) -> Finished {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let finished = login::finish_in(store, attempt, |_| local.clone(), sign_out).unwrap();
        if finished != Finished::Waiting || std::time::Instant::now() > deadline {
            return finished;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

#[cfg(all(unix, feature = "desktop"))]
#[test]
fn adding_runs_the_agents_own_login_in_a_new_directory_and_the_same_email_is_not_added_twice() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("terminalx");
    let secrets = MemorySecrets::default();
    let store = store(&root, &secrets);
    let person = person(dir.path());
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let programs = login::Programs { claude: Some(fake_claude(&bin, "bo@example.com")), path_env: "/usr/bin:/bin".into(), ..Default::default() };
    let sign_out = login::Cli { programs: programs.clone() };
    let local = Identity { email: Some("ada@example.com".into()), organization_id: Some("org-ada".into()), ..Default::default() };
    crate::test_log::capture();

    let started = login::start_in(&store, Agent::Claude, None, &programs, Some(&person), &sign_out).unwrap();
    assert_eq!((started.flow, started.again), (login::Flow::Browser, false));
    assert_eq!(started.verification_url.as_deref(), Some("https://claude.ai/oauth/authorize?code=true&state=abc"));
    assert!(started.user_code.is_none());
    let account = account_dir(&root, Agent::Claude, &started.account_id);
    let Finished::Added { account: added } = settle(&store, &started.attempt_id, &sign_out, &local) else { panic!("not added") };
    assert_eq!((added.id.as_str(), added.label.as_str(), added.kind), (started.account_id.as_str(), "bo@example.com · Pro", Kind::Subscription));
    assert!(account.join(".credentials.json").is_file(), "the login stays where the agent wrote it");
    let record = std::fs::read_to_string(bin.join("record")).unwrap();
    assert_eq!(record.lines().next().unwrap(), format!("auth login --claudeai {} none", account.display()), "the login ran in the account's directory, with no key from the environment");

    // The same address again: signed out, its directory deleted, not listed twice.
    let again = login::start_in(&store, Agent::Claude, None, &programs, Some(&person), &sign_out).unwrap();
    let second = account_dir(&root, Agent::Claude, &again.account_id);
    assert!(second.is_dir());
    let Finished::Duplicate { account_id, label } = settle(&store, &again.attempt_id, &sign_out, &local) else { panic!("added twice") };
    assert_eq!((account_id.as_str(), label.as_str()), (started.account_id.as_str(), "bo@example.com · Pro"));
    assert!(!second.exists(), "the duplicate's directory is gone");
    assert!(std::fs::read_to_string(bin.join("record")).unwrap().contains(&format!("auth logout {} none", second.display())), "the agent's own logout ran in the duplicate's directory");
    assert_eq!(list_in(&store, Agent::Claude).unwrap().accounts.len(), 2);
    assert!(account.join(".credentials.json").is_file(), "the first account is untouched");

    // This Mac's own login signed in a second time is not a second account either.
    let mine = login::Programs { claude: Some(fake_claude(&bin, "ada@example.com")), ..programs.clone() };
    let attempt = login::start_in(&store, Agent::Claude, None, &mine, Some(&person), &sign_out).unwrap();
    let local_org = Identity { organization_id: Some("org-1".into()), ..local.clone() };
    let Finished::Duplicate { account_id, .. } = settle(&store, &attempt.attempt_id, &sign_out, &local_org) else { panic!("added This Mac's login") };
    assert_eq!(account_id, LOCAL);

    // Canceled: the CLI stops and the new directory goes.
    let slow = bin.join("claude-slow");
    std::fs::write(&slow, "#!/bin/sh\nsleep 30\n").unwrap();
    std::fs::set_permissions(&slow, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let waiting = login::Programs { claude: Some(slow), ..programs.clone() };
    let attempt = login::start_in(&store, Agent::Claude, None, &waiting, Some(&person), &sign_out).unwrap();
    assert_eq!(login::finish_in(&store, &attempt.attempt_id, |_| local.clone(), &sign_out).unwrap(), Finished::Waiting);
    let pending = account_dir(&root, Agent::Claude, &attempt.account_id);
    assert!(pending.is_dir());
    login::cancel_in(&store, &attempt.attempt_id, &sign_out).unwrap();
    assert!(!pending.exists());
    assert_eq!(list_in(&store, Agent::Claude).unwrap().accounts.len(), 2);

    // No token in the index, and none and no address logged.
    let index = std::fs::read_to_string(root.join("agent-logins.json")).unwrap();
    assert!(!index.contains(TOKEN) && !index.contains(REFRESH) && !index.contains("sk-ant"), "{index}");
    for secret in [TOKEN, REFRESH, "bo@example.com", "oauth/authorize"] {
        assert!(crate::test_log::logged(secret).is_empty(), "{secret} was logged");
    }
}

#[cfg(all(unix, feature = "desktop"))]
#[test]
fn signing_in_again_runs_in_that_accounts_directory_only() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("terminalx");
    let secrets = MemorySecrets::default();
    let store = store(&root, &secrets);
    let person = person(dir.path());
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let programs = login::Programs { claude: Some(fake_claude(&bin, "bo@example.com")), path_env: "/usr/bin:/bin".into(), ..Default::default() };
    let sign_out = Recorded::default();
    let local = Identity::default();
    let started = login::start_in(&store, Agent::Claude, None, &programs, Some(&person), &sign_out).unwrap();
    let Finished::Added { account } = settle(&store, &started.attempt_id, &sign_out, &local) else { panic!() };
    let other = new_id();
    create_private(&account_dir(&root, Agent::Claude, &other)).unwrap();
    claude_signs_in(&account_dir(&root, Agent::Claude, &other), "cy@example.com", "org-cy");
    add_signed_in(&store, Agent::Claude, &other, &identity_of(&root, &other), None, false).unwrap();

    // Signed out meanwhile (expired, or logged out by hand).
    std::fs::remove_file(account_dir(&root, Agent::Claude, &account.id).join(".credentials.json")).unwrap();
    let again = login::start_in(&store, Agent::Claude, Some(&account.id), &programs, Some(&person), &sign_out).unwrap();
    assert!(again.again && again.account_id == account.id);
    let Finished::SignedInAgain { account: back } = settle(&store, &again.attempt_id, &sign_out, &local) else { panic!() };
    assert_eq!(back.id, account.id);
    let logins: Vec<String> = std::fs::read_to_string(bin.join("record")).unwrap().lines().filter(|line| line.starts_with("auth login")).map(str::to_string).collect();
    assert_eq!(logins.last().unwrap(), &format!("auth login --claudeai {} none", account_dir(&root, Agent::Claude, &account.id).display()));
    assert_eq!(identity_of(&root, &other).email.as_deref(), Some("cy@example.com"), "the other account was not touched");
    assert!(login::start_in(&store, Agent::Claude, Some(LOCAL), &programs, Some(&person), &sign_out).is_err(), "This Mac's login signs in with the agent itself");
}

#[cfg(all(unix, feature = "desktop"))]
fn identity_of(root: &Path, id: &str) -> Identity {
    crate::agent_local_login::identity_in("claude", &account_dir(root, Agent::Claude, id))
}

#[cfg(all(unix, feature = "desktop"))]
#[test]
fn removing_an_account_signs_it_out_first_and_deletes_only_its_own_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("terminalx");
    let secrets = MemorySecrets::default();
    let store = store(&root, &secrets);
    let person = person(dir.path());
    let mut ids = Vec::new();
    for (email, org) in [("bo@example.com", "org-bo"), ("cy@example.com", "org-cy")] {
        let id = new_id();
        let account = make_dir(&store, Agent::Claude, &id, Some(&person)).unwrap();
        claude_signs_in(&account, email, org);
        add_signed_in(&store, Agent::Claude, &id, &identity_of(&root, &id), None, false).unwrap();
        ids.push(id);
    }
    let (x, y) = (&ids[0], &ids[1]);
    set_default_in(&store, Agent::Claude, Some(x), None).unwrap();
    set_default_in(&store, Agent::Claude, Some(x), Some("project-1")).unwrap();
    set_default_in(&store, Agent::Claude, Some(y), Some("project-2")).unwrap();
    let codex = new_id();
    make_dir(&store, Agent::Codex, &codex, None).unwrap();
    std::fs::write(account_dir(&root, Agent::Codex, &codex).join("auth.json"), "{}").unwrap();
    let person_before = everything_under(&person.dir) + &std::fs::read_to_string(&person.claude_json).unwrap();
    let x_dir = account_dir(&root, Agent::Claude, x);

    let sign_out = Recorded::default();
    let view = remove_in(&store, Agent::Claude, x, &sign_out).unwrap();
    let calls = sign_out.calls.into_inner().unwrap();
    assert_eq!(calls, vec![format!("logout claude {}", x_dir.display()), format!("forget {}", claude_dir::keychain_service(&x_dir).unwrap())], "logout first, then X's own Keychain entry");
    assert!(!calls.iter().any(|call| call == "forget Claude Code-credentials"));
    assert!(!x_dir.exists(), "X's directory is gone");
    assert_eq!(view.accounts.iter().map(|account| account.id.as_str()).collect::<Vec<_>>(), [LOCAL, y.as_str()]);
    assert_eq!(view.default_account, LOCAL, "a removed default falls back to This Mac's login");
    assert_eq!(view.project_defaults.len(), 1);
    assert_eq!(view.project_defaults.get("project-2"), Some(y));
    // Everything else is as it was: Y, the Codex account, and the person's own files that X linked to.
    assert_eq!(identity_of(&root, y).email.as_deref(), Some("cy@example.com"));
    assert!(account_dir(&root, Agent::Codex, &codex).join("auth.json").is_file());
    assert_eq!(everything_under(&person.dir) + &std::fs::read_to_string(&person.claude_json).unwrap(), person_before);
    assert!(person.dir.join("projects/-work-repo").is_dir() && person.dir.join("skills/review").is_dir());

    assert!(remove_in(&store, Agent::Claude, LOCAL, &Recorded::default()).is_err(), "This Mac's login cannot be removed");
    assert!(remove_in(&store, Agent::Claude, x, &Recorded::default()).is_err(), "already gone");

    // A logout that fails removes nothing.
    struct Refuses;
    impl SignOut for Refuses {
        fn logout(&self, _: Agent, _: &Path) -> Result<()> {
            anyhow::bail!("offline")
        }
        fn forget_item(&self, _: &str) -> Result<()> {
            panic!("nothing is deleted after a failed logout")
        }
    }
    assert!(remove_in(&store, Agent::Claude, y, &Refuses).is_err());
    assert!(account_dir(&root, Agent::Claude, y).is_dir());
    assert!(list_in(&store, Agent::Claude).unwrap().accounts.iter().any(|account| &account.id == y));
}

#[test]
fn removing_a_key_account_deletes_only_its_keychain_item() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = MemorySecrets::default();
    let store = store(dir.path(), &secrets);
    let first = store.add_key_account(Agent::Codex, "sk-proj-first-key-000000000000000000000000", None).unwrap();
    let second = store.add_key_account(Agent::Codex, "sk-proj-second-key-00000000000000000000000", Some("Work".into())).unwrap();
    let revision_of = |id: &str| store.entry(Agent::Codex).unwrap().accounts.iter().find(|account| account.id == id).unwrap().key.clone().unwrap().revision;
    let (kept, gone) = (revision_of(&second), revision_of(&first));
    let view = remove_in(&store, Agent::Codex, &first, &Recorded::default()).unwrap();
    assert_eq!(view.accounts.iter().map(|account| account.label.as_str()).collect::<Vec<_>>(), ["This Mac's login", "Work"]);
    assert!(secrets.stored("dev.terminalx.agent-keys", &format!("codex/{gone}")).is_none());
    assert!(secrets.stored("dev.terminalx.agent-keys", &format!("codex/{kept}")).is_some());
    assert!(!std::fs::read_to_string(dir.path().join("agent-logins.json")).unwrap().contains("second-key"));
}

#[cfg(unix)]
#[test]
fn a_sign_in_the_app_never_saw_end_leaves_a_directory_swept_later() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = MemorySecrets::default();
    let store = store(dir.path(), &secrets);
    let listed = new_id();
    create_private(&account_dir(dir.path(), Agent::Codex, &listed)).unwrap();
    std::fs::write(account_dir(dir.path(), Agent::Codex, &listed).join("auth.json"), "{}").unwrap();
    add_signed_in(&store, Agent::Codex, &listed, &Identity { email: Some("bo@example.com".into()), ..Default::default() }, None, false).unwrap();
    let (old, fresh, open) = (new_id(), new_id(), new_id());
    for id in [&old, &fresh, &open] {
        create_private(&account_dir(dir.path(), Agent::Codex, id)).unwrap();
    }
    let hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 3600);
    for id in [&old, &open, &listed] {
        std::fs::File::open(account_dir(dir.path(), Agent::Codex, id)).unwrap().set_modified(hour_ago).unwrap();
    }
    sweep_unlisted(&store, Agent::Codex, std::slice::from_ref(&open));
    assert!(!account_dir(dir.path(), Agent::Codex, &old).exists());
    for id in [&fresh, &open, &listed] {
        assert!(account_dir(dir.path(), Agent::Codex, id).exists(), "{id}");
    }
}

#[test]
fn the_usage_twin_matches_the_typescript_contract() {
    let usage = AgentAccountUsage { account_id: "aaaa1111".into(), label: "Work".into(), windows: Vec::new(), error: None, unavailable: true };
    assert_eq!(serde_json::to_value(&usage).unwrap(), json!({ "accountId": "aaaa1111", "label": "Work", "windows": [], "error": null, "unavailable": true }));
    let back: AgentAccountUsage = serde_json::from_value(json!({ "accountId": "a", "label": "b", "windows": [], "error": "usage unavailable", "unavailable": false })).unwrap();
    assert_eq!(back.error.as_deref(), Some("usage unavailable"));
}

/// How a sign-in ended, as Settings reads it (`AgentAccountLoginFinished` in
/// src/lib/agentAccounts.ts): the status tag and camelCase fields.
#[test]
fn a_finished_sign_in_has_the_wire_names_settings_reads() {
    let duplicate = Finished::Duplicate { account_id: "0123456789abcdef".into(), label: "Work · Max".into() };
    assert_eq!(serde_json::to_value(&duplicate).unwrap(), serde_json::json!({"status":"duplicate","accountId":"0123456789abcdef","label":"Work · Max"}));
    assert_eq!(serde_json::to_value(Finished::Failed { message: "no login".into() }).unwrap(), serde_json::json!({"status":"failed","message":"no login"}));
    assert_eq!(serde_json::to_value(Finished::Waiting).unwrap(), serde_json::json!({"status":"waiting"}));
}
