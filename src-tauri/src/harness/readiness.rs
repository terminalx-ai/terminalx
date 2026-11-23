//! Local installation and login checks. These never start a model turn, log
//! credentials, or treat an unreadable/unsupported probe as a signed-out account.

use std::time::Duration;
use std::path::PathBuf;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State { Missing, SignedOut, Ready, Unknown }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
    pub state: State,
    pub checked_at: String,
    pub version: Option<String>,
    pub login_method: Option<String>,
    pub plan: Option<String>,
    /// The signed-in account's address, display only (PRO-306).
    pub account: Option<String>,
    /// Claude Code's organization name, display only (PRO-306).
    pub organization: Option<String>,
    /// What the agent's own login says, when a key saved in Settings is
    /// what its new tabs use instead (PRO-306): whether switching back to
    /// the subscription would work. `None` otherwise: the fields above are
    /// its own login then.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub own_login: Option<OwnLogin>,
}

/// An agent's own login, beside a saved API key that takes its place.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OwnLogin {
    pub state: State,
    pub login_method: Option<String>,
    pub plan: Option<String>,
    pub account: Option<String>,
    pub organization: Option<String>,
}

/// A local login is evidence of configuration, not proof of entitlement or
/// token validity at the provider. Custom routes cannot be judged by an OpenAI
/// login probe, and are deliberately left unknown.
fn codex_state(value: &Value) -> State {
    if value["requiresOpenaiAuth"] != true { return State::Unknown; }
    match value.get("account") {
        Some(Value::Null) => State::SignedOut,
        Some(account) if matches!(account["type"].as_str(), Some("chatgpt" | "apiKey" | "chatgptAuthTokens")) => State::Ready,
        _ => State::Unknown,
    }
}

fn claude_state(value: &Value) -> State {
    match value["loggedIn"].as_bool() {
        Some(true) => State::Ready,
        Some(false) => State::SignedOut,
        None => State::Unknown,
    }
}

/// Only allowlisted display metadata reaches the webview, never the account
/// document (which may gain credential fields in a future CLI release).
fn account_details(agent: &str, value: &Value) -> (Option<String>, Option<String>) {
    let (method, plan) = if agent == "claude" && claude_state(value) == State::Ready {
        (value["authMethod"].as_str(), value["subscriptionType"].as_str())
    } else if agent == "codex" && codex_state(value) == State::Ready {
        (value["account"]["type"].as_str(), value["account"]["planType"].as_str())
    } else { return (None, None); };
    let method = match method {
        Some("claude.ai" | "oauth") => Some("Claude account"),
        Some("chatgpt" | "chatgptAuthTokens") => Some("ChatGPT account"),
        Some("api_key" | "apiKey" | "console") => Some("API key"),
        _ => None,
    }.map(str::to_owned);
    let plan = plan.filter(|plan| matches!(*plan, "free" | "pro" | "max" | "team" | "enterprise" | "plus" | "business" | "edu" | "go" | "api"))
        .map(str::to_owned);
    (method, plan)
}

/// An address fit to name an account on the page: one token with an `@`.
fn display_address(raw: &str) -> Option<String> {
    let address = raw.trim();
    (address.len() <= 120 && address.contains('@') && !address.chars().any(|c| c.is_control() || c.is_whitespace())).then(|| address.to_string())
}

/// Whose login it is, for "Signed in" and the Login row: the account's
/// address and Claude Code's organization name, each checked to be a plain
/// display string, of a login that is in use. Nothing else of the document.
fn account_identity(agent: &str, value: &Value) -> (Option<String>, Option<String>) {
    let (address, organization) = if agent == "claude" && claude_state(value) == State::Ready {
        (value["email"].as_str(), value["orgName"].as_str())
    } else if agent == "codex" && codex_state(value) == State::Ready {
        (value["account"]["email"].as_str(), None)
    } else { return (None, None); };
    let organization = organization.map(str::trim)
        .filter(|name| !name.is_empty() && name.chars().count() <= 120 && !name.chars().any(char::is_control))
        .map(str::to_owned);
    (address.and_then(display_address), organization)
}

/// `home::prepare` links the user's auth file when one exists, and otherwise
/// preserves a login completed in the managed terminal. Inspect that same
/// effective account without creating a home or reading credential contents.
fn codex_home_for_check(user: Option<PathBuf>, managed: Option<PathBuf>) -> Option<PathBuf> {
    if !user.as_ref().is_some_and(|home| home.join("auth.json").exists())
        && managed.as_ref().is_some_and(|home| home.join("auth.json").exists()) {
        managed
    } else { user }
}

pub fn check(id: &str) -> Readiness {
    match super::offered().into_iter().find(|h| h.id == id) {
        Some(agent) => check_binary(id, agent.path),
        None => Readiness { state: State::Unknown, checked_at: chrono::Utc::now().to_rfc3339(), version: None, login_method: None, plan: None, account: None, organization: None, own_login: None },
    }
}

/// The checks for agent `id` with its CLI at `path` (`None`: not installed).
///
/// One check at a time. Every view of an agent checks again when a terminal
/// exits, so an install's exit starts several at once; and two Codex app
/// servers starting together in a new `CODEX_HOME` (the first run after an
/// install) race to create its state database, and the loser exits with
/// "failed to initialize sqlite state runtime" (Codex 0.167.0, PRO-152): a
/// fresh install would read as "login not checked" and its sign-in would
/// not follow.
pub fn check_binary(id: &str, path: Option<String>) -> Readiness {
    check_in(id, path, None)
}

/// The login of one agent account (#980) of agent `id`: what the agent's own
/// status says with its configuration directory set to the account's,
/// `CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex. A key the
/// app's environment or the saved-key setting has does not count: this is
/// that directory's own sign-in. An account whose directory is gone is
/// signed out ("Sign in again").
pub fn check_account(id: &str, dir: &std::path::Path) -> Readiness {
    let path = super::offered().into_iter().find(|h| h.id == id).and_then(|agent| agent.path);
    check_account_binary(id, path, dir)
}

pub fn check_account_binary(id: &str, path: Option<String>, dir: &std::path::Path) -> Readiness {
    if path.is_some() && !dir.is_dir() {
        return Readiness { state: State::SignedOut, checked_at: chrono::Utc::now().to_rfc3339(), version: None, login_method: None, plan: None, account: None, organization: None, own_login: None };
    }
    check_in(id, path, Some(dir))
}

/// Variables that would make `claude auth status` report something other
/// than the directory's own login.
const ACCOUNT_CHECK_UNSET: &[&str] = &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

fn check_in(id: &str, path: Option<String>, account: Option<&std::path::Path>) -> Readiness {
    static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let mut result = Readiness { state: State::Unknown, checked_at: String::new(), version: None, login_method: None, plan: None, account: None, organization: None, own_login: None };
    if let Some(path) = path {
        let mut version = std::process::Command::new(&path);
        version.arg("--version").env("PATH", crate::binpath::login_path()).env("NO_COLOR", "1");
        if let Ok(text) = crate::git::output_within(version, Duration::from_secs(3)) {
            // Only retain the version token, never arbitrary command output.
            result.version = super::executables::version_token(&text);
        }
        result.state = match id {
            "codex" => {
                let home = match account {
                    Some(dir) => Some(dir.to_path_buf()),
                    None => codex_home_for_check(super::codex::home::user_root(), crate::store::root().ok().map(|root| root.join("codex"))),
                };
                super::codex::appserver::ask_with_timeout(
                    super::codex::appserver::Where { codex_home: home.as_deref(), cwd: None },
                    "account/read", json!({ "refreshToken": false }), Duration::from_secs(5),
                ).map(|value| { (result.login_method, result.plan) = account_details("codex", &value); (result.account, result.organization) = account_identity("codex", &value); codex_state(&value) }).unwrap_or(State::Unknown)
            }
            "claude" => {
                let mut command = std::process::Command::new(path);
                command.args(["auth", "status", "--json"]).env("PATH", crate::binpath::login_path()).env("NO_COLOR", "1");
                if let Some(dir) = account {
                    command.env("CLAUDE_CONFIG_DIR", dir);
                    for name in ACCOUNT_CHECK_UNSET {
                        command.env_remove(name);
                    }
                }
                crate::git::capture_within(command, Duration::from_secs(5)).ok()
                    .and_then(|output| serde_json::from_slice::<Value>(&output.stdout).ok())
                    .map(|value| { (result.login_method, result.plan) = account_details("claude", &value); (result.account, result.organization) = account_identity("claude", &value); claude_state(&value) }).unwrap_or(State::Unknown)
            }
            _ => State::Unknown,
        };
    } else { result.state = State::Missing; }
    // An API key saved in Settings → Agents that new tabs use (PRO-306) signs
    // an installed agent in: what New Session, the agent menu and the start
    // screen read must say so, or a person with a key and no subscription
    // could never start one. Its own login is not what tabs will use.
    if account.is_none() && result.state != State::Missing && crate::agent_keys::uses_saved_key(id) {
        // Kept apart, so Settings can still say whether the subscription
        // would work before anyone switches back to it.
        result.own_login = Some(OwnLogin {
            state: result.state,
            login_method: result.login_method.replace("API key".into()),
            plan: result.plan.take(),
            account: result.account.take(),
            organization: result.organization.take(),
        });
        result.state = State::Ready;
    }
    result.checked_at = chrono::Utc::now().to_rfc3339();
    result
}

/// How long an answer about an agent's latest release is kept (PRO-377).
const LATEST_FOR: Duration = Duration::from_secs(6 * 60 * 60);

static LATEST: std::sync::Mutex<Vec<(String, std::time::Instant, Option<String>)>> = std::sync::Mutex::new(Vec::new());

/// The latest published release of an agent's CLI, from the npm registry,
/// for the "· up to date" beside its version in Settings (PRO-377). `None`
/// when the agent has no package, data privacy mode is on, or the registry
/// does not answer; an answer is kept for six hours.
pub fn latest_version(harness: &str) -> Option<String> {
    let package = super::npm_package(harness)?;
    if let Some((_, _, answer)) = LATEST.lock().unwrap().iter().find(|(id, at, _)| id == harness && at.elapsed() < LATEST_FOR) {
        return answer.clone();
    }
    let agent = crate::data_privacy::http_agent().timeout(Duration::from_secs(5)).build();
    let answer = agent
        .get(&format!("https://registry.npmjs.org/{package}/latest"))
        .call()
        .ok()
        .and_then(|response| response.into_json::<Value>().ok())
        .and_then(|body| release_version(&body));
    // A failed lookup is asked again next time rather than kept.
    if answer.is_some() {
        let mut cache = LATEST.lock().unwrap();
        cache.retain(|(id, _, _)| id != harness);
        cache.push((harness.to_owned(), std::time::Instant::now(), answer.clone()));
    }
    answer
}

/// The `version` of a registry `latest` document, when it looks like one.
fn release_version(body: &Value) -> Option<String> {
    let version = body.get("version")?.as_str()?;
    (!version.is_empty() && version.len() <= 40 && version.starts_with(|c: char| c.is_ascii_digit()) && version.chars().all(|c| c.is_ascii_alphanumeric() || ".-_+".contains(c)))
        .then(|| version.to_owned())
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_a_release_version_from_the_registry() {
        assert_eq!(super::release_version(&json!({"name": "@anthropic-ai/claude-code", "version": "2.3.41"})).as_deref(), Some("2.3.41"));
        assert_eq!(super::release_version(&json!({"version": "<script>"})), None);
        assert_eq!(super::release_version(&json!({"version": ""})), None);
        assert_eq!(super::release_version(&json!({})), None);
        assert_eq!(super::super::npm_package("claude"), Some("@anthropic-ai/claude-code"));
        assert_eq!(super::super::npm_package("codex"), Some("@openai/codex"));
        assert_eq!(super::latest_version("no-such-agent"), None);
    }

    use super::*;

    #[test]
    fn account_details_only_keep_display_fields_of_a_known_login() {
        assert_eq!(account_details("claude", &json!({"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","accessToken":"secret"})), (Some("Claude account".into()), Some("max".into())));
        assert_eq!(account_details("codex", &json!({"requiresOpenaiAuth":true,"account":{"type":"chatgpt","planType":"plus","accessToken":"secret"}})), (Some("ChatGPT account".into()), Some("plus".into())));
        assert_eq!(account_details("claude", &json!({"loggedIn":false,"authMethod":"claude.ai","subscriptionType":"max"})), (None, None));
        assert_eq!(account_details("codex", &json!({"requiresOpenaiAuth":false,"account":{"type":"chatgpt","planType":"plus"}})), (None, None));
    }

    /// PRO-306: a person with a company key and no subscription. Every view
    /// that refuses a signed-out agent (New Session, the agent menu, the
    /// start screen) reads this check, not Settings.
    #[cfg(unix)]
    #[test]
    fn a_saved_key_in_use_makes_an_installed_agent_ready_everywhere() {
        use std::os::unix::fs::PermissionsExt;
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let claude = dir.path().join("claude");
        std::fs::write(&claude, "#!/bin/sh\ncase \"$1\" in\n  --version) echo '2.3.41 (Claude Code)' ;;\n  auth) echo '{\"loggedIn\":false}' ;;\nesac\n").unwrap();
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = Some(claude.to_string_lossy().into_owned());
        assert_eq!(check_binary("claude", path.clone()).state, State::SignedOut);

        let secrets = crate::keychain::testing::MemorySecrets::default();
        crate::agent_keys::save_for_test("claude", "sk-ant-api03-ReadinessKey0123456789abcdefghijklmnop-test", &secrets);
        let ready = check_binary("claude", path.clone());
        assert_eq!((ready.state, ready.login_method.as_deref(), ready.version.as_deref()), (State::Ready, Some("API key"), Some("2.3.41")));
        // Its own login is still told, apart: there is none to switch back to.
        assert_eq!(ready.own_login, Some(OwnLogin { state: State::SignedOut, login_method: None, plan: None, account: None, organization: None }));
        // Signed in to the subscription as well: whose, for when it is chosen again.
        std::fs::write(&claude, "#!/bin/sh\ncase \"$1\" in\n  --version) echo '2.3.41 (Claude Code)' ;;\n  auth) echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"subscriptionType\":\"max\",\"email\":\"ada@example.com\",\"orgName\":\"Acme\"}' ;;\nesac\n").unwrap();
        let both = check_binary("claude", path.clone());
        assert_eq!((both.state, both.login_method.as_deref(), both.plan.as_deref(), both.account.as_deref()), (State::Ready, Some("API key"), None, None));
        assert_eq!(both.own_login, Some(OwnLogin { state: State::Ready, login_method: Some("Claude account".into()), plan: Some("max".into()), account: Some("ada@example.com".into()), organization: Some("Acme".into()) }));
        // Not installed stays not installed: a key does not run a CLI.
        assert_eq!(check_binary("claude", None).state, State::Missing);
        // Another agent's key signs nothing in.
        assert!(!crate::agent_keys::uses_saved_key("codex"));

        // Back on the subscription (the key kept, or removed): its own login again.
        crate::agent_keys::set_mode("claude", crate::agent_keys::Mode::Subscription).unwrap();
        let own = check_binary("claude", path);
        assert_eq!((own.state, own.account.as_deref(), own.own_login), (State::Ready, Some("ada@example.com"), None));
    }

    /// #980: an added account's login is checked in its own directory, and
    /// a saved key in use does not make it look signed in.
    #[cfg(unix)]
    #[test]
    fn an_account_is_checked_in_its_own_directory() {
        use std::os::unix::fs::PermissionsExt;
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let claude = dir.path().join("claude");
        // Signed in exactly where CLAUDE_CONFIG_DIR says a marker file is.
        std::fs::write(&claude, "#!/bin/sh\ncase \"$1\" in\n  --version) echo '2.3.41 (Claude Code)' ;;\n  auth) if [ -n \"$CLAUDE_CONFIG_DIR\" ] && [ -f \"$CLAUDE_CONFIG_DIR/signed-in\" ] && [ -z \"$ANTHROPIC_API_KEY\" ]; then echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"subscriptionType\":\"pro\",\"email\":\"bo@example.com\"}'; else echo '{\"loggedIn\":false}'; fi ;;\nesac\n").unwrap();
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = Some(claude.to_string_lossy().into_owned());
        let (one, two) = (dir.path().join("one"), dir.path().join("two"));
        std::fs::create_dir_all(&one).unwrap();
        std::fs::create_dir_all(&two).unwrap();
        std::fs::write(one.join("signed-in"), "").unwrap();
        let secrets = crate::keychain::testing::MemorySecrets::default();
        crate::agent_keys::save_for_test("claude", "sk-ant-api03-ReadinessKey0123456789abcdefghijklmnop-test", &secrets);
        let first = check_account_binary("claude", path.clone(), &one);
        assert_eq!((first.state, first.account.as_deref(), first.plan.as_deref(), first.own_login), (State::Ready, Some("bo@example.com"), Some("pro"), None));
        assert_eq!(check_account_binary("claude", path.clone(), &two).state, State::SignedOut);
        // Deleted outside the app: signed out, so Settings offers "Sign in again".
        assert_eq!(check_account_binary("claude", path.clone(), &dir.path().join("gone")).state, State::SignedOut);
        assert_eq!(check_account_binary("claude", None, &one).state, State::Missing);
    }

    #[test]
    fn the_account_and_organization_are_kept_only_as_display_strings_of_a_login_in_use() {
        let claude = json!({"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com","orgName":"Acme","orgId":"secret-org-id","accessToken":"secret"});
        assert_eq!(account_identity("claude", &claude), (Some("ada@example.com".into()), Some("Acme".into())));
        assert_eq!(account_identity("claude", &json!({"loggedIn":false,"email":"ada@example.com","orgName":"Acme"})), (None, None));
        assert_eq!(account_identity("claude", &json!({"loggedIn":true,"email":"not an address","orgName":"Two\nlines"})), (None, None));
        let codex = json!({"requiresOpenaiAuth":true,"account":{"type":"chatgpt","email":"ada@example.com","planType":"pro"}});
        assert_eq!(account_identity("codex", &codex), (Some("ada@example.com".into()), None));
        assert_eq!(account_identity("codex", &json!({"requiresOpenaiAuth":true,"account":null})), (None, None));
    }

    #[test]
    fn a_login_completed_in_the_managed_terminal_is_not_reported_signed_out() {
        let user = tempfile::tempdir().unwrap();
        let managed = tempfile::tempdir().unwrap();
        let choose = || codex_home_for_check(Some(user.path().into()), Some(managed.path().into())).unwrap();
        assert_eq!(choose(), user.path());
        std::fs::write(managed.path().join("auth.json"), "{}").unwrap();
        assert_eq!(choose(), managed.path());
        std::fs::write(user.path().join("auth.json"), "{}").unwrap();
        assert_eq!(choose(), user.path(), "the user's login takes precedence on the next launch");
    }

    #[cfg(unix)]
    #[test]
    fn checks_made_at_once_do_not_race_a_new_codex_home() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        // A stand-in that fails as Codex does when another app server is
        // creating the same new home at that moment.
        let fake = dir.path().join("codex");
        std::fs::write(&fake, format!(r#"#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.167.0" ;;
  app-server)
    mkdir "{lock}" 2>/dev/null || {{ echo "failed to initialize sqlite state runtime" >&2; exit 1; }}
    sleep 0.3
    rmdir "{lock}"
    echo '{{"id":2,"result":{{"account":null,"requiresOpenaiAuth":true}}}}'
    cat >/dev/null ;;
esac
"#, lock = dir.path().join("creating").display())).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _codex = super::super::codex::pty::codex_program_for_tests(fake.clone());
        let path = fake.to_string_lossy().into_owned();
        let states: Vec<State> = std::thread::scope(|scope| {
            let checks: Vec<_> = (0..3).map(|_| scope.spawn(|| check_binary("codex", Some(path.clone())).state)).collect();
            checks.into_iter().map(|check| check.join().unwrap()).collect()
        });
        assert_eq!(states, [State::SignedOut; 3]);
    }

    #[test]
    fn local_account_evidence_is_distinct_from_unknown_and_custom_routes() {
        assert_eq!(codex_state(&json!({"account": null, "requiresOpenaiAuth": true})), State::SignedOut);
        for kind in ["chatgpt", "apiKey", "chatgptAuthTokens"] {
            assert_eq!(codex_state(&json!({"account": {"type": kind}, "requiresOpenaiAuth": true})), State::Ready);
        }
        for value in [json!({}), json!({"account": null}), json!({"account": null, "requiresOpenaiAuth": false}), json!({"account": {}, "requiresOpenaiAuth": true})] {
            assert_eq!(codex_state(&value), State::Unknown);
        }
        assert_eq!(claude_state(&json!({"loggedIn": true})), State::Ready);
        assert_eq!(claude_state(&json!({"loggedIn": false})), State::SignedOut);
        assert_eq!(claude_state(&json!({"error": "unavailable"})), State::Unknown);
    }
}
