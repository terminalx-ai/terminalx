//! The direct child reserves its PID (and therefore the group's ID) until
//! cleanup is complete. Never reap while a numeric group operation remains.

use std::io;
use std::process::ExitStatus;
use std::time::Duration;

pub(super) struct Child(std::process::Child);

impl Child {
    pub(super) fn new(child: std::process::Child) -> Self { Self(child) }

    pub(super) fn exited(&self) -> io::Result<bool> { exited(self.0.id()) }

    fn signal(&self, signal: i32) -> io::Result<()> {
        // In addition to exclusive Child ownership, refuse a numeric signal
        // if an unexpected external reaper has taken away the ownership anchor.
        self.exited()?;
        #[cfg(test)]
        observe(self.0.id(), Event::Signal(signal));
        // SAFETY: this child is unreaped and was spawned with process_group(0).
        if unsafe { libc::kill(-(self.0.id() as i32), signal) } == 0 { return Ok(()); }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) { Ok(()) } else { Err(error) }
    }

    pub(super) fn finish(mut self, git_cancelled: bool) -> io::Result<ExitStatus> {
        let mut signal_error = None;
        if git_cancelled {
            // Git owns its lockfiles. Keep its bounded SIGTERM cleanup window;
            // never remove repository locks or shared SSH sockets ourselves.
            signal_error = self.signal(libc::SIGTERM).err();
            std::thread::sleep(Duration::from_millis(250));
        }
        loop {
            self.exited()?;
            if let Err(error) = self.signal(libc::SIGKILL) { signal_error.get_or_insert(error); }
            #[cfg(test)]
            observe(self.0.id(), Event::Scan);
            // The zombie leader still reserves the ID, so a delayed scan cannot
            // adopt a replacement group. Unknown membership is not drained.
            if self.exited()? && matches!(other_members(self.0.id()), Ok(false)) { break; }
            std::thread::sleep(Duration::from_millis(5));
        }
        #[cfg(test)]
        observe(self.0.id(), Event::Reap);
        let status = self.0.wait();
        #[cfg(test)]
        observe(self.0.id(), Event::Reaped);
        // No signal, group existence probe or membership scan after this wait.
        let status = status?;
        match signal_error { Some(error) => Err(error), None => Ok(status) }
    }
}

fn exited(pid: u32) -> io::Result<bool> {
    // id_t is signed on some Unix targets and unsigned on others.
    #[allow(clippy::unnecessary_cast)]
    let id = pid as libc::id_t;
    loop {
        // SAFETY: zero is valid siginfo storage; WNOWAIT observes our own child
        // without reaping it. No other code has access to this Child to wait.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe { libc::waitid(libc::P_PID, id, &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) } == 0 {
            // SAFETY: waitid initialized the siginfo union's child fields.
            return Ok(unsafe { info.si_pid() } != 0);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted { return Err(error); }
    }
}

#[cfg(target_os = "macos")]
fn other_members(leader: u32) -> io::Result<bool> {
    // libproc's PROC_PGRP_ONLY includes live and zombie processes under the
    // kernel process-list lock. A two-slot buffer suffices: one is our leader;
    // any other positive PID means cleanup must keep waiting, even if truncated.
    let mut pids = [0i32; 2];
    // SAFETY: libproc receives exactly the size of the writable PID buffer.
    let bytes = unsafe { libc::proc_listpids(2, leader, pids.as_mut_ptr().cast(),
        std::mem::size_of_val(&pids) as i32) };
    if bytes <= 0 { return Err(io::Error::last_os_error()); }
    Ok(pids.iter().any(|pid| *pid > 0 && *pid as u32 != leader))
}

#[cfg(target_os = "linux")]
fn other_members(leader: u32) -> io::Result<bool> {
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<i32>().ok()) else { continue };
        if pid as u32 == leader { continue; }
        // SAFETY: this only reads group membership. The unreaped leader keeps
        // the group identity reserved throughout the scan, including zombies.
        let group = unsafe { libc::getpgid(pid) };
        if group == leader as i32 { return Ok(true); }
        if group < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) { return Err(error); }
        }
    }
    Ok(false)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn other_members(leader: u32) -> io::Result<bool> {
    let output = std::process::Command::new("/bin/ps").args(["-A", "-o", "pid=,pgid="])
        .env("LC_ALL", "C").output()?;
    if !output.status.success() { return Err(io::Error::other("Could not inspect the owned process group")); }
    Ok(String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        let mut words = line.split_whitespace();
        let pid = words.next().and_then(|word| word.parse::<u32>().ok());
        let group = words.next().and_then(|word| word.parse::<u32>().ok());
        group == Some(leader) && pid != Some(leader)
    }))
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq)]
enum Event { Signal(i32), Scan, Reap, Reaped }

#[cfg(test)]
type Observer = Box<dyn Fn(u32, Event)>;

#[cfg(test)]
thread_local! {
    static OBSERVER: std::cell::RefCell<Option<Observer>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn observe(pid: u32, event: Event) {
    OBSERVER.with(|observer| { if let Some(observer) = observer.borrow().as_ref() { observer(pid, event); } });
}

#[cfg(test)]
#[path = "github_process_group_tests.rs"]
mod tests;
