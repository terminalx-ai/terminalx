//! What runs in a pane's terminal (#437).
//!
//! A tab is whatever its terminal has in front: an agent's CLI the reader
//! typed into a shell is as much that agent's tab as one the app launched.
//! Nothing tells the app that a program was started by hand, so it asks the
//! terminal. A PTY knows which process group it gives its input to, and
//! whether it is being read a key at a time; both cost one call each and are
//! asked of every pane several times a second (`Terminals::fronts`).
//!
//! The processes themselves are only looked at when that answer is worth it:
//! a job that is not the pane's own shell has put the terminal in raw mode,
//! which is what a full-screen program does and what `claude --version` or
//! `codex exec` never do. Then the processes on that terminal are listed once
//! and the job is read against the harness registry (`harness::recognise`).
//!
//! What this does not see: an agent inside `tmux` or over `ssh` (the job in
//! front is `tmux` or `ssh`, and the agent has another terminal), and a shell
//! that replaced itself with an agent (`exec claude`), which is still the
//! pane's own process.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::pty::{PaneFront, Terminals};

/// How often every pane's terminal is asked what it has in front.
const TICK: Duration = Duration::from_millis(250);
/// A full-screen job that is not an agent is looked at again after this long,
/// and then less and less often: a wrapper may still be on its way to
/// starting one.
const RECHECK: Duration = Duration::from_secs(1);
const RECHECK_MAX: Duration = Duration::from_secs(15);

/// An agent's CLI in a pane's foreground job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Agent {
    /// The harness id, as the registry has it.
    pub harness: &'static str,
    /// The process that was recognised: the outermost one, when a launcher
    /// and the program it starts are both the agent.
    pub pid: u32,
    /// That process and every other process of the same agent in the job. A
    /// CLI installed with a package manager is a launcher and the program it
    /// starts, and which of the two holds the conversation is the harness's
    /// to say.
    pub pids: Vec<u32>,
    /// The job it is in: the process group that has the terminal.
    pub job: u32,
}

/// One process on a pane's terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Process {
    pub pid: u32,
    pub ppid: u32,
    pub pgid: u32,
    pub argv: Vec<String>,
}

/// `ps -o pid=,ppid=,pgid=,args=`: three numbers, then the command line.
pub fn parse_ps(output: &str) -> Vec<Process> {
    output
        .lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            let pid = words.next()?.parse().ok()?;
            let ppid = words.next()?.parse().ok()?;
            let pgid = words.next()?.parse().ok()?;
            Some(Process { pid, ppid, pgid, argv: words.map(str::to_string).collect() })
        })
        .collect()
}

/// The agent in the job `foreground`, if one of its processes is an agent's
/// CLI. Of several, the outermost: an agent that starts another agent as a
/// tool is still the one the reader is talking to.
pub fn agent_in(processes: &[Process], foreground: u32) -> Option<Agent> {
    let job: Vec<(&Process, &'static str)> = processes
        .iter()
        .filter(|process| process.pgid == foreground)
        .filter_map(|process| Some((process, crate::harness::recognise(process.argv.iter().map(String::as_str))?)))
        .collect();
    let parent = |pid: u32| processes.iter().find(|process| process.pid == pid).map(|process| process.ppid);
    // Whether `ancestor` is above `pid`. Bounded, so a table read while it
    // was changing cannot loop.
    let below = |mut pid: u32, ancestor: u32| {
        for _ in 0..64 {
            match parent(pid) {
                Some(above) if above == ancestor => return true,
                Some(above) if above != pid && above > 1 => pid = above,
                _ => return false,
            }
        }
        false
    };
    let (outermost, harness) = job.iter().find(|(process, _)| !job.iter().any(|(other, _)| below(process.pid, other.pid))).copied()?;
    let mut pids = vec![outermost.pid];
    pids.extend(job.iter().filter(|(process, found)| *found == harness && process.pid != outermost.pid && below(process.pid, outermost.pid)).map(|(process, _)| process.pid));
    Some(Agent { harness, pid: outermost.pid, pids, job: foreground })
}

/// The processes on a terminal, by its device (`/dev/ttys004`).
fn processes_on(tty: &std::path::Path) -> Vec<Process> {
    let Some(name) = tty.to_str().map(|path| path.strip_prefix("/dev/").unwrap_or(path)) else { return Vec::new() };
    let listed = std::process::Command::new("ps").env("LC_ALL", "C").args(["-o", "pid=,ppid=,pgid=,args=", "-t", name]).output();
    match listed {
        Ok(output) => parse_ps(&String::from_utf8_lossy(&output.stdout)),
        Err(error) => {
            log::warn!("list the processes on {name}: {error}");
            Vec::new()
        }
    }
}

/// What the watcher has made of one pane.
struct Seen {
    foreground: u32,
    agent: Option<Agent>,
    /// When a full-screen job that is no agent is looked at again.
    recheck: Option<(Instant, Duration)>,
}

/// What one look at a pane concluded.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    /// As it was.
    Same,
    /// An agent is in front now (or a different one is).
    Agent(Agent),
    /// The agent that was in front no longer is.
    Gone,
}

/// Follows every pane's foreground, and says when an agent comes or goes.
#[derive(Default)]
pub struct Watch {
    seen: Mutex<HashMap<String, Seen>>,
}

impl Watch {
    /// Watch `terminals` for as long as the process lives. `changed` is told
    /// the pane and the agent now in front of it, or `None` when the one that
    /// was there has gone; it is called from the watcher's own thread, one
    /// change at a time.
    pub fn start(terminals: Arc<Terminals>, changed: impl Fn(&str, Option<&Agent>) + Send + 'static) {
        let watch = Watch::default();
        let spawned = std::thread::Builder::new().name("pane-foreground".into()).spawn(move || loop {
            std::thread::sleep(TICK);
            watch.look(&terminals.fronts(), Instant::now(), |front| front.tty.as_deref().map(processes_on).unwrap_or_default(), &changed);
        });
        if let Err(error) = spawned {
            log::warn!("watch the terminals' foreground: {error}");
        }
    }

    /// One look at every pane. `processes` lists the processes on a pane's
    /// terminal and is only asked when the answer can change something.
    fn look(&self, fronts: &[PaneFront], now: Instant, processes: impl Fn(&PaneFront) -> Vec<Process>, changed: &impl Fn(&str, Option<&Agent>)) {
        let mut seen = self.seen.lock().unwrap();
        // A pane that closed takes its agent with it.
        let closed: Vec<String> = seen.keys().filter(|id| !fronts.iter().any(|front| &front.id == *id)).cloned().collect();
        for id in closed {
            if seen.remove(&id).is_some_and(|pane| pane.agent.is_some()) {
                changed(&id, None);
            }
        }
        for front in fronts {
            let pane = seen.entry(front.id.clone()).or_insert(Seen { foreground: front.pid, agent: None, recheck: None });
            match judge(pane, front, now, &processes) {
                Verdict::Same => {}
                Verdict::Agent(agent) => changed(&front.id, Some(&agent)),
                Verdict::Gone => changed(&front.id, None),
            }
        }
    }
}

fn judge(pane: &mut Seen, front: &PaneFront, now: Instant, processes: &impl Fn(&PaneFront) -> Vec<Process>) -> Verdict {
    let moved = pane.foreground != front.foreground;
    pane.foreground = front.foreground;
    if moved {
        pane.recheck = None;
    }
    // The pane's own process has the terminal: its shell at a prompt, or the
    // CLI an agent tab was launched with, which the session manager knows.
    if front.foreground == front.pid {
        return if pane.agent.take().is_some() { Verdict::Gone } else { Verdict::Same };
    }
    if let Some(agent) = &pane.agent {
        // The same job is still in front, and it was an agent's: it is until
        // the terminal goes to another. Raw mode is not asked for again, since
        // an agent lets go of it while it runs a command of the reader's.
        if !moved {
            return Verdict::Same;
        }
        // Another job took the terminal: this one was suspended or has ended.
        let _ = agent;
        pane.agent = None;
        return match classify(pane, front, now, processes) {
            Some(agent) => Verdict::Agent(agent),
            None => Verdict::Gone,
        };
    }
    match classify(pane, front, now, processes) {
        Some(agent) => Verdict::Agent(agent),
        None => Verdict::Same,
    }
}

/// Read the job in front against the registry, if now is a moment to.
fn classify(pane: &mut Seen, front: &PaneFront, now: Instant, processes: &impl Fn(&PaneFront) -> Vec<Process>) -> Option<Agent> {
    // A job that prints and exits never takes the terminal raw.
    if !front.raw {
        pane.recheck = None;
        return None;
    }
    if pane.recheck.is_some_and(|(at, _)| now < at) {
        return None;
    }
    let found = agent_in(&processes(front), front.foreground);
    match &found {
        Some(agent) => {
            pane.recheck = None;
            pane.agent = Some(agent.clone());
        }
        None => {
            let wait = pane.recheck.map_or(RECHECK, |(_, last)| (last * 2).min(RECHECK_MAX));
            pane.recheck = Some((now + wait, wait));
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    fn process(pid: u32, ppid: u32, pgid: u32, command: &str) -> Process {
        Process { pid, ppid, pgid, argv: command.split_whitespace().map(str::to_string).collect() }
    }

    #[test]
    fn ps_rows_are_read_as_three_numbers_and_a_command_line() {
        let table = parse_ps("  501   400   501 -zsh\n 7203   501  7203 claude --resume 0a1b\n 7300  7203  7203 /bin/zsh -c git status\nnot a row\n\n");
        assert_eq!(table, vec![process(501, 400, 501, "-zsh"), process(7203, 501, 7203, "claude --resume 0a1b"), process(7300, 7203, 7203, "/bin/zsh -c git status")]);
    }

    #[test]
    fn the_agent_of_a_job_is_found_whatever_started_it() {
        // Typed as it is.
        let table = [process(501, 400, 501, "-zsh"), process(700, 501, 700, "claude")];
        assert_eq!(agent_in(&table, 700), Some(Agent { harness: "claude", pid: 700, pids: vec![700], job: 700 }));
        // Through npx: the wrapper is not the agent, what it started is.
        let table = [process(501, 400, 501, "-zsh"), process(700, 501, 700, "npm exec @anthropic-ai/claude-code"), process(710, 700, 700, "node /Users/me/.npm/_npx/9f/node_modules/.bin/claude")];
        assert_eq!(agent_in(&table, 700), Some(Agent { harness: "claude", pid: 710, pids: vec![710], job: 700 }));
        // A launcher and the program it runs are one agent, both named.
        let table = [process(501, 400, 501, "-zsh"), process(800, 501, 800, "node /usr/local/lib/node_modules/@openai/codex/bin/codex.js"), process(801, 800, 800, "/usr/local/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex")];
        assert_eq!(agent_in(&table, 800), Some(Agent { harness: "codex", pid: 800, pids: vec![800, 801], job: 800 }));
        // Another job on the same terminal is not this one's.
        assert_eq!(agent_in(&table, 501), None);
    }

    /// An editor's plugin, `watch` and a spinner all hold the terminal the
    /// way a session does, and run an agent's binary with no screen under
    /// them. That is not somebody's session, and the tab stays a terminal.
    #[test]
    fn a_headless_run_under_a_program_that_holds_the_terminal_is_not_a_session() {
        let table = [process(501, 400, 501, "-zsh"), process(700, 501, 700, "nvim notes.md"), process(710, 700, 700, "claude -p --output-format stream-json")];
        assert_eq!(agent_in(&table, 700), None);
        let table = [process(501, 400, 501, "-zsh"), process(700, 501, 700, "watch -n5 codex exec status"), process(710, 700, 700, "sh -c codex exec status"), process(711, 710, 700, "codex exec status")];
        assert_eq!(agent_in(&table, 700), None);
        // Under a program that is no agent, a session is still one: a script of the reader's that runs the CLI.
        let table = [process(501, 400, 501, "-zsh"), process(700, 501, 700, "/bin/sh /Users/me/bin/work"), process(710, 700, 700, "claude --resume")];
        assert_eq!(agent_in(&table, 700), Some(Agent { harness: "claude", pid: 710, pids: vec![710], job: 700 }));
    }

    #[test]
    fn an_agent_that_starts_another_agent_is_still_the_one_in_front() {
        let table = [process(501, 400, 501, "-zsh"), process(700, 501, 700, "claude"), process(720, 700, 700, "/bin/zsh -c codex exec fix"), process(721, 720, 700, "codex exec fix")];
        assert_eq!(agent_in(&table, 700), Some(Agent { harness: "claude", pid: 700, pids: vec![700], job: 700 }));
    }

    /// A pane whose shell is 501, with the watcher's own clock and a process
    /// table the test sets. `asked` counts how often the table was read.
    struct Rig {
        watch: Watch,
        table: RefCell<Vec<Process>>,
        asked: Cell<usize>,
        now: Cell<Instant>,
        changes: RefCell<Vec<Option<&'static str>>>,
    }

    impl Rig {
        fn new() -> Self {
            Self { watch: Watch::default(), table: RefCell::default(), asked: Cell::new(0), now: Cell::new(Instant::now()), changes: RefCell::default() }
        }

        fn look(&self, foreground: u32, raw: bool) {
            self.now.set(self.now.get() + TICK);
            let front = PaneFront { id: "s:1".into(), pid: 501, foreground, raw, tty: None };
            self.watch.look(
                &[front],
                self.now.get(),
                |_| {
                    self.asked.set(self.asked.get() + 1);
                    self.table.borrow().clone()
                },
                &|_: &str, agent: Option<&Agent>| self.changes.borrow_mut().push(agent.map(|agent| agent.harness)),
            );
        }

        fn close(&self) {
            self.watch.look(&[], self.now.get(), |_| Vec::new(), &|_: &str, agent: Option<&Agent>| self.changes.borrow_mut().push(agent.map(|agent| agent.harness)));
        }
    }

    #[test]
    fn an_agent_started_exited_and_replaced_by_another_is_followed() {
        let rig = Rig::new();
        // At the prompt: nothing to read, and no process is looked at.
        rig.look(501, true);
        rig.look(501, false);
        assert_eq!(rig.asked.get(), 0);

        // The reader types `claude`: the job is in front before it has drawn.
        *rig.table.borrow_mut() = vec![process(501, 400, 501, "-zsh"), process(700, 501, 700, "claude")];
        rig.look(700, false);
        assert!(rig.changes.borrow().is_empty(), "a job that has not taken the terminal raw is not a session yet");
        assert_eq!(rig.asked.get(), 0);
        rig.look(700, true);
        assert_eq!(*rig.changes.borrow(), [Some("claude")]);
        // It stays the tab's agent without being asked about again, even while
        // it gives the terminal back to a command of the reader's.
        rig.look(700, true);
        rig.look(700, false);
        rig.look(700, true);
        assert_eq!((rig.changes.borrow().len(), rig.asked.get()), (1, 1));

        // It exits: the shell has the terminal again.
        rig.look(501, true);
        assert_eq!(*rig.changes.borrow(), [Some("claude"), None]);

        // Codex next, in the same pane.
        *rig.table.borrow_mut() = vec![process(501, 400, 501, "-zsh"), process(900, 501, 900, "codex")];
        rig.look(900, true);
        assert_eq!(*rig.changes.borrow(), [Some("claude"), None, Some("codex")]);

        // The pane is closed with it running.
        rig.close();
        assert_eq!(rig.changes.borrow().last(), Some(&None));
    }

    #[test]
    fn a_one_shot_run_of_an_agents_binary_is_not_a_session() {
        let rig = Rig::new();
        *rig.table.borrow_mut() = vec![process(501, 400, 501, "-zsh"), process(700, 501, 700, "claude -p hello")];
        for _ in 0..40 {
            rig.look(700, false);
        }
        rig.look(501, true);
        assert!(rig.changes.borrow().is_empty());
        assert_eq!(rig.asked.get(), 0, "a job that prints and exits is never read");
    }

    #[test]
    fn a_full_screen_program_that_is_no_agent_is_read_rarely_and_a_late_agent_is_still_found() {
        let rig = Rig::new();
        *rig.table.borrow_mut() = vec![process(501, 400, 501, "-zsh"), process(700, 501, 700, "npm exec @anthropic-ai/claude-code")];
        // A minute of a wrapper (or an editor) holding the terminal raw.
        for _ in 0..240 {
            rig.look(700, true);
        }
        assert!(rig.changes.borrow().is_empty());
        assert!(rig.asked.get() <= 9, "read {} times in a minute", rig.asked.get());
        // The wrapper gets round to starting the agent.
        rig.table.borrow_mut().push(process(710, 700, 700, "node /Users/me/.npm/_npx/9f/node_modules/.bin/claude"));
        for _ in 0..(RECHECK_MAX.as_millis() / TICK.as_millis() + 1) {
            rig.look(700, true);
        }
        assert_eq!(*rig.changes.borrow(), [Some("claude")]);
    }

    #[test]
    fn a_suspended_agent_gives_the_tab_back_and_takes_it_again_when_resumed() {
        let rig = Rig::new();
        *rig.table.borrow_mut() = vec![process(501, 400, 501, "-zsh"), process(700, 501, 700, "claude")];
        rig.look(700, true);
        // Ctrl+Z: the shell is in front, the agent is still there, stopped.
        rig.look(501, true);
        // Another agent is started while the first is in the background.
        rig.table.borrow_mut().push(process(900, 501, 900, "codex"));
        rig.look(900, true);
        // It exits, and `fg` brings the first one back.
        rig.look(501, true);
        rig.look(700, true);
        assert_eq!(*rig.changes.borrow(), [Some("claude"), None, Some("codex"), None, Some("claude")]);
    }

    /// The whole of it against a real terminal: an interactive shell in a
    /// PTY, and a program named as an agent's CLI started in it by hand. The
    /// program is `sleep` under another name, and the terminal is put in raw
    /// mode for it the way a full-screen program does for itself.
    #[cfg(unix)]
    #[test]
    fn a_program_typed_into_a_real_shell_is_seen_by_its_name_once_the_terminal_is_raw() {
        use std::sync::mpsc;

        let dir = tempfile::tempdir().unwrap();
        let sleep = ["/bin/sleep", "/usr/bin/sleep"].into_iter().find(|path| std::path::Path::new(path).exists()).expect("a sleep to stand for the agent");
        for name in ["claude", "codex"] {
            std::os::unix::fs::symlink(sleep, dir.path().join(name)).unwrap();
        }
        let terminals = Arc::new(Terminals::new());
        let sink: Arc<dyn crate::sink::EventSink> = Arc::new(crate::sink::BroadcastSink::new(64));
        let spec = crate::pty::PaneSpec { cwd: dir.path().to_str().unwrap(), cols: 80, rows: 24, command: Some("bash --norc --noprofile -i"), env: &[] };
        terminals.spawn(sink, "s:1", spec).unwrap();
        let watch = Watch::default();
        let (seen, changes) = mpsc::channel::<Option<Agent>>();
        // Look as the watcher's thread does, until `wanted` is what the last change said.
        let until = |what: &str, wanted: &dyn Fn(&Option<Agent>) -> bool| {
            let deadline = Instant::now() + Duration::from_secs(60);
            loop {
                watch.look(&terminals.fronts(), Instant::now(), |front| front.tty.as_deref().map(processes_on).unwrap_or_default(), &|_: &str, agent: Option<&Agent>| seen.send(agent.cloned()).unwrap());
                if let Ok(change) = changes.try_recv() {
                    assert!(wanted(&change), "{what}: {change:?}");
                    return change;
                }
                assert!(Instant::now() < deadline, "never happened: {what}");
                std::thread::sleep(TICK);
            }
        };
        let own = |terminals: &Terminals| terminals.fronts().first().is_some_and(|front| front.foreground == front.pid);
        let at_prompt = || {
            let deadline = Instant::now() + Duration::from_secs(60);
            while !own(&terminals) {
                assert!(Instant::now() < deadline, "the shell never took the terminal back");
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        at_prompt();

        // Printing and exiting, as `claude --version` does: never a session.
        terminals.write("s:1", b"./claude 1\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        while own(&terminals) {
            assert!(Instant::now() < deadline, "the job never came to the front");
            std::thread::sleep(Duration::from_millis(5));
        }
        while !own(&terminals) {
            watch.look(&terminals.fronts(), Instant::now(), |front| front.tty.as_deref().map(processes_on).unwrap_or_default(), &|_: &str, agent: Option<&Agent>| seen.send(agent.cloned()).unwrap());
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(changes.try_recv().is_err(), "a job that left the terminal as it was is not an agent's session");

        // Full screen, as the CLI itself is.
        terminals.write("s:1", b"stty raw -echo; ./claude 600\n").unwrap();
        let claude = until("claude in front", &|change| change.as_ref().is_some_and(|agent| agent.harness == "claude")).unwrap();
        assert_eq!(claude.pids, [claude.pid]);
        assert!(crate::harness::host::is_alive(claude.pid));
        // It exits, and the tab is the shell's again.
        crate::harness::host::kill_now(claude.pid);
        until("claude gone", &|change| change.is_none());
        at_prompt();
        // Another agent in the same terminal.
        terminals.write("s:1", b"stty raw -echo; ./codex 600\n").unwrap();
        let codex = until("codex in front", &|change| change.as_ref().is_some_and(|agent| agent.harness == "codex")).unwrap();
        // The pane is closed with it running.
        terminals.kill_all();
        until("the pane closed", &|change| change.is_none());
        crate::harness::host::kill_now(codex.pid);
    }

    #[test]
    fn one_agent_taking_the_terminal_from_another_is_one_change() {
        let rig = Rig::new();
        *rig.table.borrow_mut() = vec![process(501, 400, 501, "-zsh"), process(700, 501, 700, "claude"), process(900, 501, 900, "codex")];
        rig.look(700, true);
        // The shell hands the terminal straight from one job to the next
        // between two looks.
        rig.look(900, true);
        assert_eq!(*rig.changes.borrow(), [Some("claude"), Some("codex")]);
    }
}
