//! The pipeline's hands in the app: real sessions, the reader's own `git`
//! and `gh`, and the event the issue page listens for.

use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Utc};
use tauri::{AppHandle, Manager};

use crate::github::{PinnedMerge, PrSnapshot};
use crate::issues::LinearReviewMove;
use crate::session::SessionManager;
use crate::session_ops::{NewSession, NewTab};
use crate::sink::EventSink;
use crate::store::index::{self, IssueRef, SessionEntry};
use crate::store::projects::IssuePipelineSettings;

use super::engine::{self, Diff, Host, Workspace};
use super::{store, Pipeline, SessionRef};

/// A diff past this is read for its paths only; the areas a change touches
/// are found in the paths long before a patch gets this large.
const PATCH_LIMIT: usize = 4 * 1024 * 1024;

/// The host for workspaces on this computer. It needs only what the control
/// socket also holds, so the window and the `terminalx` CLI drive the same one.
pub struct LocalHost {
    sink: Arc<dyn EventSink>,
    manager: SessionManager,
}

impl LocalHost {
    pub fn new(sink: Arc<dyn EventSink>, manager: SessionManager) -> Self {
        Self { sink, manager }
    }

    pub fn of(app: &AppHandle) -> Result<Self> {
        let manager = app.state::<crate::AppState>().manager().context("session manager is not ready")?;
        Ok(Self::new(Arc::new(app.clone()), manager))
    }
}

fn issue_number(issue: &IssueRef) -> String {
    issue.identifier.trim_start_matches('#').to_string()
}

fn linear_key() -> Result<String> {
    crate::store::settings::load().linear_api_key.filter(|key| !key.trim().is_empty()).ok_or_else(|| anyhow!("Linear is not connected. Add an API key in Settings → Integrations."))
}

/// The number at the end of a pull request URL.
pub(crate) fn pr_number(url: &str) -> Option<u64> {
    let mut parts = url.trim().trim_end_matches('/').rsplit('/');
    let number = parts.next()?.parse().ok()?;
    (parts.next()? == "pull").then_some(number)
}

/// A checkout as git reports it now.
fn workspace(cwd: &Path) -> Result<Workspace> {
    if !crate::git::is_repo(cwd) {
        bail!("{} is not a Git checkout.", cwd.display());
    }
    let status = crate::git::work_status(cwd);
    let porcelain = crate::git::run(cwd, &["status", "--porcelain", "--untracked-files=normal", "--"])?;
    Ok(Workspace {
        head: status.head.context("the checkout has no commit yet")?,
        branch: status.branch,
        default_branch: status.default_branch,
        // `XY path`: two status letters, a space, the path.
        dirty: porcelain.lines().filter_map(|line| line.get(3..)).map(String::from).collect(),
        ahead_of_base: status.ahead_of_base.unwrap_or(0),
    })
}

/// The base branch as this checkout can name it: the remote's, when it has
/// been fetched, since that is what the pull request merges into.
fn base_ref(cwd: &Path, base_branch: &str) -> String {
    let remote = format!("origin/{base_branch}");
    crate::git::resolve_base(cwd, Some(&remote)).unwrap_or_else(|_| base_branch.to_string())
}

/// What `head` changed since it left `base`: the three-dot range, so commits
/// the base gained meanwhile are not counted as the branch's.
fn diff(cwd: &Path, base: &str, head: &str) -> Result<Diff> {
    let range = format!("{base}...{head}");
    // Without rename detection: a file moved out of a protected place is
    // listed where it was as well as where it went.
    let names = crate::git::run(cwd, &["-c", "core.quotepath=off", "diff", "--name-only", "--no-renames", &range, "--"])?;
    let mut patch = crate::git::run(cwd, &["diff", "--no-color", "--no-ext-diff", &range, "--"])?;
    if patch.len() > PATCH_LIMIT {
        patch.clear();
    }
    Ok(Diff { paths: names.lines().filter(|line| !line.is_empty()).map(String::from).collect(), patch })
}

/// How long a push may take before it is given up on.
const PUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Push the checkout's branch, setting its upstream the first time. Never
/// forced, and with a deadline: a push that hangs must not hold the pipeline.
fn push(cwd: &Path) -> Result<()> {
    let branch = crate::git::current_branch(cwd).context("the checkout is not on a branch")?;
    let has_upstream = crate::git::run(cwd, &["rev-parse", "--abbrev-ref", "@{upstream}"]).is_ok();
    let args: Vec<&str> = if has_upstream { vec!["push"] } else { vec!["push", "-u", "origin", &branch] };
    crate::git::run_within(cwd, &args, PUSH_TIMEOUT, &|| false).map_err(|error| match error {
        crate::git::RunError::TimedOut => anyhow!("git push did not finish within {} minutes.", PUSH_TIMEOUT.as_secs() / 60),
        crate::git::RunError::Stopped => anyhow!("git push was stopped."),
        crate::git::RunError::Failed(message) => anyhow!("{message}"),
        crate::git::RunError::Spawn(error) => anyhow!("git could not be started: {error}"),
    })
}

impl Host for LocalHost {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }

    fn session(&self, session_id: &str) -> Result<SessionEntry> {
        index::get(session_id)
    }

    fn settings(&self, project_path: &str) -> Result<IssuePipelineSettings> {
        crate::store::projects::issue_pipeline_settings(project_path)
    }

    fn pause(&self) {
        std::thread::sleep(std::time::Duration::from_secs(2));
    }

    fn send(&self, to: &SessionRef, prompt: &str) -> Result<()> {
        self.manager.send(&to.session_id, &to.tab_id, prompt.to_string(), Vec::new())?;
        Ok(())
    }

    /// A session of its own in the author's checkout, with the author's
    /// agent and settings. It carries no issue reference: the issue page finds
    /// it through the pipeline, and it must never be taken for the session
    /// that is working on the issue.
    fn open_reviewer(&self, pipeline: &Pipeline, author: &SessionEntry) -> Result<SessionRef> {
        let tab = author.tab(&pipeline.author.tab_id).context("the author's conversation is gone")?;
        let title: String = format!("Review {} {}", pipeline.issue.identifier, pipeline.issue.title).chars().take(80).collect();
        let entry = crate::session_ops::create_session_blocking(
            &*self.sink,
            NewSession {
                project_path: author.project_path.clone(),
                title: Some(title),
                use_worktree: false,
                base_ref: None,
                worktree_name: None,
                on_main: false,
                issue: None,
                automation: None,
                cwd: Some(author.cwd.clone()),
                tab: Some(NewTab { harness: tab.harness.clone(), model: tab.model.clone(), effort: tab.effort.clone(), permission_mode: Some(tab.permission_mode.clone()) }),
            },
        )
        .map_err(anyhow::Error::msg)?;
        let tab = entry.tabs.first().context("the reviewer session has no tab")?;
        Ok(SessionRef { session_id: entry.id.clone(), tab_id: tab.id.clone() })
    }

    fn workspace(&self, cwd: &Path) -> Result<Workspace> {
        workspace(cwd)
    }

    fn base_ref(&self, cwd: &Path, base_branch: &str) -> String {
        base_ref(cwd, base_branch)
    }

    fn diff(&self, cwd: &Path, base: &str, head: &str) -> Result<Diff> {
        diff(cwd, base, head)
    }

    fn push(&self, cwd: &Path) -> Result<()> {
        push(cwd)
    }

    fn open_pull_request(&self, cwd: &Path, branch: &str) -> Result<Option<PrSnapshot>> {
        match crate::github::prs_for_branch(cwd, branch)?.into_iter().find(|pr| pr.state == "OPEN") {
            Some(open) => crate::github::pr_snapshot(cwd, open.number).map(Some),
            None => Ok(None),
        }
    }

    fn create_pull_request(&self, cwd: &Path, title: &str, body: &str) -> Result<u64> {
        let base = crate::git::default_branch(cwd);
        let url = crate::github::create_pr(cwd, title, body, base.as_deref(), false)?;
        pr_number(&url).with_context(|| format!("GitHub opened the pull request but answered with {url:?}, which names no number."))
    }

    fn pull_request(&self, cwd: &Path, number: u64) -> Result<PrSnapshot> {
        crate::github::pr_snapshot(cwd, number)
    }

    fn edit_pull_request_body(&self, cwd: &Path, number: u64, body: &str) -> Result<()> {
        crate::github::edit_pr_body(cwd, number, body)
    }

    fn comment(&self, cwd: &Path, number: u64, body: &str) -> Result<String> {
        crate::github::comment_pr(cwd, number, body)
    }

    fn merge(&self, cwd: &Path, number: u64, method: &str, commit: &str) -> Result<PinnedMerge> {
        crate::github::merge_pr_at(cwd, number, method, commit)
    }

    fn issue_body(&self, project_path: &str, issue: &IssueRef) -> Option<String> {
        let details = if issue.provider == "linear" {
            crate::issues::linear_details(&linear_key().ok()?, &issue.id)
        } else {
            crate::issues::github_details(Path::new(project_path), &issue_number(issue))
        };
        details.ok()?.body
    }

    fn move_to_review(&self, issue: &IssueRef) -> Result<Option<String>> {
        if issue.provider != "linear" {
            return Ok(None);
        }
        Ok(Some(match crate::issues::linear_move_to_review(&linear_key()?, &issue.id)? {
            LinearReviewMove::Moved(state) => format!("Moved {} to {state} in Linear.", issue.identifier),
            LinearReviewMove::Unchanged(state) => format!("{} is {state} in Linear and was left there.", issue.identifier),
            LinearReviewMove::NoReviewState => format!("{} was left where it is: its Linear team has no review state.", issue.identifier),
        }))
    }

    fn changed(&self, pipeline: &Pipeline) {
        self.sink.emit("issue_pipeline", pipeline);
    }
}

/// Whether a tab is the author or the reviewer of some pipeline. Asked on
/// every turn that ends anywhere, so it reads the store and nothing else.
fn takes_part(session_id: &str, tab_id: &str) -> bool {
    store::for_session(session_id).ok().flatten().is_some_and(|pipeline| pipeline.role_of(session_id, tab_id).is_some())
}

fn off_thread(app: &AppHandle, work: impl FnOnce(&LocalHost) + Send + 'static) {
    let Ok(host) = LocalHost::of(app) else {
        return;
    };
    let _ = std::thread::Builder::new().name("issue-pipeline".into()).spawn(move || work(&host));
}

/// A turn ended. Called from the hook thread, which must get back to the
/// agent at once: everything a pipeline does about it happens elsewhere.
pub fn turn_completed(app: &AppHandle, session_id: &str, tab_id: &str, final_message: Option<String>) {
    if !takes_part(session_id, tab_id) {
        return;
    }
    let (session_id, tab_id) = (session_id.to_string(), tab_id.to_string());
    off_thread(app, move |host| engine::turn_completed(host, &session_id, &tab_id, final_message.as_deref()));
}

pub fn turn_failed(app: &AppHandle, session_id: &str, tab_id: &str, interrupted: bool) {
    if !takes_part(session_id, tab_id) {
        return;
    }
    let (session_id, tab_id) = (session_id.to_string(), tab_id.to_string());
    let detail = if interrupted { "Its turn was interrupted." } else { "Its agent ended before the turn finished." };
    off_thread(app, move |host| engine::turn_failed(host, &session_id, &tab_id, detail));
}

/// Watch the pull requests that pipelines are waiting on.
pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("issue-pipeline-poll".into())
        .spawn(move || {
            let host = match LocalHost::of(&app) {
                Ok(host) => host,
                Err(error) => return log::warn!("issue pipelines are not watched: {error:#}"),
            };
            engine::recover(&host);
            loop {
                std::thread::sleep(std::time::Duration::from_secs(30));
                engine::poll(&host);
            }
        })
        .expect("start the issue pipeline poller");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(cwd: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .current_dir(cwd)
            .args(["-c", "user.name=T", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A real repository: `main` with one commit, and a branch off it.
    fn repository() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q", "-b", "main"]);
        std::fs::write(root.join("README.md"), "one\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "first"]);
        git(root, &["checkout", "-q", "-b", "raccoon/433-work"]);
        dir
    }

    #[test]
    fn a_checkout_is_read_for_its_commit_its_branch_and_what_is_uncommitted() {
        let dir = repository();
        let root = dir.path();
        let fresh = workspace(root).unwrap();
        assert_eq!(fresh.head, git(root, &["rev-parse", "HEAD"]));
        assert_eq!((fresh.branch.as_deref(), fresh.default_branch.as_deref()), (Some("raccoon/433-work"), Some("main")));
        assert!(fresh.dirty.is_empty());
        assert_eq!(fresh.ahead_of_base, 0, "a branch with nothing of its own has nothing to open a pull request for");

        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/auth.rs"), "fn check() {}\n").unwrap();
        std::fs::write(root.join("README.md"), "one\ntwo\n").unwrap();
        // Untracked and modified both count: either would be left out of the pull request.
        let mut dirty = workspace(root).unwrap().dirty;
        dirty.sort();
        assert_eq!(dirty, ["README.md", "src/"]);

        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "second"]);
        let committed = workspace(root).unwrap();
        assert!(committed.dirty.is_empty());
        assert_eq!(committed.ahead_of_base, 1);
        assert_ne!(committed.head, fresh.head);

        assert!(workspace(tempfile::tempdir().unwrap().path()).unwrap_err().to_string().contains("is not a Git checkout"));
    }

    #[test]
    fn a_push_goes_to_the_branchs_own_remote_branch_and_a_refusal_is_reported_in_gits_words() {
        let dir = repository();
        let root = dir.path();
        let remote = tempfile::tempdir().unwrap();
        git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
        git(root, &["remote", "add", "origin", remote.path().to_str().unwrap()]);
        std::fs::write(root.join("work.txt"), "work\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "work"]);
        // The first push names the upstream; the remote gets this branch and no other.
        push(root).unwrap();
        assert_eq!(git(remote.path(), &["for-each-ref", "--format=%(refname)"]), "refs/heads/raccoon/433-work");
        assert_eq!(git(remote.path(), &["rev-parse", "refs/heads/raccoon/433-work"]), git(root, &["rev-parse", "HEAD"]));
        // Later pushes follow it.
        std::fs::write(root.join("work.txt"), "more\n").unwrap();
        git(root, &["commit", "-q", "-am", "more"]);
        push(root).unwrap();
        assert_eq!(git(remote.path(), &["rev-parse", "refs/heads/raccoon/433-work"]), git(root, &["rev-parse", "HEAD"]));
        // A push the remote will not take (history rewritten locally) is not forced.
        git(root, &["reset", "-q", "--hard", "HEAD~1"]);
        std::fs::write(root.join("work.txt"), "different\n").unwrap();
        git(root, &["commit", "-q", "-am", "different"]);
        let refused = push(root).unwrap_err().to_string();
        assert!(refused.contains("rejected") || refused.contains("non-fast-forward"), "{refused}");
        assert_ne!(git(remote.path(), &["rev-parse", "refs/heads/raccoon/433-work"]), git(root, &["rev-parse", "HEAD"]));
    }

    #[test]
    fn a_branchs_diff_is_what_it_changed_and_not_what_its_base_gained() {
        let dir = repository();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/auth.rs"), "fn check_permissions() {}\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "branch work"]);
        let head = git(root, &["rev-parse", "HEAD"]);
        // Meanwhile main moves on with a file of its own.
        git(root, &["checkout", "-q", "main"]);
        std::fs::write(root.join("deploy.yml"), "on: push\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "main moves"]);
        git(root, &["checkout", "-q", "raccoon/433-work"]);

        // With no remote, the base is the local branch.
        let base = base_ref(root, "main");
        assert_eq!(base, "main");
        let changed = diff(root, &base, &head).unwrap();
        assert_eq!(changed.paths, ["src/auth.rs"]);
        assert!(changed.patch.contains("+fn check_permissions() {}") && !changed.patch.contains("deploy.yml"));
        // And it is what the security pass and the protected categories are judged on.
        assert_eq!(crate::issue_pipeline::categories::security_areas(&changed.paths, &changed.patch), ["authorization"]);

        // A file moved out of a protected place is still a change to that place.
        git(root, &["mv", "src/auth.rs", "notes.txt"]);
        git(root, &["commit", "-q", "-m", "move it"]);
        let moved = diff(root, &base, &git(root, &["rev-parse", "HEAD"])).unwrap();
        assert_eq!(moved.paths, ["notes.txt"], "added and removed again within the branch: only where it ended up");
        git(root, &["checkout", "-q", "main"]);
        std::fs::create_dir_all(root.join("db/migrations")).unwrap();
        std::fs::write(root.join("db/migrations/0042_add.sql"), "create table plans (id int);\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "a migration on main"]);
        git(root, &["checkout", "-q", "-b", "raccoon/434-move", "main"]);
        git(root, &["mv", "db/migrations/0042_add.sql", "old.txt"]);
        git(root, &["commit", "-q", "-m", "move the migration away"]);
        let mut renamed = diff(root, "main", &git(root, &["rev-parse", "HEAD"])).unwrap().paths;
        renamed.sort();
        assert_eq!(renamed, ["db/migrations/0042_add.sql", "old.txt"]);
        git(root, &["checkout", "-q", "raccoon/433-work"]);

        // A fetched remote branch is preferred: it is what the pull request merges into.
        git(root, &["update-ref", "refs/remotes/origin/main", "main"]);
        assert_eq!(base_ref(root, "main"), "origin/main");
        assert_eq!(diff(root, "origin/main", &head).unwrap().paths, ["src/auth.rs"]);
        assert!(diff(root, "origin/main", "0000000").is_err());
    }

    #[test]
    fn a_pull_request_number_is_read_from_the_url_gh_prints() {
        assert_eq!(pr_number("https://github.com/acme/widgets/pull/433\n"), Some(433));
        assert_eq!(pr_number("https://github.com/acme/widgets/pull/433/"), Some(433));
        assert_eq!(pr_number("https://github.com/acme/widgets/issues/433"), None);
        assert_eq!(pr_number("Creating pull request..."), None);
        assert_eq!(pr_number(""), None);
    }
}
