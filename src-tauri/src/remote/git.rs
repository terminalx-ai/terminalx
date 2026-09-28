//! `git/1` and the repository half of `lifecycle/1`: the Git repositories of
//! one cloud workspace, as the runtime serves them (PRO-27).
//!
//! - **Repositories.** A workspace is one repository (its root) or several
//!   clones below it (`targetDirectory` of the setup, at most two levels
//!   deep). Every call names its repository with `repo` (workspace-relative,
//!   as `git.repositories` lists it). Leaving it out works only when there is
//!   exactly one; with several the call is refused as `ambiguous_repository`,
//!   never answered for whichever came first.
//! - **Authorship and credentials are separate.** `git.commit` takes the
//!   author (`{ name, email }`) from the client, which is the signed-in
//!   person's Git identity on their desktop; the runtime has none of its own.
//!   Pushing and pull requests authenticate with the workspace's GitHub App
//!   token through the credential helper and `gh` shim (PRO-14,
//!   `cloud_github`), which never appears here.
//! - **Uncertain outcomes are reconciled before anything is repeated.** A push
//!   first asks the remote for the branch head and does nothing when it is
//!   already there; a push that fails in an ambiguous way asks again before
//!   reporting. A pull request is created only when the remote has the
//!   branch at the local head and no open one exists for it, and a failed
//!   create looks for the one it may have made. What still cannot be known is
//!   `outcome_unknown`, and repeating the call is safe.
//! - Pull requests go through `gh` in the repository, so the shim mints a
//!   token for that repository. `TERMINALX_SERVE_GH` replaces the `gh` run
//!   (tests use `scripts/remote-runtime/fake-gh`).

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use super::protocol::RpcError;

/// At most this many repositories are listed (the disposition contract's bound).
pub const MAX_REPOSITORIES: usize = 20;
const MAX_DEPTH: usize = 2;
const MAX_DIFF_BYTES: usize = 768 * 1024;
/// One side of a file comparison; both fit a relay frame with room to spare.
const MAX_CONTENT_BYTES: usize = 384 * 1024;
const MAX_CHANGED_FILES: usize = 2000;
const MAX_BODY_BYTES: usize = 4096;
const LOCAL_TIMEOUT: Duration = Duration::from_secs(60);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
/// Per repository in `lifecycle.dispositionFacts`.
pub const FACTS_TIMEOUT: Duration = Duration::from_secs(2);
const TOO_LARGE: &str = "<file too large to show>";
/// Directories never searched for repositories.
const SKIPPED_DIRS: &[&str] = &["node_modules", "target", "vendor", "dist", "build"];

pub struct WorkspaceGit {
    root: PathBuf,
    gh: Option<PathBuf>,
}

/// One repository a call was routed to.
struct Repo {
    /// Workspace-relative, `.` for the root.
    name: String,
    dir: PathBuf,
}

/// What one Git or `gh` process did.
struct Ran {
    ok: bool,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

impl Ran {
    fn text(&self) -> String {
        // `git push --porcelain` reports a rejected ref on stdout.
        let text = [self.stderr.trim(), self.stdout.trim()].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n");
        if self.timed_out {
            format!("timed out{}{text}", if text.is_empty() { "" } else { ": " })
        } else {
            text
        }
    }
}

/// How a failed Git or GitHub call failed, for the client to act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Failure {
    /// The GitHub token was refused or could not be minted.
    Auth,
    /// The remote has work the local branch does not (or a merge conflicts).
    Conflict,
    /// The remote could not be reached: whether it happened is unknown.
    Network,
    Other,
}

fn classify(text: &str, timed_out: bool) -> Failure {
    let lower = text.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| lower.contains(needle));
    if has(&[
        "authentication failed",
        "could not read username",
        "could not read password",
        "invalid username or password",
        "bad credentials",
        "http 401",
        "error: 401",
        "returned error: 403",
        "permission to",
        "no longer accepts this workspace's runtime credential",
        "github app installation",
        "not one of this workspace's repositories",
        "gh auth login",
    ]) {
        return Failure::Auth;
    }
    if has(&[
        "non-fast-forward",
        "fetch first",
        "[rejected]",
        "remote contains work that you do",
        "not possible to fast-forward",
        "diverging branches",
        "conflict",
        "not mergeable",
        "would be overwritten",
    ]) {
        return Failure::Conflict;
    }
    if timed_out
        || has(&[
            "could not resolve host",
            "connection timed out",
            "operation timed out",
            "connection refused",
            "connection reset",
            "network is unreachable",
            "the remote end hung up",
            "early eof",
            "unable to access",
            "error connecting to",
            "tls handshake",
            "i/o timeout",
            "broken pipe",
        ])
    {
        return Failure::Network;
    }
    Failure::Other
}

fn failure_error(what: &str, text: &str, failure: Failure) -> RpcError {
    match failure {
        Failure::Auth => RpcError::new("auth_failed", format!("{what}: GitHub refused this workspace's credentials: {text}")),
        Failure::Conflict => RpcError::new("conflict", format!("{what}: {text}")),
        Failure::Network => RpcError::new("outcome_unknown", format!("{what}: the remote could not be reached, so whether it happened is unknown; trying again checks first: {text}")),
        Failure::Other => RpcError::new("git_failed", format!("{what}: {text}")),
    }
}

fn run_bounded(mut command: Command, timeout: Duration) -> std::io::Result<Ran> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own group, so a timeout also ends `git-remote-https` and `ssh`.
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buffer);
            }
            String::from_utf8_lossy(&buffer).into_owned()
        })
    };
    let stdout = drain(child.stdout.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if Instant::now() >= deadline {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    match status {
        Some(status) => Ok(Ran {
            ok: status.success(),
            stdout: stdout.join().unwrap_or_default(),
            stderr: stderr.join().unwrap_or_default(),
            timed_out: false,
        }),
        // A grandchild may still hold the pipes; the readers finish on their own.
        None => Ok(Ran { ok: false, stdout: String::new(), stderr: String::new(), timed_out: true }),
    }
}

fn git_command(dir: &Path) -> Command {
    let mut command = Command::new(crate::binpath::resolve("git").unwrap_or_else(|| PathBuf::from("git")));
    command
        .current_dir(dir)
        .env("PATH", crate::binpath::login_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        // Paths are file names, never pathspec magic such as `:(top)` or `:!x`.
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("LC_ALL", "C");
    command
}

/// `origin` without credentials that someone may have written into it.
fn display_remote(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) if parsed.password().is_some() || !parsed.username().is_empty() => {
            let _ = parsed.set_username("");
            let _ = parsed.set_password(None);
            parsed.to_string()
        }
        _ => url.to_string(),
    }
}

pub fn valid_ref_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('-')
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.'))
}

fn valid_object_id(value: &str) -> bool {
    (7..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn required_str<'a>(params: &'a Value, name: &str) -> Result<&'a str, RpcError> {
    params.get(name).and_then(Value::as_str).ok_or_else(|| RpcError::invalid(format!("{name} is required")))
}

fn optional_ref<'a>(params: &'a Value, name: &str) -> Result<Option<&'a str>, RpcError> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if valid_ref_name(value) => Ok(Some(value)),
        Some(_) => Err(RpcError::invalid(format!("{name} is not a valid branch name"))),
    }
}

/// The desktop user's Git identity, for authorship only.
#[derive(Deserialize)]
struct Author {
    name: String,
    email: String,
}

impl Author {
    fn check(&self) -> Result<(), RpcError> {
        let clean = |value: &str| !value.chars().any(|c| c.is_control() || c == '<' || c == '>');
        let name = self.name.trim();
        let email = self.email.trim();
        if name.is_empty() || name.len() > 200 || !clean(name) {
            return Err(RpcError::invalid("author.name must be a name"));
        }
        if email.len() < 3 || email.len() > 254 || !email.contains('@') || email.contains(char::is_whitespace) || !clean(email) {
            return Err(RpcError::invalid("author.email must be an email address"));
        }
        Ok(())
    }
}

fn truncate_text(text: &mut String, max: usize) -> bool {
    if text.len() <= max {
        return false;
    }
    let mut cut = max;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    true
}

impl WorkspaceGit {
    pub fn new(root: PathBuf) -> Self {
        Self { root, gh: std::env::var_os("TERMINALX_SERVE_GH").map(PathBuf::from) }
    }

    #[cfg(test)]
    pub fn set_gh(&mut self, gh: PathBuf) {
        self.gh = Some(gh);
    }

    /// Answer a `git.*` method; `None` for any other.
    pub fn handle(&self, method: &str, params: &Value) -> Option<Result<Value, RpcError>> {
        let result = match method {
            "git.repositories" => Ok(self.list()),
            "git.status" => self.status(params),
            "git.diff" => self.diff(params),
            "git.workingChanges" => self.working_changes(params),
            "git.changesBetween" => self.changes_between(params),
            "git.fileContents" => self.file_contents(params),
            "git.log" => self.log(params),
            "git.branches" => self.branches(params),
            "git.checkout" => self.checkout(params),
            "git.stage" => self.paths(params, &["add", "-A", "--"]),
            "git.unstage" => self.unstage(params),
            "git.commit" => self.commit(params),
            "git.fetch" => self.fetch(params),
            "git.push" => self.push(params),
            "git.pull" => self.pull(params),
            "git.prs" => self.prs(params),
            "git.prCreate" => self.pr_create(params),
            "git.prReady" => self.pr_ready(params),
            "git.prMerge" => self.pr_merge(params),
            _ => return None,
        };
        Some(result)
    }

    // ---- repositories ----------------------------------------------------

    /// Workspace-relative repository directories, sorted; the root alone when
    /// it is one. Symlinks, hidden and build directories are not searched.
    pub fn repositories(&self) -> (Vec<String>, bool) {
        if self.root.join(".git").exists() {
            return (vec![".".into()], false);
        }
        let mut found = Vec::new();
        let mut truncated = false;
        let mut frontier = vec![(self.root.clone(), 0usize)];
        while let Some((dir, depth)) = frontier.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            let mut children: Vec<_> = entries.filter_map(Result::ok).collect();
            children.sort_by_key(|entry| entry.file_name());
            for entry in children {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || SKIPPED_DIRS.contains(&name.as_str()) {
                    continue;
                }
                let Ok(kind) = entry.file_type() else { continue };
                if !kind.is_dir() {
                    continue;
                }
                let path = entry.path();
                if path.join(".git").exists() {
                    if found.len() >= MAX_REPOSITORIES {
                        truncated = true;
                        continue;
                    }
                    found.push(path.strip_prefix(&self.root).unwrap_or(&path).to_string_lossy().into_owned());
                } else if depth + 1 < MAX_DEPTH {
                    frontier.push((path, depth + 1));
                }
            }
        }
        found.sort();
        (found, truncated)
    }

    fn list(&self) -> Value {
        let (names, truncated) = self.repositories();
        let repositories: Vec<Value> = names
            .iter()
            .map(|name| {
                let dir = self.dir(name);
                json!({
                    "repo": name,
                    "branch": crate::git::current_branch(&dir),
                    "head": crate::git::head_commit(&dir),
                    "remote": crate::git::remote_url(&dir).map(|url| display_remote(&url)),
                    "defaultBranch": crate::git::default_branch(&dir),
                })
            })
            .collect();
        json!({ "repositories": repositories, "truncated": truncated })
    }

    fn dir(&self, name: &str) -> PathBuf {
        if name == "." {
            self.root.clone()
        } else {
            self.root.join(name)
        }
    }

    /// The repository a call names, or the only one there is.
    fn repo(&self, params: &Value) -> Result<Repo, RpcError> {
        let (names, _) = self.repositories();
        match params.get("repo") {
            None | Some(Value::Null) => match names.len() {
                0 => Err(RpcError::not_found("this workspace has no Git repository")),
                1 => Ok(Repo { dir: self.dir(&names[0]), name: names[0].clone() }),
                count => Err(RpcError::new(
                    "ambiguous_repository",
                    format!("this workspace has {count} repositories ({}); name one with repo", names.join(", ")),
                )),
            },
            Some(Value::String(name)) => {
                let name = if name.is_empty() { "." } else { name.trim_end_matches('/') };
                names
                    .iter()
                    .find(|known| known.as_str() == name)
                    .map(|known| Repo { dir: self.dir(known), name: known.clone() })
                    .ok_or_else(|| RpcError::not_found(format!("{name} is not a repository in this workspace")))
            }
            Some(_) => Err(RpcError::invalid("repo must be a string")),
        }
    }

    fn git(&self, repo: &Repo, args: &[&str]) -> Result<String, RpcError> {
        self.git_timed(repo, args, LOCAL_TIMEOUT, &[])
    }

    fn git_timed(&self, repo: &Repo, args: &[&str], timeout: Duration, env: &[(&str, &str)]) -> Result<String, RpcError> {
        let ran = self.run_git(&repo.dir, args, timeout, env)?;
        if ran.ok {
            return Ok(ran.stdout);
        }
        let text = ran.text();
        Err(failure_error(&format!("git {}", args.first().copied().unwrap_or("")), &text, classify(&text, ran.timed_out)))
    }

    fn run_git(&self, dir: &Path, args: &[&str], timeout: Duration, env: &[(&str, &str)]) -> Result<Ran, RpcError> {
        let mut command = git_command(dir);
        command.args(args);
        for (key, value) in env {
            command.env(key, value);
        }
        run_bounded(command, timeout).map_err(RpcError::internal)
    }

    /// A repository-relative path: lexically inside it. Git refuses paths
    /// outside the repository itself, and pathspec magic is off.
    fn repo_path(relative: &str) -> Result<String, RpcError> {
        if relative.is_empty() || relative.len() > 4096 || relative.contains('\0') {
            return Err(RpcError::new("path_forbidden", "invalid path"));
        }
        let mut clean = PathBuf::new();
        for component in Path::new(relative).components() {
            match component {
                Component::Normal(part) => clean.push(part),
                Component::CurDir => {}
                _ => return Err(RpcError::new("path_forbidden", "paths are repository-relative and may not leave it")),
            }
        }
        let clean = clean.to_string_lossy().into_owned();
        Ok(if clean.is_empty() { ".".into() } else { clean })
    }

    fn path_list(params: &Value) -> Result<Vec<String>, RpcError> {
        params
            .get("paths")
            .and_then(Value::as_array)
            .filter(|paths| !paths.is_empty() && paths.len() <= 1000)
            .ok_or_else(|| RpcError::invalid("paths must list 1 to 1000 paths"))?
            .iter()
            .map(|path| path.as_str().ok_or_else(|| RpcError::invalid("paths must be strings")).and_then(Self::repo_path))
            .collect()
    }

    // ---- reads -----------------------------------------------------------

    fn status(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = match self.repo(params) {
            Ok(repo) => repo,
            // Older clients ask a workspace that is no repository at all.
            Err(error) if error.code == "not_found" && params.get("repo").is_none() => return Ok(json!({ "repository": false })),
            Err(error) => return Err(error),
        };
        let porcelain = self.git(&repo, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
        let mut files = Vec::new();
        let mut conflicted = Vec::new();
        let mut parts = porcelain.split('\0').filter(|part| !part.is_empty());
        while let Some(entry) = parts.next() {
            if entry.len() < 4 {
                continue;
            }
            let (index, worktree, path) = (&entry[0..1], &entry[1..2], &entry[3..]);
            let mut file = json!({ "path": path, "index": index, "worktree": worktree });
            if index == "R" || index == "C" {
                file["from"] = json!(parts.next());
            }
            if matches!(&entry[0..2], "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU") {
                conflicted.push(path.to_string());
            }
            files.push(file);
        }
        let status = crate::git::work_status(&repo.dir);
        Ok(json!({
            "repository": true,
            "repo": repo.name,
            "branch": status.branch,
            "head": status.head,
            "upstream": status.upstream,
            "ahead": status.ahead,
            "behind": status.behind,
            "defaultBranch": status.default_branch,
            "aheadOfBase": status.ahead_of_base,
            "dirty": status.dirty,
            "operation": self.operation(&repo),
            "conflicted": conflicted,
            "files": files,
        }))
    }

    /// A merge, rebase or cherry-pick left in progress.
    fn operation(&self, repo: &Repo) -> Option<&'static str> {
        let git_dir = self.git(repo, &["rev-parse", "--absolute-git-dir"]).ok()?;
        let git_dir = PathBuf::from(git_dir.trim());
        if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
            Some("rebase")
        } else if git_dir.join("MERGE_HEAD").exists() {
            Some("merge")
        } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
            Some("cherry-pick")
        } else {
            None
        }
    }

    fn diff(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let mut args = vec!["diff", "--no-color", "--no-ext-diff"];
        if params.get("staged").and_then(Value::as_bool) == Some(true) {
            args.push("--cached");
        }
        args.push("--");
        let path = match params.get("path").and_then(Value::as_str) {
            Some(path) => Some(Self::repo_path(path)?),
            None => None,
        };
        if let Some(path) = &path {
            args.push(path);
        }
        let mut diff = self.git(&repo, &args)?;
        let truncated = truncate_text(&mut diff, MAX_DIFF_BYTES);
        Ok(json!({ "repo": repo.name, "diff": diff, "truncated": truncated }))
    }

    /// The desktop's `working_changes`: HEAD's tree, and what differs from it
    /// in the working tree (untracked files included).
    fn working_changes(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let head = crate::git::head_tree(&repo.dir).map_err(git_error)?;
        let snapshot = crate::git::snapshot_tree(&repo.dir).map_err(git_error)?;
        let mut files = if head == snapshot { Vec::new() } else { crate::git::changes_between(&repo.dir, &head, Some(&snapshot)).map_err(git_error)? };
        let truncated = files.len() > MAX_CHANGED_FILES;
        files.truncate(MAX_CHANGED_FILES);
        Ok(json!({ "repo": repo.name, "head": head, "files": files, "truncated": truncated }))
    }

    fn changes_between(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let base = required_str(params, "base")?;
        let head = params.get("head").and_then(Value::as_str);
        if !valid_object_id(base) || head.is_some_and(|head| !valid_object_id(head)) {
            return Err(RpcError::invalid("base and head are tree ids"));
        }
        let mut files = crate::git::changes_between(&repo.dir, base, head).map_err(git_error)?;
        let truncated = files.len() > MAX_CHANGED_FILES;
        files.truncate(MAX_CHANGED_FILES);
        Ok(json!({ "repo": repo.name, "files": files, "truncated": truncated }))
    }

    /// One file at tree `base` and at tree `head` (or in the working tree).
    fn file_contents(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let path = Self::repo_path(required_str(params, "path")?)?;
        let base = required_str(params, "base")?;
        let head = params.get("head").and_then(Value::as_str);
        if !valid_object_id(base) || head.is_some_and(|head| !valid_object_id(head)) {
            return Err(RpcError::invalid("base and head are tree ids"));
        }
        let bound = |text: Option<String>| text.map(|text| if text.len() > MAX_CONTENT_BYTES { TOO_LARGE.to_string() } else { text });
        let before = bound(crate::git::blob_at(&repo.dir, base, &path).map_err(git_error)?);
        let after = match head {
            Some(head) => bound(crate::git::blob_at(&repo.dir, head, &path).map_err(git_error)?),
            None => self.working_file(&repo, &path)?,
        };
        Ok(json!({ "before": before, "after": after }))
    }

    /// A working-tree file, never through a link that leaves the workspace.
    fn working_file(&self, repo: &Repo, path: &str) -> Result<Option<String>, RpcError> {
        let Ok(resolved) = std::fs::canonicalize(repo.dir.join(path)) else { return Ok(None) };
        if !resolved.starts_with(&self.root) {
            return Err(RpcError::new("path_forbidden", "the path resolves outside the workspace"));
        }
        let Ok(meta) = std::fs::metadata(&resolved) else { return Ok(None) };
        if !meta.is_file() {
            return Ok(None);
        }
        if meta.len() > MAX_CONTENT_BYTES as u64 {
            return Ok(Some(TOO_LARGE.into()));
        }
        Ok(std::fs::read(&resolved).ok().map(|bytes| String::from_utf8_lossy(&bytes).into_owned()))
    }

    fn log(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(50).clamp(1, 500) as u32;
        let from = params.get("from").and_then(Value::as_str);
        if from.is_some_and(|from| !valid_object_id(from)) {
            return Err(RpcError::invalid("from is a commit id"));
        }
        if crate::git::head_commit(&repo.dir).is_none() && from.is_none() {
            return Ok(json!({ "repo": repo.name, "commits": [] }));
        }
        let mut commits = crate::git::log_commits(&repo.dir, from, limit).map_err(git_error)?;
        for commit in &mut commits {
            truncate_text(&mut commit.body, MAX_BODY_BYTES);
        }
        Ok(json!({ "repo": repo.name, "commits": commits }))
    }

    fn branches(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let branches = crate::git::list_branches(&repo.dir).map_err(git_error)?;
        Ok(json!({
            "repo": repo.name,
            "branches": branches,
            "current": crate::git::current_branch(&repo.dir),
            "defaultBranch": crate::git::default_branch(&repo.dir),
        }))
    }

    // ---- local writes ----------------------------------------------------

    fn checkout(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let branch = required_str(params, "branch")?;
        if !valid_ref_name(branch) {
            return Err(RpcError::invalid("invalid branch name"));
        }
        let create = params.get("create").and_then(Value::as_bool).unwrap_or(false);
        let from = optional_ref(params, "from")?;
        match (create, from) {
            (true, Some(from)) => self.git(&repo, &["checkout", "-b", branch, from, "--"])?,
            (true, None) => self.git(&repo, &["checkout", "-b", branch, "--"])?,
            (false, _) => self.git(&repo, &["checkout", branch, "--"])?,
        };
        Ok(json!({ "repo": repo.name, "branch": branch }))
    }

    fn paths(&self, params: &Value, prefix: &[&str]) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let paths = Self::path_list(params)?;
        let mut args: Vec<&str> = prefix.to_vec();
        args.extend(paths.iter().map(String::as_str));
        self.git(&repo, &args)?;
        Ok(json!({ "repo": repo.name, "paths": paths }))
    }

    fn unstage(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        // Before the first commit there is no HEAD to restore from.
        if crate::git::head_commit(&repo.dir).is_some() {
            self.paths(params, &["restore", "--staged", "--"])
        } else {
            self.paths(params, &["rm", "--cached", "-r", "-q", "--"])
        }
    }

    fn commit(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let message = required_str(params, "message")?;
        if message.trim().is_empty() || message.len() > 64 * 1024 {
            return Err(RpcError::invalid("a commit message is required"));
        }
        let author: Author = params
            .get("author")
            .cloned()
            .ok_or_else(|| RpcError::invalid("author ({ name, email }) is required: commits carry the person's identity, not the workspace's"))
            .and_then(|author| serde_json::from_value(author).map_err(|error| RpcError::invalid(format!("author: {error}"))))?;
        author.check()?;
        let (name, email) = (author.name.trim(), author.email.trim());
        let staged_only = params.get("staged").and_then(Value::as_bool) == Some(true);
        let paths = match params.get("paths") {
            Some(Value::Null) | None => None,
            Some(_) => Some(Self::path_list(params)?),
        };
        match &paths {
            Some(paths) => {
                let mut args = vec!["add", "-A", "--"];
                args.extend(paths.iter().map(String::as_str));
                self.git(&repo, &args)?;
            }
            None if !staged_only => {
                self.git(&repo, &["add", "-A", "--", "."])?;
            }
            None => {}
        }
        let staged = self.git(&repo, &["diff", "--cached", "--name-only", "-z", "--"])?;
        if staged.is_empty() {
            return Err(RpcError::invalid("nothing to commit"));
        }
        let env = [
            ("GIT_AUTHOR_NAME", name),
            ("GIT_AUTHOR_EMAIL", email),
            ("GIT_COMMITTER_NAME", name),
            ("GIT_COMMITTER_EMAIL", email),
        ];
        let user_name = format!("user.name={name}");
        let user_email = format!("user.email={email}");
        let mut args = vec!["-c", &user_name, "-c", &user_email, "commit", "--quiet", "-m", message];
        if let Some(paths) = &paths {
            args.push("--");
            args.extend(paths.iter().map(String::as_str));
        }
        self.git_timed(&repo, &args, LOCAL_TIMEOUT, &env)?;
        Ok(json!({
            "repo": repo.name,
            "commit": crate::git::head_commit(&repo.dir),
            "branch": crate::git::current_branch(&repo.dir),
            "author": { "name": name, "email": email },
        }))
    }

    // ---- the remote ------------------------------------------------------

    fn fetch(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        self.git_timed(&repo, &["fetch", "--prune", "origin"], NETWORK_TIMEOUT, &[])?;
        let (ahead, behind) = crate::git::upstream_counts(&repo.dir);
        Ok(json!({ "repo": repo.name, "ahead": ahead, "behind": behind }))
    }

    fn pull(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let output = self.git_timed(&repo, &["pull", "--ff-only", "--no-rebase"], NETWORK_TIMEOUT, &[])?;
        Ok(json!({ "repo": repo.name, "output": output, "head": crate::git::head_commit(&repo.dir) }))
    }

    /// The commit `origin` has for `branch`: `Some(None)` when it has no
    /// such branch, `Err` when it could not be asked.
    fn remote_head(&self, repo: &Repo, branch: &str, timeout: Duration) -> Result<Option<String>, RpcError> {
        let reference = format!("refs/heads/{branch}");
        let out = self.git_timed(repo, &["ls-remote", "origin", &reference], timeout, &[])?;
        Ok(out
            .lines()
            .find_map(|line| line.split_once('\t').filter(|(_, name)| *name == reference).map(|(sha, _)| sha.to_string())))
    }

    fn local_head(&self, repo: &Repo, branch: &str) -> Result<String, RpcError> {
        self.git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}^{{commit}}")])
            .map(|sha| sha.trim().to_string())
            .map_err(|_| RpcError::not_found(format!("there is no local branch {branch}")))
    }

    /// Point `branch` at `origin/<branch>` once the remote has it.
    fn track(&self, repo: &Repo, branch: &str) {
        let refspec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
        let _ = self.git_timed(repo, &["fetch", "--no-tags", "origin", &refspec], NETWORK_TIMEOUT, &[]);
        let _ = self.git(repo, &["branch", &format!("--set-upstream-to=origin/{branch}"), branch]);
    }

    fn push(&self, params: &Value) -> Result<Value, RpcError> {
        self.push_with(params, |repo, branch| {
            let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
            self.run_git(&repo.dir, &["push", "--porcelain", "origin", &refspec], NETWORK_TIMEOUT, &[])
        })
    }

    fn push_with(&self, params: &Value, push: impl FnOnce(&Repo, &str) -> Result<Ran, RpcError>) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let branch = match optional_ref(params, "branch")? {
            Some(branch) => branch.to_string(),
            None => crate::git::current_branch(&repo.dir).ok_or_else(|| RpcError::invalid("HEAD is detached; name a branch to push"))?,
        };
        let local = self.local_head(&repo, &branch)?;
        let answer = |pushed: bool, reconciled: bool| {
            json!({ "repo": repo.name, "branch": branch, "head": local, "pushed": pushed, "reconciled": reconciled })
        };
        // A resend, or a retry after an answer that never arrived: ask first.
        if self.remote_head(&repo, &branch, NETWORK_TIMEOUT)?.as_deref() == Some(local.as_str()) {
            self.track(&repo, &branch);
            return Ok(answer(false, true));
        }
        let ran = push(&repo, &branch)?;
        if ran.ok {
            self.track(&repo, &branch);
            return Ok(answer(true, false));
        }
        let text = ran.text();
        let failure = classify(&text, ran.timed_out);
        if matches!(failure, Failure::Network | Failure::Other) {
            // It may have landed before the connection went.
            if let Ok(Some(remote)) = self.remote_head(&repo, &branch, NETWORK_TIMEOUT) {
                if remote == local {
                    self.track(&repo, &branch);
                    return Ok(answer(true, true));
                }
            }
        }
        Err(match failure {
            Failure::Conflict => RpcError::new(
                "conflict",
                format!("push {branch}: the remote branch has commits this one does not; pull (or fetch and merge) first: {text}"),
            ),
            other => failure_error(&format!("push {branch}"), &text, other),
        })
    }

    // ---- pull requests ---------------------------------------------------

    fn gh(&self, repo: &Repo, args: &[&str], timeout: Duration) -> Result<String, RpcError> {
        let bin = self
            .gh
            .clone()
            .or_else(|| crate::binpath::resolve("gh"))
            .ok_or_else(|| RpcError::new("unavailable", "the GitHub CLI is not installed in this workspace"))?;
        let mut command = Command::new(bin);
        command
            .current_dir(&repo.dir)
            .args(args)
            .env("PATH", crate::binpath::login_path())
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .env("NO_COLOR", "1");
        let ran = run_bounded(command, timeout).map_err(RpcError::internal)?;
        if ran.ok {
            return Ok(ran.stdout);
        }
        let text = ran.text();
        Err(failure_error(&format!("gh {}", args.iter().take(2).copied().collect::<Vec<_>>().join(" ")), &text, classify(&text, ran.timed_out)))
    }

    fn list_prs(&self, repo: &Repo, branch: &str, state: &str, timeout: Duration) -> Result<Vec<crate::github::PullRequest>, RpcError> {
        let out = self.gh(repo, &["pr", "list", "--head", branch, "--state", state, "--json", crate::github::FIELDS, "--limit", "100"], timeout)?;
        let value: Value = serde_json::from_str(&out).map_err(|error| RpcError::new("git_failed", format!("gh pr list: {error}")))?;
        let mut prs: Vec<_> = value.as_array().map(|prs| prs.iter().map(crate::github::parse_pr).collect()).unwrap_or_default();
        prs.sort_by(|a, b| (b.state == "OPEN").cmp(&(a.state == "OPEN")).then(b.number.cmp(&a.number)));
        Ok(prs)
    }

    fn branch_param(&self, repo: &Repo, params: &Value) -> Result<String, RpcError> {
        match optional_ref(params, "branch")? {
            Some(branch) => Ok(branch.to_string()),
            None => crate::git::current_branch(&repo.dir).ok_or_else(|| RpcError::invalid("HEAD is detached; name a branch")),
        }
    }

    fn prs(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let branch = self.branch_param(&repo, params)?;
        let prs = self.list_prs(&repo, &branch, "all", NETWORK_TIMEOUT)?;
        Ok(json!({ "repo": repo.name, "branch": branch, "prs": prs }))
    }

    fn pr_create(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let branch = self.branch_param(&repo, params)?;
        let title = required_str(params, "title")?.trim();
        if title.is_empty() || title.len() > 1024 {
            return Err(RpcError::invalid("a title is required"));
        }
        let body = params.get("body").and_then(Value::as_str).unwrap_or("");
        if body.len() > 64 * 1024 {
            return Err(RpcError::invalid("the description is too long"));
        }
        let base = match optional_ref(params, "base")? {
            Some(base) => base.to_string(),
            None => crate::git::default_branch(&repo.dir).ok_or_else(|| RpcError::invalid("name a base branch"))?,
        };
        if base == branch {
            return Err(RpcError::invalid("the base branch is the branch itself"));
        }
        let draft = params.get("draft").and_then(Value::as_bool).unwrap_or(false);
        let open = |prs: Vec<crate::github::PullRequest>| prs.into_iter().find(|pr| pr.state == "OPEN");
        // One open pull request per branch: a resend, or one made elsewhere, is answered with it.
        if let Some(existing) = open(self.list_prs(&repo, &branch, "open", NETWORK_TIMEOUT)?) {
            return Ok(json!({ "repo": repo.name, "pr": existing, "created": false, "existing": true }));
        }
        let local = self.local_head(&repo, &branch)?;
        if self.remote_head(&repo, &branch, NETWORK_TIMEOUT)?.as_deref() != Some(local.as_str()) {
            return Err(RpcError::new("unpushed", format!("push {branch} first: the remote does not have its latest commit")));
        }
        let mut args = vec!["pr", "create", "--title", title, "--body", body, "--base", &base, "--head", &branch];
        if draft {
            args.push("--draft");
        }
        let created = self.gh(&repo, &args, NETWORK_TIMEOUT);
        // Created or not, what GitHub now has is the answer.
        match (created, self.list_prs(&repo, &branch, "open", NETWORK_TIMEOUT).map(open)) {
            (Ok(_), Ok(Some(pr))) => Ok(json!({ "repo": repo.name, "pr": pr, "created": true, "existing": false })),
            (Err(_), Ok(Some(pr))) => Ok(json!({ "repo": repo.name, "pr": pr, "created": true, "existing": false, "reconciled": true })),
            (Ok(url), _) => Err(RpcError::new("outcome_unknown", format!("GitHub reported {} but it could not be read back yet", url.trim()))),
            (Err(error), _) => Err(error),
        }
    }

    fn pr_number(params: &Value) -> Result<String, RpcError> {
        params
            .get("number")
            .and_then(Value::as_u64)
            .filter(|number| *number > 0)
            .map(|number| number.to_string())
            .ok_or_else(|| RpcError::invalid("number is required"))
    }

    fn pr_view(&self, repo: &Repo, number: &str) -> Result<crate::github::PullRequest, RpcError> {
        let out = self.gh(repo, &["pr", "view", number, "--json", crate::github::FIELDS], NETWORK_TIMEOUT)?;
        let value: Value = serde_json::from_str(&out).map_err(|error| RpcError::new("git_failed", format!("gh pr view: {error}")))?;
        Ok(crate::github::parse_pr(&value))
    }

    fn pr_ready(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let number = Self::pr_number(params)?;
        let result = self.gh(&repo, &["pr", "ready", &number], NETWORK_TIMEOUT);
        let pr = self.pr_view(&repo, &number);
        match (result, pr) {
            (_, Ok(pr)) if !pr.is_draft => Ok(json!({ "repo": repo.name, "pr": pr })),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Ok(_), Ok(_)) => Err(RpcError::new("outcome_unknown", "GitHub still reports a draft")),
        }
    }

    fn pr_merge(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let number = Self::pr_number(params)?;
        let flag = match params.get("method").and_then(Value::as_str).unwrap_or("merge") {
            "merge" => "--merge",
            "squash" => "--squash",
            "rebase" => "--rebase",
            _ => return Err(RpcError::invalid("method is merge, squash or rebase")),
        };
        let result = self.gh(&repo, &["pr", "merge", &number, flag], NETWORK_TIMEOUT);
        // `gh pr merge` can fail with the merge already through; ask again.
        match (result, self.pr_view(&repo, &number)) {
            (_, Ok(pr)) if pr.state == "MERGED" => Ok(json!({ "repo": repo.name, "pr": pr })),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Ok(_), Ok(pr)) => Ok(json!({ "repo": repo.name, "pr": pr })),
        }
    }

    // ---- lifecycle.dispositionFacts --------------------------------------

    /// Unpublished work per repository, for the dialog before archive or
    /// delete. Read-only and bounded; a forge that cannot be asked in time is
    /// `openPullRequests: null`, never an error.
    pub fn disposition_repositories(&self) -> Vec<Value> {
        let (names, _) = self.repositories();
        names.iter().map(|name| self.repository_facts(name)).collect()
    }

    fn repository_facts(&self, name: &str) -> Value {
        let repo = Repo { name: name.to_string(), dir: self.dir(name) };
        let deadline = Instant::now() + FACTS_TIMEOUT;
        let left = || deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
        let git = |args: &[&str]| self.run_git(&repo.dir, args, left(), &[]).ok().filter(|ran| ran.ok).map(|ran| ran.stdout);
        let branch = git(&["symbolic-ref", "--short", "-q", "HEAD"]).map(|out| out.trim().to_string()).filter(|out| !out.is_empty());
        let porcelain = git(&["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
        let (dirty, untracked) = match &porcelain {
            Some(out) => {
                let mut dirty = 0u32;
                let mut untracked = 0u32;
                let mut parts = out.split('\0').filter(|part| !part.is_empty());
                while let Some(entry) = parts.next() {
                    dirty += 1;
                    if entry.starts_with("??") {
                        untracked += 1;
                    }
                    if entry.starts_with('R') || entry.starts_with('C') {
                        parts.next();
                    }
                }
                (Some(dirty), Some(untracked))
            }
            None => (None, None),
        };
        let has_upstream = git(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).is_some();
        let count = |out: Option<String>| out.and_then(|out| out.trim().parse::<u32>().ok());
        let unpushed = if has_upstream { count(git(&["rev-list", "--count", "@{upstream}..HEAD"])) } else { None };
        // Commits no remote-tracking ref has, whatever the upstream: what a delete would lose.
        let local_only = if crate::git::head_commit(&repo.dir).is_some() {
            count(git(&["rev-list", "--count", "HEAD", "--not", "--remotes"]))
        } else {
            Some(0)
        };
        let open_prs = branch.as_ref().and_then(|branch| {
            let out = self.gh(&repo, &["pr", "list", "--head", branch, "--state", "open", "--json", "number,url,state", "--limit", "20"], left()).ok()?;
            let value: Value = serde_json::from_str(&out).ok()?;
            Some(
                value
                    .as_array()?
                    .iter()
                    .map(|pr| json!({ "number": pr["number"], "url": pr["url"], "state": pr["state"].as_str().unwrap_or("OPEN").to_ascii_lowercase() }))
                    .collect::<Vec<_>>(),
            )
        });
        json!({
            "path": name,
            "branch": branch,
            "dirtyFiles": dirty,
            "untrackedFiles": untracked,
            "unpushedCommits": unpushed,
            "hasUpstream": has_upstream,
            "localOnlyCommits": local_only,
            "openPullRequests": open_prs,
        })
    }
}

fn git_error(error: anyhow::Error) -> RpcError {
    let text = format!("{error:#}");
    failure_error("git", &text, classify(&text, false))
}

#[cfg(test)]
#[path = "git_tests.rs"]
mod tests;
