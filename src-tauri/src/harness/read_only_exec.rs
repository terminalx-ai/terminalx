//! TerminalX runs an automatically approved discovery command itself
//! (PRO-330). The provider's shell is never used for it: that shell has
//! loaded the user's startup files, and what they define (a function named
//! `/usr/bin/env` or `/bin/test`, readonly exported loader variables, an
//! xtrace prompt or a DEBUG trap) runs before, or instead of, anything typed
//! into it. Here every program is an absolute path executed directly, with an
//! empty environment plus a fixed list, in the approved directory. The
//! provider receives the result as the hook's answer and runs nothing.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How a list member is joined to the one before it: `;` (or a newline),
/// `&&` or `||`. Pipelines bind tighter than all three.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Join {
    Then,
    And,
    Or,
}

/// What the model is told first, with the exit status after it. Its first
/// line is what `ran_result` recognises, so keep the two together.
const HEADER: &str = "TerminalX approved this read-only command and ran it itself, without a shell. Exit status: ";

/// Status for a command that never started because its approved directory is
/// gone, the same status the earlier in-shell directory guard used.
pub const NOT_IN_DIRECTORY: i32 = 125;
/// `timeout(1)`'s status for a command it stopped.
const TIMED_OUT: i32 = 124;

/// Below the 600 s both CLIs give the permission hook, so the answer always
/// arrives before the CLI gives up on it.
const MAX_TIMEOUT: Duration = Duration::from_secs(540);
/// Claude Code's own Bash default.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
/// Claude Code's default Bash output limit, in bytes rather than characters.
const DEFAULT_LIMIT: usize = 30_000;

/// A vetted discovery command. Only `read_only::approved` builds one.
#[derive(Debug)]
pub struct Approved {
    directory: PathBuf,
    /// The directory as it was inspected. Programs start in it by
    /// descriptor, so a path swapped for another directory since then is
    /// refused rather than followed.
    handle: std::fs::File,
    lists: Vec<(Join, Vec<Vec<OsString>>)>,
    env: Vec<(&'static str, String)>,
    timeout: Duration,
    limit: usize,
    notes: Vec<String>,
}

/// How a pipeline ended.
#[cfg(unix)]
enum Stop {
    Exited(i32),
    Deadline,
    /// Nobody wants the result any more.
    Abandoned,
}

/// What a run produced, and what the model is told about it.
#[derive(Debug)]
pub struct Ran {
    pub status: i32,
    /// Interleaved stdout and stderr of every program, shortened in the
    /// middle when longer than the limit.
    pub output: String,
    directory: PathBuf,
    notes: Vec<String>,
}

impl Approved {
    pub(super) fn new(
        directory: PathBuf,
        handle: std::fs::File,
        lists: Vec<(Join, Vec<Vec<OsString>>)>,
        env: Vec<(&'static str, String)>,
        input: &serde_json::Value,
    ) -> Self {
        // Claude's Bash `timeout` and Codex's `timeout_ms` are both
        // milliseconds. Codex's `yield_time_ms` only says when to report
        // partial output, so it is not a reason to stop the command.
        let timeout = ["timeout", "timeout_ms"]
            .iter()
            .find_map(|field| input[*field].as_u64())
            .map(Duration::from_millis)
            .unwrap_or(DEFAULT_TIMEOUT)
            .clamp(Duration::from_secs(1), MAX_TIMEOUT);
        let limit = input["max_output_tokens"]
            .as_u64()
            .map(|tokens| usize::try_from(tokens.saturating_mul(4)).unwrap_or(usize::MAX))
            .map_or(DEFAULT_LIMIT, |bytes| bytes.clamp(1024, DEFAULT_LIMIT));
        Self { directory, handle, lists, env, timeout, limit, notes: Vec::new() }
    }

    /// Codex's normalized hooks omit a call's `workdir`, so a directory it
    /// only reported may not be the one the model meant. Say so rather
    /// than let output from one directory pass for another's.
    pub fn directory_was_reported(mut self) -> Self {
        self.notes.push("Codex does not tell TerminalX a call's workdir, so it ran in the session directory above. To look anywhere else, pass absolute paths in the command.".into());
        self
    }

    /// The directory the command runs in, as approved.
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// A run nothing abandons. TerminalX itself always uses `run_while`.
    #[cfg(test)]
    pub fn run(&self) -> Ran {
        self.run_while(&|| true).expect("a run nothing abandons finishes")
    }

    /// Run while `wanted` holds: the hook that asked is still connected and
    /// its CLI is still the tab's. Once it is not, nobody will read the
    /// result, so the programs are stopped and the run returns None.
    pub fn run_while(&self, wanted: &dyn Fn() -> bool) -> Option<Ran> {
        let ran = |status, output: String, notes: Vec<String>| Ran {
            status,
            output,
            directory: self.directory.clone(),
            notes,
        };
        if !same_directory(&self.directory, &self.handle) {
            return Some(ran(
                NOT_IN_DIRECTORY,
                String::new(),
                vec!["TerminalX did not run it: its directory is no longer the one TerminalX checked. Request a separate approval.".into()],
            ));
        }
        Some(match self.execute(wanted) {
            Ok(None) => return None,
            Ok(Some((status, capture, timed_out))) => {
                let mut notes = self.notes.clone();
                if timed_out {
                    notes.push(format!(
                        "TerminalX stopped it after {} s.",
                        self.timeout.as_secs()
                    ));
                }
                let (output, omitted) = capture.text();
                if omitted > 0 {
                    notes.push(format!(
                        "The output was {} bytes; {omitted} bytes in the middle are left out.",
                        capture.total
                    ));
                }
                ran(status, output, notes)
            }
            Err(error) => ran(
                NOT_IN_DIRECTORY,
                String::new(),
                vec![format!("TerminalX could not run it: {error}.")],
            ),
        })
    }

    /// The status, output and whether the deadline stopped it; None when
    /// the run was abandoned.
    #[cfg(unix)]
    fn execute(&self, wanted: &dyn Fn() -> bool) -> std::io::Result<Option<(i32, Capture, bool)>> {
        let deadline = Instant::now() + self.timeout;
        let (mut reader, writer) = std::io::pipe()?;
        let capture = Arc::new(Mutex::new(Capture::new(self.limit)));
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        {
            let capture = capture.clone();
            std::thread::spawn(move || {
                let mut buffer = [0u8; 8192];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => capture.lock().unwrap().push(&buffer[..n]),
                    }
                }
                let _ = done_tx.send(());
            });
        }
        let mut status = 0;
        let mut timed_out = false;
        for (join, pipeline) in &self.lists {
            match join {
                Join::And if status != 0 => continue,
                Join::Or if status == 0 => continue,
                _ => {}
            }
            match self.pipeline(pipeline, &writer, deadline, wanted)? {
                Stop::Exited(code) => status = code,
                Stop::Deadline => {
                    status = TIMED_OUT;
                    timed_out = true;
                    break;
                }
                Stop::Abandoned => return Ok(None),
            }
        }
        // EOF arrives once every program holding the pipe has exited. A
        // program that left a descendant holding it is not waited for.
        drop(writer);
        let _ = done_rx.recv_timeout(Duration::from_secs(1));
        let capture = std::mem::replace(&mut *capture.lock().unwrap(), Capture::new(0));
        Ok(Some((status, capture, timed_out)))
    }

    #[cfg(not(unix))]
    fn execute(&self, _: &dyn Fn() -> bool) -> std::io::Result<Option<(i32, Capture, bool)>> {
        Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "only Unix runs approved commands"))
    }

    /// Run one pipeline to its status: the last program's, as in a shell
    /// without `pipefail`.
    #[cfg(unix)]
    fn pipeline(
        &self,
        pipeline: &[Vec<OsString>],
        sink: &std::io::PipeWriter,
        deadline: Instant,
        wanted: &dyn Fn() -> bool,
    ) -> std::io::Result<Stop> {
        use std::os::unix::process::{CommandExt, ExitStatusExt};
        use std::process::{Command, Stdio};

        let mut children = Vec::new();
        let mut input = Stdio::null();
        let mut last_failed = None;
        for (index, argv) in pipeline.iter().enumerate() {
            let last = index + 1 == pipeline.len();
            let mut command = Command::new(&argv[0]);
            command
                .args(&argv[1..])
                .env_clear()
                .envs(self.env.iter().map(|(key, value)| (*key, value)))
                .env("PWD", &self.directory)
                .stdin(std::mem::replace(&mut input, Stdio::null()))
                .stderr(sink.try_clone()?)
                // Its own group, so a timeout stops what it started too.
                .process_group(0);
            enter(&mut command, &self.handle);
            if last {
                command.stdout(sink.try_clone()?);
            } else {
                command.stdout(Stdio::piped());
            }
            match command.spawn() {
                Ok(mut child) => {
                    if let Some(stdout) = child.stdout.take() {
                        input = Stdio::from(stdout);
                    }
                    children.push(child);
                    last_failed = None;
                }
                Err(error) => {
                    let name = Path::new(&argv[0]).display();
                    let _ = writeln!(&mut &*sink, "terminalx: {name}: {error}");
                    // A shell's statuses for a program it could not start.
                    last_failed = Some(if error.kind() == std::io::ErrorKind::PermissionDenied { 126 } else { 127 });
                }
            }
            // Drop the command so its copies of the pipe close here.
            drop(command);
        }
        let mut statuses: Vec<Option<std::process::ExitStatus>> = vec![None; children.len()];
        let mut pause = Duration::from_millis(1);
        loop {
            for (child, status) in children.iter_mut().zip(statuses.iter_mut()) {
                if status.is_none() {
                    *status = child.try_wait()?;
                }
            }
            if statuses.iter().all(Option::is_some) {
                break;
            }
            let abandoned = !wanted();
            if abandoned || Instant::now() >= deadline {
                for (child, status) in children.iter_mut().zip(&statuses) {
                    if status.is_none() {
                        // SAFETY: killpg only sends a signal to the group the
                        // child leads (process_group(0) above).
                        unsafe { libc::killpg(child.id() as libc::pid_t, libc::SIGKILL) };
                        let _ = child.wait();
                    }
                }
                return Ok(if abandoned { Stop::Abandoned } else { Stop::Deadline });
            }
            std::thread::sleep(pause.min(deadline.saturating_duration_since(Instant::now())));
            pause = (pause * 2).min(Duration::from_millis(25));
        }
        if let Some(status) = last_failed {
            return Ok(Stop::Exited(status));
        }
        let status = statuses.last().copied().flatten();
        Ok(Stop::Exited(status.map_or(127, |status| {
            status
                .code()
                .unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
        })))
    }

    /// A test needs programs the read-only language never approves, such
    /// as `/usr/bin/env`, to observe exactly what a program receives.
    #[cfg(test)]
    pub(super) fn for_test(directory: &Path, lists: Vec<(Join, Vec<Vec<&str>>)>, input: serde_json::Value) -> Self {
        let lists = lists
            .into_iter()
            .map(|(join, pipeline)| {
                (join, pipeline.into_iter().map(|argv| argv.into_iter().map(OsString::from).collect()).collect())
            })
            .collect();
        let handle = open_directory(directory).unwrap();
        Self::new(directory.to_path_buf(), handle, lists, super::Execution::owner().env, &input)
    }
}

/// The directory at `path`, opened to pin it for inspection and execution.
pub(super) fn open_directory(path: &Path) -> Option<std::fs::File> {
    let handle = std::fs::File::open(path).ok()?;
    handle.metadata().ok()?.is_dir().then_some(handle)
}

/// Whether `path` still names the directory `handle` was opened on.
fn same_directory(path: &Path, handle: &std::fs::File) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (std::fs::metadata(path), handle.metadata()) {
            (Ok(now), Ok(checked)) => now.is_dir() && now.dev() == checked.dev() && now.ino() == checked.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (path, handle);
        false
    }
}

/// Never reached: `approved` declines on other platforms.
#[cfg(not(unix))]
pub(super) fn enter(_: &mut std::process::Command, _: &std::fs::File) {}

/// Start `command` in the directory `handle` was opened on, not whatever
/// its path names by the time the program starts.
#[cfg(unix)]
pub(super) fn enter(command: &mut std::process::Command, handle: &std::fs::File) {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    let fd = handle.as_raw_fd();
    // SAFETY: fchdir is async-signal-safe, allocates nothing and only uses
    // a descriptor the child inherited across fork; the caller keeps
    // `handle` open until spawn returns.
    unsafe {
        command.pre_exec(move || {
            if libc::fchdir(fd) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
}

impl Ran {
    /// What the model is told, as the hook's answer. The CLI shows a hook
    /// answer as a blocked call, so the text says plainly that it ran.
    pub fn report(&self) -> String {
        let mut text = format!(
            "{HEADER}{}.\nDirectory: {}\nThe CLI shows this as a blocked call because TerminalX answered in its place. The command did run, and this is its result: do not run it again.\n",
            self.status,
            self.directory.display()
        );
        for note in &self.notes {
            text.push_str(note);
            text.push('\n');
        }
        if self.output.is_empty() {
            text.push_str("\nOutput: none\n");
        } else {
            text.push_str("\nOutput:\n");
            text.push_str(&self.output);
        }
        text
    }
}

/// The exit status and output of a command TerminalX ran itself, from the
/// text a CLI recorded as the call's result. Codex puts its own words first.
pub fn ran_result(text: &str) -> Option<(i32, String)> {
    let text = text.strip_prefix("Command blocked by PreToolUse hook: ").unwrap_or(text);
    let rest = text.strip_prefix(HEADER)?;
    let (status, rest) = rest.split_once(".\n")?;
    let status = status.parse().ok()?;
    let (_, output) = rest.split_once("\n\nOutput")?;
    let output = match output.strip_prefix(":\n") {
        Some(output) => output.to_string(),
        None if output.trim_end() == ": none" => String::new(),
        None => return None,
    };
    Some((status, output))
}

/// The first and last half of the limit, with the total seen.
struct Capture {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    total: usize,
    limit: usize,
}

impl Capture {
    fn new(limit: usize) -> Self {
        Self { head: Vec::new(), tail: VecDeque::new(), total: 0, limit }
    }

    fn push(&mut self, mut bytes: &[u8]) {
        self.total += bytes.len();
        let room = (self.limit / 2).saturating_sub(self.head.len());
        let (first, rest) = bytes.split_at(room.min(bytes.len()));
        self.head.extend_from_slice(first);
        bytes = rest;
        let keep = self.limit - self.limit / 2;
        if bytes.len() >= keep {
            self.tail.clear();
            self.tail.extend(&bytes[bytes.len() - keep..]);
        } else {
            self.tail.extend(bytes);
            while self.tail.len() > keep {
                self.tail.pop_front();
            }
        }
    }

    /// The text kept and how many bytes were left out of its middle.
    fn text(&self) -> (String, usize) {
        let kept = self.head.len() + self.tail.len();
        let omitted = self.total - kept;
        let mut bytes = self.head.clone();
        if omitted > 0 {
            bytes.extend_from_slice(format!("\n[... {omitted} bytes left out ...]\n").as_bytes());
        }
        bytes.extend(self.tail.iter());
        (String::from_utf8_lossy(&bytes).into_owned(), omitted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_keeps_both_ends_of_long_output() {
        let mut capture = Capture::new(10);
        capture.push(b"0123");
        capture.push(b"456789abcdef");
        capture.push(b"XYZ");
        let (text, omitted) = capture.text();
        assert_eq!(omitted, 9);
        assert_eq!(text, "01234\n[... 9 bytes left out ...]\nefXYZ");
        let mut short = Capture::new(10);
        short.push(b"hello");
        assert_eq!(short.text(), ("hello".into(), 0));
    }

    #[test]
    fn reports_round_trip_through_both_clis_wording() {
        let ran = Ran { status: 3, output: "a\n\nOutput:\nb\n".into(), directory: "/w".into(), notes: vec!["note".into()] };
        assert_eq!(ran_result(&ran.report()), Some((3, "a\n\nOutput:\nb\n".into())));
        let codex = format!("Command blocked by PreToolUse hook: {}", ran.report());
        assert_eq!(ran_result(&codex), Some((3, "a\n\nOutput:\nb\n".into())));
        let empty = Ran { status: 0, output: String::new(), directory: "/w".into(), notes: Vec::new() };
        assert_eq!(ran_result(&empty.report()), Some((0, String::new())));
        for text in ["The user declined this action.", "TerminalX approved this read-only command", ""] {
            assert_eq!(ran_result(text), None);
        }
    }

    #[test]
    fn timeouts_and_output_limits_follow_the_call_within_the_hook_deadline() {
        let at = |input| Approved::new("/".into(), open_directory(Path::new("/")).unwrap(), Vec::new(), Vec::new(), &input);
        let plain = at(serde_json::json!({}));
        assert_eq!((plain.timeout, plain.limit), (DEFAULT_TIMEOUT, DEFAULT_LIMIT));
        assert_eq!(at(serde_json::json!({"timeout": 5000})).timeout, Duration::from_secs(5));
        assert_eq!(at(serde_json::json!({"timeout_ms": 600_000})).timeout, MAX_TIMEOUT);
        assert_eq!(at(serde_json::json!({"timeout": 0})).timeout, Duration::from_secs(1));
        assert_eq!(at(serde_json::json!({"max_output_tokens": 1000})).limit, 4000);
        assert_eq!(at(serde_json::json!({"max_output_tokens": 1})).limit, 1024);
        assert_eq!(at(serde_json::json!({"max_output_tokens": 1_000_000})).limit, DEFAULT_LIMIT);
    }
}
