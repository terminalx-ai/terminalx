//! `terminalx-serve pair`: let another computer operate this one, with the
//! person's consent in this terminal (docs/MACHINES.md, decision 9, "Pairing
//! by code"; the design's screen 21.06, "On the server").
//!
//! It turns hosting on (`machines.allowOperating`) if the person agrees,
//! makes a one-time code that works for five minutes, and waits. When a
//! computer asks with the code, it names it, shows the pairing fingerprint the
//! computer shows too, and asks "Allow? [y/N]". Only "y" approves; anything
//! else, end of input, Ctrl-C or two minutes without an answer declines.
//!
//! Only a person may answer: `pair` refuses unless its input and output are a
//! terminal, and the runtime refuses to make a code or approve for a process
//! it started or one in its terminals (`consent`).
//!
//! `pair --phone` pairs a phone the same way (PRO-359): it prints the
//! `terminalx://pair` link as a QR in the terminal, the phone scans it, and the
//! person compares the fingerprint the phone shows and answers Allow here. The
//! runtime serves that phone itself while no TerminalX window takes phones.

use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde_json::json;

use super::control_client::{refusal_code, Attachment, Runtime};
use crate::machine_wire::{self, CreatedCode, CreatedPhoneCode, MachineCode, Status};

const USAGE: &str = "\
Usage: terminalx-serve pair [--phone] [--data-dir <dir>]

Let another computer operate this one. Shows a one-time pairing code to paste
into TerminalX on that computer (Settings → Machines → Add a machine), then
asks you to allow it. Run it in a terminal of your own: it will not approve
for an agent or a terminal TerminalX runs.

  --phone   Pair a phone instead: shows a QR to scan with TerminalX on the
            phone (Machines → Add), then asks you to allow it.";

/// How long `pair` waits for hosting to start once it is on.
const LISTEN_WAIT: Duration = Duration::from_secs(30);

/// How often the status is read while waiting.
const POLL: Duration = Duration::from_millis(250);

/// Run `terminalx-serve pair` with the arguments after its name.
pub fn run(args: &[String]) -> i32 {
    match pair(args) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("terminalx-serve pair: {error:#}");
            1
        }
    }
}

fn pair(args: &[String]) -> Result<i32> {
    let (flag, rest) = super::take_data_dir(args)?;
    let mut phone = false;
    match rest.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        [] => {}
        ["--phone"] => phone = true,
        ["-h" | "--help" | "help"] => {
            println!("{USAGE}");
            return Ok(0);
        }
        _ => {
            eprintln!("{USAGE}");
            return Ok(2);
        }
    }
    if !terminal::is_terminal(0) || !terminal::is_terminal(1) {
        eprintln!("terminalx-serve pair: only a person at a terminal may pair a computer, and this one's input or output is not a terminal. Run it in a terminal of your own.");
        return Ok(2);
    }
    let data = super::resolve_data_dir(flag.as_deref())?;
    let _signals = terminal::Interrupts::catch();
    let runtime = Runtime::connect_or_start(&data)?;
    // The settings the runtime watches are in its data directory. Set before
    // any thread of this process reads the environment.
    let canonical = std::fs::canonicalize(&data).with_context(|| format!("resolve {}", data.display()))?;
    std::env::set_var("TERMINALX_HOME", &canonical);

    let mut status = runtime.status()?;
    // Before anything is turned on: a window pairs this Mac's phones.
    if phone && (status.phone_route || status.phones.window_open) {
        eprintln!("terminalx-serve pair: TerminalX is open on this Mac, so its window pairs phones: Settings → Devices.");
        return Ok(1);
    }
    if !status.enabled {
        if phone {
            // Phones reach a server through the same listener computers use.
            println!("This server does not take connections now. Phones and other computers you pair");
        } else {
            println!("Other computers may not operate this server now. A computer you pair can run");
        }
        println!("agents, terminals and Git here, and read and change files, as {}.", user_label());
        match terminal::ask("Let other computers operate this server? [y/N] ", None)? {
            terminal::Answer::Line(line) if allows(&line) => {}
            terminal::Answer::Interrupted => return Ok(130),
            _ => {
                println!("Nothing changed.");
                return Ok(1);
            }
        }
        turn_on(&canonical)?;
    }
    status = wait_until_listening(&runtime, status)?;
    let machine_id = status.machine_id.clone().context("the runtime has no machine id")?;
    let attachment = runtime.attach()?;
    if phone {
        return pair_phone(&runtime, &attachment, &machine_id);
    }
    let mut first = true;
    loop {
        let created = match create_code(&attachment) {
            Ok(created) => created,
            Err(error) => {
                eprintln!("terminalx-serve pair: {error:#}");
                return Ok(1);
            }
        };
        let code = MachineCode::decode(&created.code).context("the runtime made a code this build cannot read")?;
        if first {
            print!("{}", header(&code, &machine_id));
            first = false;
        }
        println!();
        println!("Pairing code, valid for {}, works once:", clock(created.expires_at - now_ms()));
        println!("{}", created.code);
        println!();
        match wait(&runtime, &attachment, created.expires_at)? {
            Outcome::Approved => return Ok(0),
            Outcome::Declined => return Ok(1),
            Outcome::Interrupted => return Ok(130),
            Outcome::Ended(why) => {
                println!("{why}");
                match terminal::ask("Make a new code? [y/N] ", None)? {
                    terminal::Answer::Line(line) if allows(&line) => continue,
                    terminal::Answer::Interrupted => return Ok(130),
                    _ => return Ok(1),
                }
            }
        }
    }
}

/// The screen's first lines: what runs here, its name and its machine id.
fn header(code: &MachineCode, machine_id: &str) -> String {
    format!(
        "TerminalX {} · {} {}\n{:<12}{}\n{:<12}{}\n",
        code.machine.version,
        os_label(&code.machine.os.family),
        std::env::consts::ARCH,
        "Name",
        printable(&code.machine.name),
        "Machine ID",
        machine_id
    )
}

fn os_label(family: &str) -> &str {
    match family {
        "linux" => "Linux",
        "macos" => "macOS",
        other => other,
    }
}

/// Remaining time as `M:SS`, rounded up so a fresh code reads 5:00.
fn clock(remaining_ms: i64) -> String {
    let seconds = (remaining_ms.max(0) + 999) / 1000;
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

/// Only "y" or "Y" approves.
fn allows(answer: &str) -> bool {
    matches!(answer.trim(), "y" | "Y")
}

/// A name from another computer, without anything that would steer the terminal.
fn printable(text: &str) -> String {
    text.chars().filter(|character| !character.is_control()).collect()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn user_label() -> String {
    std::env::var("USER").ok().filter(|user| !user.is_empty()).unwrap_or_else(|| "this user".into())
}

/// `machines.allowOperating` on, through the settings store so every other
/// key in the file, known or not, stays. `TERMINALX_HOME` names `data`.
fn turn_on(data: &Path) -> Result<()> {
    debug_assert_eq!(crate::store::state_home_env().map(std::path::PathBuf::from).as_deref(), Some(data));
    let mut settings = crate::store::settings::load();
    settings.machines.allow_operating = true;
    crate::store::settings::save(&settings).context("turn on \"Let other computers operate this server\" in settings.json")?;
    Ok(())
}

fn wait_until_listening(runtime: &Runtime, mut status: Status) -> Result<Status> {
    let deadline = Instant::now() + LISTEN_WAIT;
    loop {
        if status.enabled && status.listening.is_some() && status.machine_id.is_some() {
            return Ok(status);
        }
        if status.enabled && status.host_key == machine_wire::HostKeyState::Needed {
            bail!("this runtime waits for the TerminalX window's key; pair it from Settings → Machines in the window");
        }
        if Instant::now() >= deadline {
            match status.error {
                Some(error) => bail!("other computers cannot reach this server: {error}"),
                None => bail!("the runtime did not start listening for computers within {} seconds", LISTEN_WAIT.as_secs()),
            }
        }
        std::thread::sleep(POLL);
        status = runtime.status()?;
    }
}

fn create_code(attachment: &Attachment) -> Result<CreatedCode> {
    let created = attachment.call(machine_wire::CREATE_CODE, json!({}));
    match created {
        Ok(created) => serde_json::from_value(created).context("read the pairing code"),
        Err(error) if refusal_code(&error) == Some("pairing_paused") => bail!("too many wrong pairing attempts; pairing is paused for a minute. Try again then."),
        Err(error) => Err(error),
    }
}

enum Outcome {
    Approved,
    Declined,
    Interrupted,
    /// The code expired or ended; why, to print.
    Ended(&'static str),
}

/// Wait for a computer to ask with the code, and ask the person.
fn wait(runtime: &Runtime, attachment: &Attachment, expires_at: i64) -> Result<Outcome> {
    let mut out = std::io::stdout();
    loop {
        if terminal::interrupted() {
            println!();
            return Ok(Outcome::Interrupted);
        }
        let status = runtime.status()?;
        if let Some(pending) = status.pending {
            let label = printable(&pending.label);
            write!(out, "\r\x1b[K")?;
            println!("✓ {label} asks to operate this server. Fingerprint {}.", printable(&pending.fingerprint));
            let deadline = Instant::now() + Duration::from_millis((pending.expires_at - now_ms()).max(0) as u64);
            let answer = terminal::ask("Allow? [y/N] ", Some(deadline))?;
            let approved = matches!(&answer, terminal::Answer::Line(line) if allows(line));
            if !approved {
                let _ = attachment.call(machine_wire::DECLINE, json!({ "requestId": pending.request_id }));
                return Ok(match answer {
                    terminal::Answer::Interrupted => {
                        println!("\nNot allowed.");
                        Outcome::Interrupted
                    }
                    terminal::Answer::TimedOut => {
                        println!("\nNo answer in time: not allowed.");
                        Outcome::Declined
                    }
                    terminal::Answer::Closed => {
                        println!("\nNot allowed.");
                        Outcome::Declined
                    }
                    terminal::Answer::Line(_) => {
                        println!("Not allowed.");
                        Outcome::Declined
                    }
                });
            }
            return match attachment.call(machine_wire::APPROVE, json!({ "requestId": pending.request_id })) {
                Ok(_) => {
                    println!("✓ {label} may now operate this server. `terminalx-serve devices` lists it.");
                    Ok(Outcome::Approved)
                }
                Err(error) if refusal_code(&error) == Some("not_found") => Ok(Outcome::Ended("The computer stopped waiting before it was allowed.")),
                Err(error) => {
                    eprintln!("terminalx-serve pair: {error:#}");
                    Ok(Outcome::Declined)
                }
            };
        }
        let left = expires_at - now_ms();
        if left <= 0 {
            write!(out, "\r\x1b[K")?;
            return Ok(Outcome::Ended("The code expired."));
        }
        if status.code.is_none() {
            write!(out, "\r\x1b[K")?;
            return Ok(Outcome::Ended("The code ended: the computer that used it stopped asking, or another code was made."));
        }
        write!(out, "\r\x1b[KWaiting for a computer to pair… {}", clock(left))?;
        out.flush()?;
        std::thread::sleep(POLL);
    }
}

/// `pair --phone`: a QR for the phone, then the person's answer.
fn pair_phone(runtime: &Runtime, attachment: &Attachment, machine_id: &str) -> Result<i32> {
    let mut first = true;
    loop {
        let created = match attachment.call(machine_wire::PHONE_CODE, json!({})) {
            Ok(created) => serde_json::from_value::<CreatedPhoneCode>(created).context("read the phone pairing code")?,
            Err(error) if refusal_code(&error) == Some("window_takes_phones") => {
                eprintln!("terminalx-serve pair: TerminalX is open on this Mac, so its window pairs phones: Settings → Devices.");
                return Ok(1);
            }
            Err(error) => {
                eprintln!("terminalx-serve pair: {error:#}");
                return Ok(1);
            }
        };
        if first {
            let name = crate::machine_name::computer_name().unwrap_or_else(|| "this server".into());
            print!(
                "TerminalX {} · {} {}\n{:<12}{}\n{:<12}{}\n",
                env!("CARGO_PKG_VERSION"),
                os_label(std::env::consts::OS),
                std::env::consts::ARCH,
                "Name",
                printable(&name),
                "Machine ID",
                machine_id
            );
            first = false;
        }
        println!();
        println!("Scan with TerminalX on your phone (Machines → Add). Valid for {}, works once:", clock(created.expires_at - now_ms()));
        println!();
        print!("{}", qr(&created.link)?);
        println!();
        println!("Or paste this link on the phone:");
        println!("{}", created.link);
        println!();
        match wait_phone(runtime, attachment, created.expires_at)? {
            Outcome::Approved => return Ok(0),
            Outcome::Declined => return Ok(1),
            Outcome::Interrupted => return Ok(130),
            Outcome::Ended(why) => {
                println!("{why}");
                match terminal::ask("Make a new code? [y/N] ", None)? {
                    terminal::Answer::Line(line) if allows(&line) => continue,
                    terminal::Answer::Interrupted => return Ok(130),
                    _ => return Ok(1),
                }
            }
        }
    }
}

/// `text` as a QR drawn with half blocks, two modules a character, dark on
/// light whatever the terminal's colours, with the quiet zone scanners need.
fn qr(text: &str) -> Result<String> {
    let code = qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::L).context("the pairing link does not fit a QR")?;
    let width = code.width();
    let colors = code.to_colors();
    const QUIET: usize = 2;
    let dark = |x: usize, y: usize| -> bool {
        x >= QUIET && y >= QUIET && x - QUIET < width && y - QUIET < width && colors[(y - QUIET) * width + (x - QUIET)] == qrcode::Color::Dark
    };
    let side = width + 2 * QUIET;
    let mut out = String::new();
    for row in (0..side).step_by(2) {
        for column in 0..side {
            // Upper module as the foreground of "▀", lower as its background.
            let colour = |is_dark: bool| if is_dark { 16 } else { 231 };
            out.push_str(&format!("\x1b[38;5;{}m\x1b[48;5;{}m▀", colour(dark(column, row)), colour(dark(column, row + 1))));
        }
        out.push_str("\x1b[0m\n");
    }
    Ok(out)
}

/// Wait for the phone to scan the code, and ask the person.
fn wait_phone(runtime: &Runtime, attachment: &Attachment, expires_at: i64) -> Result<Outcome> {
    let mut out = std::io::stdout();
    loop {
        if terminal::interrupted() {
            println!();
            return Ok(Outcome::Interrupted);
        }
        let status = runtime.status()?;
        if let Some(pending) = status.phones.pending {
            write!(out, "\r\x1b[K")?;
            println!("✓ A phone asks to connect. Check it shows the fingerprint {}.", printable(&pending.fingerprint));
            let deadline = Instant::now() + Duration::from_millis((pending.expires_at - now_ms()).max(0) as u64);
            let answer = terminal::ask("Allow? [y/N] ", Some(deadline))?;
            if !matches!(&answer, terminal::Answer::Line(line) if allows(line)) {
                let _ = attachment.call(machine_wire::PHONE_DECLINE, json!({ "requestId": pending.request_id }));
                return Ok(match answer {
                    terminal::Answer::Interrupted => {
                        println!("\nNot allowed.");
                        Outcome::Interrupted
                    }
                    terminal::Answer::TimedOut => {
                        println!("\nNo answer in time: not allowed.");
                        Outcome::Declined
                    }
                    terminal::Answer::Closed => {
                        println!("\nNot allowed.");
                        Outcome::Declined
                    }
                    terminal::Answer::Line(_) => {
                        println!("Not allowed.");
                        Outcome::Declined
                    }
                });
            }
            return match attachment.call(machine_wire::PHONE_APPROVE, json!({ "requestId": pending.request_id })) {
                Ok(_) => {
                    println!("✓ The phone is paired. It lists this server under Machines; `terminalx-serve devices` lists it.");
                    Ok(Outcome::Approved)
                }
                Err(error) if refusal_code(&error) == Some("not_found") => Ok(Outcome::Ended("The phone stopped waiting before it was allowed.")),
                Err(error) => {
                    eprintln!("terminalx-serve pair: {error:#}");
                    Ok(Outcome::Declined)
                }
            };
        }
        let left = expires_at - now_ms();
        if left <= 0 {
            write!(out, "\r\x1b[K")?;
            return Ok(Outcome::Ended("The code expired."));
        }
        if status.phones.code.is_none() {
            write!(out, "\r\x1b[K")?;
            return Ok(Outcome::Ended("The code ended: the phone that used it stopped asking, another code was made, or a TerminalX window opened."));
        }
        write!(out, "\r\x1b[KWaiting for the phone… {}", clock(left))?;
        out.flush()?;
        std::thread::sleep(POLL);
    }
}

/// The person's terminal: answers read with a deadline, and Ctrl-C caught
/// so it declines instead of leaving a computer waiting.
mod terminal {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Instant;

    use anyhow::Result;

    static INTERRUPTED: AtomicBool = AtomicBool::new(false);

    pub fn is_terminal(fd: libc::c_int) -> bool {
        // SAFETY: isatty only inspects the descriptor.
        unsafe { libc::isatty(fd) == 1 }
    }

    pub fn interrupted() -> bool {
        INTERRUPTED.load(Ordering::Relaxed)
    }

    extern "C" fn on_signal(_: libc::c_int) {
        INTERRUPTED.store(true, Ordering::Relaxed);
    }

    /// Ctrl-C, a closed terminal or a stop request while `pair` runs.
    pub struct Interrupts;

    impl Interrupts {
        pub fn catch() -> Self {
            for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
                // SAFETY: the handler only stores to an atomic. No
                // SA_RESTART: a read waiting for an answer returns at once.
                unsafe {
                    let mut action: libc::sigaction = std::mem::zeroed();
                    action.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
                    libc::sigemptyset(&mut action.sa_mask);
                    action.sa_flags = 0;
                    libc::sigaction(signal, &action, std::ptr::null_mut());
                }
            }
            Self
        }
    }

    pub enum Answer {
        Line(String),
        /// End of input.
        Closed,
        TimedOut,
        Interrupted,
    }

    /// Print `prompt` and read one line, until `deadline`. Anything typed
    /// before the prompt is thrown away: only an answer to it counts.
    pub fn ask(prompt: &str, deadline: Option<Instant>) -> Result<Answer> {
        use std::io::Write;
        // SAFETY: tcflush discards input not yet read from the terminal.
        unsafe { libc::tcflush(0, libc::TCIFLUSH) };
        let mut out = std::io::stdout();
        write!(out, "{prompt}")?;
        out.flush()?;
        let mut line = Vec::new();
        loop {
            if interrupted() {
                return Ok(Answer::Interrupted);
            }
            let wait = match deadline {
                Some(deadline) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Ok(Answer::TimedOut);
                    }
                    left.as_millis().min(200) as libc::c_int
                }
                None => 200,
            };
            let mut poll = libc::pollfd { fd: 0, events: libc::POLLIN, revents: 0 };
            // SAFETY: one pollfd, as counted.
            let ready = unsafe { libc::poll(&mut poll, 1, wait) };
            if ready < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error.into());
            }
            if ready == 0 {
                continue;
            }
            let mut buffer = [0u8; 256];
            // SAFETY: reads at most the buffer's length into it.
            let read = unsafe { libc::read(0, buffer.as_mut_ptr().cast(), buffer.len()) };
            if read < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error.into());
            }
            if read == 0 {
                return Ok(Answer::Closed);
            }
            line.extend_from_slice(&buffer[..read as usize]);
            if let Some(end) = line.iter().position(|byte| *byte == b'\n') {
                return Ok(Answer::Line(String::from_utf8_lossy(&line[..end]).into_owned()));
            }
            if line.len() > 4096 {
                return Ok(Answer::Line(String::new()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_yes_allows() {
        for yes in ["y", "Y", " y\n"] {
            assert!(allows(yes), "{yes:?}");
        }
        for no in ["", "n", "N", "no", "yes", "yy", "ok", "y please", "\u{1b}y"] {
            assert!(!allows(no), "{no:?}");
        }
    }

    #[test]
    fn the_phone_qr_is_square_with_its_quiet_zone_and_resets_colour() {
        let link = "terminalx://pair?code=".to_string() + &"A".repeat(400) + "&name=Build%20server";
        let drawn = qr(&link).unwrap();
        let side = qrcode::QrCode::with_error_correction_level(link.as_bytes(), qrcode::EcLevel::L).unwrap().width() + 4;
        let rows: Vec<&str> = drawn.lines().collect();
        assert_eq!(rows.len(), side.div_ceil(2), "two modules a row");
        assert!(rows.iter().all(|row| row.matches('▀').count() == side && row.ends_with("\x1b[0m")), "every row is the full width and resets the colour");
        assert!(rows[0].starts_with("\x1b[38;5;231m\x1b[48;5;231m▀"), "the quiet zone is light");
    }

    #[test]
    fn the_clock_rounds_up_and_never_goes_below_zero() {
        assert_eq!(clock(300_000), "5:00");
        assert_eq!(clock(299_001), "5:00");
        assert_eq!(clock(299_000), "4:59");
        assert_eq!(clock(61_000), "1:01");
        assert_eq!(clock(1), "0:01");
        assert_eq!(clock(-5), "0:00");
    }

    #[test]
    fn the_header_follows_the_design_with_the_machine_id() {
        use base64::Engine as _;
        let keypair = crate::relay_e2ee::HostKeypair::from_secret([7; 32]);
        let code = MachineCode::new(
            crate::relay_e2ee::random_token(),
            base64::engine::general_purpose::STANDARD.encode(keypair.public()),
            crate::machine_wire::MachineIdentity {
                machine_id: keypair.host_id(),
                name: "dev-server\u{1b}[2J".into(),
                os: crate::machine_wire::MachineOs { family: "linux".into(), version: Some("6.8".into()) },
                version: "0.2.33".into(),
            },
            vec!["ws://192.168.1.20:6768/machine/1".into()],
            1,
        );
        let printed = header(&code, &keypair.host_id());
        let lines: Vec<&str> = printed.lines().collect();
        assert_eq!(lines[0], format!("TerminalX 0.2.33 · Linux {}", std::env::consts::ARCH));
        assert_eq!(lines[1], "Name        dev-server[2J", "no escape reaches the terminal");
        assert_eq!(lines[2], format!("Machine ID  {}", keypair.host_id()));
        assert_eq!(os_label("macos"), "macOS");
    }

    #[test]
    fn without_a_terminal_it_refuses_before_reaching_any_runtime() {
        // Under `cargo test` neither input nor output is a terminal in CI;
        // where they are, the refusal is the serve test's to show.
        if terminal::is_terminal(0) && terminal::is_terminal(1) {
            return;
        }
        let data = tempfile::tempdir().unwrap();
        assert_eq!(run(&["--data-dir".into(), data.path().display().to_string()]), 2);
        assert!(!data.path().join("settings.json").exists(), "nothing was turned on");
    }
}
