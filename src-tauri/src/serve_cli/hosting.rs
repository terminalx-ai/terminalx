//! `terminalx-serve hosting`: where this server listens for the computers
//! and phones paired with it, and who it answers (PRO-487, docs/MACHINES.md
//! "As built (PRO-487)", docs/HEADLESS-SERVER.md "Where the server listens").
//!
//! `hosting` alone says the choice, the addresses listening now, whether
//! public callers are answered and who the runtime runs as: the same lines
//! `service status` prints. `hosting --listen relay|tailscale|lan|all`
//! changes the choice. It writes `settings.json`, which the runtime watches,
//! so it also works while the runtime is stopped: a server that cannot be
//! reached any more is brought back over SSH with it.

use std::path::Path;

use anyhow::{Context, Result};

use crate::listen::{Listen, Plan, RunsAs};
use crate::store::settings::MachinesSettings;

const USAGE: &str = "\
Usage: terminalx-serve hosting [--listen relay|tailscale|lan|all] [--allow-public] [--data-dir <dir>]

Where this server listens for paired computers and phones (TCP 6768).
Alone, it shows the choice and the addresses listening now.

  --listen relay      No port is opened. Computers and phones reach this
                      server through the TerminalX relay, end-to-end
                      encrypted. Needs `terminalx-serve login`.
  --listen tailscale  This server's Tailscale address only.
  --listen lan        Its private network and Tailscale addresses.
  --listen all        Every address it has, public ones included.
  --allow-public      Also answer callers whose own address is public.
                      Without it they are refused under every choice.";

/// Run `terminalx-serve hosting` with the arguments after its name.
pub fn run(args: &[String]) -> i32 {
    match hosting(args) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("terminalx-serve hosting: {error:#}");
            1
        }
    }
}

/// What the arguments ask for.
#[derive(Debug, PartialEq, Eq)]
enum Asked {
    Show,
    Choose(Listen, bool),
    Help,
    Usage,
}

fn parse(rest: &[String]) -> Asked {
    let (mut listen, mut allow_public, mut named) = (None, false, false);
    let mut args = rest.iter().map(String::as_str);
    while let Some(arg) = args.next() {
        let word = match arg {
            "-h" | "--help" | "help" => return Asked::Help,
            "--allow-public" => {
                allow_public = true;
                continue;
            }
            "--listen" => args.next(),
            other => other.strip_prefix("--listen="),
        };
        match word.and_then(Listen::from_word) {
            Some(choice) if !named => {
                listen = Some(choice);
                named = true;
            }
            _ => return Asked::Usage,
        }
    }
    match listen {
        // Nothing listens under "relay", so there is no caller to allow.
        Some(Listen::Relay) if allow_public => Asked::Usage,
        Some(listen) => Asked::Choose(listen, allow_public),
        None if allow_public => Asked::Usage,
        None => Asked::Show,
    }
}

fn hosting(args: &[String]) -> Result<i32> {
    let (flag, rest) = super::take_data_dir(args)?;
    let asked = parse(&rest);
    match asked {
        Asked::Help => {
            println!("{USAGE}");
            return Ok(0);
        }
        Asked::Usage => {
            eprintln!("{USAGE}");
            return Ok(2);
        }
        Asked::Show | Asked::Choose(..) => {}
    }
    let data = super::resolve_data_dir(flag.as_deref())?;
    let Asked::Choose(listen, allow_public) = asked else {
        for line in lines(&View::read(&data)) {
            println!("{line}");
        }
        return Ok(0);
    };
    std::fs::create_dir_all(&data).with_context(|| format!("create {}", data.display()))?;
    // The settings the runtime watches are in its data directory. Set before
    // any thread of this process reads the environment.
    let canonical = crate::paths::canonicalize(&data).with_context(|| format!("resolve {}", data.display()))?;
    std::env::set_var("TERMINALX_HOME", &canonical);
    crate::listen::choose(listen, allow_public).context("write the choice to settings.json")?;
    println!("This server listens on: {}. {}", listen.label(), listen.exposes());
    println!("Callers from public addresses are {}.", if allow_public { "answered" } else { "refused" });
    if listen == Listen::Relay && !signed_in(&canonical) {
        println!("This server is not signed in to TerminalX, so nothing can reach it until you run `terminalx-serve login`.");
    }
    let view = settled(&canonical, listen);
    if view.live.is_none() {
        println!("The runtime is not running; the choice applies when it starts.");
    } else if view.hosting {
        println!("{}", listening_line(&view));
    } else {
        println!("Hosting is off, so nothing listens yet: `terminalx-serve pair` turns it on.");
    }
    Ok(0)
}

/// Whether `terminalx-serve login` was run for `data`.
pub(super) fn signed_in(data: &Path) -> bool {
    matches!(crate::machine_account::load(data), Ok(Some(_)))
}

/// The view once the running runtime follows the new choice, or after a few
/// seconds of waiting for it.
fn settled(data: &Path, listen: Listen) -> View {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let view = View::read(data);
        let followed = view.live.as_ref().is_none_or(|live| live.chosen && live.choice == listen && (!view.hosting || live.addresses.len() == view.would_bind.len()));
        if followed || std::time::Instant::now() >= deadline {
            return view;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

/// What `hosting` and `service status` say.
pub(super) struct View {
    /// `machines.allowOperating`, or the running runtime hosting phones.
    pub hosting: bool,
    pub plan: Plan,
    /// The running runtime's own account of it; `None` while it is stopped
    /// or is a version from before the setting.
    pub live: Option<crate::machine_wire::ListenStatus>,
    /// The addresses the choice binds on this server now.
    pub would_bind: Vec<String>,
    /// A public address of this server, if it has one.
    pub public_address: Option<String>,
    pub runs_as: RunsAs,
}

impl View {
    /// Read the settings of `data`, and the runtime's status when it runs.
    pub(super) fn read(data: &Path) -> Self {
        let machines = settings(data).unwrap_or_default();
        let plan = Plan::of(&machines);
        let interfaces = crate::listen::interfaces();
        let status = live(data);
        let live_listen = status.as_ref().and_then(|status| status.listen.clone());
        Self {
            hosting: status.as_ref().map_or(machines.allow_operating, |status| status.hosting()),
            plan,
            would_bind: plan.binds(&interfaces).into_iter().map(|ip| std::net::SocketAddr::from((ip, crate::direct_endpoints::DIRECT_PORT)).to_string()).collect(),
            public_address: interfaces.iter().find(|ip| crate::listen::is_public(std::net::IpAddr::V4(**ip))).map(ToString::to_string),
            // The runtime's word when it runs; else this user's, who the
            // user service runs as.
            runs_as: status.and_then(|status| status.runs_as).filter(|runs_as| runs_as.root || runs_as.passwordless_sudo.is_some()).unwrap_or_else(crate::listen::runs_as),
            live: live_listen,
        }
    }

    fn ask_public(&self) -> bool {
        match &self.live {
            Some(live) => live.ask_public,
            None => self.hosting && self.plan.public_unanswered && self.public_address.is_some(),
        }
    }
}

/// `machines` of the settings in `data`. `None`: unreadable.
fn settings(data: &Path) -> Option<MachinesSettings> {
    let text = match std::fs::read_to_string(data.join("settings.json")) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(MachinesSettings::default()),
        Err(_) => return None,
    };
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    match &value["machines"] {
        serde_json::Value::Null => Some(MachinesSettings::default()),
        machines => serde_json::from_value(machines.clone()).ok(),
    }
}

/// The running runtime's machine host status, if a runtime runs for `data`.
fn live(data: &Path) -> Option<crate::machine_wire::Status> {
    #[cfg(unix)]
    {
        super::control_client::Runtime::connect(data).ok()?.status().ok()
    }
    #[cfg(not(unix))]
    {
        let _ = data;
        None
    }
}

/// "Listening  …": the choice and the addresses.
fn listening_line(view: &View) -> String {
    let plan = &view.plan;
    let choice = if plan.chosen { plan.choice.label().to_string() } else { format!("{} (kept from before this setting existed)", plan.choice.label()) };
    let addresses = match &view.live {
        Some(live) => live.addresses.clone(),
        None => view.would_bind.clone(),
    };
    let every = |address: &String| address.starts_with("0.0.0.0:");
    let place = if plan.choice == Listen::Relay {
        "no port is open; computers and phones come through the TerminalX relay".to_string()
    } else if !view.hosting {
        "nothing listens while hosting is off".to_string()
    } else if addresses.is_empty() {
        match plan.choice {
            Listen::Tailscale => "nothing listens: this server has no Tailscale address now".to_string(),
            _ => "nothing listens: this server has no such address now".to_string(),
        }
    } else if addresses.iter().any(every) {
        format!("every interface, TCP {}", addresses.iter().find(|address| every(address)).and_then(|address| address.rsplit(':').next()).unwrap_or("6768"))
    } else {
        addresses.join(", ")
    };
    format!("Listening  {choice}: {place}")
}

/// The lines about listening, public callers and the runtime's user.
pub(super) fn lines(view: &View) -> Vec<String> {
    let mut lines = vec![listening_line(view), "           (`terminalx-serve hosting --listen relay|tailscale|lan|all` changes it)".to_string()];
    if view.ask_public() {
        lines.push("Public     DECIDE: this server listened on every interface before this setting existed, and it".into());
        lines.push(format!("           can be reached from the internet{}.", view.public_address.as_ref().map(|address| format!(" ({address})")).unwrap_or_default()));
        lines.push("           Callers from public addresses are refused until you choose:".into());
        lines.push("             keep the public address:  terminalx-serve hosting --listen all --allow-public".into());
        lines.push("             close it:                 terminalx-serve hosting --listen relay   (or tailscale, lan)".into());
    } else if view.plan.choice != Listen::Relay {
        lines.push(format!("Public     callers from public addresses are {}", if view.plan.allow_public { "answered (--allow-public)" } else { "refused" }));
    }
    let runs_as = &view.runs_as;
    if runs_as.root {
        lines.push(format!("Runs as    {} (root): every paired computer and every agent on this server acts as root", runs_as.user));
    } else {
        lines.push(format!("Runs as    {}", runs_as.user));
        lines.push(match runs_as.passwordless_sudo {
            Some(true) => format!("Sudo       {} has passwordless sudo: paired computers and agents can become root", runs_as.user),
            Some(false) => format!("Sudo       {} cannot use sudo without a password", runs_as.user),
            None => "Sudo       not known yet".to_string(),
        });
    }
    lines
}

/// The question `pair` asks the first time hosting is turned on: the four
/// choices, each with the addresses it would open on this server.
pub(super) fn question(interfaces: &[std::net::Ipv4Addr]) -> String {
    let addresses = |choice: Listen| {
        let binds = crate::listen::bind_addresses(choice, interfaces);
        match choice {
            Listen::Relay => String::new(),
            Listen::All => {
                let public: Vec<String> = interfaces.iter().filter(|ip| crate::listen::is_public(std::net::IpAddr::V4(**ip))).map(ToString::to_string).collect();
                if public.is_empty() { " This server has no public address of its own now.".to_string() } else { format!(" Here that includes {}.", public.join(", ")) }
            }
            _ if binds.is_empty() => " This server has none now, so nothing would listen.".to_string(),
            _ => format!(" Here: {}.", binds.iter().map(ToString::to_string).collect::<Vec<_>>().join(", ")),
        }
    };
    let mut text = String::from("Where should this server listen for them?\n");
    for (number, choice) in Listen::EVERY.into_iter().enumerate() {
        text.push_str(&format!("  {}) {:<15} {}{}\n", number + 1, choice.label(), choice.exposes(), addresses(choice)));
    }
    text.push_str("Callers from public addresses are refused under every choice unless you allow them.\n");
    text
}

/// The answer to [`question`]: a number, a word, or nothing for "Relay only".
pub(super) fn answer(line: &str) -> Option<Listen> {
    match line.trim().to_ascii_lowercase().as_str() {
        "" | "1" => Some(Listen::Relay),
        "2" => Some(Listen::Tailscale),
        "3" => Some(Listen::Lan),
        "4" => Some(Listen::All),
        word => Listen::from_word(word),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    fn view(machines: MachinesSettings, interfaces: &[&str], runs_as: RunsAs) -> View {
        let interfaces: Vec<std::net::Ipv4Addr> = interfaces.iter().map(|ip| ip.parse().unwrap()).collect();
        let plan = Plan::of(&machines);
        View {
            hosting: machines.allow_operating,
            plan,
            live: None,
            would_bind: plan.binds(&interfaces).into_iter().map(|ip| format!("{ip}:6768")).collect(),
            public_address: interfaces.iter().find(|ip| crate::listen::is_public(std::net::IpAddr::V4(**ip))).map(ToString::to_string),
            runs_as,
        }
    }

    fn sam(sudo: bool) -> RunsAs {
        RunsAs { user: "sam".into(), root: false, passwordless_sudo: Some(sudo) }
    }

    #[test]
    fn the_listen_command_takes_one_choice_and_public_callers_only_with_a_listener() {
        assert_eq!(parse(&args(&[])), Asked::Show);
        assert_eq!(parse(&args(&["--listen", "relay"])), Asked::Choose(Listen::Relay, false));
        assert_eq!(parse(&args(&["--listen=lan"])), Asked::Choose(Listen::Lan, false));
        assert_eq!(parse(&args(&["--allow-public", "--listen", "all"])), Asked::Choose(Listen::All, true));
        assert_eq!(parse(&args(&["--help"])), Asked::Help);
        for wrong in [&["--listen"][..], &["--listen", "everything"], &["--listen", "lan", "--listen", "all"], &["--allow-public"], &["--listen", "relay", "--allow-public"], &["lan"]] {
            assert_eq!(parse(&args(wrong)), Asked::Usage, "{wrong:?}");
        }
        assert_eq!(run(&args(&["--listen", "everything"])), 2);
    }

    #[test]
    fn the_first_pairing_question_defaults_to_relay_only_and_names_this_servers_addresses() {
        assert_eq!(answer("\n"), Some(Listen::Relay), "Enter keeps the default");
        assert_eq!((answer("1"), answer(" 2 "), answer("3"), answer("4")), (Some(Listen::Relay), Some(Listen::Tailscale), Some(Listen::Lan), Some(Listen::All)));
        assert_eq!((answer("LAN"), answer("all")), (Some(Listen::Lan), Some(Listen::All)));
        assert_eq!((answer("5"), answer("y"), answer("public")), (None, None, None), "All interfaces is never a slip of the key");

        let interfaces: Vec<std::net::Ipv4Addr> = ["127.0.0.1", "10.0.0.4", "100.93.49.78", "203.0.113.7"].iter().map(|ip| ip.parse().unwrap()).collect();
        let asked = question(&interfaces);
        let rows: Vec<&str> = asked.lines().collect();
        assert!(rows[1].starts_with("  1) Relay only") && rows[1].contains("No port is opened"), "{asked}");
        assert!(rows[2].starts_with("  2) Tailscale") && rows[2].ends_with("Here: 100.93.49.78."), "{asked}");
        assert!(rows[3].starts_with("  3) Local network") && rows[3].ends_with("Here: 10.0.0.4, 100.93.49.78."), "{asked}");
        assert!(rows[4].starts_with("  4) All interfaces") && rows[4].ends_with("Here that includes 203.0.113.7."), "{asked}");
        assert!(question(&["192.168.1.9".parse().unwrap()]).contains("2) Tailscale       TCP 6768 on this computer's Tailscale address only. This server has none now, so nothing would listen."));
    }

    #[test]
    fn status_says_the_choice_the_addresses_and_who_it_runs_as() {
        let relay = view(MachinesSettings { allow_operating: true, listen: Some(Listen::Relay), allow_public: Some(false) }, &["203.0.113.7", "10.0.0.4"], sam(false));
        let said = lines(&relay).join("\n");
        assert!(said.starts_with("Listening  Relay only: no port is open; computers and phones come through the TerminalX relay"), "{said}");
        assert!(!said.contains("Public"), "nothing listens, so no caller to speak of: {said}");
        assert!(said.contains("Runs as    sam\nSudo       sam cannot use sudo without a password"), "{said}");

        let lan = view(MachinesSettings { allow_operating: true, listen: Some(Listen::Lan), allow_public: Some(false) }, &["203.0.113.7", "10.0.0.4", "100.93.49.78"], sam(true));
        let said = lines(&lan).join("\n");
        assert!(said.contains("Listening  Local network: 10.0.0.4:6768, 100.93.49.78:6768"), "{said}");
        assert!(said.contains("Public     callers from public addresses are refused"), "{said}");
        assert!(said.contains("Sudo       sam has passwordless sudo: paired computers and agents can become root"), "{said}");

        let root = view(MachinesSettings { allow_operating: true, listen: Some(Listen::All), allow_public: Some(true) }, &["203.0.113.7"], RunsAs { user: "root".into(), root: true, passwordless_sudo: None });
        let said = lines(&root).join("\n");
        assert!(said.contains("Listening  All interfaces: every interface, TCP 6768"), "{said}");
        assert!(said.contains("Public     callers from public addresses are answered (--allow-public)"), "{said}");
        assert!(said.contains("Runs as    root (root): every paired computer and every agent on this server acts as root") && !said.contains("Sudo"), "{said}");

        let off = view(MachinesSettings { allow_operating: false, listen: Some(Listen::Lan), allow_public: Some(false) }, &["10.0.0.4"], sam(false));
        assert!(lines(&off)[0].contains("Local network: nothing listens while hosting is off"));
    }

    #[test]
    fn a_server_from_before_the_setting_is_asked_once_about_its_public_address() {
        let before = MachinesSettings { allow_operating: true, listen: None, allow_public: None };
        let asked = view(before.clone(), &["203.0.113.7", "10.0.0.4"], sam(false));
        let said = lines(&asked).join("\n");
        assert!(said.contains("Listening  All interfaces (kept from before this setting existed): every interface, TCP 6768"), "{said}");
        assert!(said.contains("Public     DECIDE") && said.contains("(203.0.113.7)") && said.contains("refused until you choose"), "{said}");
        assert!(said.contains("terminalx-serve hosting --listen all --allow-public") && said.contains("terminalx-serve hosting --listen relay"), "{said}");

        // Behind NAT with nothing refused: nothing to decide.
        let private = view(before.clone(), &["10.0.0.4"], sam(false));
        let said = lines(&private).join("\n");
        assert!(!said.contains("DECIDE") && said.contains("Public     callers from public addresses are refused"), "{said}");

        // The runtime's word wins: a public caller it refused opens the question behind NAT too.
        let mut refused = view(before, &["10.0.0.4"], sam(false));
        refused.live = Some(crate::machine_wire::ListenStatus { choice: Listen::All, chosen: false, addresses: vec!["0.0.0.0:6768".into()], allow_public: false, ask_public: true, refused_public_at: Some(1) });
        assert!(lines(&refused).join("\n").contains("Public     DECIDE"));

        // Answered either way: never asked again.
        let kept = view(MachinesSettings { allow_operating: true, listen: Some(Listen::All), allow_public: Some(true) }, &["203.0.113.7"], sam(false));
        assert!(!lines(&kept).join("\n").contains("DECIDE"));
    }

    #[test]
    fn the_settings_are_read_from_the_file_and_default_without_one() {
        let data = tempfile::tempdir().unwrap();
        assert_eq!(settings(data.path()).unwrap().listen, None);
        std::fs::write(data.path().join("settings.json"), r#"{"machines":{"allowOperating":true,"listen":"tailscale","allowPublic":false},"other":1}"#).unwrap();
        let machines = settings(data.path()).unwrap();
        assert_eq!((machines.allow_operating, machines.listen, machines.allow_public), (true, Some(Listen::Tailscale), Some(false)));
        std::fs::write(data.path().join("settings.json"), "{not json").unwrap();
        assert!(settings(data.path()).is_none());
    }
}
