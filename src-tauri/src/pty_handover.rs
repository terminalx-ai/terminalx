//! Handing a runtime's terminals to the runtime that replaces it (#765).
//!
//! The runtime being replaced execs its successor's binary in its own
//! process (`local_runtime::handover`), so the programs in its panes stay its
//! children and their terminals stay open: each pane's master descriptor is
//! carried across the exec. What the runtime knew of each pane goes with it
//! in the handover record: what it printed, the screen it drew, its process
//! group, and how long it has been quiet.
//!
//! Nothing a program writes is lost on the way. A pane's reader takes output
//! from the terminal only while the pane is not frozen, and counts each read
//! under the same lock. Freezing waits until the emitter has put everything
//! counted into the scrollback, so what the program writes after that stays
//! in the terminal for the next owner's reader. A program that exits
//! meanwhile is left unreaped: the next owner reaps it and reports its exit.

#[cfg(unix)]
use std::os::fd::{AsRawFd, BorrowedFd, OwnedFd};
#[cfg(unix)]
use std::path::PathBuf;
use std::sync::{Condvar, MutexGuard};

use super::*;

/// What a pane's reader, emitter and waiter hold off on while it is handed over.
#[derive(Default)]
pub(super) struct Hold {
    state: Mutex<Held>,
    changed: Condvar,
}

#[derive(Default)]
#[cfg_attr(not(unix), allow(dead_code))]
pub(super) struct Held {
    frozen: bool,
    /// Chunks the reader has taken from the terminal.
    pub(super) read: u64,
    /// Chunks the emitter has put into the scrollback.
    drawn: u64,
}

impl Hold {
    fn lock(&self) -> MutexGuard<'_, Held> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(unix)]
    pub(super) fn try_running(&self) -> Option<MutexGuard<'_, Held>> {
        let held = self.lock();
        if held.frozen { None } else { Some(held) }
    }

    /// The pane's state, once it is not being handed over: what the reader
    /// reads under, and what an exited program's waiter waits for.
    #[cfg(unix)]
    pub(super) fn thawed(&self) -> MutexGuard<'_, Held> {
        let mut held = self.lock();
        while held.frozen {
            held = self.changed.wait(held).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        held
    }

    /// The emitter put `chunks` more of what was read into the scrollback.
    pub(super) fn drew(&self, chunks: u64) {
        self.lock().drawn += chunks;
        self.changed.notify_all();
    }

    #[cfg(unix)]
    fn freeze(&self) {
        self.lock().frozen = true;
    }

    #[cfg(unix)]
    fn is_frozen(&self) -> bool {
        self.lock().frozen
    }

    #[cfg(unix)]
    fn thaw(&self) {
        self.lock().frozen = false;
        self.changed.notify_all();
    }

    #[cfg(unix)]
    /// Wait until everything read has reached the scrollback, until `deadline`.
    fn drained(&self, deadline: Instant) -> bool {
        let mut held = self.lock();
        while held.drawn < held.read {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            held = self.changed.wait_timeout(held, left).unwrap_or_else(|poisoned| poisoned.into_inner()).0;
        }
        true
    }
}

/// How a pane's program is waited for.
pub(super) enum Waiter {
    /// Opened by this runtime (on Linux, only without a supervisor).
    Spawned(Box<dyn portable_pty::Child + Send + Sync>),
    /// Opened by the runtime this one replaced in the same process, whose
    /// child it still is (#765).
    #[cfg(unix)]
    Adopted,
    /// Started by its launch's supervisor, which reports how its shell ended
    /// (#467). The shell is the supervisor's child, never this process's.
    #[cfg(target_os = "linux")]
    Supervised(Arc<super::supervisor::Owner>),
}

impl Waiter {
    /// Wait for the program to exit, and reap it with its exit code, unless
    /// the pane is being handed over by then: the next owner reaps it, and
    /// this waits for the handover to be called off.
    pub(super) fn wait(&mut self, pid: Option<u32>, hold: &Hold) -> Option<i32> {
        #[cfg(unix)]
        if let Some(pid) = pid {
            exited_unreaped(pid);
            drop(hold.thawed());
        }
        #[cfg(not(unix))]
        let _ = (pid, hold);
        match self {
            Self::Spawned(child) => child.wait().ok().map(|status| status.exit_code() as i32),
            #[cfg(unix)]
            Self::Adopted => pid.and_then(reap),
            // As portable-pty reports it: the exit code, or 1 for a signal.
            #[cfg(target_os = "linux")]
            Self::Supervised(owner) => owner.wait_shell().map(|status| if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { 1 }),
        }
    }
}

/// Wait until `pid` has exited, leaving it to be reaped. Returns at once for
/// a process that is not this one's child.
#[cfg(unix)]
fn exited_unreaped(pid: u32) {
    #[allow(clippy::unnecessary_cast)]
    let id = pid as libc::id_t;
    loop {
        // SAFETY: an all-zero siginfo_t is valid, and waitid fills at most it.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: WNOWAIT leaves the child waitable; only `info` is written.
        if unsafe { libc::waitid(libc::P_PID, id, &mut info, libc::WEXITED | libc::WNOWAIT) } == 0 {
            return;
        }
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return;
        }
    }
}

/// Reap `pid`, as `portable_pty` reports it: its exit code, or 1 when a
/// signal ended it. `None` when it is not this process's child to reap.
#[cfg(unix)]
fn reap(pid: u32) -> Option<i32> {
    let pid = libc::pid_t::try_from(pid).ok()?;
    loop {
        let mut status = 0;
        // SAFETY: waitpid writes the status of this process's own child.
        let reaped = unsafe { libc::waitpid(pid, &mut status, 0) };
        if reaped == pid {
            return Some(if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { 1 });
        }
        if reaped < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        return None;
    }
}

/// Everything a pane's threads are started with.
pub(super) struct Parts {
    pub master: Box<dyn MasterPty + Send>,
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    pub waiter: Waiter,
    pub pid: Option<u32>,
    /// The process group the pane's program leads, which stopping it signals.
    pub group: Option<u32>,
    /// The supervisor that owns a pane opened here, and what is listed of it.
    #[cfg(target_os = "linux")]
    pub owned: Option<Arc<OwnedGroup>>,
    pub explicit_command: bool,
    pub environment: crate::store::environment::Stamp,
    pub cwd: String,
    pub created: String,
    pub scrollback: VecDeque<u8>,
    /// How much of the scrollback the pane's own program printed.
    pub printed: u64,
    pub screen: vt100::Parser,
    pub last_output: Option<Instant>,
}

#[cfg(unix)]
/// One pane as it is handed over: its terminal, and what was known of it.
pub(crate) struct FrozenPane {
    pub id: String,
    /// The terminal's master, a descriptor of its own.
    pub master: OwnedFd,
    pub pid: Option<u32>,
    pub group: Option<u32>,
    pub explicit_command: bool,
    pub environment: crate::store::environment::Stamp,
    pub cwd: String,
    pub created: String,
    /// The program's side of the terminal, by which its processes are listed.
    pub tty: Option<PathBuf>,
    pub cols: u16,
    pub rows: u16,
    pub scrollback: Vec<u8>,
    pub printed: u64,
    /// Escape sequences that draw the pane's screen again as it stands.
    pub screen: Vec<u8>,
    /// How long since the pane last drew anything, once it has.
    pub quiet: Option<Duration>,
    pub title: Option<String>,
    pub renamed: bool,
    pub docked: Option<bool>,
    /// Its launch's supervisor, held, and a duplicate of its channel (#467).
    #[cfg(target_os = "linux")]
    pub supervised: Option<(super::supervisor::Carried, OwnedFd)>,
}

#[cfg(unix)]
/// Every terminal as it is handed over.
#[derive(Default)]
pub(crate) struct Frozen {
    pub panes: Vec<FrozenPane>,
    /// What exited panes printed, and the tails an idle exit kept.
    pub retained: Vec<crate::local_runtime::scrollback::History>,
    /// Process groups this runtime started that no pane leads any more,
    /// which Stop All still ends.
    pub groups: Vec<u32>,
    /// Supervised launches no live pane holds, by the pane id they had.
    #[cfg(target_os = "linux")]
    pub supervised: Vec<(String, super::supervisor::Carried, OwnedFd)>,
}

#[cfg(unix)]
impl Terminals {
    /// Stop every pane's output where it stands, with all of it in the
    /// scrollback, and say what each pane is. No pane is opened until
    /// [`Self::thaw`]; a pane that is not drained within `within` calls the
    /// whole freeze off.
    pub(crate) fn freeze(&self, within: Duration) -> Result<Frozen> {
        *self.frozen.lock().unwrap() = true;
        // Every supervised launch is held still and carried; one that is
        // starting, releasing or lost is not, and the handover waits (#467).
        #[cfg(target_os = "linux")]
        let carried = match self.park_supervisors(within) {
            Ok(carried) => carried,
            Err(error) => { self.thaw(); return Err(error); }
        };
        let holds: Vec<Arc<Hold>> = self.panes.lock().unwrap().values().map(|pane| pane.hold.clone()).collect();
        for hold in &holds {
            hold.freeze();
        }
        let deadline = Instant::now() + within;
        if !holds.iter().all(|hold| hold.drained(deadline)) {
            self.thaw();
            bail!("A terminal did not finish taking in its program's output in time.");
        }
        #[cfg(target_os = "linux")]
        return self.frozen_state(carried).inspect_err(|_| self.thaw());
        #[cfg(not(target_os = "linux"))]
        self.frozen_state().inspect_err(|_| self.thaw())
    }

    /// Let every pane's output go on: the handover was called off.
    pub(crate) fn thaw(&self) {
        *self.frozen.lock().unwrap() = false;
        for pane in self.panes.lock().unwrap().values() {
            pane.hold.thaw();
        }
        #[cfg(target_os = "linux")]
        for owner in self.supervisors() { owner.unpark(); }
    }

    /// Take each held supervisor's state again, just before the record is
    /// written: a terminal closed since the freeze goes over as stopping.
    #[cfg(target_os = "linux")]
    pub(crate) fn refresh_frozen(&self, frozen: &mut Frozen) {
        let owners = self.supervisors();
        // Each carried state is one launch's; a launch's id names its owner.
        let carried = frozen.panes.iter_mut().filter_map(|pane| pane.supervised.as_mut().map(|(carried, _)| carried))
            .chain(frozen.supervised.iter_mut().map(|(_, carried, _)| carried));
        for carried in carried {
            if let Some(owner) = owners.iter().find(|owner| owner.launch_is(carried)) { owner.refresh(carried); }
        }
    }

    /// A supervised launch was stopped after its state went into the record:
    /// the handover must be called off so that Stop is not lost (#765).
    #[cfg(target_os = "linux")]
    pub(crate) fn stopped_since_refresh(&self) -> bool {
        self.supervisors().iter().any(|owner| owner.stopped_while_parked())
    }

    /// Every launch a supervisor still owns, with or without a pane.
    #[cfg(target_os = "linux")]
    fn supervisors(&self) -> Vec<Arc<super::supervisor::Owner>> {
        self.groups.lock().unwrap().iter().filter_map(|(_, group)| group.owner().cloned()).collect()
    }

    /// Hold each supervised launch still, keyed by its owner. No launch
    /// starts meanwhile: `frozen` is set, and one already starting refuses.
    #[cfg(target_os = "linux")]
    fn park_supervisors(&self, within: Duration) -> Result<Vec<(Arc<super::supervisor::Owner>, super::supervisor::Carried, OwnedFd)>> {
        if self.bootstrapping.load(Ordering::SeqCst) > 0 { bail!("A terminal was opening."); }
        let mut carried = Vec::new();
        let mut not = 0;
        for owner in self.supervisors() {
            match owner.park(within) {
                super::supervisor::Parked::Carried(state, fd) => carried.push((owner, state, fd)),
                super::supervisor::Parked::Settled => {}
                super::supervisor::Parked::Not => not += 1,
            }
        }
        if not > 0 { return Err(super::SupervisedTerminals(not).into()); }
        Ok(carried)
    }

    #[cfg(not(target_os = "linux"))]
    fn frozen_state(&self) -> Result<Frozen> {
        self.frozen_panes()
    }

    /// The panes, with each supervised launch's carried state beside the
    /// pane that holds it, and the rest under the ids they had (#467).
    #[cfg(target_os = "linux")]
    fn frozen_state(&self, carried: Vec<(Arc<super::supervisor::Owner>, super::supervisor::Carried, OwnedFd)>) -> Result<Frozen> {
        let mut frozen = self.frozen_panes()?;
        let mut carried: Vec<_> = carried.into_iter().map(Some).collect();
        let mut take = |owner: &Arc<super::supervisor::Owner>| carried.iter_mut().find(|entry| entry.as_ref().is_some_and(|(held, _, _)| Arc::ptr_eq(held, owner)))
            .and_then(Option::take).map(|(_, state, fd)| (state, fd));
        let owners: HashMap<String, Arc<super::supervisor::Owner>> = self.panes.lock().unwrap().iter()
            .filter_map(|(id, pane)| pane.group.owner().map(|owner| (id.clone(), owner.clone()))).collect();
        for pane in &mut frozen.panes {
            if let Some(owner) = owners.get(&pane.id) { pane.supervised = take(owner); }
        }
        for (id, group) in self.groups.lock().unwrap().iter() {
            if let Some((state, fd)) = group.owner().and_then(&mut take) { frozen.supervised.push((id.clone(), state, fd)); }
        }
        Ok(frozen)
    }

    fn frozen_panes(&self) -> Result<Frozen> {
        use crate::local_runtime::scrollback::History;
        // A supervised launch goes over as its supervisor, never as a group.
        #[cfg(target_os = "linux")]
        let groups: Vec<u32> = { let supervised: std::collections::HashSet<u32> = self.groups.lock().unwrap().iter()
            .filter(|(_, group)| group.owner().is_some()).filter_map(|(_, group)| group.pid()).collect();
            self.owned_groups().into_iter().filter(|group| !supervised.contains(group)).collect() };
        #[cfg(not(target_os = "linux"))]
        let groups = self.owned_groups();
        let mut retained = self.retained.lock().unwrap().clone();
        let panes = self.panes.lock().unwrap();
        let titles = self.titles.lock().unwrap().clone();
        let renamed = self.renamed.lock().unwrap().clone();
        let docked = self.docked.lock().unwrap().clone();
        for pane in retained.values_mut() { pane.docked = docked.get(&pane.id).copied(); }
        let mut frozen = Vec::new();
        // A pane opened just as the freeze began, by a path that does not
        // wait for admission, would go on being read after this.
        if !panes.values().all(|pane| pane.hold.is_frozen()) {
            bail!("A terminal was opening.");
        }
        for (id, pane) in panes.iter() {
            let scrollback: Vec<u8> = pane.scrollback.lock().unwrap().iter().copied().collect();
            let title = titles.get(id).cloned();
            if !*pane.alive.lock().unwrap() {
                // Its program has gone: what it printed is all there is.
                retained.insert(id.clone(), History { id: id.clone(), cwd: pane.cwd.clone(), created: pane.created.clone(), title, renamed: renamed.contains(id), docked: docked.get(id).copied(), data: scrollback });
                continue;
            }
            let fd = pane.master.as_raw_fd().context("a terminal has no descriptor to hand over")?;
            // SAFETY: the pane keeps its master open while the panes are locked.
            let master = unsafe { BorrowedFd::borrow_raw(fd) }.try_clone_to_owned().context("duplicate a terminal's descriptor")?;
            let size = pane.master.get_size().map_err(|error| anyhow!("terminal size: {error}"))?;
            let screen = {
                let parser = pane.screen.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                let screen = parser.screen();
                let mut drawn = Vec::new();
                if screen.alternate_screen() {
                    drawn.extend_from_slice(b"\x1b[?1049h");
                }
                drawn.extend_from_slice(screen.state_formatted().as_bytes());
                drawn
            };
            frozen.push(FrozenPane {
                id: id.clone(),
                master,
                pid: pane.pid,
                group: pane.group.pid(),
                explicit_command: pane.explicit_command,
                environment: pane.environment.clone(),
                cwd: pane.cwd.clone(),
                created: pane.created.clone(),
                tty: pane.master.tty_name(),
                cols: size.cols,
                rows: size.rows,
                scrollback,
                printed: pane.printed.load(Ordering::Relaxed),
                screen,
                quiet: pane.last_output.lock().unwrap().map(|at| at.elapsed()),
                title,
                renamed: renamed.contains(id), docked: docked.get(id).copied(),
                #[cfg(target_os = "linux")]
                supervised: None,
            });
        }
        let led: std::collections::HashSet<u32> = frozen.iter().filter_map(|pane| pane.group).collect();
        Ok(Frozen { panes: frozen, retained: retained.into_values().collect(), groups: groups.into_iter().filter(|group| !led.contains(group)).collect(),
            #[cfg(target_os = "linux")] supervised: Vec::new() })
    }

    /// Take over a pane the runtime this one replaced was running: its
    /// program goes on in the same terminal, and its output from where the
    /// handover left it.
    pub(crate) fn adopt(&self, sink: Arc<dyn EventSink>, pane: FrozenPane) -> Result<()> {
        let FrozenPane { id, master, pid, group, explicit_command, environment, cwd, created, tty, cols, rows, scrollback, printed, screen, quiet, title, renamed, docked, #[cfg(target_os = "linux")] supervised } = pane;
        if self.panes.lock().unwrap().contains_key(&id) {
            bail!("a terminal named {id} is already open");
        }
        let master = AdoptedMaster { fd: master, tty, took_writer: AtomicBool::new(false) };
        let reader = master.try_clone_reader()?;
        // As a pane opened under a supervisor writes (`supervised_writer`).
        #[cfg(target_os = "linux")]
        let writer: Box<dyn Write + Send> = if supervised.is_some() { Box::new(master.file()?) } else { master.take_writer()? };
        #[cfg(not(target_os = "linux"))]
        let writer = master.take_writer()?;
        let mut parser = vt100::Parser::new(screen_size(rows), screen_size(cols), 0);
        parser.process(&screen);
        let mut back = VecDeque::with_capacity(SCROLLBACK_BYTES);
        push_scrollback(&mut back, &scrollback);
        // Its supervisor's observer resumes where the last runtime held it.
        #[cfg(target_os = "linux")]
        let (waiter, owned) = match supervised {
            Some((state, socket)) => {
                let (shell, helper) = (state.shell(), state.supervisor());
                match super::supervisor::Owner::adopt(state, socket) {
                    Ok(owner) => (Waiter::Supervised(owner.clone()), Some(Arc::new(OwnedGroup::supervised(owner, shell)))),
                    Err(error) => {
                        // Its channel let go, the supervisor ends what it
                        // runs and exits: reaped here, and the reader told.
                        super::supervisor::reap_abandoned(helper);
                        self.notice(format!("A terminal could not be kept running through the update and was stopped: \u{201c}{}\u{201d}.", title.as_deref().unwrap_or(&id)));
                        return Err(anyhow::Error::from(error).context("take over the terminal's supervisor"));
                    }
                }
            }
            None => (Waiter::Adopted, None),
        };
        #[cfg(not(target_os = "linux"))]
        let waiter = Waiter::Adopted;
        self.start(sink, &id, Parts {
            master: Box::new(master),
            reader,
            writer,
            waiter,
            pid,
            group,
            #[cfg(target_os = "linux")]
            owned,
            explicit_command,
            environment,
            cwd,
            created,
            scrollback: back,
            printed,
            screen: parser,
            last_output: quiet.and_then(|quiet| Instant::now().checked_sub(quiet)),
        })?;
        if let Some(docked) = docked { self.docked.lock().unwrap().insert(id.clone(), docked); }
        if let Some(title) = title {
            self.titles.lock().unwrap().insert(id.clone(), title);
            if renamed {
                self.renamed.lock().unwrap().insert(id);
            }
        }
        Ok(())
    }

    /// Take over a supervised launch no live pane held, under its pane id:
    /// Stop and Stop All end it as before the handover (#467).
    #[cfg(target_os = "linux")]
    pub(crate) fn adopt_supervised(&self, id: &str, state: super::supervisor::Carried, socket: OwnedFd) -> Result<()> {
        let (shell, helper) = (state.shell(), state.supervisor());
        let owner = match super::supervisor::Owner::adopt(state, socket) {
            Ok(owner) => owner,
            Err(error) => {
                super::supervisor::reap_abandoned(helper);
                self.notice(format!("Processes a closed terminal left running could not be kept through the update and were stopped ({id})."));
                return Err(anyhow::Error::from(error).context("take over a launch's supervisor"));
            }
        };
        self.groups.lock().unwrap().push((id.to_string(), Arc::new(OwnedGroup::supervised(owner, shell))));
        Ok(())
    }

    /// Take over what the runtime this one replaced kept of exited panes,
    /// and the process groups it still owned.
    pub(crate) fn adopt_rest(&self, retained: Vec<crate::local_runtime::scrollback::History>, groups: Vec<u32>) {
        {
            let mut titles = self.titles.lock().unwrap();
            let mut renamed = self.renamed.lock().unwrap();
            for pane in &retained {
                if let Some(docked) = pane.docked { self.docked.lock().unwrap().insert(pane.id.clone(), docked); }
                if let Some(title) = &pane.title {
                    titles.insert(pane.id.clone(), title.clone());
                }
                if pane.renamed {
                    renamed.insert(pane.id.clone());
                }
            }
        }
        self.retained.lock().unwrap().extend(retained.into_iter().map(|pane| (pane.id.clone(), pane)));
        let mut owned = self.groups.lock().unwrap();
        // The record names no pane for these: Stop All still ends them.
        owned.extend(groups.into_iter().map(|group| (String::new(), Arc::new(OwnedGroup::new(Some(group))))));
        owned.retain(|(_, group)| group.pid().is_some());
    }
}

#[cfg(unix)]
/// A terminal opened by the runtime this one replaced, by its descriptor.
struct AdoptedMaster {
    fd: OwnedFd,
    tty: Option<PathBuf>,
    took_writer: AtomicBool,
}

#[cfg(unix)]
impl AdoptedMaster {
    fn file(&self) -> std::io::Result<std::fs::File> {
        Ok(std::fs::File::from(self.fd.try_clone()?))
    }
}

#[cfg(unix)]
impl MasterPty for AdoptedMaster {
    fn resize(&self, size: PtySize) -> Result<()> {
        let size = libc::winsize { ws_row: size.rows, ws_col: size.cols, ws_xpixel: size.pixel_width, ws_ypixel: size.pixel_height };
        // SAFETY: TIOCSWINSZ reads one winsize from the pointer, which outlives the call.
        if unsafe { libc::ioctl(self.fd.as_raw_fd(), libc::TIOCSWINSZ as _, &size as *const libc::winsize) } != 0 {
            bail!("resize the terminal: {}", std::io::Error::last_os_error());
        }
        Ok(())
    }

    fn get_size(&self) -> Result<PtySize> {
        // SAFETY: an all-zero winsize is valid, and TIOCGWINSZ fills it.
        let mut size: libc::winsize = unsafe { std::mem::zeroed() };
        // SAFETY: as above.
        if unsafe { libc::ioctl(self.fd.as_raw_fd(), libc::TIOCGWINSZ as _, &mut size as *mut libc::winsize) } != 0 {
            bail!("read the terminal's size: {}", std::io::Error::last_os_error());
        }
        Ok(PtySize { rows: size.ws_row, cols: size.ws_col, pixel_width: size.ws_xpixel, pixel_height: size.ws_ypixel })
    }

    fn try_clone_reader(&self) -> Result<Box<dyn Read + Send>> {
        Ok(Box::new(self.file()?))
    }

    fn take_writer(&self) -> Result<Box<dyn Write + Send>> {
        if self.took_writer.swap(true, Ordering::SeqCst) {
            bail!("cannot take writer more than once");
        }
        Ok(Box::new(AdoptedWriter(self.file()?)))
    }

    fn process_group_leader(&self) -> Option<libc::pid_t> {
        // SAFETY: tcgetpgrp only reads the terminal's foreground group.
        match unsafe { libc::tcgetpgrp(self.fd.as_raw_fd()) } {
            pid if pid > 0 => Some(pid),
            _ => None,
        }
    }

    fn as_raw_fd(&self) -> Option<std::os::fd::RawFd> {
        Some(self.fd.as_raw_fd())
    }

    fn tty_name(&self) -> Option<PathBuf> {
        self.tty.clone()
    }
}

#[cfg(unix)]
/// An adopted terminal's input. Closed as `portable_pty` closes its own: the
/// program is sent end of input, so a pane closed here ends as one opened
/// here does.
struct AdoptedWriter(std::fs::File);

#[cfg(unix)]
impl Write for AdoptedWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.0.write(data)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

#[cfg(unix)]
impl Drop for AdoptedWriter {
    fn drop(&mut self) {
        // SAFETY: an all-zero termios is valid, and tcgetattr fills it.
        let mut mode: libc::termios = unsafe { std::mem::zeroed() };
        // SAFETY: the descriptor is this writer's own.
        if unsafe { libc::tcgetattr(self.0.as_raw_fd(), &mut mode) } == 0 {
            let eof = mode.c_cc[libc::VEOF];
            if eof != 0 {
                let _ = self.0.write_all(&[b'\n', eof]);
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// Every `tick-N` in `output`, in order.
    fn ticks(output: &[u8]) -> Vec<u64> {
        String::from_utf8_lossy(output).split("tick-").skip(1)
            .filter_map(|rest| rest.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()).collect()
    }

    fn exits(sink: &crate::sink::BroadcastSink) -> std::sync::mpsc::Receiver<PtyExit> {
        let (sent, received) = std::sync::mpsc::channel();
        let sent = Mutex::new(sent);
        sink.listen("pty_exit", Box::new(move |payload| {
            if let Ok(exit) = serde_json::from_str::<PtyExit>(payload) { let _ = sent.lock().unwrap().send(exit); }
        }));
        received
    }

    const COUNTER: &str = "sh -c 'i=0; while [ ! -f stop ]; do i=$((i+1)); echo tick-$i; sleep 0.02; done; exit 7'";

    fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// #765: a pane handed to another owner keeps its program, its pid and
    /// every byte it wrote, before, during and after the handover; and its
    /// exit, with its code, is the new owner's to report.
    #[test]
    fn a_handed_over_pane_keeps_its_program_and_loses_no_output() {
        let dir = tempfile::tempdir().unwrap();
        let first: Arc<dyn EventSink> = Arc::new(crate::sink::BroadcastSink::new(1024));
        let old = Terminals::new();
        let spec = PaneSpec { cwd: dir.path().to_str().unwrap(), cols: 100, rows: 30, command: Some(COUNTER), env: &[] };
        old.spawn(first, "counter", spec).unwrap();
        old.set_title("counter", "Counter");
        let pid = old.pid("counter").unwrap();
        wait_for("the first ticks", || ticks(&old.read_output("counter").unwrap_or_default()).len() >= 5);

        let mut frozen = old.freeze(Duration::from_secs(5)).unwrap();
        assert!(old.spawn(Arc::new(crate::sink::BroadcastSink::new(8)), "late", PaneSpec { cwd: dir.path().to_str().unwrap(), cols: 80, rows: 24, command: None, env: &[] })
            .is_err_and(|error| error.to_string() == HANDING_OVER), "no pane opens during a handover");
        assert_eq!(frozen.panes.len(), 1);
        let pane = frozen.panes.remove(0);
        let handed: Vec<u64> = ticks(&pane.scrollback);
        assert_eq!((pane.pid, pane.cols, pane.rows, pane.title.as_deref()), (Some(pid), 100, 30, Some("Counter")));
        // The program writes on while nobody reads; the terminal keeps it.
        std::thread::sleep(Duration::from_millis(300));

        let sink = Arc::new(crate::sink::BroadcastSink::new(1024));
        let exited = exits(&sink);
        let new = Terminals::new();
        new.adopt(sink.clone(), pane).unwrap();
        assert_eq!(new.pid("counter"), Some(pid), "the same program");
        assert_eq!(new.title("counter"), Some(("Counter".to_string(), false)));
        let last = *handed.last().unwrap();
        wait_for("ticks after the handover", || ticks(&new.read_output("counter").unwrap_or_default()).last().is_some_and(|tick| *tick > last + 20));
        let all = ticks(&new.read_output("counter").unwrap());
        assert!(all.windows(2).all(|pair| pair[1] == pair[0] + 1), "a tick was lost or repeated: {all:?}");
        assert!(all.contains(&last) && all.contains(&(last + 1)), "the handover's last tick and the next: {all:?}");
        assert_eq!(new.screen("counter", |screen| { let (rows, cols) = screen.size(); (rows.get(), cols.get()) }), Some((30, 100)), "the screen keeps its size");

        std::fs::write(dir.path().join("stop"), b"").unwrap();
        let exit = exited.recv_timeout(Duration::from_secs(30)).expect("the new owner reports the exit");
        assert_eq!((exit.id.as_str(), exit.code), ("counter", Some(7)));
        // The old owner never reaps or reports it: in a real handover its
        // threads are gone with its process image.
        std::mem::forget(old);
    }

    #[cfg(target_os = "linux")]
    fn sleeper(terminals: &Terminals, dir: &tempfile::TempDir, id: &str) -> u32 {
        terminals.spawn(Arc::new(crate::sink::BroadcastSink::new(64)), id, PaneSpec { cwd: dir.path().to_str().unwrap(), cols: 80, rows: 24, command: Some("sleep 300"), env: &[] }).unwrap();
        terminals.pid(id).unwrap()
    }

    /// #467 review: a terminal closed while the handover holds its
    /// supervisor goes into the record as stopping, and the runtime that
    /// takes over ends it; nothing keeps running unseen.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_terminal_closed_during_a_handover_is_stopped_by_the_runtime_that_takes_over() {
        let dir = tempfile::tempdir().unwrap();
        let old = Terminals::new();
        let pid = sleeper(&old, &dir, "closing");
        let mut frozen = old.freeze(Duration::from_secs(5)).unwrap();
        old.kill("closing");
        assert!(old.stopped_since_refresh(), "held, the observer sent nothing for that Stop");
        old.refresh_frozen(&mut frozen);
        assert!(!old.stopped_since_refresh(), "the record now carries it");
        let pane = frozen.panes.remove(0);
        assert!(pane.supervised.as_ref().unwrap().0.stopping_for_test(), "carried as stopping");
        let new = Terminals::new();
        new.adopt(Arc::new(crate::sink::BroadcastSink::new(64)), pane).unwrap();
        wait_for("the runtime that took over to end it", || !crate::harness::host::is_alive(pid) && new.owned_groups().is_empty());
    }

    /// #467 review: one closed after its state went into the record calls
    /// the handover off, and its Stop goes ahead where it was asked.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_terminal_closed_after_the_record_calls_the_handover_off() {
        let dir = tempfile::tempdir().unwrap();
        let old = Terminals::new();
        let pid = sleeper(&old, &dir, "late");
        let mut frozen = old.freeze(Duration::from_secs(5)).unwrap();
        old.refresh_frozen(&mut frozen);
        assert!(!old.stopped_since_refresh());
        old.kill("late");
        assert!(old.stopped_since_refresh(), "the handover must be called off");
        old.thaw();
        wait_for("its Stop to go ahead once thawed", || !crate::harness::host::is_alive(pid) && old.owned_groups().is_empty());
    }

    /// #467 review: a terminal whose supervisor the runtime taking over
    /// cannot adopt is said by name, and its helper is reaped, not left a
    /// zombie.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_supervisor_that_cannot_be_adopted_is_said_and_reaped() {
        let dir = tempfile::tempdir().unwrap();
        let old = Terminals::new();
        let shell = sleeper(&old, &dir, "unadoptable");
        old.set_title("unadoptable", "Dev server");
        let mut frozen = old.freeze(Duration::from_secs(5)).unwrap();
        let mut pane = frozen.panes.remove(0);
        let helper = pane.supervised.as_ref().unwrap().0.supervisor();
        pane.supervised.as_mut().unwrap().0.break_for_test();
        let new = Terminals::new();
        assert!(new.adopt(Arc::new(crate::sink::BroadcastSink::new(64)), pane).is_err());
        assert!(new.notices.lock().unwrap().iter().any(|notice| notice.contains("could not be kept running through the update") && notice.contains("Dev server")),
            "{:?}", new.notices.lock().unwrap());
        // In one process the old runtime still holds a copy of the channel,
        // so the helper is ended here, as the exec would close the copy.
        unsafe { libc::kill(helper as i32, libc::SIGKILL); libc::kill(shell as i32, libc::SIGKILL); }
        wait_for("the abandoned helper to be reaped", || !std::path::Path::new(&format!("/proc/{helper}")).exists());
    }

    /// #765: a handover called off leaves every pane as it was.
    #[test]
    fn a_handover_called_off_lets_output_go_on() {
        let dir = tempfile::tempdir().unwrap();
        let sink = Arc::new(crate::sink::BroadcastSink::new(1024));
        let exited = exits(&sink);
        let terminals = Terminals::new();
        let spec = PaneSpec { cwd: dir.path().to_str().unwrap(), cols: 80, rows: 24, command: Some(COUNTER), env: &[] };
        terminals.spawn(sink.clone(), "counter", spec).unwrap();
        wait_for("the first ticks", || ticks(&terminals.read_output("counter").unwrap_or_default()).len() >= 3);
        let frozen = terminals.freeze(Duration::from_secs(5)).unwrap();
        let held = ticks(&frozen.panes[0].scrollback).len();
        drop(frozen);
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(ticks(&terminals.read_output("counter").unwrap()).len(), held, "nothing is read while frozen");
        terminals.thaw();
        wait_for("more ticks", || ticks(&terminals.read_output("counter").unwrap_or_default()).len() > held + 10);
        let all = ticks(&terminals.read_output("counter").unwrap());
        assert!(all.windows(2).all(|pair| pair[1] == pair[0] + 1), "{all:?}");
        std::fs::write(dir.path().join("stop"), b"").unwrap();
        assert_eq!(exited.recv_timeout(Duration::from_secs(30)).unwrap().code, Some(7));
    }
}
