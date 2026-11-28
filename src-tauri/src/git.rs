//! Git, by shelling out. The only other thing this module shells out to is
//! nothing: `gh` lives in `github.rs`.
//!
//! Every diff invocation ends in `--`, or a working-tree file named like a sha
//! makes git die with "ambiguous argument".

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

#[cfg(unix)]
#[path = "git_ssh.rs"]
pub(crate) mod ssh;

pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[path = "git_checkpoints.rs"]
pub mod checkpoints;

#[path = "git_worktree_identity.rs"]
pub(crate) mod worktree_identity;

#[path = "git_shared.rs"]
pub(crate) mod shared;

pub(crate) fn git() -> Command {
    let mut c = Command::new(crate::binpath::resolve("git").unwrap_or_else(|| PathBuf::from("git")));
    c.env("PATH", crate::binpath::login_path());
    c.env("GIT_TERMINAL_PROMPT", "0");
    // Inspection must not turn a missing partial-clone object into a transfer.
    // Explicit fetches still use their admission boundary. This environment is
    // scoped to our Git child, never the application or an agent's process.
    c.env("GIT_NO_LAZY_FETCH", "1");
    c.env("LC_ALL", "C");
    // Paths past Windows' 260-character limit: a checkpoint's ref under
    // `.git/refs` alone is about 130 of them, so a repository a little deep
    // in the disk could not be checkpointed or reset without this.
    // Added after any configuration this process was itself given that way.
    #[cfg(windows)]
    {
        let given = std::env::var("GIT_CONFIG_COUNT").ok().and_then(|count| count.parse::<usize>().ok()).unwrap_or(0);
        c.env("GIT_CONFIG_COUNT", (given + 1).to_string())
            .env(format!("GIT_CONFIG_KEY_{given}"), "core.longpaths")
            .env(format!("GIT_CONFIG_VALUE_{given}"), "true");
    }
    c
}

/// A path Git printed on a line of its own, without its line ending. Only the
/// ending is removed: a file name may itself end in whitespace.
pub(crate) fn path_line(out: &str) -> &str {
    let line = out.strip_suffix('\n').unwrap_or(out);
    #[cfg(windows)]
    let line = line.strip_suffix('\r').unwrap_or(line);
    line
}

/// Git subcommands that run no ordinary hooks, so a command bound to a
/// verified checkout may name its Git directory and work tree in the
/// environment (see `bind`). Git exports both to hooks, and a hook that runs
/// Git from a subdirectory would then fail or see the wrong top level, so a
/// command that can run hooks is only started in the checkout. Index writers
/// among these can still run `post-index-change` and the `core.fsmonitor`
/// program, which then see those variables too.
pub(crate) const HOOKLESS: &[&str] = &[
    "add", "cat-file", "check-ignore", "cherry", "config", "diff", "diff-tree", "for-each-ref", "hash-object", "log",
    "ls-files", "ls-remote", "ls-tree", "merge-base", "merge-tree", "patch-id", "remote", "restore", "rev-list",
    "rev-parse", "rm", "show", "show-ref", "status", "symbolic-ref", "update-index", "write-tree",
];

/// The subcommand of `args`, past the options before it.
#[cfg_attr(not(unix), allow(dead_code))]
fn subcommand<'a>(args: &[&'a str]) -> Option<&'a str> {
    let mut args = args.iter().copied();
    while let Some(arg) = args.next() {
        if matches!(arg, "-c" | "--config-env" | "-C") { args.next(); continue; }
        if arg.starts_with('-') { continue; }
        return Some(arg);
    }
    None
}

/// Start `command` in the opened `directory`, whatever its path names now.
#[cfg(unix)]
pub(crate) fn start_in(command: &mut Command, directory: std::os::unix::io::RawFd) {
    use std::os::unix::process::CommandExt;
    // SAFETY: the closure runs in the forked child before exec and only calls
    // fchdir, which is async-signal-safe. The caller keeps the descriptor
    // open for as long as commands may start in it.
    unsafe {
        command.pre_exec(move || if libc::fchdir(directory) == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) });
    }
}

#[cfg(unix)]
thread_local! {
    /// Checkouts bound on this thread: each binding's own token, the path
    /// callers name (canonical when it resolves), the opened top-level
    /// directory, and the Git directory (relative to it when inside).
    static BOUND: std::cell::RefCell<Vec<(u64, PathBuf, std::os::unix::io::RawFd, PathBuf)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Hands each binding a token of its own, so it releases only its entry.
#[cfg(unix)]
static NEXT_BINDING: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A checkout bound for this thread while it lives (see `bind`). Not `Send`:
/// it is released on the thread that bound it.
pub(crate) struct Bound {
    #[cfg(unix)]
    token: u64,
    _thread: std::marker::PhantomData<std::sync::MutexGuard<'static, ()>>,
}

/// Bind `path` to the verified checkout opened as `top` with its Git
/// directory `git_dir`. While the returned value lives, local Git commands
/// this module starts on this thread for exactly `path` start in the opened
/// directory instead of changing to the path (spelled as given or
/// canonically), so they reach that checkout
/// even if another one is put at the path; a `HOOKLESS` one also names the
/// Git directory and work tree, so a `core.worktree` written later is not
/// read. Transfers, other threads and other paths are unaffected. `top` must
/// outlive the binding. Off Unix nothing is bound.
pub(crate) fn bind(path: &Path, #[cfg(unix)] top: &std::fs::File, #[cfg(unix)] git_dir: &Path) -> Bound {
    #[cfg(unix)]
    let token = {
        use std::os::unix::io::AsRawFd;
        let token = NEXT_BINDING.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = crate::paths::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        BOUND.with(|bound| bound.borrow_mut().push((token, path, top.as_raw_fd(), git_dir.to_path_buf())));
        token
    };
    #[cfg(not(unix))]
    let _ = path;
    Bound {
        #[cfg(unix)]
        token,
        _thread: std::marker::PhantomData,
    }
}

impl Drop for Bound {
    fn drop(&mut self) {
        #[cfg(unix)]
        BOUND.with(|bound| {
            let mut bound = bound.borrow_mut();
            bound.retain(|(token, ..)| *token != self.token);
        });
    }
}

/// The binding for `cwd`, matched by its spelling or, failing that, its
/// canonical path.
#[cfg(unix)]
fn bound_at(cwd: &Path) -> Option<(std::os::unix::io::RawFd, PathBuf)> {
    BOUND.with(|bound| {
        let bound = bound.borrow();
        if bound.is_empty() {
            return None;
        }
        let find = |cwd: &Path| bound.iter().rev().find(|(_, path, ..)| path == cwd).map(|(_, _, fd, dir)| (*fd, dir.clone()));
        find(cwd).or_else(|| find(&crate::paths::canonicalize(cwd).ok()?))
    })
}

/// A local Git command in `cwd`, for a command whose arguments are `args`:
/// started in a bound checkout when `cwd` names one (see `bind`).
pub(crate) fn git_in(cwd: &Path, args: &[&str]) -> Command {
    #[cfg(not(unix))]
    let _ = args;
    let mut command = git();
    #[cfg(unix)]
    if let Some((directory, git_dir)) = bound_at(cwd) {
        start_in(&mut command, directory);
        if subcommand(args).is_some_and(|sub| HOOKLESS.contains(&sub)) {
            command.env("GIT_DIR", git_dir).env("GIT_WORK_TREE", ".").env_remove("GIT_COMMON_DIR");
        }
        return command;
    }
    command.current_dir(cwd);
    command
}

pub fn run(cwd: &Path, args: &[&str]) -> Result<String> {
    if transfer_args(args) { return transfer(cwd, args); }
    run_command(&mut git_in(cwd, args), args)
}

pub(crate) fn run_command(command: &mut Command, args: &[&str]) -> Result<String> {
    let out = command.args(args).output().with_context(|| format!("git {}", args.join(" ")))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        bail!("git {}: {}", args.join(" "), if err.is_empty() { format!("exit {}", out.status) } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn transfer_args(args: &[&str]) -> bool {
    let mut args = args.iter().copied();
    while let Some(arg) = args.next() {
        if matches!(arg, "-c" | "--config-env") { args.next(); continue; }
        if arg.starts_with("-c") || arg.starts_with("--config-env=") { continue; }
        return matches!(arg, "fetch" | "pull" | "push" | "clone" | "ls-remote");
    }
    false
}

/// Reject a dynamic ref, branch, remote, or revision range that could be
/// interpreted by Git as an option flag.
fn reject_dash_arg(kind: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.starts_with('-') || value.contains('\0') {
        bail!("invalid git {kind}");
    }
    Ok(())
}

/// Refresh this project's comparison branch for landed/cleanup verification.
/// Submodules are outside that check (and prevent a verified safe deletion).
/// Never recurse: child repositories are outside this verification contract.
/// The SSH boundary is shared with ordinary transfers, including its proxy
/// refusal; agent processes keep their own runners.
pub(crate) fn fetch_admitted(cwd: &Path, branch: &str, timeout: std::time::Duration) -> Result<()> {
    reject_dash_arg("branch", branch)?;
    let _request = crate::github_process::scope();
    let mut command = git();
    command.current_dir(cwd).args(["fetch", "--quiet", "--no-recurse-submodules", "--end-of-options", "origin", branch]);
    let output = crate::github_process::git_verification_output(command, timeout)?;
    if !output.status.success() {
        bail!("git fetch: {}", String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(())
}

/// A bounded ignored-file scan. Stop Git when its output reaches the byte
/// limit; never decode a partial NUL-delimited name at that boundary.
pub(crate) fn file_names_bounded(mut command: Command, args: &[&str], max_files: usize, max_bytes: usize) -> Result<(Vec<String>, bool)> {
    use std::io::Read;
    use std::process::Stdio;
    let mut child = command.args(args).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
    let mut bytes = Vec::new();
    let read = child.stdout.take().context("Missing Git output")?.take(max_bytes as u64 + 1).read_to_end(&mut bytes);
    let byte_limit = bytes.len() > max_bytes;
    if read.is_err() || byte_limit { let _ = child.kill(); }
    let status = child.wait()?;
    read?;
    anyhow::ensure!(byte_limit || status.success(), "Git ignored-file listing failed");
    if byte_limit {
        bytes.truncate(max_bytes);
        bytes.truncate(bytes.iter().rposition(|byte| *byte == 0).map_or(0, |index| index + 1));
    }
    let names = String::from_utf8(bytes).context("A file name is not valid UTF-8")?;
    let mut all = names.split('\0').filter(|name| !name.is_empty());
    let files = all.by_ref().take(max_files).map(String::from).collect();
    Ok((files, byte_limit || all.next().is_some()))
}

/// Unlike --no-index, check-ignore's default also rejects tracked paths,
/// including tracked files absent from disk. Both conditions must hold before
/// copying secrets into a checkout whose ignore rules may differ from the source.
pub(crate) fn ignored_untracked_paths(mut command: Command, paths: &[String]) -> Result<std::collections::BTreeSet<String>> {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = command.args(["check-ignore", "-z", "--stdin"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let mut stdin = child.stdin.take().context("Missing Git input")?;
    let input = paths.join("\0") + "\0";
    // Feed stdin while wait_with_output drains stdout, avoiding pipe deadlocks.
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
    let output = child.wait_with_output();
    let written = writer.join().map_err(|_| anyhow!("Git input writer stopped"))?;
    let output = output?;
    anyhow::ensure!(matches!(output.status.code(), Some(0 | 1)), "Git ignore check failed: {}", String::from_utf8_lossy(&output.stderr));
    written?;
    Ok(String::from_utf8(output.stdout)?.split('\0').filter(|name| !name.is_empty()).map(String::from).collect())
}

/// `run` for a command whose exit code is an answer (`merge-tree`): the code
/// and stdout, or `None` when git could not be started or was killed.
pub fn raw(cwd: &Path, args: &[&str]) -> Option<(i32, String)> {
    let transfer = transfer_args(args);
    let mut command = if transfer { let mut command = git(); command.current_dir(cwd); command } else { git_in(cwd, args) };
    command.args(args);
    let out = if transfer { crate::github_process::git_output_admitted(command, crate::github_process::TIMEOUT, crate::github_process::ticket()).ok()? }
        else { command.output().ok()? };
    Some((out.status.code()?, String::from_utf8_lossy(&out.stdout).into_owned()))
}

/// Inspect local objects while retaining exit status and diagnostic output.
/// Missing promised objects are errors, never an implicit network request.
pub(crate) fn inspect_output(cwd: &Path, args: &[&str]) -> Result<std::process::Output> {
    anyhow::ensure!(!transfer_args(args), "a transfer is not a local Git inspection");
    git_in(cwd, args).args(args).output().with_context(|| format!("git {}", args.join(" ")))
}

/// Why `run_within` did not succeed.
#[derive(Debug)]
pub enum RunError {
    /// Still running at the deadline; killed.
    TimedOut,
    /// `stop` said to give up; killed.
    Stopped,
    /// Git exited with an error: what it wrote to stderr.
    Failed(String),
    /// Git could not be started.
    Spawn(std::io::Error),
}

/// `run` for a transfer that may never end: it has a deadline, and `stop` is
/// asked while it runs. Either way the whole process group is killed, so no
/// transport or credential helper is left behind.
pub fn run_within(cwd: &Path, args: &[&str], timeout: std::time::Duration, stop: &dyn Fn() -> bool) -> std::result::Result<(), RunError> {
    run_within_reporting(cwd, args, timeout, stop, |_| {})
}

/// `run_within`, handing each line Git writes to stderr to `on_line` as it
/// comes. With `--progress` Git redraws a line by ending it with a carriage
/// return, so those count as lines too. A failure carries only what was not
/// progress.
pub fn run_within_reporting(
    cwd: &Path,
    args: &[&str],
    timeout: std::time::Duration,
    stop: &dyn Fn() -> bool,
    on_line: impl Fn(&str) + Send + 'static,
) -> std::result::Result<(), RunError> {
    let _request = crate::github_process::scope();
    let mut command = git();
    command.current_dir(cwd).args(args);
    let out = crate::github_process::git_output_reporting(command, timeout, crate::github_process::ticket(), stop, Some(Box::new(on_line)))
        .map_err(transfer_error)?;
    transfer_result(out).map(|_| ())
}

fn transfer_error(error: anyhow::Error) -> RunError {
    if error.is::<crate::github_process::TimedOut>() { RunError::TimedOut }
    else if error.is::<crate::github_process::Stopped>() { RunError::Stopped }
    else { match error.downcast::<std::io::Error>() { Ok(error) => RunError::Spawn(error), Err(error) => RunError::Failed(error.to_string()) } }
}

fn transfer_result(out: std::process::Output) -> std::result::Result<String, RunError> {
    if out.status.success() { return Ok(String::from_utf8_lossy(&out.stdout).into_owned()); }
    let err = String::from_utf8_lossy(&out.stderr);
    Err(RunError::Failed(if err.trim().is_empty() { format!("exit {}", out.status) } else { err.trim().to_string() }))
}

pub(crate) fn transfer_output(cwd: &Path, args: &[&str], timeout: std::time::Duration) -> std::result::Result<String, RunError> {
    let _request = crate::github_process::scope();
    let mut command = git();
    command.current_dir(cwd).args(args);
    transfer_result(crate::github_process::git_output_admitted(command, timeout, crate::github_process::ticket()).map_err(transfer_error)?)
}

/// Run `command` to its end or to the deadline, whichever comes first, and
/// return what it printed. The deadline includes draining both output pipes;
/// at expiry its whole process group is killed, even if the direct child has
/// already exited. For a call whose complete answer is needed.
pub(crate) fn output_within(command: Command, timeout: std::time::Duration) -> std::result::Result<String, RunError> {
    answer_of(capture_within(command, timeout))
}

/// [`output_within`] for a one-shot program given `input` on stdin, so long or
/// private text is never on a command line. On Windows it runs without a
/// console, and everything it started ends with it.
pub(crate) fn output_feeding(command: Command, input: Vec<u8>, timeout: std::time::Duration) -> std::result::Result<String, RunError> {
    answer_of(capture(command, Some(input), None, timeout))
}

/// [`output_feeding`] that also ends, with `ErrorKind::Interrupted`, once `cancel` is set.
#[cfg(feature = "desktop")]
pub(crate) fn output_feeding_until(command: Command, input: Vec<u8>, timeout: std::time::Duration, cancel: &std::sync::atomic::AtomicBool) -> std::result::Result<String, RunError> {
    answer_of(capture(command, Some(input), Some(cancel), timeout))
}

fn answer_of(captured: std::io::Result<std::process::Output>) -> std::result::Result<String, RunError> {
    let out = captured.map_err(|error| match error.kind() {
        std::io::ErrorKind::TimedOut => RunError::TimedOut,
        _ => RunError::Spawn(error),
    })?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(RunError::Failed(if err.trim().is_empty() { format!("exit {}", out.status) } else { err.trim().to_string() }))
    }
}

/// `Command::output` with a deadline: the exit status and everything written
/// to both pipes, whatever the status. Both pipes are drained while the child
/// runs, so an answer larger than the pipe buffer never blocks it. A deadline
/// that passes, draining included, is an `ErrorKind::TimedOut` error, and the
/// whole process group has been killed.
pub(crate) fn capture_within(command: Command, timeout: std::time::Duration) -> std::io::Result<std::process::Output> {
    capture(command, None, None, timeout)
}

fn capture(mut command: Command, input: Option<Vec<u8>>, cancel: Option<&std::sync::atomic::AtomicBool>, timeout: std::time::Duration) -> std::io::Result<std::process::Output> {
    use std::io::{Read, Write};
    let cancelled = || cancel.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::SeqCst));
    use std::process::Stdio;
    command.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    #[cfg(unix)]
    let mut child = command.spawn()?;
    // Only a one-shot program: a job would also end a daemon git left running.
    // It joins the job before it runs, so nothing it starts can escape.
    #[cfg(windows)]
    let tied = input.is_some();
    #[cfg(windows)]
    let mut child = if tied {
        crate::win::process::spawn_tied(&mut command, windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)?
    } else {
        command.spawn()?
    };
    if let Some(bytes) = input {
        let stdin = child.stdin.take();
        // Beside the reads: the program may answer before it has read all of this.
        std::thread::spawn(move || {
            if let Some(mut stdin) = stdin {
                let _ = stdin.write_all(&bytes);
            }
        });
    }
    // Read as it comes, so a full pipe never blocks the child.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            bytes
        })
    };
    let stdout = drain(child.stdout.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            // A wrapper can exit while a background child retains its pipes.
            // Do not join a reader until EOF, or accept output after expiry.
            Ok(Some(status)) if stdout.is_finished() && stderr.is_finished() && std::time::Instant::now() < deadline && !cancelled() => break status,
            Ok(_) if std::time::Instant::now() < deadline && !cancelled() => std::thread::sleep(std::time::Duration::from_millis(20)),
            ended => {
                #[cfg(unix)]
                // SAFETY: signals the process group this function just created.
                unsafe {
                    libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
                }
                #[cfg(windows)]
                if tied {
                    crate::win::process::kill_tree(child.id());
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err(match ended {
                    Err(error) => error,
                    _ if cancelled() => std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled"),
                    _ => std::io::Error::new(std::io::ErrorKind::TimedOut, format!("no answer within {} ms", timeout.as_millis())),
                });
            }
        }
    };
    #[cfg(windows)]
    if tied {
        crate::win::process::kill_tree(child.id());
    }
    Ok(std::process::Output { status, stdout: stdout.join().unwrap_or_default(), stderr: stderr.join().unwrap_or_default() })
}

/// `run` with a deadline.
pub fn run_bounded(cwd: &Path, args: &[&str], timeout: std::time::Duration) -> std::result::Result<String, RunError> {
    if transfer_args(args) { return transfer_output(cwd, args, timeout); }
    let mut command = git_in(cwd, args);
    command.args(args);
    output_within(command, timeout)
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TimedOut => write!(f, "no answer in time"),
            Self::Stopped => write!(f, "it was stopped"),
            Self::Failed(text) => write!(f, "{}", text.lines().next().unwrap_or(text)),
            Self::Spawn(error) => write!(f, "it could not be started: {error}"),
        }
    }
}

/// Run `git <first>` with its output fed to `git <second>`, and return what
/// the second prints. For the plumbing pairs git expects to be piped
/// (`log -p | patch-id`).
pub fn pipe(cwd: &Path, first: &[&str], second: &[&str]) -> Result<String> {
    use std::process::Stdio;
    let mut source = git_in(cwd, first).args(first).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().with_context(|| format!("git {}", first.join(" ")))?;
    let feed = source.stdout.take().context("no pipe from git")?;
    let out = git_in(cwd, second).args(second).stdin(Stdio::from(feed)).output().with_context(|| format!("git {}", second.join(" ")));
    let produced = source.wait()?;
    let out = out?;
    if !produced.success() {
        bail!("git {}: exit {produced}", first.join(" "));
    }
    if !out.status.success() {
        bail!("git {}: {}", second.join(" "), String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Run git with extra environment variables.
pub fn run_env(cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> Result<String> {
    let transfer = transfer_args(args);
    let mut command = if transfer { let mut command = git(); command.current_dir(cwd); command } else { git_in(cwd, args) };
    command.args(args).envs(env.iter().copied());
    let out = if transfer { crate::github_process::git_output_admitted(command, crate::github_process::TIMEOUT, crate::github_process::ticket())? }
        else { command.output().with_context(|| format!("git {}", args.join(" ")))? };
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        bail!("git {}: {}", args.join(" "), if err.is_empty() { format!("exit {}", out.status) } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn run_ok(cwd: &Path, args: &[&str]) -> bool {
    if transfer_args(args) { return transfer(cwd, args).is_ok(); }
    git_in(cwd, args).args(args).output().map(|o| o.status.success()).unwrap_or(false)
}

/// What Git makes by itself of merging `theirs` into `ours`
/// (`merge-tree --write-tree`): the tree, and whether it holds conflicts.
/// No checkout or index is touched; the objects it writes are unreferenced.
pub fn merge_tree(cwd: &Path, ours: &str, theirs: &str) -> Result<(String, bool)> {
    reject_dash_arg("revision", ours)?;
    reject_dash_arg("revision", theirs)?;
    let out = git_in(cwd, &["merge-tree"]).args(["merge-tree", "--write-tree", "--end-of-options", ours, theirs]).output().context("git merge-tree")?;
    // Exit 1 is "merged, with conflicts": the tree is still printed first.
    let conflicted = match out.status.code() {
        Some(0) => false,
        Some(1) => true,
        _ => bail!("git merge-tree: {}", String::from_utf8_lossy(&out.stderr).trim()),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let tree = stdout.lines().next().map(str::trim).filter(|tree| is_tree_id(tree)).context("git merge-tree printed no tree")?;
    Ok((tree.to_string(), conflicted))
}

/// The Git operation under way in the checkout, if one is: a merge, a
/// rebase, a cherry-pick, a revert or a bisect left part way.
pub fn operation_in_progress(cwd: &Path) -> Result<Option<&'static str>> {
    let dir = run(cwd, &["rev-parse", "--absolute-git-dir"])?;
    let dir = Path::new(path_line(&dir));
    let marks = [
        ("MERGE_HEAD", "merge"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("BISECT_LOG", "bisect"),
        ("sequencer", "cherry-pick or revert"),
    ];
    Ok(marks.into_iter().find(|(mark, _)| std::fs::symlink_metadata(dir.join(mark)).is_ok()).map(|(_, what)| what))
}

/// The paths `git status --porcelain -z` lists as unmerged.
pub(crate) fn unmerged_in(porcelain: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut entries = porcelain.split('\0').filter(|entry| !entry.is_empty());
    while let Some(entry) = entries.next() {
        let (Some(flags), Some(path)) = (entry.get(..2), entry.get(3..)) else { continue };
        // A rename or copy is followed by the path it came from.
        if flags.starts_with(['R', 'C']) {
            entries.next();
        }
        if matches!(flags, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU") {
            out.push(path.to_string());
        }
    }
    out
}

pub fn is_repo(cwd: &Path) -> bool {
    run_ok(cwd, &["rev-parse", "--is-inside-work-tree"])
}

pub fn current_branch(cwd: &Path) -> Option<String> {
    run(cwd, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn default_branch(cwd: &Path) -> Option<String> {
    if let Ok(s) = run(cwd, &["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]) {
        let s = s.trim();
        return Some(s.strip_prefix("origin/").unwrap_or(s).to_string());
    }
    for cand in ["main", "master"] {
        if run_ok(cwd, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{cand}")]) {
            return Some(cand.to_string());
        }
    }
    current_branch(cwd)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
    pub remote: bool,
    /// When the branch's tip was committed (RFC 3339), for "updated 2h ago".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
    /// Who wrote the tip commit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

pub fn list_branches(cwd: &Path) -> Result<Vec<BranchInfo>> {
    let cur = current_branch(cwd);
    let out = run(cwd, &["for-each-ref", "--format=%(refname:short)%09%(refname)%09%(committerdate:iso-strict)%09%(authorname)", "refs/heads", "refs/remotes"])?;
    let mut v = Vec::new();
    for line in out.lines() {
        let mut fields = line.splitn(4, '\t');
        let short = fields.next().unwrap_or_default();
        let full = fields.next().unwrap_or_default();
        let mut text = || fields.next().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
        if short.ends_with("/HEAD") {
            continue;
        }
        v.push(BranchInfo {
            name: short.to_string(),
            current: cur.as_deref() == Some(short),
            remote: full.starts_with("refs/remotes/"),
            updated: text(),
            author: text(),
        });
    }
    Ok(v)
}

/// Tree id of the working tree right now, via a temp index so the real index,
/// working tree and stash are untouched. Copying the index rather than starting
/// empty keeps this fast: the copy carries git's stat cache. Only paths under
/// cwd are refreshed; checkpoint callers explicitly pass the checkout root.
pub fn snapshot_tree(cwd: &Path) -> Result<String> {
    Ok(snapshot_files(cwd, &[], false)?.tree)
}

/// A checkpoint's snapshot: the tree, and the exact bytes of files it cannot
/// give back. Keeping them is best effort: without them it is still a snapshot,
/// restored as git writes it.
pub fn exact_snapshot(cwd: &Path) -> Result<checkpoints::bytes::Snapshot> {
    snapshot_files(cwd, &[], true)
}

fn snapshot_tree_including(cwd: &Path, paths: &[String]) -> Result<checkpoints::bytes::Snapshot> {
    snapshot_files(cwd, paths, true)
}

/// Return staged and unstaged changes. During a conflict, keep the checkout
/// reviewable by comparing HEAD with a temporary snapshot of the worktree;
/// Git cannot write a tree from an index containing unmerged entries.
pub fn working_change_sets(
    cwd: &Path,
    hide_whitespace: bool,
) -> Result<(String, String, Vec<ChangedFile>, Vec<ChangedFile>)> {
    let head = head_tree(cwd)?;
    if !run(cwd, &["ls-files", "-u", "--"])?.is_empty() {
        let worktree = snapshot_tree(cwd)?;
        let changes = if head == worktree {
            Vec::new()
        } else {
            changes_between_options(cwd, &head, Some(&worktree), hide_whitespace)?
        };
        return Ok((head.clone(), head, Vec::new(), changes));
    }
    let index = run(cwd, &["write-tree"])?.trim().to_string();
    let worktree = snapshot_tree(cwd)?;
    let staged = if head == index {
        Vec::new()
    } else {
        changes_between_options(cwd, &head, Some(&index), hide_whitespace)?
    };
    let unstaged = if index == worktree {
        Vec::new()
    } else {
        changes_between_options(cwd, &index, Some(&worktree), hide_whitespace)?
    };
    Ok((head, index, staged, unstaged))
}

/// Include a checkpoint's paths even if later edits added them to .gitignore.
fn snapshot_files(cwd: &Path, paths: &[String], keep_bytes: bool) -> Result<checkpoints::bytes::Snapshot> {
    let index = path_line(&run(cwd, &["rev-parse", "--git-path", "index"])?).to_string();
    let index_path = if Path::new(&index).is_absolute() { PathBuf::from(&index) } else { cwd.join(&index) };
    let tmp = std::env::temp_dir().join(format!("raccoon-index-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
    let result = (|| {
        if index_path.exists() {
            std::fs::copy(&index_path, &tmp)?;
            // Git trusts an entry's cached stat only when the entry is older than the index file
            // itself; one written in the same second is "racily clean" and gets its content
            // read again. A copy made later would otherwise vouch for an entry its source did
            // not, and a same-size edit made within that second would be missed (#1298).
            let modified = std::fs::metadata(&index_path)?.modified()?;
            std::fs::File::options().write(true).open(&tmp)?.set_modified(modified)?;
        }
        let mut c = git_in(cwd, &["add"]);
        c.env("GIT_INDEX_FILE", &tmp).args(["add", "-A", "--", "."]);
        let o = c.output()?;
        if !o.status.success() {
            bail!("snapshot add: {}", String::from_utf8_lossy(&o.stderr));
        }
        for path in paths {
            let present = std::fs::symlink_metadata(cwd.join(path)).is_ok();
            let mut c = git_in(cwd, &[if present { "add" } else { "update-index" }]);
            c.env("GIT_INDEX_FILE", &tmp).arg("--literal-pathspecs");
            if present {
                c.args(["add", "-f", "--", path]);
            } else {
                c.args(["update-index", "--force-remove", "--", path]);
            }
            let output = c.output()?;
            if !output.status.success() { bail!("snapshot file: {}", String::from_utf8_lossy(&output.stderr)); }
        }
        let mut c = git_in(cwd, &["write-tree"]);
        c.env("GIT_INDEX_FILE", &tmp).args(["write-tree"]);
        let o = c.output()?;
        if !o.status.success() {
            bail!("write-tree: {}", String::from_utf8_lossy(&o.stderr));
        }
        let tree = String::from_utf8_lossy(&o.stdout).trim().to_string();
        let kept = if keep_bytes {
            checkpoints::bytes::record(cwd, &tmp).unwrap_or_else(|error| {
                log::warn!("keep exact line endings for a checkpoint: {error:#}");
                None
            })
        } else {
            None
        };
        Ok(checkpoints::bytes::Snapshot::new(tree, kept))
    })();
    let _ = std::fs::remove_file(&tmp);
    result
}

pub fn head_tree(cwd: &Path) -> Result<String> {
    match run(cwd, &["rev-parse", "HEAD^{tree}"]) {
        Ok(s) => Ok(s.trim().to_string()),
        Err(_) if is_repo(cwd) => Ok(EMPTY_TREE.into()),
        Err(e) => Err(e),
    }
}

/// A stable pair for workspace review. Both the list and file contents use
/// these trees, including untracked files, without changing the real index.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRange {
    pub target: String,
    pub base: String,
    pub head: String,
}

pub fn review_range(cwd: &Path, target: Option<&str>, uncommitted: bool) -> Result<ReviewRange> {
    if !is_repo(cwd) {
        bail!("Not a Git repository");
    }
    let unborn = head_commit(cwd).is_none();
    let target = if uncommitted {
        "HEAD".to_string()
    } else if let Some(target) = target {
        reject_dash_arg("target ref", target)?;
        target.to_string()
    } else if let Ok(remote) = run(cwd, &["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]) {
        remote.trim().to_string()
    } else {
        default_branch(cwd).unwrap_or_else(|| "HEAD".into())
    };
    let base = if uncommitted || (unborn && target == current_branch(cwd).unwrap_or_else(|| "HEAD".into())) {
        head_tree(cwd)?
    } else {
        // Resolve first, with option parsing terminated, before merge-base.
        let commit = run(cwd, &["rev-parse", "--verify", "--end-of-options", &format!("{target}^{{commit}}")])?;
        if unborn {
            EMPTY_TREE.to_string()
        } else {
            let base = run(cwd, &["merge-base", "HEAD", commit.trim()])?;
            run(cwd, &["rev-parse", &format!("{}^{{tree}}", base.trim())])?.trim().to_string()
        }
    };
    Ok(ReviewRange { target, base, head: snapshot_tree(cwd)? })
}

pub fn head_commit(cwd: &Path) -> Option<String> {
    run(cwd, &["rev-parse", "HEAD"]).ok().map(|s| s.trim().to_string())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// Content identity at the reviewed head. Deletions retain the removed blob's
    /// identity with a prefix; live diffs without a snapshot have no identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob_hash: Option<String>,
    pub status: ChangeStatus,
    pub additions: u32,
    pub deletions: u32,
}

fn is_tree_id(s: &str) -> bool {
    (7..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Changed files between two trees (or a tree and the working tree when
/// `head` is `None`), with per-file line counts.
pub fn changes_between(cwd: &Path, base: &str, head: Option<&str>) -> Result<Vec<ChangedFile>> {
    changes_between_options(cwd, base, head, false)
}

pub fn changes_between_options(cwd: &Path, base: &str, head: Option<&str>, hide_whitespace: bool) -> Result<Vec<ChangedFile>> {
    if !is_tree_id(base) {
        bail!("bad base tree id");
    }
    if let Some(h) = head {
        if !is_tree_id(h) {
            bail!("bad head tree id");
        }
    }
    let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-M", "--raw", "--no-abbrev", "-z", "--end-of-options", base];
    if let Some(h) = head {
        args.push(h);
    }
    args.push("--");
    // Read raw statuses separately from line counts, keeping identities independent
    // of the whitespace display option. -z preserves tabs/newlines in file names.
    let status_out = run(cwd, &args.iter().filter(|a| **a != "--numstat").cloned().collect::<Vec<_>>())?;
    let mut num_args = args.iter().filter(|a| **a != "--raw").copied().collect::<Vec<_>>();
    if hide_whitespace { num_args.insert(1, "-w"); }
    let num_out = run(cwd, &num_args)?;

    let mut counts = std::collections::HashMap::new();
    let mut records = num_out.split('\0');
    while let Some(rec) = records.next() {
        if rec.is_empty() {
            continue;
        }
        let mut it = rec.splitn(3, '\t');
        let a = it.next().unwrap_or("0");
        let d = it.next().unwrap_or("0");
        let mut p = it.next().unwrap_or("");
        if p.is_empty() {
            // A rename is counts, old path, new path in separate NUL fields.
            records.next();
            p = records.next().unwrap_or("");
        }
        counts.insert(p.to_string(), (a.parse().unwrap_or(0), d.parse().unwrap_or(0)));
    }
    let mut out = Vec::new();
    let fields: Vec<&str> = status_out.split('\0').collect();
    let mut i = 0;
    while i < fields.len() {
        let st = fields[i];
        if st.is_empty() {
            i += 1;
            continue;
        }
        let raw: Vec<&str> = st.split_whitespace().collect();
        if raw.len() != 5 || !st.starts_with(':') {
            bail!("Malformed git diff raw record");
        }
        let code = raw[4].chars().next().unwrap_or('M');
        let blob_hash = head.map(|_| if code == 'D' { format!("deleted:{}", raw[2]) } else { raw[3].to_string() });
        match code {
            'R' | 'C' => {
                let old = fields.get(i + 1).copied().unwrap_or("").to_string();
                let new = fields.get(i + 2).copied().unwrap_or("").to_string();
                let (a, d) = counts.get(&new).copied().unwrap_or((0, 0));
                out.push(ChangedFile { path: new, old_path: Some(old), blob_hash, status: ChangeStatus::Renamed, additions: a, deletions: d });
                i += 3;
            }
            _ => {
                let p = fields.get(i + 1).copied().unwrap_or("").to_string();
                let (a, d) = counts.get(&p).copied().unwrap_or((0, 0));
                let status = match code {
                    'A' => ChangeStatus::Added,
                    'D' => ChangeStatus::Deleted,
                    _ => ChangeStatus::Modified,
                };
                out.push(ChangedFile { path: p, old_path: None, blob_hash, status, additions: a, deletions: d });
                i += 2;
            }
        }
    }
    Ok(out)
}

pub(crate) enum BlobContents {
    Bytes(Vec<u8>),
    TooLarge(usize),
}

/// Read only local objects. The tree proves absence; a missing promised blob
/// (or an unavailable tree) is an error, never the empty side of a comparison.
/// Shared by text/SVG and binary media so none can implicitly fetch a revision.
pub(crate) fn blob_bytes_at(cwd: &Path, tree: &str, path: &str, limit: usize) -> Result<Option<BlobContents>> {
    if !is_tree_id(tree) {
        bail!("bad tree id");
    }
    if path.is_empty() || path.contains('\0') || !Path::new(path).components().all(|c| matches!(c, std::path::Component::Normal(_))) {
        bail!("Invalid repository-relative revision path");
    }
    // An unborn repository need not have written the well-known empty tree.
    if tree == EMPTY_TREE { return Ok(None); }
    let unavailable = || format!("Revision of {path} is unavailable locally. Fetch the missing objects in the workspace before comparing this revision.");
    let listing = git_in(cwd, &["ls-tree"]).env("GIT_LITERAL_PATHSPECS", "1")
        .args(["ls-tree", "--full-tree", "-z", tree, "--", path]).output()?;
    if !listing.status.success() { bail!("{}", unavailable()); }
    if listing.stdout.is_empty() { return Ok(None); }
    let listing = std::str::from_utf8(&listing.stdout)?;
    let (header, found) = listing.split_once('\t').context("Invalid revision tree entry")?;
    let fields: Vec<_> = header.split_whitespace().collect();
    if found.strip_suffix('\0') != Some(path) || fields.len() != 3 || fields[1] != "blob" {
        bail!("Not a regular revision blob");
    }
    let oid = fields[2];
    let size = git_in(cwd, &["cat-file"]).args(["cat-file", "-s", oid]).output()?;
    if !size.status.success() { bail!("{}", unavailable()); }
    let size: usize = std::str::from_utf8(&size.stdout)?.trim().parse()?;
    if size > limit { return Ok(Some(BlobContents::TooLarge(size))); }
    let content = git_in(cwd, &["cat-file"]).args(["cat-file", "blob", oid]).output()?;
    if !content.status.success() { bail!("{}", unavailable()); }
    Ok(Some(if content.stdout.len() > limit { BlobContents::TooLarge(content.stdout.len()) } else { BlobContents::Bytes(content.stdout) }))
}

/// Contents of `path` at `tree`, or `None` only if the local tree proves absence.
pub fn blob_at(cwd: &Path, tree: &str, path: &str) -> Result<Option<String>> {
    Ok(blob_text_at(cwd, tree, path, 4 * 1024 * 1024)?.0)
}

/// Keep the byte count even when the preview is replaced with a marker.
pub fn blob_text_at(cwd: &Path, tree: &str, path: &str, limit: usize) -> Result<(Option<String>, Option<u64>)> {
    Ok(match blob_bytes_at(cwd, tree, path, limit)? {
        None => (None, None),
        Some(BlobContents::TooLarge(size)) => (Some("<file too large to show>".into()), Some(size as u64)),
        Some(BlobContents::Bytes(bytes)) => {
            let size = bytes.len() as u64;
            let text = String::from_utf8_lossy(&bytes).into_owned();
            (Some(if text.len() > limit { "<file too large to show>".into() } else { text }), Some(size))
        }
    })
}

pub fn working_file_with_size(cwd: &Path, path: &str) -> (Option<String>, Option<u64>) {
    let p = cwd.join(path);
    let Ok(meta) = std::fs::metadata(&p) else { return (None, None) };
    if meta.len() > 4 * 1024 * 1024 {
        return (Some("<file too large to show>".into()), Some(meta.len()));
    }
    match std::fs::read(&p) {
        Ok(bytes) => (Some(String::from_utf8_lossy(&bytes).into_owned()), Some(bytes.len() as u64)),
        Err(_) => (None, None),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkStatus {
    pub is_repo: bool,
    pub dirty: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub default_branch: Option<String>,
    /// Commits on this branch that `origin/<default>` doesn't have.
    pub ahead_of_base: Option<u32>,
    pub head: Option<String>,
    /// A merge, rebase, cherry-pick, revert or bisect left in progress.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    /// Paths with unresolved conflicts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicted: Vec<String>,
}

/// Worktrees are created with --no-track. The published branch still counts
/// even when Git has no branch.<name>.merge configuration.
pub(crate) fn comparison_ref(cwd: &Path) -> Option<String> {
    if let Ok(upstream) = run(cwd, &["rev-parse", "--symbolic-full-name", "@{upstream}"]) {
        return Some(upstream.trim().into());
    }
    let branch = current_branch(cwd)?;
    let remote = format!("refs/remotes/origin/{branch}");
    run(cwd, &["rev-parse", "--verify", "--quiet", &remote]).ok()?;
    Some(remote)
}

pub fn upstream_counts(cwd: &Path) -> (u32, u32) {
    comparison_ref(cwd)
        .filter(|reference| reject_dash_arg("ref", reference).is_ok())
        .and_then(|reference| {
            run(cwd, &["rev-list", "--left-right", "--count", "--end-of-options", &format!("HEAD...{reference}"), "--"]).ok()
                .and_then(|s| parse_upstream_counts(&s))
        })
        .unwrap_or((0, 0))
}

pub(crate) fn parse_upstream_counts(output: &str) -> Option<(u32, u32)> {
    let mut it = output.split_whitespace();
    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
}

/// One command answering everything the header and handoff row need, so no
/// button is drawn from one snapshot beside another from a different one.
/// Infallible: a non-repo answers defaults.
pub fn work_status(cwd: &Path) -> WorkStatus {
    if !is_repo(cwd) {
        return WorkStatus::default();
    }
    let branch = current_branch(cwd);
    let porcelain = run(cwd, &["status", "--porcelain", "-z", "--untracked-files=normal", "--"]).ok();
    let dirty = porcelain.as_deref().is_some_and(|s| !s.is_empty());
    let conflicted = porcelain.as_deref().map(unmerged_in).unwrap_or_default();
    let upstream = run(cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).ok().map(|s| s.trim().to_string());
    let (ahead, behind) = upstream_counts(cwd);
    let default = default_branch(cwd);
    let ahead_of_base = default.as_ref().filter(|d| reject_dash_arg("branch", d).is_ok()).and_then(|d| {
        let base = if run_ok(cwd, &["show-ref", "--verify", "--quiet", "--", &format!("refs/remotes/origin/{d}")]) {
            format!("origin/{d}")
        } else {
            d.clone()
        };
        run(cwd, &["rev-list", "--count", "--end-of-options", &format!("{base}..HEAD"), "--"]).ok().and_then(|s| s.trim().parse().ok())
    });
    let operation = operation_in_progress(cwd).ok().flatten().map(String::from);
    WorkStatus { is_repo: true, dirty, branch, upstream, ahead, behind, default_branch: default, ahead_of_base, head: head_commit(cwd), operation, conflicted }
}

// ---------------------------------------------------------------- worktrees

pub fn worktree_root(project: &Path) -> PathBuf {
    let dir = crate::store::settings::load().worktree_dir;
    // Written with `/` on every system: joined part by part, so the path is
    // spelled the way git and a resolved path spell it here.
    if Path::new(&dir).is_absolute() {
        return project.join(dir);
    }
    dir.split(['/', '\\']).filter(|part| !part.is_empty()).fold(project.to_path_buf(), |path, part| path.join(part))
}

pub fn worktree_path(project: &Path, name: &str) -> PathBuf {
    worktree_root(project).join(name)
}

pub fn worktree_branch_for(project: &Path, name: &str) -> Result<String> {
    Ok(format!("{}{}", crate::store::configuration::branch_prefix(project)?, name))
}

/// Every `raccoon/*` branch, local and remote-tracking, so a name whose PR
/// already landed is never redrawn.
pub fn worktree_branch_names(project: &Path) -> Vec<String> {
    let Ok(prefix) = crate::store::configuration::branch_prefix(project) else { return Vec::new(); };
    if prefix.is_empty() { return Vec::new(); }
    run(project, &["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"])
        .map(|s| {
            s.lines()
                .filter_map(|l| {
                    let l = l.trim();
                    let l = l.split_once('/').filter(|(r, _)| *r == "origin").map(|(_, rest)| rest).unwrap_or(l);
                    l.strip_prefix(&prefix).map(|n| n.to_string())
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Names taken on disk, in branches, or in the index.
pub fn taken_worktree_names(project: &Path, index_names: &[String]) -> Vec<String> {
    let mut v: Vec<String> = index_names.to_vec();
    v.extend(worktree_branch_names(project));
    if let Ok(rd) = std::fs::read_dir(worktree_root(project)) {
        v.extend(rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()));
    }
    v
}

/// Base ref for a new worktree: `origin/<default>` when it exists, else the
/// local default branch, else HEAD.
pub fn resolve_base(project: &Path, requested: Option<&str>) -> Result<String> {
    if let Some(r) = requested.filter(|r| !r.is_empty()) {
        reject_dash_arg("base ref", r)?;
        if !run_ok(project, &["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{r}^{{commit}}")]) {
            bail!("unknown base ref {r}");
        }
        return Ok(r.to_string());
    }
    if let Some(d) = default_branch(project).filter(|d| reject_dash_arg("branch", d).is_ok()) {
        let remote = format!("origin/{d}");
        if run_ok(project, &["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{remote}^{{commit}}")]) {
            return Ok(remote);
        }
        if run_ok(project, &["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{d}^{{commit}}")]) {
            return Ok(d);
        }
    }
    Ok("HEAD".into())
}

/// Creation-time provenance; this does not describe later branch updates.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeBase {
    pub commit: String,
    pub fetched: bool,
    pub warning: Option<String>,
    /// The ref the worktree was made from (`origin/main`, `develop`): what its
    /// branch is read against and merges into. Absent for one checked out from
    /// an existing branch, and for sessions made before it was recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// Copy outcome at creation, retained for clients that were not connected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_copy: Option<crate::worktree_files::CopyReport>,
}

const WORKTREE_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Refresh only the default remote-tracking ref, independent of configured
/// fetch refspecs. Never update a local branch or the project's checkout.
fn fetch_worktree_base(project: &Path, requested: Option<&str>, timeout: std::time::Duration) -> (bool, Option<String>) {
    if requested.is_some_and(|r| !r.is_empty()) || !run_ok(project, &["remote", "get-url", "origin"]) {
        return (false, None);
    }
    let result = match default_branch(project).filter(|branch| reject_dash_arg("branch", branch).is_ok()) {
        Some(branch) => run_within(
            project,
            &[
                "-c", "credential.interactive=false", "fetch", "--no-tags", "--no-recurse-submodules",
                "--no-write-fetch-head", "--refmap=", "--end-of-options", "origin", &format!("+refs/heads/{branch}:refs/remotes/origin/{branch}"),
            ],
            timeout,
            &|| false,
        ),
        None => Err(RunError::Failed("default branch is unknown".into())),
    };
    match result {
        Ok(()) => (true, None),
        Err(error) => {
            let reason = match error {
                RunError::TimedOut => "fetch timed out".to_string(),
                RunError::Stopped => "fetch stopped".to_string(),
                RunError::Failed(message) => message,
                RunError::Spawn(error) => error.to_string(),
            };
            (false, Some(format!("Could not fetch origin's default branch ({reason}). This worktree was created from a local ref and may be out of date.")))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWorktree {
    pub name: String,
    pub path: String,
    pub branch: String,
    pub base: String,
    /// Tree id of the base commit, the first turn's changes baseline.
    pub base_tree: String,
    pub worktree_base: Option<WorktreeBase>,
}

/// A path as an argument for `git`, which takes strings. A checkout under a
/// name this platform allows but UTF-8 does not is the reader's to hear about,
/// not something to take the app down over.
fn arg(path: &Path) -> Result<&str> {
    path.to_str().with_context(|| format!("{} is not a name git can be given", path.display()))
}

pub fn create_worktree(project: &Path, name: &str, base: Option<&str>) -> Result<CreatedWorktree> {
    create_worktree_with_timeout(project, name, base, WORKTREE_FETCH_TIMEOUT)
}

/// Allocate before checking files out, so a failed checkout hook cannot hide
/// an already-created worktree from the fork's rollback.
pub(crate) fn create_fork_worktree(project: &Path, name: &str, base: Option<&str>) -> Result<(CreatedWorktree, String)> {
    create_worktree_impl(project, name, base, WORKTREE_FETCH_TIMEOUT, true)
}

fn create_worktree_with_timeout(project: &Path, name: &str, base: Option<&str>, timeout: std::time::Duration) -> Result<CreatedWorktree> {
    create_worktree_impl(project, name, base, timeout, false).map(|(worktree, _)| worktree)
}

fn create_worktree_impl(project: &Path, name: &str, base: Option<&str>, timeout: std::time::Duration, fork: bool) -> Result<(CreatedWorktree, String)> {
    let _request = crate::github_process::scope();
    if name.is_empty() || name.starts_with('-') || (!crate::names::is_worktree_name(name) && name.contains(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')) {
        bail!("bad worktree name");
    }
    let branch = worktree_branch_for(project, name)?;
    reject_dash_arg("branch", &branch)?;
    let (fetched, warning) = fetch_worktree_base(project, base, timeout);
    let base = resolve_base(project, base)?;
    reject_dash_arg("base ref", &base)?;
    let base_commit = run(project, &["rev-parse", "--verify", "--end-of-options", &format!("{base}^{{commit}}")])?.trim().to_string();
    let path = worktree_path(project, name);
    let sparse = crate::store::configuration::sparse_checkout(project)?;
    std::fs::create_dir_all(worktree_root(project))?;
    if fork {
        // No checkout hook runs until Git has successfully registered the
        // branch and worktree, at which point both are ours to roll back.
        if let Err(error) = run(project, &["worktree", "add", "--no-checkout", "--no-track", "-b", &branch, "--end-of-options", arg(&path)?, &base_commit]) {
            // Git can fail before we know whether it created either name.
            // Never guess ownership: point out any remaining destination.
            if std::fs::symlink_metadata(&path).is_ok() || branch_exists(project, &branch) {
                bail!("{error:#}; the destination {} or branch {branch} exists; its ownership could not be established, so it was kept", path.display());
            }
            return Err(error);
        }
        let checkout = match sparse.as_deref() {
            Some(folders) => crate::sparse_checkout::populate(&path, folders, true),
            None => run(&path, &["checkout", "-q"]).map(|_| ()),
        };
        if let Err(error) = checkout {
            let cleanup = rollback_new_worktree(project, &path, &branch, &base_commit, false);
            return Err(match cleanup { Ok(()) => error, Err(cleanup) => anyhow!("{error:#}; cleanup failed: {cleanup:#}") });
        }
    } else {
        worktree_add(project, &["--no-track", "-b", &branch, "--end-of-options", arg(&path)?, &base], &path, sparse.as_deref(), Some(&branch), true)?;
    }
    ensure_worktree_dir_ignored(project);
    let metadata = (|| -> Result<(String, String)> {
        Ok((run(&path, &["rev-parse", "HEAD^{tree}"])?.trim().to_string(),
            run(&path, &["rev-parse", "HEAD"])?.trim().to_string()))
    })();
    let (base_tree, commit) = match metadata {
        Ok(metadata) => metadata,
        Err(error) if !fork => return Err(error),
        Err(error) => {
            // The branch was just made at `base`; retain it if it has moved.
            let cleanup = rollback_new_worktree(project, &path, &branch, &base_commit, false);
            return Err(match cleanup { Ok(()) => error, Err(cleanup) => anyhow!("{error:#}; cleanup failed: {cleanup:#}") });
        }
    };
    let from = Some(base.clone()).filter(|b| b != "HEAD");
    Ok((CreatedWorktree {
        name: name.to_string(), path: path.to_string_lossy().into_owned(), branch, base, base_tree,
        worktree_base: Some(WorktreeBase { commit, fetched, warning, from, file_copy: crate::worktree_files::copy_on_create(project, &path) }),
    }, base_commit))
}

/// Roll back only the worktree and branch made for an unpublished fork.
/// Compare the branch tip before deleting it so a branch moved by another
/// process is retained and reported instead of losing new commits.
pub(crate) fn rollback_created_worktree(project: &Path, worktree: &CreatedWorktree, expected: &str, snapshot: Option<&str>) -> Result<()> {
    let path = Path::new(&worktree.path);
    let snapshot = snapshot.context("worktree contains changes not owned by the fork; it was kept")?;
    if fork_worktree_snapshot(path, worktree.worktree_base.as_ref().and_then(|base| base.file_copy.as_ref()).map(|report| report.copied_files.as_slice()).unwrap_or_default())? != snapshot { bail!("worktree changes were added or modified; it was kept"); }
    rollback_new_worktree(project, path, &worktree.branch, expected, true)
}

/// Capture tracked changes while accepting only the exact files that the
/// creation copy published and that have not since been changed.
pub(crate) fn fork_worktree_snapshot(path: &Path, copied: &[crate::worktree_files::CopiedFile]) -> Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let untracked = run(path, &["ls-files", "--others", "-z"])?;
    let actual: std::collections::BTreeSet<_> = untracked.split('\0').filter(|name| !name.is_empty()).collect();
    let expected: std::collections::BTreeSet<_> = copied.iter().map(|file| file.path.as_str()).collect();
    if actual != expected { bail!("worktree contains untracked or ignored files; it was kept"); }
    for file in copied {
        let relative = Path::new(&file.path);
        let mut current = path.to_path_buf();
        for component in relative.components() {
            current.push(component);
            let metadata = std::fs::symlink_metadata(&current)?;
            if metadata.file_type().is_symlink() { bail!("copied file {} was replaced; worktree was kept", file.path); }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 { bail!("copied file {} was replaced; worktree was kept", file.path); }
            }
        }
        let metadata = std::fs::symlink_metadata(&current)?;
        if !metadata.is_file() { bail!("copied file {} was replaced; worktree was kept", file.path); }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if (metadata.dev(), metadata.ino()) != file.identity { bail!("copied file {} was replaced; worktree was kept", file.path); }
            if metadata.permissions().mode() & 0o7777 != file.mode { bail!("copied file {} permissions changed; worktree was kept", file.path); }
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            let identity = std::fs::File::open(&current).and_then(|opened| crate::win::fs::file_id(&opened))?;
            if identity != file.identity || metadata.file_attributes() != file.mode {
                bail!("copied file {} metadata changed; worktree was kept", file.path);
            }
        }
        let mut input = std::fs::File::open(&current)?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 16384];
        loop {
            let count = input.read(&mut buffer)?;
            if count == 0 { break; }
            hash.update(&buffer[..count]);
        }
        let digest: [u8; 32] = hash.finalize().into();
        if digest != file.digest { bail!("copied file {} changed; worktree was kept", file.path); }
    }
    let status = run(path, &["status", "--porcelain=v1", "--untracked-files=no"])?;
    let staged = run(path, &["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "--"])?;
    let unstaged = run(path, &["diff", "--binary", "--no-ext-diff", "--no-textconv", "--"])?;
    if status.is_empty() { return Ok(String::new()); }
    Ok(format!("{status}\0{staged}\0{unstaged}"))
}

fn rollback_new_worktree(project: &Path, path: &Path, branch: &str, expected: &str, verified: bool) -> Result<()> {
    reject_dash_arg("branch", branch)?;
    if !verified && !fork_worktree_snapshot(path, &[])?.is_empty() { bail!("worktree contains changes; it was kept"); }
    if !is_worktree_of(project, path) { bail!("{} is no longer this repository's worktree", path.display()); }
    let actual_branch = run(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    if actual_branch.trim() != branch { bail!("{} no longer has branch {branch}", path.display()); }
    let current = run(project, &["rev-parse", "--verify", "--end-of-options", &format!("refs/heads/{branch}")])?;
    if current.trim() != expected { bail!("branch {branch} moved; it and the worktree were kept"); }
    run(project, &["worktree", "remove", "--force", "--", arg(path)?])?;
    run(project, &["update-ref", "-d", &format!("refs/heads/{branch}"), expected])?;
    Ok(())
}

/// A worktree on a branch that already exists, rather than a new one: the
/// branch is checked out as it is, its commits and upstream kept. A remote
/// branch (`origin/fix-x`) gets a local branch of its name tracking it.
pub fn checkout_worktree(project: &Path, name: &str, branch: &str) -> Result<CreatedWorktree> {
    crate::store::configuration::branch_prefix(project)?;
    if name.is_empty() || name.starts_with('-') || name.contains(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_') {
        bail!("bad worktree name");
    }
    if branch.starts_with('-') || branch.contains("..") || branch.contains('\0') || branch.trim().is_empty() {
        bail!("bad branch name");
    }
    let path = worktree_path(project, name);
    let sparse = crate::store::configuration::sparse_checkout(project)?;
    let sparse = sparse.as_deref();
    std::fs::create_dir_all(worktree_root(project))?;
    let local = if branch_exists(project, branch) {
        add_checkout(project, &path, &[branch], branch, sparse)?;
        branch.to_string()
    } else {
        let remote = format!("refs/remotes/{branch}");
        if run(project, &["rev-parse", "--verify", "--quiet", "--end-of-options", &remote]).is_err() {
            bail!("no branch named {branch}");
        }
        let local = branch.split_once('/').map(|(_, rest)| rest).unwrap_or(branch).to_string();
        if local.starts_with('-') || local.trim().is_empty() {
            bail!("bad branch name");
        }
        if branch_exists(project, &local) {
            add_checkout(project, &path, &[&local], &local, sparse)?;
        } else {
            worktree_add(project, &["--track", "-b", &local, "--end-of-options", arg(&path)?, branch], &path, sparse, Some(&local), true)?;
        }
        local
    };
    ensure_worktree_dir_ignored(project);
    let base_tree = run(&path, &["rev-parse", "HEAD^{tree}"])?.trim().to_string();
    let commit = run(&path, &["rev-parse", "HEAD"])?.trim().to_string();
    Ok(CreatedWorktree {
        name: name.to_string(),
        path: path.to_string_lossy().into_owned(),
        branch: local,
        base: commit.clone(),
        base_tree,
        worktree_base: Some(WorktreeBase { commit, fetched: false, warning: None, from: None, file_copy: crate::worktree_files::copy_on_create(project, &path) }),
    })
}

/// Begin detached so gh can create a uniquely named branch directly at the PR head.
pub fn checkout_pr_worktree(project: &Path, name: &str, number: u64) -> Result<CreatedWorktree> {
    checkout_pr_worktree_with(project, name, number, crate::github::checkout_pr)
}

pub(crate) fn checkout_pr_worktree_with(project: &Path, name: &str, number: u64, checkout: impl FnOnce(&Path, u64, &str) -> Result<()>) -> Result<CreatedWorktree> {
    if name.is_empty() || name.starts_with('-') || name.contains(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_') || number == 0 { bail!("Invalid pull request worktree"); }
    let branch = worktree_branch_for(project, name)?;
    reject_dash_arg("branch", &branch)?;
    if branch_exists(project, &branch) { bail!("Branch {branch} already exists"); }
    let path = worktree_path(project, name);
    if path.exists() { bail!("Worktree path already exists: {}", path.display()); }
    let sparse = crate::store::configuration::sparse_checkout(project)?;
    std::fs::create_dir_all(worktree_root(project))?;
    // Narrowed before the PR's branch is checked out, which then keeps to the same folders.
    worktree_add(project, &["--detach", "--end-of-options", arg(&path)?, "HEAD"], &path, sparse.as_deref(), None, true)?;
    // Before the file copy below: it refuses to stage inside an unignored folder.
    ensure_worktree_dir_ignored(project);
    let result = (|| {
        checkout(&path, number, &branch)?;
        let commit = run(&path, &["rev-parse", "HEAD"])?.trim().to_string();
        let base_tree = run(&path, &["rev-parse", "HEAD^{tree}"])?.trim().to_string();
        Ok(CreatedWorktree {
            name: name.into(), path: path.to_string_lossy().into_owned(), branch: branch.clone(),
            base: commit.clone(), base_tree,
            worktree_base: Some(WorktreeBase { commit, fetched: true, warning: None, from: None, file_copy: crate::worktree_files::copy_on_create(project, &path) }),
        })
    })();
    if result.is_err() {
        // Only the checkout allocated above is removed; it has never hosted a session.
        if run(project, &["worktree", "remove", "--force", "--", arg(&path)?]).is_ok() && branch_exists(project, &branch) {
            let _ = run(project, &["branch", "-D", "--", &branch]);
        }
    }
    result
}

/// `git worktree add` with `args` (its options, the path and the commit).
/// With `sparse`, the repository's `sparseCheckout` folders, the new
/// worktree checks out only those folders and the root files: it is added
/// without a checkout, narrowed in its own configuration, then checked out,
/// so the primary checkout and other worktrees are left as they are. One that
/// cannot be narrowed is removed again, with the branch `-b` made for it (`created`).
/// Without `hooks`, the repository's checkout hooks do not run (a restore).
pub(crate) fn worktree_add(project: &Path, args: &[&str], path: &Path, sparse: Option<&[String]>, created: Option<&str>, hooks: bool) -> Result<()> {
    let mut command = if hooks { vec![] } else { vec!["-c", "core.hooksPath=/dev/null"] };
    command.extend(["worktree", "add"]);
    if sparse.is_some() { command.push("--no-checkout"); }
    command.extend_from_slice(args);
    run(project, &command)?;
    let Some(folders) = sparse else { return Ok(()) };
    if let Err(error) = crate::sparse_checkout::populate(path, folders, hooks) {
        // Only the checkout made just now, which has never hosted a session.
        if run(project, &["worktree", "remove", "--force", "--", arg(path)?]).is_ok() {
            if let Some(branch) = created { let _ = run(project, &["branch", "-D", "--", branch]); }
        }
        bail!("Could not check out only the chosen folders: {error:#}");
    }
    Ok(())
}

/// `git worktree add <path> <branch>`, saying plainly when the branch is already checked out somewhere.
fn add_checkout(project: &Path, path: &Path, rest: &[&str], branch: &str, sparse: Option<&[String]>) -> Result<()> {
    reject_dash_arg("branch", branch)?;
    let mut args = vec!["--end-of-options", arg(path)?];
    args.extend_from_slice(rest);
    worktree_add(project, &args, path, sparse, None, true).map_err(|e| {
        let text = e.to_string();
        if text.contains("already checked out") || text.contains("already used by worktree") {
            anyhow::anyhow!("{branch} is already checked out in another folder. Open that workspace instead, or pick New branch.")
        } else {
            e
        }
    })
}

/// Move a TerminalX-managed worktree and rename its matching branch. The
/// checkout may be dirty; `git worktree move` preserves its contents.
pub fn rename_worktree(project: &Path, path: &Path, name: &str) -> Result<CreatedWorktree> {
    if name.is_empty() || name.starts_with('-') || name.contains('/') || name == "." || name == ".." {
        bail!("bad worktree name");
    }
    let project = crate::paths::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    let path = crate::paths::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if path == project {
        bail!("the project's own checkout cannot be renamed here");
    }
    let managed_root = crate::paths::canonicalize(worktree_root(&project)).unwrap_or_else(|_| worktree_root(&project));
    if path.parent() != Some(managed_root.as_path()) {
        bail!("only TerminalX-managed workspaces can be renamed");
    }
    let old_name = path.file_name().and_then(|part| part.to_str()).ok_or_else(|| anyhow::anyhow!("workspace has no usable name"))?;
    let old_branch = worktree_branch_for(&project, old_name)?;
    let branch = current_branch(&path).ok_or_else(|| anyhow::anyhow!("workspace has no branch"))?;
    if branch != old_branch {
        bail!("workspace branch does not match its TerminalX name");
    }
    if old_name == name {
        let base_tree = run(&path, &["rev-parse", "HEAD^{tree}"])?.trim().to_string();
        return Ok(CreatedWorktree { name: name.to_string(), path: path.to_string_lossy().into_owned(), branch, base: "HEAD".into(), base_tree, worktree_base: None });
    }
    let destination = worktree_path(&project, name);
    if destination.exists() {
        bail!("workspace {name} already exists");
    }
    let new_branch = worktree_branch_for(&project, name)?;
    reject_dash_arg("branch", &new_branch)?;
    run(&project, &["worktree", "move", "--", arg(&path)?, arg(&destination)?])?;
    if let Err(rename_error) = run(&destination, &["branch", "-m", "--", &new_branch]) {
        let rollback = run(&project, &["worktree", "move", "--", arg(&destination)?, arg(&path)?]);
        if let Err(rollback_error) = rollback {
            bail!("rename branch failed: {rename_error:#}; moving the workspace back also failed: {rollback_error:#}");
        }
        return Err(rename_error);
    }
    let base_tree = run(&destination, &["rev-parse", "HEAD^{tree}"])?.trim().to_string();
    Ok(CreatedWorktree {
        name: name.to_string(),
        path: destination.to_string_lossy().into_owned(),
        branch: new_branch,
        base: "HEAD".into(),
        base_tree,
        worktree_base: None,
    })
}

/// Keep the worktree directory out of the project's own status without
/// touching `.gitignore`: `.git/info/exclude` is local to this clone.
pub(crate) fn ensure_worktree_dir_ignored(project: &Path) {
    let dir = crate::store::settings::load().worktree_dir;
    let top = dir.split('/').next().unwrap_or(".raccoon").to_string();
    if let Ok(git_dir) = run(project, &["rev-parse", "--git-common-dir"]) {
        let git_dir = path_line(&git_dir);
        let git_dir = if Path::new(git_dir).is_absolute() { PathBuf::from(git_dir) } else { project.join(git_dir) };
        let info = git_dir.join("info");
        let exclude = info.join("exclude");
        let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
        let line = format!("/{top}/");
        if !existing.lines().any(|l| l.trim() == line) {
            let _ = std::fs::create_dir_all(&info);
            let mut s = existing;
            if !s.is_empty() && !s.ends_with('\n') {
                s.push('\n');
            }
            s.push_str(&line);
            s.push('\n');
            let _ = std::fs::write(&exclude, s);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDisposition {
    pub exists: bool,
    /// Whether the counts below could be read. A directory that is no longer
    /// a working tree of its own (its `.git` file is gone or broken) cannot
    /// be checked: git would answer for the project around it and report
    /// nothing. The counts are then 0 and mean "unknown", not "clean".
    #[serde(default)]
    pub checked: bool,
    pub uncommitted: u32,
    /// Commits no other ref holds. Over-warning is the safe direction.
    pub unpushed: u32,
    pub branch: Option<String>,
}

/// Whether `path` is the top of a working tree of its own. Without this a
/// git command run there silently answers for the enclosing repository.
pub fn is_own_worktree(path: &Path) -> bool {
    let Ok(top) = run(path, &["rev-parse", "--show-toplevel"]) else { return false };
    match (crate::paths::canonicalize(path_line(&top)), crate::paths::canonicalize(path)) {
        (Ok(top), Ok(path)) => top == path,
        _ => false,
    }
}

/// A repository's shared git directory, resolved.
pub(crate) fn common_dir(cwd: &Path) -> Option<PathBuf> {
    let out = run(cwd, &["rev-parse", "--git-common-dir"]).ok()?;
    let dir = path_line(&out);
    let dir = if Path::new(dir).is_absolute() { PathBuf::from(dir) } else { cwd.join(dir) };
    crate::paths::canonicalize(dir).ok()
}

/// Whether `path` is the top of a working tree of `project`'s repository.
/// A clone, or another repository's worktree, sitting at that path is a
/// working tree too, but its counts say nothing about this project and git
/// will refuse to remove it as one of ours.
pub fn is_worktree_of(project: &Path, path: &Path) -> bool {
    is_own_worktree(path) && common_dir(path).is_some_and(|theirs| Some(theirs) == common_dir(project))
}

pub fn branch_exists(project: &Path, branch: &str) -> bool {
    if reject_dash_arg("branch", branch).is_err() {
        return false;
    }
    run_ok(project, &["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("refs/heads/{branch}")])
}

pub fn worktree_disposition(project: &Path, name: &str) -> WorktreeDisposition {
    let path = worktree_path(project, name);
    if std::fs::symlink_metadata(&path).is_err() {
        return WorktreeDisposition::default();
    }
    let Ok(branch) = worktree_branch_for(project, name) else { return WorktreeDisposition { exists: true, ..Default::default() }; };
    let unchecked = WorktreeDisposition { exists: true, checked: false, uncommitted: 0, unpushed: 0, branch: Some(branch.clone()) };
    if reject_dash_arg("branch", &branch).is_err() || !is_worktree_of(project, &path) {
        return unchecked;
    }
    let uncommitted = run(&path, &["status", "--porcelain", "--"]).map(|s| s.lines().count() as u32);
    // What deleting loses: commits only HEAD holds, and commits only the
    // worktree's branch holds. They differ when HEAD was moved off the
    // branch (`git checkout --detach`), and the branch is deleted either way.
    let exclude = format!("--exclude={branch}");
    let mut args = vec!["rev-list", "--count", "--not", exclude.as_str(), "--branches", "--remotes", "--tags", "--not", "--end-of-options", "HEAD"];
    if branch_exists(project, &branch) {
        args.push(&branch);
    }
    let unpushed = run(&path, &args).ok().and_then(|s| s.trim().parse::<u32>().ok());
    match (uncommitted, unpushed) {
        (Ok(uncommitted), Some(unpushed)) => WorktreeDisposition { exists: true, checked: true, uncommitted, unpushed, branch: Some(branch) },
        _ => unchecked,
    }
}

/// Bytes a file or directory tree takes on disk. Symlinks are counted as
/// links and never followed.
pub fn size_on_disk(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
    #[cfg(unix)]
    let own = {
        use std::os::unix::fs::MetadataExt;
        meta.blocks() * 512
    };
    #[cfg(not(unix))]
    let own = meta.len();
    if !meta.is_dir() {
        return own;
    }
    let children: u64 = std::fs::read_dir(path).into_iter().flatten().flatten().map(|entry| size_on_disk(&entry.path())).sum();
    own + children
}

pub fn format_size(bytes: u64) -> String {
    match bytes {
        b if b >= 1_000_000_000 => format!("{:.1} GB", b as f64 / 1e9),
        b if b >= 1_000_000 => format!("{} MB", b / 1_000_000),
        b if b >= 1_000 => format!("{} KB", b / 1_000),
        b => format!("{b} B"),
    }
}

/// Whether the caller showed the person what a removal would lose and got a
/// confirmation. Only then may a directory git cannot remove be deleted
/// directly, and a branch that holds commits nothing else has be deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectDelete {
    Allowed,
    Never,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoval {
    /// The worktree's branch, when it was kept because it holds commits no
    /// other branch, remote or tag has.
    pub kept_branch: Option<String>,
    /// A branch made to keep a detached HEAD's commits reachable, when the
    /// directory was deleted directly and nothing else held them.
    pub rescued_branch: Option<String>,
}

/// Where the managed worktree `name` lives. The guard keys on shape: a direct
/// child of the worktree root or nothing, so an empty name can never resolve
/// to the project itself and a name with a separator can never climb out.
#[cfg_attr(not(test), allow(dead_code))]
pub fn managed_worktree_path(project: &Path, name: &str) -> Result<PathBuf> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        bail!("refusing to remove: bad worktree name");
    }
    let root = worktree_root(project);
    let path = root.join(name);
    if path.parent() != Some(root.as_path()) || path.file_name().and_then(|part| part.to_str()) != Some(name) {
        bail!("refusing to remove: not under the worktree directory");
    }
    Ok(path)
}

/// Delete a managed worktree's directory without git's help, for one git
/// could not remove (its `.git` file is gone, or git never knew it). The
/// directory goes for good; nothing is moved to the Trash.
///
/// The guard is checked on what is really on disk: `path` must be a real
/// directory, not a symlink; once both are resolved it must still be a
/// direct child of the project's worktree root; and it must be this
/// project's (see [`belongs_to_project`]), because the worktree folder is a
/// setting and two projects, or a clone someone put there, can share it.
pub fn remove_managed_worktree_dir(project: &Path, path: &Path) -> Result<()> {
    let meta = std::fs::symlink_metadata(path).with_context(|| format!("{} cannot be read", path.display()))?;
    if meta.file_type().is_symlink() {
        bail!("refusing to remove: {} is a symbolic link", path.display());
    }
    if !meta.is_dir() {
        bail!("refusing to remove: {} is not a directory", path.display());
    }
    let root = crate::paths::canonicalize(worktree_root(project)).context("the worktree directory cannot be resolved")?;
    let resolved = crate::paths::canonicalize(path).with_context(|| format!("{} cannot be resolved", path.display()))?;
    if resolved.parent() != Some(root.as_path()) {
        bail!("refusing to remove: {} is not directly under the worktree directory", path.display());
    }
    let project_dir = crate::paths::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    if resolved == project_dir || project_dir.starts_with(&resolved) {
        bail!("refusing to remove: {} holds the project itself", path.display());
    }
    belongs_to_project(project, &resolved)?;
    std::fs::remove_dir_all(&resolved).with_context(|| format!("delete {}", resolved.display()))
}

/// Whether a directory in the worktree folder is this project's to delete
/// directly: its `.git` is absent (what is left of a removal that failed
/// part-way), or is a file pointing into this project's `.git/worktrees/`.
/// A `.git` directory is a repository of its own; a link pointing anywhere
/// else is another project's worktree. Both are refused.
fn belongs_to_project(project: &Path, dir: &Path) -> Result<()> {
    let dot_git = dir.join(".git");
    let meta = match std::fs::symlink_metadata(&dot_git) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => bail!("refusing to remove: {} cannot be read: {e}", dot_git.display()),
        Ok(meta) => meta,
    };
    if !meta.is_file() {
        bail!("refusing to remove: {} is a repository of its own, not a worktree of this project", dir.display());
    }
    let text = std::fs::read_to_string(&dot_git).with_context(|| format!("read {}", dot_git.display()))?;
    let Some(link) = text.lines().next().and_then(|line| line.strip_prefix("gitdir:")).map(str::trim).filter(|link| !link.is_empty()) else {
        bail!("refusing to remove: {} does not say which repository it belongs to", dot_git.display());
    };
    let link = if Path::new(link).is_absolute() { PathBuf::from(link) } else { dir.join(link) };
    let common = run(project, &["rev-parse", "--git-common-dir"]).context("the project's git directory cannot be found")?;
    let common = path_line(&common);
    let common = if Path::new(common).is_absolute() { PathBuf::from(common) } else { project.join(common) };
    let ours = common.join("worktrees");
    // The record may already be gone (git drops it before it fails on the
    // directory), so fall back to comparing the paths as written.
    let resolve = |p: &Path| crate::paths::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let owner = link.parent().map(resolve);
    let matches = owner.as_deref().is_some_and(|owner| owner == resolve(&ours) || owner == crate::paths::canonicalize(&common).unwrap_or(common.clone()).join("worktrees"));
    if !matches {
        bail!("refusing to remove: {} is a worktree of another repository", dir.display());
    }
    Ok(())
}

/// Commits on `branch` that no other branch, remote or tag holds. `None`
/// when git cannot say.
pub fn unique_commits(project: &Path, branch: &str) -> Option<u32> {
    reject_dash_arg("branch", branch).ok()?;
    run(project, &["rev-list", "--count", "--not", &format!("--exclude={branch}"), "--branches", "--remotes", "--tags", "--not", "--end-of-options", branch])
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

/// The commit a worktree's HEAD is detached at, read from the repository's
/// record of the worktree (`.git/worktrees/<id>/HEAD`), which is still there
/// when the directory itself is broken. `None` when HEAD is on a branch or
/// there is no record.
pub fn detached_head(project: &Path, path: &Path) -> Option<String> {
    let admin = std::fs::read_to_string(path.join(".git"))
        .ok()
        .and_then(|text| text.lines().next().and_then(|line| line.strip_prefix("gitdir:")).map(|link| link.trim().to_string()))
        .map(|link| if Path::new(&link).is_absolute() { PathBuf::from(link) } else { path.join(link) })
        .or_else(|| Some(common_dir(project)?.join("worktrees").join(path.file_name()?)))?;
    // Only a record in this project's own git directory is read.
    if crate::paths::canonicalize(admin.parent()?).ok()? != common_dir(project)?.join("worktrees") {
        return None;
    }
    let head = std::fs::read_to_string(admin.join("HEAD")).ok()?;
    let head = head.trim();
    (head.len() >= 40 && head.chars().all(|c| c.is_ascii_hexdigit())).then(|| head.to_string())
}

/// Keep a detached commit reachable when no branch, remote or tag holds it:
/// a branch `raccoon/rescued/<name>-<short sha>` is made for it. Returns the
/// branch made.
pub fn rescue_detached(project: &Path, name: &str, commit: &str) -> Option<String> {
    if reject_dash_arg("commit", commit).is_err() || !is_tree_id(commit) {
        return None;
    }
    let unheld: u32 = run(project, &["rev-list", "--count", "--not", "--branches", "--remotes", "--tags", "--not", "--end-of-options", commit]).ok()?.trim().parse().ok()?;
    if unheld == 0 {
        return None;
    }
    let branch = format!("{}rescued/{name}-{}", crate::store::configuration::branch_prefix(project).ok()?, &commit[..8]);
    reject_dash_arg("branch", &branch).ok()?;
    run(project, &["branch", "--", &branch, commit]).ok().map(|_| branch)
}

/// What a removal that failed left behind, in words for the person.
pub fn leftover_state(path: &Path) -> String {
    if std::fs::symlink_metadata(path).is_err() {
        return "The directory is gone.".into();
    }
    let size = format_size(size_on_disk(path));
    if is_own_worktree(path) {
        format!("It is still a checkout ({size} on disk), though some of its files may already have been removed.")
    } else {
        format!("It was partly removed: {size} remain on disk and it is no longer a usable checkout.")
    }
}

/// Remove a worktree and its branch.
///
/// When `git worktree remove --force` fails and `direct` allows it, the
/// directory is deleted directly, behind the guard above, and the stale
/// record pruned. An error names the directory, both reasons and what state
/// the directory was left in, and leaves the branch alone so the removal can
/// be tried again.
///
/// Commits are not lost quietly. The branch is deleted when nothing else
/// would go with it. A branch that holds commits of its own is deleted only
/// when git removed the worktree itself for a caller that showed those
/// commits and got a confirmation ([`DirectDelete::Allowed`]; the
/// disposition counts them). After a direct delete the directory could not
/// be checked, so such a branch is kept and named in the result, and a
/// detached HEAD nothing else holds is given a branch of its own.
///
/// Workspaces are removed by path through `workspaces::delete`, which shares
/// this function's guards and rules. Removing by name is for a managed
/// worktree no session points at; nothing in the app does that yet, so
/// outside tests this has no caller.
#[cfg_attr(not(test), allow(dead_code))]
pub fn remove_worktree(project: &Path, name: &str, direct: DirectDelete) -> Result<WorktreeRemoval> {
    let path = managed_worktree_path(project, name)?;
    let mut removal = WorktreeRemoval::default();
    let mut removed_by_git = false;
    // `symlink_metadata` so a dangling link still counts as something there.
    if let Ok(meta) = std::fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() {
            bail!("refusing to remove: {} is a symbolic link", path.display());
        }
        // Read before git touches anything: it drops its record of the
        // worktree before it fails on the directory.
        let detached = detached_head(project, &path);
        let target = arg(&path)?;
        let _ = run(project, &["worktree", "unlock", "--", target]);
        match run(project, &["worktree", "remove", "--force", "--", target]) {
            Ok(_) => removed_by_git = true,
            Err(git_error) if direct == DirectDelete::Never => {
                bail!("Could not remove the worktree at {}: {git_error:#}. {}", path.display(), leftover_state(&path));
            }
            Err(git_error) => {
                if let Some(commit) = &detached {
                    removal.rescued_branch = rescue_detached(project, name, commit);
                }
                if let Err(direct_error) = remove_managed_worktree_dir(project, &path) {
                    bail!("Could not remove the worktree at {}: {direct_error:#} ({git_error:#}). {}", path.display(), leftover_state(&path));
                }
            }
        }
    }
    let _ = run(project, &["worktree", "prune"]);
    let Ok(branch) = worktree_branch_for(project, name) else { return Ok(removal); };
    if !branch_exists(project, &branch) {
        return Ok(removal);
    }
    let confirmed = removed_by_git && direct == DirectDelete::Allowed;
    if !confirmed && unique_commits(project, &branch) != Some(0) {
        removal.kept_branch = Some(branch);
        return Ok(removal);
    }
    let _ = run(project, &["branch", "-D", "--", &branch]);
    Ok(removal)
}

pub fn list_worktrees(project: &Path) -> Result<Vec<(String, Option<String>)>> {
    let out = shared::run(project, &["worktree", "list", "--porcelain"])?;
    let mut v = Vec::new();
    let mut cur: Option<String> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            if let Some(c) = cur.take() {
                v.push((c, None));
            }
            cur = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            if let Some(c) = cur.take() {
                v.push((c, Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string())));
            }
        }
    }
    if let Some(c) = cur {
        v.push((c, None));
    }
    Ok(v)
}

// ---------------------------------------------------------------- history & commits

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub body: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub parent: Option<String>,
    pub tree: String,
}

pub fn log_commits(cwd: &Path, range: Option<&str>, limit: u32) -> Result<Vec<CommitInfo>> {
    let fmt = "--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%T%x1e";
    let limit = format!("-n{limit}");
    let mut args = vec!["log", fmt, &limit];
    if let Some(r) = range {
        reject_dash_arg("revision range", r)?;
        args.push("--end-of-options");
        args.push(r);
    }
    args.push("--");
    let out = run(cwd, &args)?;
    Ok(out
        .split('\x1e')
        .filter(|r| !r.trim().is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').split('\x1f').collect();
            if f.len() < 9 {
                return None;
            }
            Some(CommitInfo {
                sha: f[0].into(),
                short_sha: f[1].into(),
                subject: f[2].into(),
                body: f[3].trim().into(),
                author: f[4].into(),
                email: f[5].into(),
                date: f[6].into(),
                parent: f[7].split_whitespace().next().map(String::from),
                tree: f[8].into(),
            })
        })
        .collect())
}

pub fn commit_all(cwd: &Path, message: &str, paths: Option<&[String]>) -> Result<String> {
    match paths {
        Some(ps) if !ps.is_empty() => {
            let mut args = vec!["add", "-A", "--"];
            args.extend(ps.iter().map(|s| s.as_str()));
            run(cwd, &args)?;
            let mut args = vec!["commit", "-m", message, "--"];
            args.extend(ps.iter().map(|s| s.as_str()));
            run(cwd, &args)?;
        }
        _ => {
            run(cwd, &["add", "-A", "--", "."])?;
            run(cwd, &["commit", "-m", message])?;
        }
    }
    Ok(head_commit(cwd).unwrap_or_default())
}

/// Commit the explicit index when it has changes; otherwise preserve the
/// repository panel's historical add-all behavior.
pub fn commit_staged_or_all(cwd: &Path, message: &str) -> Result<String> {
    let staged = match raw(cwd, &["diff", "--cached", "--quiet", "--exit-code", "--"]) {
        Some((0, _)) => false,
        Some((1, _)) => true,
        _ => bail!("Could not inspect the Git index before committing."),
    };
    if staged {
        run(cwd, &["commit", "-m", message])?;
        return Ok(head_commit(cwd).unwrap_or_default());
    }
    commit_all(cwd, message, None)
}

/// Add paths to the index without changing their working-tree contents.
pub fn stage_paths(cwd: &Path, paths: &[String]) -> Result<()> {
    anyhow::ensure!(!paths.is_empty(), "Select at least one file to stage.");
    anyhow::ensure!(run(cwd, &["ls-files", "-u", "--"])?.is_empty(), "Resolve merge conflicts before staging files.");
    let mut args = vec!["--literal-pathspecs", "add", "-A", "--"];
    args.extend(paths.iter().map(String::as_str));
    run(cwd, &args).map(|_| ())
}

/// Remove paths from the index while preserving every working-tree edit.
pub fn unstage_paths(cwd: &Path, paths: &[String]) -> Result<()> {
    anyhow::ensure!(!paths.is_empty(), "Select at least one file to unstage.");
    let mut args = vec!["--literal-pathspecs", "reset", "-q", "HEAD", "--"];
    args.extend(paths.iter().map(String::as_str));
    run(cwd, &args).map(|_| ())
}

pub fn unstage_all(cwd: &Path) -> Result<()> {
    run(cwd, &["reset", "-q"]).map(|_| ())
}

/// Apply one hunk from Git's own working-tree or cached diff. The patch is
/// generated here so callers cannot redirect it to another path. `reverse`
/// removes a selected cached hunk; neither operation touches the worktree.
pub fn apply_hunk(
    cwd: &Path,
    path: &str,
    old_path: Option<&str>,
    index: usize,
    reverse: bool,
) -> Result<()> {
    anyhow::ensure!(
        !path.is_empty() && !path.contains('\0'),
        "Invalid file path."
    );
    if !reverse && !path_is_tracked(cwd, path) {
        if let Some(old) = old_path {
            let staged_old = raw(cwd, &["diff", "--cached", "--quiet", "--exit-code", "--", old]);
            anyhow::ensure!(matches!(staged_old, Some((0, _))), "Unstage existing changes to the original file before staging rename hunks.");
            let before = hunk_diff(cwd, path, old_path, false)?;
            let count = hunk_starts(&before).len();
            anyhow::ensure!(index < count, "That hunk is no longer available. Refresh the diff and try again.");
            stage_paths(cwd, &[old.to_string(), path.to_string()])?;
            let result = (|| {
                let diff = hunk_diff(cwd, path, old_path, true)?;
                let staged_count = hunk_starts(&diff).len();
                anyhow::ensure!(index < staged_count, "That hunk is no longer available. Refresh the diff and try again.");
                for other in (0..staged_count).rev().filter(|other| *other != index) {
                    apply_patch(cwd, &hunk_patch(&diff, other)?, true)?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                if let Err(rollback_error) = unstage_paths(cwd, &[old.to_string(), path.to_string()]) {
                    bail!("Could not finish staging this rename hunk ({error}); the worktree is unchanged, but unstage {path} and {old} to restore the index: {rollback_error}");
                }
                return Err(error);
            }
            return Ok(());
        }
    }
    let diff = hunk_diff(cwd, path, old_path, reverse)?;
    apply_patch(cwd, &hunk_patch(&diff, index)?, reverse)
}

fn hunk_starts(diff: &str) -> Vec<usize> {
    let mut starts: Vec<usize> = diff.match_indices("\n@@ -").map(|(i, _)| i + 1).collect();
    if diff.starts_with("@@ -") {
        starts.insert(0, 0);
    }
    starts
}

fn hunk_patch(diff: &str, index: usize) -> Result<String> {
    let starts = hunk_starts(diff);
    let header_end = starts.first().copied().ok_or_else(|| anyhow!("This file has no text hunks to apply."))?;
    let selected = starts.get(index).ok_or_else(|| anyhow!("That hunk is no longer available. Refresh the diff and try again."))?;
    let end = starts.get(index + 1).copied().unwrap_or(diff.len());
    let patch = format!("{}{}", &diff[..header_end], &diff[*selected..end]);
    Ok(keep_rename_path_for_hunk(&patch))
}

/// Apply a selected rename hunk as a content edit at the destination path.
/// Keeping Git's rename metadata would move the whole file on reverse apply.
fn keep_rename_path_for_hunk(patch: &str) -> String {
    let Some(plus) = patch.lines().find(|line| {
        line.starts_with("+++ b/") || line.starts_with("+++ \"b/")
    }) else {
        return patch.to_string();
    };
    if !patch.lines().any(|line| line.starts_with("rename from ")) {
        return patch.to_string();
    }
    let new_path = &plus[4..];
    let old_path = if let Some(stripped) = new_path.strip_prefix("\"b/") {
        format!("\"a/{stripped}")
    } else {
        format!("a/{}", new_path.strip_prefix("b/").unwrap_or(new_path))
    };
    let mut lines = Vec::new();
    for (i, line) in patch.lines().enumerate() {
        match i {
            0 => lines.push(format!("diff --git {old_path} {new_path}")),
            _ if line.starts_with("similarity index ") || line.starts_with("rename from ") || line.starts_with("rename to ") => continue,
            _ if line.starts_with("--- a/") || line.starts_with("--- \"a/") => lines.push(format!("--- {old_path}")),
            _ if line.starts_with("+++ b/") || line.starts_with("+++ \"b/") => lines.push(format!("+++ {new_path}")),
            _ => lines.push(line.to_string()),
        }
    }
    lines.join("\n") + if patch.ends_with('\n') { "\n" } else { "" }
}

fn apply_patch(cwd: &Path, patch: &str, reverse: bool) -> Result<()> {
    use std::io::Write;
    use std::process::Stdio;
    let args: &[&str] = if reverse {
        &["apply", "--cached", "--reverse", "--recount", "--"]
    } else {
        &["apply", "--cached", "--recount", "--"]
    };
    let mut command = git_in(cwd, args);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let mut stdin = child.stdin.take().ok_or_else(|| anyhow!("Git input unavailable"))?;
    let write_result = stdin.write_all(patch.as_bytes());
    drop(stdin);
    let output = child.wait_with_output()?;
    write_result?;
    if !output.status.success() {
        bail!(
            "git apply: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

pub fn hunk_count(cwd: &Path, path: &str, old_path: Option<&str>, staged: bool) -> Result<usize> {
    anyhow::ensure!(
        !path.is_empty() && !path.contains('\0'),
        "Invalid file path."
    );
    let diff = hunk_diff(cwd, path, old_path, staged)?;
    Ok(hunk_starts(&diff).len())
}

fn hunk_diff(cwd: &Path, path: &str, old_path: Option<&str>, cached: bool) -> Result<String> {
    if !cached && !path_is_tracked(cwd, path) {
        if let Some(old) = old_path {
            let index = run(cwd, &["write-tree"])?.trim().to_string();
            let previous = run(cwd, &["show", &format!("{index}:{old}")])?;
            let temp = tempfile::tempdir()?;
            let baseline = temp.path().join("baseline");
            std::fs::write(&baseline, previous)?;
            let output = git_in(cwd, &["diff"])
                .args([
                    "--literal-pathspecs", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color",
                    "--unified=3", "--", baseline.to_str().ok_or_else(|| anyhow!("Invalid temporary path"))?, path,
                ])
                .output()?;
            anyhow::ensure!(matches!(output.status.code(), Some(0 | 1)), "git diff could not read the renamed file: {}", String::from_utf8_lossy(&output.stderr).trim());
            return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
        }
    }
    let mut args = vec![
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--find-renames",
        "--unified=3",
    ];
    if cached {
        args.push("--cached");
    }
    args.push("--");
    if let Some(old) = old_path {
        args.push(old);
    }
    args.push(path);
    let diff = run(cwd, &args)?;
    if !diff.is_empty() || cached {
        return Ok(diff);
    }
    // Git's ordinary diff omits untracked files. Build their patch from /dev/null;
    // this still lets `git apply --cached` select only one hunk.
    let tracked = path_is_tracked(cwd, path);
    if tracked {
        return Ok(diff);
    }
    use std::process::Stdio;
    let output = git_in(cwd, &["diff"])
        .args([
            "--literal-pathspecs",
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=3",
            "--",
            "/dev/null",
            path,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()?;
    anyhow::ensure!(
        matches!(output.status.code(), Some(0 | 1)),
        "git diff could not read the untracked file: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn path_is_tracked(cwd: &Path, path: &str) -> bool {
    raw(cwd, &["--literal-pathspecs", "ls-files", "--error-unmatch", "--", path]).is_some_and(|(code, _)| code == 0)
}

pub fn staged_diff(cwd: &Path, limit: usize) -> Result<String> {
    let diff = run(
        cwd,
        &[
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--",
            ".",
        ],
    )?;
    anyhow::ensure!(
        !diff.trim().is_empty(),
        "Stage changes before generating a commit message."
    );
    anyhow::ensure!(
        diff.len() <= limit,
        "The staged diff is too large to send for a commit message. Stage a smaller selection."
    );
    Ok(diff)
}

pub fn push(cwd: &Path) -> Result<String> {
    let _request = crate::github_process::scope();
    let branch = current_branch(cwd).ok_or_else(|| anyhow!("detached HEAD"))?;
    reject_dash_arg("branch", &branch)?;
    let has_upstream = run_ok(cwd, &["rev-parse", "--abbrev-ref", "@{upstream}"]);
    if has_upstream {
        transfer(cwd, &["push"])
    } else {
        transfer(cwd, &["push", "-u", "--", "origin", &branch])
    }
}

pub fn has_remote(cwd: &Path) -> Result<bool> {
    Ok(!run(cwd, &["remote"])?.trim().is_empty())
}

pub fn add_remote(cwd: &Path, url: &str) -> Result<()> {
    let url = url.trim();
    if url.is_empty() || url.starts_with('-') || url.chars().any(char::is_control) {
        bail!("Enter a remote URL.");
    }
    // Arguments, never a shell command. Git refuses an existing origin rather
    // than silently replacing a destination another window just configured.
    run(cwd, &["remote", "add", "--", "origin", url]).map(|_| ())
}

pub fn pull(cwd: &Path) -> Result<String> {
    let _request = crate::github_process::scope();
    // The Branch tab also offers incoming commits for --no-track worktrees.
    // Pull the published branch explicitly without changing its configuration.
    if run(cwd, &["rev-parse", "--symbolic-full-name", "@{upstream}"]).is_err()
        && comparison_ref(cwd).is_some() {
        if let Some(branch) = current_branch(cwd).filter(|b| reject_dash_arg("branch", b).is_ok()) {
            return run(cwd, &["pull", "--ff-only", "--", "origin", &branch]);
        }
    }
    run(cwd, &["pull", "--ff-only"])
}

fn transfer(cwd: &Path, args: &[&str]) -> Result<String> {
    let mut command = git();
    command.current_dir(cwd).args(args);
    let out = crate::github_process::git_output_admitted(command, crate::github_process::TIMEOUT, crate::github_process::ticket())?;
    if !out.status.success() {
        bail!("git {}: {}", args[0], String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn checkout_branch(cwd: &Path, name: &str, create: bool) -> Result<()> {
    if reject_dash_arg("branch", name).is_err() {
        bail!("bad branch name");
    }
    if create {
        run(cwd, &["checkout", "-b", name])?;
    } else {
        run(cwd, &["checkout", "--end-of-options", name])?;
    }
    Ok(())
}

/// Put a checkout on a detached HEAD onto a new branch at the commit it is on
/// (PRO-295), named `name` under the project's branch prefix as a new
/// worktree's branch is: nobody has named it yet, so it reads as a drawn name
/// until it is renamed. Uncommitted work stays where it is. Refused when the
/// checkout is already on a branch, has no commit, or the branch exists.
pub fn branch_here(project: &Path, cwd: &Path, name: &str) -> Result<String> {
    if let Some(branch) = current_branch(cwd) {
        bail!("This checkout is already on {branch}.");
    }
    if head_commit(cwd).is_none() {
        bail!("This checkout has no commit to make a branch at.");
    }
    let branch = worktree_branch_for(project, name)?;
    if branch.starts_with('-') || branch_exists(cwd, &branch) {
        bail!("A branch named {branch} already exists.");
    }
    run(cwd, &["checkout", "-b", &branch])?;
    Ok(branch)
}

/// This person's Git identity (`user.name`, `user.email` from their global
/// config), which authors the commits they make in a cloud workspace.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Identity {
    pub name: String,
    pub email: String,
}

pub fn global_identity() -> Option<Identity> {
    let home = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
    let get = |key: &str| run(&home, &["config", "--global", "--get", key]).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    Some(Identity { name: get("user.name")?, email: get("user.email")? })
}

pub fn remote_url(cwd: &Path) -> Option<String> {
    run(cwd, &["remote", "get-url", "origin"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The URL `branch` is pushed to, as `git push` picks the remote: the branch's
/// `pushRemote`, else `remote.pushDefault`, else the branch's `remote`. Often
/// a fork when the work goes to someone else's repository by pull request.
pub fn push_remote_url(cwd: &Path, branch: &str) -> Option<String> {
    let remote = push_remote(cwd, branch)?;
    reject_dash_arg("remote", &remote).ok()?;
    run(cwd, &["remote", "get-url", "--", &remote]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub(crate) fn push_remote(cwd: &Path, branch: &str) -> Option<String> {
    let config = |key: String| run(cwd, &["config", "--get", &key]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    config(format!("branch.{branch}.pushRemote"))
        .or_else(|| config("remote.pushDefault".into()))
        .or_else(|| config(format!("branch.{branch}.remote")))
}

/// A single explicit destination, before Git's transport URL rewrites. Multiple
/// push URLs are refused: pipeline automation must write to exactly one repo.
pub(crate) fn configured_push_url(cwd: &Path, remote: &str) -> Result<String> {
    let configured = run(cwd, &["config", "--get-all", &format!("remote.{remote}.pushurl")])
        .or_else(|_| run(cwd, &["config", "--get-all", &format!("remote.{remote}.url")]))?;
    let urls: Vec<_> = configured.lines().filter(|url| !url.is_empty()).collect();
    if urls.len() != 1 { anyhow::bail!("Remote {remote} must have exactly one push URL for conflict resolution."); }
    Ok(urls[0].into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn captured_output_keeps_structured_status_on_nonzero_exit() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf '{\"loggedIn\":false}'; exit 1"]);
        let output = capture_within(command, std::time::Duration::from_secs(1)).unwrap();
        assert!(!output.status.success());
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()["loggedIn"], false);
    }

    #[cfg(unix)]
    #[test]
    fn bounded_output_deadline_includes_inherited_stdout_and_stderr() {
        for redirect in ["2>/dev/null", ">/dev/null"] {
            let mut command = Command::new("/bin/sh");
            // The direct child exits, but its background child keeps one
            // output pipe open. Successful early output must not defeat the
            // deadline while waiting for the remaining EOF.
            command.args(["-c", &format!("sleep 2 {redirect} & printf '  --no-daemon\\n'; exit 0")]);
            let result = output_within(command, std::time::Duration::from_millis(50));
            assert!(matches!(result, Err(RunError::TimedOut)), "{redirect}: {result:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_binding_matches_the_canonical_path_and_releases_only_its_own_entry() {
        let dir = tempfile::tempdir().unwrap();
        let base = crate::paths::canonicalize(dir.path()).unwrap();
        let init = |path: &Path| {
            std::fs::create_dir(path).unwrap();
            // Not through `run`, which a binding for this path would redirect.
            assert!(Command::new("git").current_dir(path).args(["init", "-q"]).status().unwrap().success());
        };
        let (checkout, other) = (base.join("checkout"), base.join("other"));
        init(&checkout);
        init(&other);
        let link = base.join("link");
        std::os::unix::fs::symlink(&checkout, &link).unwrap();
        let shown = |cwd: &Path| crate::paths::canonicalize(path_line(&run(cwd, &["rev-parse", "--show-toplevel"]).unwrap())).unwrap();

        // Bound by one spelling; the helpers are called with the other. The
        // checkout then moves away and another repository takes its path.
        let top = std::fs::File::open(&checkout).unwrap();
        let first = bind(&link, &top, Path::new(".git"));
        let moved = base.join("moved");
        std::fs::rename(&checkout, &moved).unwrap();
        init(&checkout);
        assert_eq!(shown(&checkout), moved);
        assert_eq!(shown(&link), moved);

        // A newer binding of the same path wins while it lives, and releasing
        // the older one leaves it in place.
        let other_top = std::fs::File::open(&other).unwrap();
        let second = bind(&checkout, &other_top, Path::new(".git"));
        assert_eq!(shown(&checkout), other);
        drop(first);
        assert_eq!(shown(&checkout), other);
        drop(second);
        assert_eq!(shown(&checkout), checkout);
    }

    pub(super) fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        run(p, &["init", "-q", "-b", "main"]).unwrap();
        run(p, &["config", "core.autocrlf", "false"]).unwrap();
        run(p, &["config", "user.email", "t@example.com"]).unwrap();
        run(p, &["config", "user.name", "T"]).unwrap();
        std::fs::write(p.join("a.txt"), "hello\n").unwrap();
        run(p, &["add", "."]).unwrap();
        run(p, &["commit", "-q", "-m", "init"]).unwrap();
        dir
    }

    /// #1298: a same-size edit made in the second the index last recorded the file is "racily
    /// clean" to Git, and a snapshot must still read its content, not trust the cached stat.
    /// Timestamps are set by hand so this does not depend on when the clock ticks.
    #[test]
    fn a_snapshot_reads_a_racily_clean_edit() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        run(p, &["init", "-q", "-b", "main"]).unwrap();
        run(p, &["config", "user.email", "t@example.com"]).unwrap();
        run(p, &["config", "user.name", "T"]).unwrap();
        // The change time cannot be set by hand; leaving it out leaves the mtime as the only clock.
        run(p, &["config", "core.trustctime", "false"]).unwrap();
        let file = p.join("a.txt");
        let then = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        let stamp = |path: &Path| std::fs::File::options().write(true).open(path).unwrap().set_modified(then).unwrap();
        std::fs::write(&file, "hello\n").unwrap();
        stamp(&file);
        run(p, &["add", "."]).unwrap();
        run(p, &["commit", "-q", "-m", "init"]).unwrap();
        // Rewritten in place, same size and mtime, within the second the index was written.
        std::fs::write(&file, "howdy\n").unwrap();
        stamp(&file);
        stamp(&p.join(".git/index"));
        let tree = snapshot_tree(p).unwrap();
        let blob = run(p, &["rev-parse", &format!("{tree}:a.txt")]).unwrap();
        assert_eq!(blob.trim(), run(p, &["hash-object", "a.txt"]).unwrap().trim());
    }

    #[test]
    fn branches_carry_when_their_tip_was_committed_and_by_whom() {
        let dir = repo();
        let branches = list_branches(dir.path()).unwrap();
        assert_eq!(branches.len(), 1);
        let main = &branches[0];
        assert_eq!((main.name.as_str(), main.current, main.remote, main.author.as_deref()), ("main", true, false, Some("T")));
        let updated = main.updated.as_deref().expect("the tip's commit time");
        assert!(updated.len() >= 20 && updated.as_bytes()[10] == b'T', "RFC 3339, got {updated}");
    }

    #[test]
    fn staging_one_hunk_preserves_other_worktree_edits_and_commit_uses_only_index() {
        let dir = repo();
        let p = dir.path();
        let original = (1..=24).map(|n| format!("line {n}\n")).collect::<String>();
        std::fs::write(p.join("a.txt"), &original).unwrap();
        commit_all(p, "fixture", None).unwrap();
        let changed = original
            .replace("line 2\n", "changed 2\n")
            .replace("line 22\n", "changed 22\n");
        std::fs::write(p.join("a.txt"), &changed).unwrap();
        assert_eq!(hunk_count(p, "a.txt", None, false).unwrap(), 2);
        apply_hunk(p, "a.txt", None, 0, false).unwrap();
        assert_eq!(
            run(p, &["diff", "--cached", "--numstat", "--", "a.txt"])
                .unwrap()
                .trim(),
            "1\t1\ta.txt"
        );
        assert_eq!(hunk_count(p, "a.txt", None, false).unwrap(), 1);
        commit_staged_or_all(p, "only first hunk").unwrap();
        let committed = run(p, &["show", "HEAD:a.txt"]).unwrap();
        assert!(committed.contains("changed 2"));
        assert!(committed.contains("line 22"));
        assert!(std::fs::read_to_string(p.join("a.txt"))
            .unwrap()
            .contains("changed 22"));
        apply_hunk(p, "a.txt", None, 0, false).unwrap();
        apply_hunk(p, "a.txt", None, 0, true).unwrap();
        assert!(run(p, &["diff", "--cached", "--quiet", "--"]).is_ok());
        assert!(std::fs::read_to_string(p.join("a.txt"))
            .unwrap()
            .contains("changed 22"));
    }

    #[test]
    fn hunk_patches_support_untracked_and_renamed_files() {
        let dir = repo();
        let p = dir.path();
        let original = (1..=24).map(|n| format!("line {n}\n")).collect::<String>();
        let new_file = (1..=24).map(|n| format!("new {n}\n")).collect::<String>();
        std::fs::write(
            p.join("fresh.txt"),
            new_file
                .replace("new 2\n", "changed 2\n")
                .replace("new 22\n", "changed 22\n"),
        )
        .unwrap();
        assert_eq!(
            hunk_count(p, "fresh.txt", None, false).unwrap(),
            1,
            "an untracked file is one all-additions hunk"
        );
        apply_hunk(p, "fresh.txt", None, 0, false).unwrap();
        assert!(
            run(p, &["diff", "--cached", "--name-only", "--", "fresh.txt"])
                .unwrap()
                .contains("fresh.txt")
        );
        unstage_all(p).unwrap();

        std::fs::write(p.join("a.txt"), &original).unwrap();
        commit_all(p, "rename fixture", None).unwrap();
        std::fs::rename(p.join("a.txt"), p.join("renamed.txt")).unwrap();
        let changed = original
            .replace("line 2\n", "changed 2\n")
            .replace("line 22\n", "changed 22\n");
        std::fs::write(p.join("renamed.txt"), changed).unwrap();
        assert_eq!(
            hunk_count(p, "renamed.txt", Some("a.txt"), false).unwrap(),
            2
        );
        apply_hunk(p, "renamed.txt", Some("a.txt"), 0, false).unwrap();
        assert_eq!(
            hunk_count(p, "renamed.txt", Some("a.txt"), true).unwrap(),
            1
        );
        assert_rename_is_staged(p);

        unstage_all(p).unwrap();
        stage_paths(p, &["a.txt".into(), "renamed.txt".into()]).unwrap();
        assert_eq!(hunk_count(p, "renamed.txt", Some("a.txt"), true).unwrap(), 2);
        apply_hunk(p, "renamed.txt", Some("a.txt"), 0, true).unwrap();
        assert_eq!(hunk_count(p, "renamed.txt", Some("a.txt"), true).unwrap(), 1);
        assert_rename_is_staged(p);
        assert!(p.join("renamed.txt").exists());
        assert!(!p.join("a.txt").exists());
    }

    fn assert_rename_is_staged(cwd: &Path) {
        let status = run(cwd, &["diff", "--cached", "--name-status", "-M", "--"]).unwrap();
        let fields: Vec<_> = status.trim().split('\t').collect();
        assert_eq!(fields.len(), 3, "expected one staged rename, got {status:?}");
        assert!(fields[0].starts_with('R'), "expected rename status, got {status:?}");
        assert_eq!(&fields[1..], ["a.txt", "renamed.txt"]);
    }

    #[test]
    fn hunk_boundaries_only_match_line_starts() {
        let dir = repo();
        let p = dir.path();
        let original = (1..=32).map(|n| format!("line {n}\n")).collect::<String>();
        std::fs::write(p.join("a.txt"), &original).unwrap();
        commit_all(p, "hunk boundary fixture", None).unwrap();
        let changed = original.replace("line 2\n", "see @@ -1,2 +1,2 @@ here\n").replace("line 30\n", "changed 30\n");
        std::fs::write(p.join("a.txt"), changed).unwrap();
        assert_eq!(hunk_count(p, "a.txt", None, false).unwrap(), 2);
        apply_hunk(p, "a.txt", None, 0, false).unwrap();
        assert_eq!(run(p, &["diff", "--cached", "--numstat", "--", "a.txt"]).unwrap().trim(), "1\t1\ta.txt");
    }

    #[test]
    fn hunk_staging_handles_missing_final_newline_and_crlf() {
        let dir = repo();
        let p = dir.path();
        let original = (1..=24).map(|n| format!("line {n}\r\n")).collect::<String>();
        std::fs::write(p.join("a.txt"), &original).unwrap();
        commit_all(p, "crlf fixture", None).unwrap();
        let changed = original.replace("line 2\r\n", "changed 2\r\n").replace("line 24\r\n", "changed final");
        std::fs::write(p.join("a.txt"), changed.as_bytes()).unwrap();
        assert_eq!(hunk_count(p, "a.txt", None, false).unwrap(), 2);
        apply_hunk(p, "a.txt", None, 1, false).unwrap();
        assert_eq!(run(p, &["diff", "--cached", "--numstat", "--", "a.txt"]).unwrap().trim(), "1\t1\ta.txt");
        assert!(run(p, &["diff", "--cached", "--", "a.txt"]).unwrap().contains("\\ No newline at end of file"));
        assert_eq!(hunk_count(p, "a.txt", None, false).unwrap(), 1);
        unstage_all(p).unwrap();
        apply_hunk(p, "a.txt", None, 0, false).unwrap();
        assert_eq!(run(p, &["diff", "--cached", "--numstat", "--", "a.txt"]).unwrap().trim(), "1\t1\ta.txt");
    }

    #[test]
    fn working_change_sets_keep_conflicted_worktree_reviewable() {
        let dir = repo();
        let p = dir.path();
        std::fs::write(p.join("a.txt"), "base\n").unwrap();
        commit_all(p, "conflict base", None).unwrap();
        run(p, &["checkout", "-qb", "other"]).unwrap();
        std::fs::write(p.join("a.txt"), "theirs\n").unwrap();
        commit_all(p, "theirs", None).unwrap();
        run(p, &["checkout", "main"]).unwrap();
        std::fs::write(p.join("a.txt"), "ours\n").unwrap();
        commit_all(p, "ours", None).unwrap();
        assert!(run(p, &["merge", "other"]).is_err());

        assert!(!run(p, &["ls-files", "-u", "--"]).unwrap().is_empty());
        let (_, index, staged, unstaged) = working_change_sets(p, false).unwrap();
        assert!(!index.is_empty());
        assert!(staged.is_empty());
        assert!(unstaged.iter().any(|file| file.path == "a.txt"));
    }


    #[test]
    fn a_branch_here_is_made_at_the_detached_commit_and_checked_out() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let project = dir.path();
        std::fs::write(project.join("b.txt"), "two\n").unwrap();
        run(project, &["add", "."]).unwrap();
        run(project, &["commit", "-qm", "second"]).unwrap();
        let detached = run(project, &["rev-parse", "HEAD~1"]).unwrap().trim().to_string();
        run(project, &["checkout", "-q", "--detach", &detached]).unwrap();
        std::fs::write(project.join("a.txt"), "edited, not committed\n").unwrap();
        assert!(current_branch(project).is_none());

        let branch = branch_here(project, project, "calm-moss-robin").unwrap();
        assert_eq!(branch, worktree_branch_for(project, "calm-moss-robin").unwrap());
        assert_eq!(current_branch(project).as_deref(), Some(branch.as_str()));
        // At the commit it was detached at, not main's tip, with the uncommitted edit kept.
        assert_eq!(run(project, &["rev-parse", "HEAD"]).unwrap().trim(), detached);
        assert_eq!(run(project, &["rev-parse", &branch]).unwrap().trim(), detached);
        assert_eq!(std::fs::read_to_string(project.join("a.txt")).unwrap(), "edited, not committed\n");

        // On a branch now, so there is nothing to make; and a name already a branch is never taken over.
        assert!(branch_here(project, project, "tidy-sage-wren").unwrap_err().to_string().contains("already on"));
        run(project, &["checkout", "-q", "--detach", "main"]).unwrap();
        assert!(branch_here(project, project, "calm-moss-robin").unwrap_err().to_string().contains("already exists"));
        assert_eq!(run(project, &["rev-parse", &branch]).unwrap().trim(), detached);
        assert!(current_branch(project).is_none());
    }

    #[test]
    fn pr_checkout_uses_the_fetched_head_and_cleans_up_a_failed_checkout() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let project = dir.path();
        // An ignored file named by .worktreeinclude is copied into a PR worktree as into any other.
        let excludes = project.join(".git/test-global-ignore");
        std::fs::write(&excludes, "").unwrap();
        run(project, &["config", "core.excludesFile", excludes.to_str().unwrap()]).unwrap();
        std::fs::write(project.join(".gitignore"), ".env\n").unwrap();
        std::fs::write(project.join(".worktreeinclude"), ".env\n").unwrap();
        run(project, &["add", "."]).unwrap();
        run(project, &["commit", "-qm", "worktree files"]).unwrap();
        std::fs::write(project.join(".env"), "LOCAL=1\n").unwrap();
        let original = run(project, &["rev-parse", "HEAD"]).unwrap();
        run(project, &["checkout", "-qb", "fork-head"]).unwrap();
        std::fs::write(project.join("fork.txt"), "from a fork").unwrap();
        run(project, &["add", "."]).unwrap();
        run(project, &["commit", "-qm", "fork change"]).unwrap();
        let head = run(project, &["rev-parse", "HEAD"]).unwrap();
        run(project, &["checkout", "main"]).unwrap();
        let wt = checkout_pr_worktree_with(project, "pr-12", 12, |cwd, number, branch| {
            assert_eq!(number, 12);
            assert_ne!(cwd, project);
            assert!(current_branch(cwd).is_none());
            run(cwd, &["checkout", "-b", branch, head.trim()]).map(|_| ())
        }).unwrap();
        assert_eq!(run(Path::new(&wt.path), &["rev-parse", "HEAD"]).unwrap(), head);
        assert_eq!(run(project, &["rev-parse", "HEAD"]).unwrap(), original);
        assert!(Path::new(&wt.path).join("fork.txt").exists());
        assert_eq!(std::fs::read_to_string(Path::new(&wt.path).join(".env")).unwrap(), "LOCAL=1\n");
        assert_eq!(wt.worktree_base.as_ref().and_then(|base| base.file_copy.as_ref()).map(|copy| copy.copied_count), Some(1));
        assert!(checkout_pr_worktree_with(project, "broken-pr", 12, |cwd, _, branch| {
            run(cwd, &["checkout", "-b", branch])?;
            bail!("GitHub unavailable")
        }).is_err());
        assert!(!worktree_path(project, "broken-pr").exists());
        assert!(!branch_exists(project, &worktree_branch_for(project, "broken-pr").unwrap()));
        // A collision never deletes the earlier worktree or branch.
        assert!(checkout_pr_worktree_with(project, "pr-12", 12, |_, _, _| unreachable!()).is_err());
        assert!(Path::new(&wt.path).exists());
    }

    #[test]
    fn adding_a_remote_resolves_a_local_only_repository_and_pushes() {
        let local = repo();
        let remote = tempfile::tempdir().unwrap();
        run(remote.path(), &["init", "--bare", "-q"]).unwrap();
        assert!(!has_remote(local.path()).unwrap());
        add_remote(local.path(), remote.path().to_str().unwrap()).unwrap();
        assert!(has_remote(local.path()).unwrap());
        push(local.path()).unwrap();
        assert_eq!(run(remote.path(), &["rev-parse", "main"]).unwrap(), run(local.path(), &["rev-parse", "HEAD"]).unwrap());
        assert!(add_remote(local.path(), "https://example.com/another.git").is_err());
        assert_eq!(remote_url(local.path()).as_deref(), remote.path().to_str());
    }

    #[test]
    fn invalid_remote_urls_do_not_change_git_configuration() {
        let local = repo();
        for url in ["", " ", "--upload-pack=bad", "https://example.com/repo\nnext"] {
            assert!(add_remote(local.path(), url).is_err());
            assert!(!has_remote(local.path()).unwrap());
        }
    }

    #[test]
    fn checks_out_an_existing_branch_in_a_worktree_as_it_is() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        run(p, &["checkout", "-q", "-b", "feat/old-work"]).unwrap();
        std::fs::write(p.join("b.txt"), "kept\n").unwrap();
        run(p, &["add", "."]).unwrap();
        run(p, &["commit", "-q", "-m", "old work"]).unwrap();
        run(p, &["checkout", "-q", "main"]).unwrap();
        let wt = checkout_worktree(p, "old-work", "feat/old-work").unwrap();
        assert_eq!(wt.branch, "feat/old-work");
        assert_eq!(current_branch(Path::new(&wt.path)).as_deref(), Some("feat/old-work"));
        assert_eq!(std::fs::read_to_string(Path::new(&wt.path).join("b.txt")).unwrap(), "kept\n");
        assert!(checkout_worktree(p, "nothing", "no-such-branch").is_err());
        assert!(checkout_worktree(p, "bad", "--force").is_err());
        let again = checkout_worktree(p, "old-work-2", "feat/old-work").unwrap_err().to_string();
        assert!(again.contains("already checked out in another folder"), "{again}");
    }

    #[test]
    fn snapshot_and_changes() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let base = snapshot_tree(p).unwrap();
        assert_eq!(base, head_tree(p).unwrap());
        std::fs::write(p.join("a.txt"), "hello\nworld\n").unwrap();
        std::fs::write(p.join("b.txt"), "new\n").unwrap();
        let head = snapshot_tree(p).unwrap();
        assert_ne!(base, head);
        // The real index is untouched.
        assert!(run(p, &["diff", "--cached", "--name-only", "--"]).unwrap().trim().is_empty());
        let mut ch = changes_between(p, &base, Some(&head)).unwrap();
        ch.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(ch.len(), 2);
        assert_eq!(ch[0].path, "a.txt");
        assert_eq!(ch[0].status, ChangeStatus::Modified);
        assert_eq!(ch[0].additions, 1);
        assert_eq!(ch[1].status, ChangeStatus::Added);
        assert_eq!(blob_at(p, &head, "b.txt").unwrap().unwrap(), "new\n");
        assert!(blob_at(p, &base, "b.txt").unwrap().is_none());
        let ws = work_status(p);
        assert!(ws.is_repo && ws.dirty);
        assert_eq!(ws.branch.as_deref(), Some("main"));
    }

    #[cfg(unix)]
    #[test]
    fn review_blob_identities_cover_renames_deletions_binary_and_live_changes() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        std::fs::write(p.join("old name"), "a unique file to rename\n").unwrap();
        std::fs::write(p.join("gone"), "removed\n").unwrap();
        commit_all(p, "fixtures", None).unwrap();
        let base = head_tree(p).unwrap();
        let renamed = "new\tname\n.txt";
        std::fs::rename(p.join("old name"), p.join(renamed)).unwrap();
        std::fs::remove_file(p.join("gone")).unwrap();
        std::fs::write(p.join("binary"), [0, 1, 255, 2]).unwrap();
        std::fs::write(p.join("a.txt"), "hello\nmodified\n").unwrap();
        let head = snapshot_tree(p).unwrap();
        let files = changes_between(p, &base, Some(&head)).unwrap();
        assert_eq!(files.len(), 4);
        for file in &files {
            let expected = if file.status == ChangeStatus::Deleted {
                format!("deleted:{}", run(p, &["rev-parse", &format!("{base}:{}", file.path)]).unwrap().trim())
            } else {
                run(p, &["rev-parse", &format!("{head}:{}", file.path)]).unwrap().trim().to_string()
            };
            assert_eq!(file.blob_hash.as_deref(), Some(expected.as_str()));
        }
        let rename = files.iter().find(|file| file.path == renamed).unwrap();
        assert_eq!(rename.old_path.as_deref(), Some("old name"));
        assert_eq!(rename.status, ChangeStatus::Renamed);
        std::fs::write(p.join("binary"), [0, 3, 255, 2]).unwrap();
        let next = snapshot_tree(p).unwrap();
        let updated = changes_between_options(p, &base, Some(&next), true).unwrap();
        for file in &files {
            let changed = updated.iter().find(|other| other.path == file.path).unwrap();
            assert_eq!(file.blob_hash == changed.blob_hash, file.path != "binary");
        }
        assert!(changes_between(p, &base, None).unwrap().iter().all(|file| file.blob_hash.is_none()));
    }

    #[test]
    fn commit_scope_counts_match_git_show_for_root_regular_and_merge_commits() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let mut commits = log_commits(p, None, 1).unwrap();
        std::fs::write(p.join("a.txt"), "hello\nmore\n").unwrap();
        commit_all(p, "regular", None).unwrap();
        commits.extend(log_commits(p, None, 1).unwrap());
        run(p, &["checkout", "-b", "other"]).unwrap();
        std::fs::write(p.join("other.txt"), "other branch\n").unwrap();
        commit_all(p, "other", None).unwrap();
        run(p, &["checkout", "main"]).unwrap();
        std::fs::write(p.join("main.txt"), "main branch\n").unwrap();
        commit_all(p, "main", None).unwrap();
        run(p, &["merge", "--no-ff", "other", "-m", "merge"]).unwrap();
        commits.extend(log_commits(p, None, 1).unwrap());
        for commit in commits {
            let base = commit.parent.as_deref().map(|sha| log_commits(p, Some(sha), 1).unwrap()[0].tree.clone()).unwrap_or_else(|| EMPTY_TREE.into());
            let files = changes_between(p, &base, Some(&commit.tree)).unwrap();
            let expected = run(p, &["show", "--format=", "--numstat", &commit.sha, "--"]).unwrap();
            let actual = files.iter().map(|file| format!("{}\t{}\t{}\n", file.additions, file.deletions, file.path)).collect::<String>();
            assert_eq!(actual.trim(), expected.trim(), "commit {}", commit.sha);
        }
    }

    #[test]
    fn whitespace_stats_preserve_the_changed_file_list_and_count_real_edits() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        std::fs::write(p.join("space.txt"), "  x = 1;\n\treturn x;\n").unwrap();
        std::fs::write(p.join("real.txt"), "a\nb\n").unwrap();
        let base = snapshot_tree(p).unwrap();
        std::fs::write(p.join("space.txt"), "x=1;\nreturn  x;  \n").unwrap();
        std::fs::write(p.join("real.txt"), " a \nc\n").unwrap();
        let head = snapshot_tree(p).unwrap();
        let normal = changes_between(p, &base, Some(&head)).unwrap();
        let hidden = changes_between_options(p, &base, Some(&head), true).unwrap();
        assert_eq!(normal.len(), 2);
        assert_eq!(hidden.len(), 2);
        let space = hidden.iter().find(|f| f.path == "space.txt").unwrap();
        assert_eq!((space.additions, space.deletions), (0, 0));
        assert!(normal.iter().find(|f| f.path == "space.txt").unwrap().additions > 0);
        let real = hidden.iter().find(|f| f.path == "real.txt").unwrap();
        assert_eq!((real.additions, real.deletions), (1, 1));
    }

    #[test]
    fn review_accumulated_work_and_merge_base() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let initial = head_tree(p).unwrap();
        run(p, &["checkout", "-qb", "feature"]).unwrap();
        std::fs::write(p.join("A"), "committed\n").unwrap();
        run(p, &["add", "A"]).unwrap();
        run(p, &["commit", "-qm", "A"]).unwrap();
        std::fs::write(p.join("a.txt"), "hello\nmodified\n").unwrap();
        std::fs::write(p.join("C"), "untracked\n").unwrap();
        let all = review_range(p, Some("main"), false).unwrap();
        assert_eq!(all.base, initial);
        let files = changes_between(p, &all.base, Some(&all.head)).unwrap();
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["A", "C", "a.txt"]);
        assert_eq!(files.iter().map(|f| f.additions).sum::<u32>(), 3);
        let uncommitted = review_range(p, None, true).unwrap();
        assert_eq!(changes_between(p, &uncommitted.base, Some(&uncommitted.head)).unwrap().len(), 2);
        assert_eq!(blob_at(p, &all.head, "C").unwrap().as_deref(), Some("untracked\n"));
        assert!(run(p, &["diff", "--cached", "--name-only"]).unwrap().is_empty());
        assert!(review_range(p, Some("missing"), false).is_err());
        assert!(review_range(p, Some("--help"), false).is_err());
        // Advance the target independently: review still starts at the merge base.
        run(p, &["stash", "-u"]).unwrap();
        run(p, &["checkout", "main"]).unwrap();
        std::fs::write(p.join("other"), "target only\n").unwrap();
        run(p, &["add", "."]).unwrap();
        run(p, &["commit", "-qm", "advance target"]).unwrap();
        run(p, &["checkout", "feature"]).unwrap();
        assert_eq!(review_range(p, Some("main"), false).unwrap().base, initial);
        assert_eq!(review_range(p, Some("feature"), false).unwrap().base, head_tree(p).unwrap());
    }

    #[test]
    fn review_unborn_clean_rename_and_delete() {
        let _home = crate::store::temp_home();
        let empty = tempfile::tempdir().unwrap();
        let p = empty.path();
        run(p, &["init", "-qb", "main"]).unwrap();
        let range = review_range(p, None, false).unwrap();
        assert!(changes_between(p, &range.base, Some(&range.head)).unwrap().is_empty());
        std::fs::write(p.join("new"), "new\n").unwrap();
        let range = review_range(p, None, false).unwrap();
        assert_eq!(changes_between(p, &range.base, Some(&range.head)).unwrap().len(), 1);
        assert!(review_range(p, Some("missing"), false).is_err());
        let dir = repo();
        let p = dir.path();
        std::fs::write(p.join("a.txt"), "one\ntwo\nthree\nfour\nfive\n").unwrap();
        std::fs::write(p.join("deleted"), "remove\n").unwrap();
        run(p, &["add", "."]).unwrap();
        run(p, &["commit", "-qm", "seed"]).unwrap();
        std::fs::rename(p.join("a.txt"), p.join("renamed")).unwrap();
        std::fs::write(p.join("renamed"), "one\ntwo\nthree\nfour\nfive\nsix\n").unwrap();
        std::fs::remove_file(p.join("deleted")).unwrap();
        let range = review_range(p, None, true).unwrap();
        let files = changes_between(p, &range.base, Some(&range.head)).unwrap();
        let rename = files.iter().find(|f| f.status == ChangeStatus::Renamed).unwrap();
        assert_eq!(rename.old_path.as_deref(), Some("a.txt"));
        assert_eq!((rename.additions, rename.deletions), (1, 0));
        let deleted = files.iter().find(|f| f.status == ChangeStatus::Deleted).unwrap();
        assert_eq!(deleted.deletions, 1);
        assert!(blob_at(p, &range.head, "deleted").unwrap().is_none());
    }

    fn stale_clone() -> (tempfile::TempDir, tempfile::TempDir) {
        let remote = repo();
        let local = tempfile::tempdir().unwrap();
        run(local.path(), &["clone", "-q", arg(remote.path()).unwrap(), "."]).unwrap();
        std::fs::write(remote.path().join("a.txt"), "latest remote content\n").unwrap();
        run(remote.path(), &["commit", "-qam", "advance remote"]).unwrap();
        (remote, local)
    }

    #[test]
    fn worktree_fetches_latest_default_without_touching_checkout() {
        let _home = crate::store::temp_home();
        let (remote, local) = stale_clone();
        let p = local.path();
        let old = head_commit(p).unwrap();
        // Even an unusual fetch mapping must not update local branches.
        run(p, &["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]).unwrap();
        std::fs::write(p.join("a.txt"), "local edits\n").unwrap();
        run(p, &["add", "a.txt"]).unwrap();
        let index = run(p, &["diff", "--cached"]).unwrap();
        let wt = create_worktree(p, "fresh-base", None).unwrap();
        assert_eq!(head_commit(Path::new(&wt.path)), head_commit(remote.path()));
        assert_eq!(wt.base_tree, head_tree(remote.path()).unwrap());
        let provenance = wt.worktree_base.unwrap();
        assert!(provenance.fetched);
        assert!(provenance.warning.is_none());
        assert_eq!(Some(provenance.commit), head_commit(remote.path()));
        assert_eq!(head_commit(p).unwrap(), old);
        assert_eq!(run(p, &["diff", "--cached"]).unwrap(), index);
        assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "local edits\n");
    }

    #[test]
    fn worktree_fetches_custom_default_with_missing_tracking_ref() {
        let _home = crate::store::temp_home();
        let (remote, local) = stale_clone();
        run(remote.path(), &["branch", "-m", "main", "trunk"]).unwrap();
        run(local.path(), &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]).unwrap();
        let wt = create_worktree(local.path(), "custom-default", None).unwrap();
        assert_eq!(wt.base, "origin/trunk");
        assert_eq!(head_commit(Path::new(&wt.path)), head_commit(remote.path()));
        assert!(wt.worktree_base.unwrap().fetched);
    }

    #[test]
    fn worktree_failed_fetch_uses_local_ref_and_warns() {
        let _home = crate::store::temp_home();
        let (remote, local) = stale_clone();
        let old = head_commit(local.path());
        drop(remote);
        let wt = create_worktree(local.path(), "offline-base", None).unwrap();
        assert_eq!(head_commit(Path::new(&wt.path)), old);
        assert_eq!(wt.base, "origin/main");
        let provenance = wt.worktree_base.unwrap();
        assert!(!provenance.fetched);
        assert!(provenance.warning.unwrap().contains("may be out of date"));
    }

    #[test]
    fn worktree_without_remote_uses_local_default_without_warning() {
        let _home = crate::store::temp_home();
        let local = repo();
        let wt = create_worktree(local.path(), "local-base", None).unwrap();
        assert_eq!(head_commit(Path::new(&wt.path)), head_commit(local.path()));
        assert_eq!(wt.base, "main");
        let provenance = wt.worktree_base.unwrap();
        assert!(!provenance.fetched);
        assert!(provenance.warning.is_none());
    }

    #[test]
    fn worktree_explicit_base_skips_fetch() {
        let _home = crate::store::temp_home();
        let (_remote, local) = stale_clone();
        let old = head_commit(local.path());
        let wt = create_worktree(local.path(), "explicit-base", Some("origin/main")).unwrap();
        assert_eq!(head_commit(Path::new(&wt.path)), old);
        assert_eq!(run(local.path(), &["rev-parse", "origin/main"]).unwrap().trim(), old.unwrap());
        let provenance = wt.worktree_base.unwrap();
        assert!(!provenance.fetched);
        assert!(provenance.warning.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn worktree_fetch_timeout_still_creates_and_warns() {
        let _home = crate::store::temp_home();
        let (_remote, local) = stale_clone();
        // A real Git transport that stalls, including a child process.
        run(local.path(), &["config", "remote.origin.url", "ext::sh -c sleep% 30"]).unwrap();
        run(local.path(), &["config", "protocol.ext.allow", "always"]).unwrap();
        let start = std::time::Instant::now();
        let wt = create_worktree_with_timeout(local.path(), "timeout-base", None, std::time::Duration::from_millis(100)).unwrap();
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
        assert_eq!(head_commit(Path::new(&wt.path)), head_commit(local.path()));
        let provenance = wt.worktree_base.unwrap();
        assert!(!provenance.fetched);
        assert!(provenance.warning.unwrap().contains("fetch timed out"));
    }

    #[test]
    fn worktree_lifecycle() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = create_worktree(p, "quiet-amber-fox", None).unwrap();
        assert!(Path::new(&wt.path).join("a.txt").exists());
        assert_eq!(wt.branch, "raccoon/quiet-amber-fox");
        assert!(worktree_branch_names(p).contains(&"quiet-amber-fox".to_string()));
        assert!(taken_worktree_names(p, &[]).contains(&"quiet-amber-fox".to_string()));
        // The project's own status doesn't list the worktree directory.
        assert!(!work_status(p).dirty);
        std::fs::write(Path::new(&wt.path).join("c.txt"), "x").unwrap();
        let d = worktree_disposition(p, "quiet-amber-fox");
        assert!(d.exists && d.uncommitted == 1 && d.unpushed == 0);
        assert!(remove_worktree(p, "", DirectDelete::Allowed).is_err());
        assert!(remove_worktree(p, "../x", DirectDelete::Allowed).is_err());
        remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).unwrap();
        assert!(!Path::new(&wt.path).exists());
        assert!(!worktree_branch_names(p).contains(&"quiet-amber-fox".to_string()));
    }

    #[test]
    fn a_bad_worktree_name_is_refused_before_anything_is_touched() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = create_worktree(p, "quiet-amber-fox", None).unwrap();
        std::fs::create_dir_all(p.join(".raccoon/outside")).unwrap();
        for name in ["", ".", "..", "../outside", "../../a.txt", "a/b", "/tmp", "a\\b", "quiet-amber-fox/..", "x\0y"] {
            assert!(managed_worktree_path(p, name).is_err(), "{name:?} names a worktree");
            assert!(remove_worktree(p, name, DirectDelete::Allowed).is_err(), "{name:?} was removed");
        }
        assert!(p.join("a.txt").exists());
        assert!(p.join(".git").exists());
        assert!(p.join(".raccoon/outside").exists());
        assert!(Path::new(&wt.path).join("a.txt").exists());
    }

    #[test]
    fn a_worktree_git_cannot_remove_is_deleted_directly() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = create_worktree(p, "quiet-amber-fox", None).unwrap();
        // Without its `.git` file git no longer accepts the directory as a worktree.
        std::fs::remove_file(Path::new(&wt.path).join(".git")).unwrap();
        assert!(run(p, &["worktree", "remove", "--force", &wt.path]).is_err());
        remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).unwrap();
        assert!(!Path::new(&wt.path).exists());
        assert!(!run(p, &["worktree", "list", "--porcelain"]).unwrap().contains("quiet-amber-fox"), "the record is pruned");
        assert!(!worktree_branch_names(p).contains(&"quiet-amber-fox".to_string()));

        // A directory git never knew about goes the same way.
        let stray = worktree_path(p, "stray");
        std::fs::create_dir_all(stray.join("node_modules")).unwrap();
        remove_worktree(p, "stray", DirectDelete::Allowed).unwrap();
        assert!(!stray.exists());
        assert!(p.join("a.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_in_the_worktree_directory_is_never_followed() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("keep.txt"), "keep").unwrap();
        std::fs::create_dir_all(worktree_root(p)).unwrap();
        let link = worktree_path(p, "link");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();

        assert!(remove_worktree(p, "link", DirectDelete::Allowed).is_err());
        assert!(remove_managed_worktree_dir(p, &link).is_err());
        assert!(outside.path().join("keep.txt").exists());
        assert!(link.symlink_metadata().is_ok(), "the link itself is left alone");

        // A link to the project must not take the project with it either.
        let to_project = worktree_path(p, "project");
        std::os::unix::fs::symlink(p, &to_project).unwrap();
        assert!(remove_worktree(p, "project", DirectDelete::Allowed).is_err());
        assert!(p.join("a.txt").exists());
    }

    #[test]
    fn the_direct_delete_only_takes_a_child_of_the_worktree_directory() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = create_worktree(p, "quiet-amber-fox", None).unwrap();
        let nested = Path::new(&wt.path).join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let sibling = p.join(".raccoon/outside");
        std::fs::create_dir_all(&sibling).unwrap();
        let elsewhere = tempfile::tempdir().unwrap();

        for path in [p.to_path_buf(), worktree_root(p), nested, sibling, elsewhere.path().to_path_buf(), worktree_root(p).join("../worktrees"), worktree_path(p, "missing")] {
            assert!(remove_managed_worktree_dir(p, &path).is_err(), "{} was deleted", path.display());
        }
        assert!(p.join("a.txt").exists());
        assert!(Path::new(&wt.path).join("nested").exists());
        assert!(elsewhere.path().exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_removal_that_fails_says_where_and_why_and_keeps_the_branch() {
        use std::os::unix::fs::PermissionsExt;
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = create_worktree(p, "quiet-amber-fox", None).unwrap();
        std::fs::set_permissions(&wt.path, std::fs::Permissions::from_mode(0o555)).unwrap();
        let error = remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).map_err(|e| format!("{e:#}"));
        std::fs::set_permissions(&wt.path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = error.unwrap_err();
        assert!(error.contains(&wt.path), "{error}");
        assert!(Path::new(&wt.path).join("a.txt").exists());
        assert!(worktree_branch_names(p).contains(&"quiet-amber-fox".to_string()));
        remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).unwrap();
        assert!(!Path::new(&wt.path).exists());
    }

    /// A worktree holding one commit nothing else has and one dirty file.
    fn worktree_with_unsaved_work(p: &Path, name: &str) -> (PathBuf, String) {
        let wt = PathBuf::from(create_worktree(p, name, None).unwrap().path);
        std::fs::write(wt.join("work.txt"), "work\n").unwrap();
        run(&wt, &["add", "."]).unwrap();
        run(&wt, &["commit", "-q", "-m", "unpushed"]).unwrap();
        let commit = run(&wt, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        std::fs::write(wt.join("dirty.txt"), "dirty\n").unwrap();
        (wt, commit)
    }

    #[test]
    fn a_broken_worktree_reads_as_unchecked_and_its_unpushed_commits_survive() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let (wt, commit) = worktree_with_unsaved_work(p, "quiet-amber-fox");
        let intact = worktree_disposition(p, "quiet-amber-fox");
        assert!(intact.checked && intact.uncommitted == 1 && intact.unpushed == 1);

        // Without its `.git` file git answers for the enclosing project, where
        // the worktree folder is ignored: that must not read as "clean".
        std::fs::remove_file(wt.join(".git")).unwrap();
        assert!(!is_own_worktree(&wt));
        let broken = worktree_disposition(p, "quiet-amber-fox");
        assert!(broken.exists && !broken.checked, "{broken:?}");

        // A caller that showed nothing may not delete it directly at all.
        assert!(remove_worktree(p, "quiet-amber-fox", DirectDelete::Never).is_err());
        assert!(wt.join("dirty.txt").exists());

        // After an explicit confirmation the directory goes, but the branch
        // holding the only copy of the commit is kept and named.
        let removal = remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).unwrap();
        assert_eq!(removal.kept_branch.as_deref(), Some("raccoon/quiet-amber-fox"));
        assert!(!wt.exists());
        assert_eq!(run(p, &["rev-parse", "raccoon/quiet-amber-fox"]).unwrap().trim(), commit);
    }

    #[test]
    fn a_clone_or_another_repositorys_worktree_at_a_managed_path_cannot_be_checked() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        std::fs::create_dir_all(worktree_root(p)).unwrap();
        // A clone with a commit only it has.
        let clone = worktree_path(p, "a-clone");
        std::fs::create_dir_all(&clone).unwrap();
        run(&clone, &["init", "-q", "-b", "main"]).unwrap();
        run(&clone, &["config", "user.email", "t@example.com"]).unwrap();
        run(&clone, &["config", "user.name", "T"]).unwrap();
        std::fs::write(clone.join("only-here.txt"), "x").unwrap();
        run(&clone, &["add", "."]).unwrap();
        run(&clone, &["commit", "-q", "-m", "local only"]).unwrap();
        assert!(is_own_worktree(&clone) && !is_worktree_of(p, &clone));
        let d = worktree_disposition(p, "a-clone");
        assert!(d.exists && !d.checked, "{d:?}");

        // Another repository's worktree.
        let other = repo();
        let foreign = worktree_path(p, "foreign");
        run(other.path(), &["worktree", "add", "-q", "-b", "theirs", foreign.to_str().unwrap()]).unwrap();
        assert!(!is_worktree_of(p, &foreign));
        assert!(!worktree_disposition(p, "foreign").checked);

        // Our own still is.
        create_worktree(p, "quiet-amber-fox", None).unwrap();
        assert!(worktree_disposition(p, "quiet-amber-fox").checked);
    }

    #[test]
    fn commits_on_the_branch_count_even_when_head_was_moved_off_it() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = PathBuf::from(create_worktree(p, "quiet-amber-fox", None).unwrap().path);
        std::fs::write(wt.join("work.txt"), "work\n").unwrap();
        run(&wt, &["add", "."]).unwrap();
        run(&wt, &["commit", "-q", "-m", "on the branch"]).unwrap();
        let commit = run(&wt, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        run(&wt, &["checkout", "-q", "--detach", "main"]).unwrap();

        let d = worktree_disposition(p, "quiet-amber-fox");
        assert!(d.checked && d.unpushed == 1, "the branch's commit is what deleting loses: {d:?}");

        // A caller that showed nothing keeps the branch.
        let removal = remove_worktree(p, "quiet-amber-fox", DirectDelete::Never).unwrap();
        assert!(!wt.exists());
        assert_eq!(removal.kept_branch.as_deref(), Some("raccoon/quiet-amber-fox"));
        assert_eq!(run(p, &["rev-parse", "raccoon/quiet-amber-fox"]).unwrap().trim(), commit);

        // One that showed the count and was confirmed deletes it, as asked.
        let again = worktree_path(p, "quiet-amber-fox");
        run(p, &["worktree", "add", "-q", again.to_str().unwrap(), "raccoon/quiet-amber-fox"]).unwrap();
        assert_eq!(worktree_disposition(p, "quiet-amber-fox").unpushed, 1);
        let removal = remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).unwrap();
        assert!(!again.exists());
        assert_eq!(removal, WorktreeRemoval::default());
    }

    #[test]
    fn a_detached_head_nothing_else_holds_is_rescued_before_a_direct_delete() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = PathBuf::from(create_worktree(p, "quiet-amber-fox", None).unwrap().path);
        run(&wt, &["checkout", "-q", "--detach"]).unwrap();
        std::fs::write(wt.join("work.txt"), "work\n").unwrap();
        run(&wt, &["add", "."]).unwrap();
        run(&wt, &["commit", "-q", "-m", "detached"]).unwrap();
        let commit = run(&wt, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        assert_eq!(detached_head(p, &wt).as_deref(), Some(commit.as_str()));

        // The directory breaks; the repository's record still knows HEAD.
        std::fs::remove_file(wt.join(".git")).unwrap();
        assert_eq!(detached_head(p, &wt).as_deref(), Some(commit.as_str()));
        let removal = remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).unwrap();
        assert!(!wt.exists());
        let rescued = removal.rescued_branch.expect("the commit is given a branch");
        assert_eq!(rescued, format!("raccoon/rescued/quiet-amber-fox-{}", &commit[..8]));
        assert_eq!(run(p, &["rev-parse", &rescued]).unwrap().trim(), commit);

        // A detached HEAD on a commit something else holds needs no rescue.
        let wt = PathBuf::from(create_worktree(p, "calm-teal-bee", None).unwrap().path);
        run(&wt, &["checkout", "-q", "--detach"]).unwrap();
        std::fs::remove_file(wt.join(".git")).unwrap();
        assert_eq!(remove_worktree(p, "calm-teal-bee", DirectDelete::Allowed).unwrap().rescued_branch, None);
    }

    #[test]
    fn a_branch_with_nothing_of_its_own_goes_after_a_direct_delete() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = create_worktree(p, "quiet-amber-fox", None).unwrap();
        std::fs::remove_file(Path::new(&wt.path).join(".git")).unwrap();
        assert_eq!(remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).unwrap(), WorktreeRemoval::default());
        assert!(!worktree_branch_names(p).contains(&"quiet-amber-fox".to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn a_removal_that_stops_part_way_says_what_is_left() {
        use std::os::unix::fs::PermissionsExt;
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let (wt, commit) = worktree_with_unsaved_work(p, "quiet-amber-fox");
        let locked = wt.join("zz-locked");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::write(locked.join("held.bin"), vec![1u8; 64 * 1024]).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();

        let error = remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).map_err(|e| format!("{e:#}"));
        let usable = is_own_worktree(&wt);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = error.unwrap_err();

        assert!(error.contains(wt.to_str().unwrap()), "{error}");
        assert!(locked.join("held.bin").exists());
        if usable {
            assert!(error.contains("still a checkout"), "{error}");
        } else {
            assert!(error.contains("partly removed") && error.contains("no longer a usable checkout"), "{error}");
        }
        assert!(error.contains("KB") || error.contains("MB"), "the size that remains is given: {error}");
        // Whatever state the directory is in, the unpushed commit is not lost.
        assert_eq!(run(p, &["rev-parse", "raccoon/quiet-amber-fox"]).unwrap().trim(), commit);

        // Retrying finishes the job and still keeps the branch.
        let removal = remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).unwrap();
        assert!(!wt.exists());
        assert_eq!(removal.kept_branch.as_deref(), Some("raccoon/quiet-amber-fox"));
    }

    #[test]
    fn another_projects_directory_in_a_shared_worktree_folder_is_refused() {
        let _home = crate::store::temp_home();
        // A worktree folder outside any project, as an absolute setting allows.
        let shared = tempfile::tempdir().unwrap();
        let shared_root = crate::paths::canonicalize(shared.path()).unwrap();
        let settings = crate::store::settings::Settings { worktree_dir: shared_root.to_string_lossy().into_owned(), ..Default::default() };
        crate::store::settings::save(&settings).unwrap();
        let ours = repo();
        let theirs = repo();
        assert_eq!(worktree_root(ours.path()), shared_root);

        // The other project's worktree, under the name of a session we are deleting.
        let foreign = PathBuf::from(create_worktree(theirs.path(), "fix-login", None).unwrap().path);
        std::fs::write(foreign.join("theirs.txt"), "theirs").unwrap();
        let error = format!("{:#}", remove_worktree(ours.path(), "fix-login", DirectDelete::Allowed).unwrap_err());
        assert!(error.contains("another repository"), "{error}");
        assert!(foreign.join("theirs.txt").exists());
        assert!(remove_managed_worktree_dir(ours.path(), &foreign).is_err());

        // A clone someone put in the worktree folder is a repository of its own.
        let clone = shared_root.join("a-clone");
        std::fs::create_dir_all(&clone).unwrap();
        run(&clone, &["init", "-q", "-b", "main"]).unwrap();
        std::fs::write(clone.join("precious.txt"), "x").unwrap();
        let error = format!("{:#}", remove_worktree(ours.path(), "a-clone", DirectDelete::Allowed).unwrap_err());
        assert!(error.contains("repository of its own"), "{error}");
        assert!(clone.join("precious.txt").exists());

        // Our own worktree there, broken, is still ours to delete.
        let own = PathBuf::from(create_worktree(ours.path(), "quiet-amber-fox", None).unwrap().path);
        let record = std::fs::read_to_string(own.join(".git")).unwrap();
        assert!(record.starts_with("gitdir:"));
        std::fs::write(own.join(".git"), format!("{}\n", record.trim().replace("quiet-amber-fox", "pruned-record"))).unwrap();
        remove_worktree(ours.path(), "quiet-amber-fox", DirectDelete::Allowed).unwrap();
        assert!(!own.exists());
        assert!(foreign.join("theirs.txt").exists());
    }

    #[test]
    fn a_dot_git_that_names_no_repository_is_refused() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = PathBuf::from(create_worktree(p, "quiet-amber-fox", None).unwrap().path);
        for content in ["", "garbage\n", "gitdir:\n", "gitdir: /somewhere/else/.git/worktrees/quiet-amber-fox\n", "gitdir: ../../..\n"] {
            std::fs::write(wt.join(".git"), content).unwrap();
            assert!(remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).is_err(), "{content:?}");
            assert!(wt.join("a.txt").exists(), "{content:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_link_inside_a_worktree_is_removed_as_a_link() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = PathBuf::from(create_worktree(p, "quiet-amber-fox", None).unwrap().path);
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("keep.txt"), "keep").unwrap();
        std::os::unix::fs::symlink(outside.path(), wt.join("linked-dir")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("keep.txt"), wt.join("linked-file")).unwrap();
        std::os::unix::fs::symlink(p, wt.join("linked-project")).unwrap();
        // Through git, and through the direct delete.
        for broken in [false, true] {
            if broken {
                let again = PathBuf::from(create_worktree(p, "quiet-amber-fox", None).unwrap().path);
                std::os::unix::fs::symlink(outside.path(), again.join("linked-dir")).unwrap();
                std::os::unix::fs::symlink(p, again.join("linked-project")).unwrap();
                std::fs::remove_file(again.join(".git")).unwrap();
            }
            remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).unwrap();
            assert!(!wt.exists());
            assert!(outside.path().join("keep.txt").exists());
            assert!(p.join("a.txt").exists());
        }
    }

    #[test]
    fn a_name_in_another_case_never_reaches_outside_the_worktree_folder() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = PathBuf::from(create_worktree(p, "quiet-amber-fox", None).unwrap().path);
        std::fs::create_dir_all(p.join(".RACCOON-other")).unwrap();
        // On a case-insensitive disk this is the same directory; on a
        // case-sensitive one it is nothing. Either way only that entry of the
        // worktree folder can be affected.
        let _ = remove_worktree(p, "QUIET-AMBER-FOX", DirectDelete::Allowed);
        assert!(!wt.exists() || wt.join("a.txt").exists());
        assert!(p.join("a.txt").exists());
        assert!(p.join(".git").is_dir());
        assert!(p.join(".RACCOON-other").exists());
    }

    #[test]
    fn log_and_commit() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        std::fs::write(p.join("a.txt"), "changed\n").unwrap();
        let sha = commit_all(p, "second\n\nbody here", None).unwrap();
        let log = log_commits(p, None, 10).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].sha, sha);
        assert_eq!(log[0].subject, "second");
        assert_eq!(log[0].body, "body here");
        assert!(log[1].parent.is_none());
    }

    #[test]
    fn dash_prefixed_refs_and_ranges_are_rejected_without_option_injection() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let injected = p.join("injected-output.txt");
        let output_flag = format!("--output={}", injected.display());
        assert!(log_commits(p, Some(&output_flag), 10).is_err());
        assert!(!injected.exists(), "git log must never interpret range as --output=<file>");
        assert!(log_commits(p, Some("--all"), 10).is_err());
        assert!(log_commits(p, Some("-p"), 10).is_err());
        assert!(log_commits(p, Some("HEAD"), 10).is_ok());
        assert!(resolve_base(p, Some("--all")).is_err());
        assert!(resolve_base(p, Some("-q")).is_err());
        assert!(review_range(p, Some("--all"), false).is_err());
        assert!(merge_tree(p, "--allow-unrelated-histories", "HEAD").is_err());
        assert!(merge_tree(p, "HEAD", "--name-only").is_err());
        assert!(fetch_admitted(p, "--upload-pack=sh", std::time::Duration::from_secs(1)).is_err());
        assert!(create_worktree(p, "-evil", None).is_err());
        assert!(checkout_worktree(p, "-evil", "main").is_err());
        assert!(checkout_branch(p, "-b", false).is_err());
        assert!(!branch_exists(p, "--all"));
        assert_eq!(unique_commits(p, "--all"), None);
    }
}
