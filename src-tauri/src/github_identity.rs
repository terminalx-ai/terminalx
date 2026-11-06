//! Which GitHub account a project is connected to.
//!
//! A reader with more than one GitHub account tells them apart by folder:
//! an SSH key per folder (through `Match exec` blocks or host aliases), and
//! a commit identity per folder (`includeIf`). So the account a project is
//! connected to is the one its pushes land as, which only the folder itself
//! can say: GitHub greets the key by its account name (`Hi name!`) when asked
//! from inside the folder. The `gh` CLI's active account is the fallback,
//! for a folder that reaches GitHub over HTTPS or has no remote yet; it is
//! what `gh` commands run as, wherever they run.
//!
//! Asking GitHub is a network round trip, so answers are kept for a while.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubIdentity {
    /// The account's login, when it could be found.
    pub login: Option<String>,
    /// Where the login came from: `ssh` (the key this folder authenticates
    /// with; its pushes land as this account) or `gh` (the CLI's active account).
    pub source: Option<String>,
    /// The email commits made in this folder carry.
    pub email: Option<String>,
    /// The origin remote as `owner/name`, when it is on GitHub.
    pub repo: Option<String>,
    /// Where the origin remote is hosted: `github`, `gitlab` or `other`;
    /// `None` for a project with no remote yet, which lives on this computer only.
    pub remote_host: Option<String>,
}

/// How long an answer stands before GitHub is asked again.
const KEEP: Duration = Duration::from_secs(10 * 60);
/// How long one SSH greeting may take before it is given up on.
const SSH_PATIENCE: Duration = Duration::from_secs(8);

static KNOWN: Mutex<Option<HashMap<PathBuf, (Instant, GithubIdentity)>>> = Mutex::new(None);

/// The account the project at `cwd` is connected to; a fresh answer when `refresh`.
pub fn identity(cwd: &Path, refresh: bool) -> GithubIdentity {
    if !refresh {
        let known = KNOWN.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, answer)) = known.as_ref().and_then(|map| map.get(cwd)) {
            if at.elapsed() < KEEP {
                return answer.clone();
            }
        }
    }
    let answer = look_up(cwd);
    let mut known = KNOWN.lock().unwrap_or_else(|e| e.into_inner());
    known.get_or_insert_with(HashMap::new).insert(cwd.to_path_buf(), (Instant::now(), answer.clone()));
    answer
}

fn look_up(cwd: &Path) -> GithubIdentity {
    let remote = crate::git::remote_url(cwd);
    let email = crate::git::run(cwd, &["config", "--get", "user.email"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let repo = remote.as_deref().and_then(crate::issues::github_repo_from_url);
    let remote_host = remote.as_deref().map(|url| remote_host_kind(url).to_string());
    // Over SSH, the key the folder uses names the account. A remote on a host
    // alias is asked by that alias; anything else by github.com, where the
    // folder's own SSH configuration still applies, since it is asked from there.
    let host = remote.as_deref().and_then(ssh_host).unwrap_or_else(|| "github.com".into());
    let https = remote.as_deref().is_some_and(|url| url.starts_with("http://") || url.starts_with("https://"));
    let greeted = if https { None } else { ssh_greeting(cwd, &host).as_deref().and_then(login_in_greeting) };
    match greeted {
        Some(login) => GithubIdentity { login: Some(login), source: Some("ssh".into()), email, repo, remote_host },
        None => {
            let login = gh_active_login();
            GithubIdentity { source: login.as_ref().map(|_| "gh".into()), login, email, repo, remote_host }
        }
    }
}

/// Where a remote is hosted, by the name of its host: `github` (an SSH alias
/// such as `github-work` included), `gitlab`, or `other`.
pub fn remote_host_kind(url: &str) -> &'static str {
    let url = url.trim();
    let host = ssh_host(url).or_else(|| url.split_once("://").and_then(|(_, rest)| rest.split('/').next()).map(|authority| authority.rsplit('@').next().unwrap_or("").split(':').next().unwrap_or("").to_string())).unwrap_or_default().to_ascii_lowercase();
    if host.contains("github") {
        "github"
    } else if host.contains("gitlab") {
        "gitlab"
    } else {
        "other"
    }
}

/// The host an SSH remote is reached at: `github-work` for
/// `git@github-work:owner/name.git`, `github.com` for `ssh://git@github.com/…`.
/// `None` for anything that is not SSH.
pub fn ssh_host(url: &str) -> Option<String> {
    let url = url.trim();
    if let Some(rest) = url.strip_prefix("ssh://") {
        let authority = rest.split('/').next()?;
        let host = authority.rsplit('@').next()?.split(':').next()?;
        return (!host.is_empty()).then(|| host.to_string());
    }
    if url.contains("://") {
        return None;
    }
    // scp-like: [user@]host:path
    let (before, _) = url.split_once(':')?;
    let host = before.rsplit('@').next()?;
    (!host.is_empty() && !host.contains('/')).then(|| host.to_string())
}

/// What GitHub says to a key: `Hi name! You've successfully authenticated…`.
pub fn login_in_greeting(text: &str) -> Option<String> {
    let start = text.find("Hi ")? + 3;
    let rest = &text[start..];
    let end = rest.find('!')?;
    let login = rest[..end].trim();
    (!login.is_empty() && !login.contains(char::is_whitespace)).then(|| login.to_string())
}

/// The active account in `gh auth status`: the `account name` (or older
/// `as name`) line that an `Active account: true` line follows.
pub fn active_login_in_status(text: &str) -> Option<String> {
    let mut current: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.split("Logged in to ").nth(1) {
            let words: Vec<&str> = rest.split_whitespace().collect();
            let login = words.iter().position(|w| *w == "account" || *w == "as").and_then(|i| words.get(i + 1)).map(|w| w.trim_matches(|c: char| !c.is_alphanumeric() && c != '-').to_string());
            current = login.filter(|l| !l.is_empty());
        } else if line.contains("Active account: true") && current.is_some() {
            return current;
        }
    }
    None
}

fn ssh_greeting(cwd: &Path, host: &str) -> Option<String> {
    let ssh = crate::binpath::resolve("ssh").unwrap_or_else(|| PathBuf::from("ssh"));
    let mut child = Command::new(ssh)
        .current_dir(cwd)
        .env("PATH", crate::binpath::login_path())
        .args(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new", &format!("git@{host}")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let started = Instant::now();
    // GitHub closes the connection itself (exit 1), so this is a wait with a
    // ceiling, not a success check.
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < SSH_PATIENCE => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let out = child.wait_with_output().ok()?;
    let mut text = String::from_utf8_lossy(&out.stderr).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stdout));
    Some(text)
}

fn gh_active_login() -> Option<String> {
    let gh = crate::binpath::resolve("gh")?;
    let out = Command::new(gh)
        .env("PATH", crate::binpath::login_path())
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .args(["auth", "status", "--hostname", "github.com"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    active_login_in_status(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_of_an_ssh_remote_is_its_alias_and_other_remotes_have_none() {
        assert_eq!(ssh_host("git@github-work:terminalx-ai/terminalx.git").as_deref(), Some("github-work"));
        assert_eq!(ssh_host("git@github.com:owner/name.git").as_deref(), Some("github.com"));
        assert_eq!(ssh_host("ssh://git@github.com/owner/name.git").as_deref(), Some("github.com"));
        assert_eq!(ssh_host("ssh://git@github.com:22/owner/name.git").as_deref(), Some("github.com"));
        assert_eq!(ssh_host("https://github.com/owner/name.git"), None);
        assert_eq!(ssh_host("/Users/me/bare.git"), None);
    }

    #[test]
    fn a_remote_is_placed_on_github_gitlab_or_elsewhere_by_its_host() {
        assert_eq!(remote_host_kind("git@github.com:owner/name.git"), "github");
        assert_eq!(remote_host_kind("git@github-work:terminalx-ai/terminalx.git"), "github");
        assert_eq!(remote_host_kind("https://github.com/owner/name"), "github");
        assert_eq!(remote_host_kind("git@gitlab.com:group/sub/name.git"), "gitlab");
        assert_eq!(remote_host_kind("https://gitlab.example.com/group/name.git"), "gitlab");
        assert_eq!(remote_host_kind("ssh://git@gitlab.com:2222/group/name.git"), "gitlab");
        assert_eq!(remote_host_kind("https://user@bitbucket.org/team/name.git"), "other");
        assert_eq!(remote_host_kind("/Users/me/bare.git"), "other");
    }

    #[test]
    fn the_greeting_names_the_account_and_nothing_else_does() {
        assert_eq!(login_in_greeting("Hi dalpattapaniya! You've successfully authenticated, but GitHub does not provide shell access.\n").as_deref(), Some("dalpattapaniya"));
        assert_eq!(login_in_greeting("Warning: Permanently added 'github.com' to the list of known hosts.\r\nHi trade100x! You've successfully authenticated").as_deref(), Some("trade100x"));
        assert_eq!(login_in_greeting("git@github.com: Permission denied (publickey)."), None);
        assert_eq!(login_in_greeting("ssh: connect to host github.com port 22: Operation timed out"), None);
        assert_eq!(login_in_greeting("Hi there friend! nope"), None);
    }

    #[test]
    fn the_active_gh_account_is_the_one_marked_active_whatever_the_wording() {
        let status = "github.com\n  ✓ Logged in to github.com account dalpattapaniya (keyring)\n  - Active account: true\n  - Git operations protocol: ssh\n\n  ✓ Logged in to github.com account trade100x (keyring)\n  - Active account: false\n";
        assert_eq!(active_login_in_status(status).as_deref(), Some("dalpattapaniya"));
        let second = "  ✓ Logged in to github.com account one (keyring)\n  - Active account: false\n  ✓ Logged in to github.com account two (keyring)\n  - Active account: true\n";
        assert_eq!(active_login_in_status(second).as_deref(), Some("two"));
        assert_eq!(active_login_in_status("  ✓ Logged in to github.com as older-gh (oauth_token)\n  - Active account: true\n").as_deref(), Some("older-gh"));
        assert_eq!(active_login_in_status("You are not logged into any GitHub hosts. Run gh auth login to authenticate.\n"), None);
    }
}
