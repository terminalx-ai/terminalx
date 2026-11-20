//! `terminalx-serve service install|status|uninstall`: the runtime as a user
//! service that starts at boot. On Linux a systemd user unit, which starts at
//! boot only while the user lingers; on macOS a LaunchAgent in
//! `~/Library/LaunchAgents`, loaded into `gui/<uid>`; on Windows a Task
//! Scheduler task of this user's that starts at their logon, registered
//! without administrator rights from a definition kept beside the install.
//!
//! The service runs `<install root>/current/terminalx-serve --data-dir <data>
//! --log-file <install root>/logs/runtime.log`, or the running executable when
//! there is no `current` (a hand-built binary). Installing it never turns
//! hosting on: `terminalx-serve pair` does, with a person's consent
//! (docs/MACHINES.md, decision 9). Uninstalling keeps the data directory.
//!
//! With hosting off, an idle runtime exits as it always has; the service
//! manager restarts it only after a failure, and `pair` and `devices revoke`
//! start it again when they need it ([`start_for`]).

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};

/// The systemd user unit's name.
pub const UNIT: &str = "terminalx.service";

/// The LaunchAgent's label.
pub const LABEL: &str = "ai.terminalx.serve";

/// The Task Scheduler task's name, in a folder of its own.
pub const TASK: &str = "\\TerminalX\\Runtime";

const USAGE: &str = "\
Usage: terminalx-serve service install|status|uninstall [--data-dir <dir>]

  install     Run the runtime as a user service that starts at boot
              (systemd on Linux, a LaunchAgent on macOS). It does not let
              other computers operate this one: `terminalx-serve pair` does.
  status      Say whether the service is installed and running
  uninstall   Stop and remove the service; the data directory is kept";

/// What the service runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub executable: PathBuf,
    pub data: PathBuf,
    pub log: PathBuf,
}

impl Plan {
    /// For an install under `root` (`~/.terminalx`): its `current` binary
    /// when there is one, else `running` (this executable).
    pub fn new(root: &Path, data: PathBuf, running: PathBuf) -> Self {
        let current = root.join("current").join(if cfg!(windows) { "terminalx-serve.exe" } else { "terminalx-serve" });
        let executable = if root.join("current").exists() { current } else { running };
        Self { executable, data, log: root.join("logs").join("runtime.log") }
    }

    /// The command line, executable first.
    pub fn arguments(&self) -> Vec<String> {
        [&self.executable, Path::new("--data-dir"), &self.data, Path::new("--log-file"), &self.log]
            .iter()
            .map(|part| part.to_string_lossy().into_owned())
            .collect()
    }
}

/// One argument of a systemd `ExecStart=`, quoted so spaces, quotes,
/// backslashes and specifiers stay literal.
fn systemd_quote(argument: &str) -> String {
    let mut quoted = String::from("\"");
    for character in argument.chars() {
        match character {
            '"' | '\\' => {
                quoted.push('\\');
                quoted.push(character);
            }
            '%' => quoted.push_str("%%"),
            '$' => quoted.push_str("$$"),
            other => quoted.push(other),
        }
    }
    quoted.push('"');
    quoted
}

/// The systemd user unit for `plan`.
pub fn systemd_unit(plan: &Plan) -> String {
    let exec = plan.arguments().iter().map(|argument| systemd_quote(argument)).collect::<Vec<_>>().join(" ");
    format!(
        "# Written by `terminalx-serve service install`; removed by `terminalx-serve service uninstall`.\n\
         [Unit]\n\
         Description=TerminalX runtime\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={exec}\n\
         Restart=on-failure\n\
         RestartSec=5\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n"
    )
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// The LaunchAgent for `plan`: loaded at login and at boot of the user's
/// launchd domain, and started again only after a failure.
pub fn launch_agent(plan: &Plan) -> String {
    let arguments = plan.arguments().iter().map(|argument| format!("\t\t<string>{}</string>\n", xml_escape(argument))).collect::<String>();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <!-- Written by `terminalx-serve service install`; removed by `terminalx-serve service uninstall`. -->\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \t<key>Label</key>\n\
         \t<string>{LABEL}</string>\n\
         \t<key>ProgramArguments</key>\n\
         \t<array>\n\
         {arguments}\
         \t</array>\n\
         \t<key>RunAtLoad</key>\n\
         \t<true/>\n\
         \t<key>KeepAlive</key>\n\
         \t<dict>\n\
         \t\t<key>SuccessfulExit</key>\n\
         \t\t<false/>\n\
         \t</dict>\n\
         \t<key>ProcessType</key>\n\
         \t<string>Background</string>\n\
         </dict>\n\
         </plist>\n"
    )
}

/// The Task Scheduler definition for `plan`: started at this user's logon,
/// as this user, with their own token (no password is stored), and again
/// after a failure; never stopped for running long or on battery.
pub fn scheduled_task(plan: &Plan, user: &str) -> String {
    let mut arguments = plan.arguments();
    let command = arguments.remove(0);
    let arguments = arguments.iter().map(|argument| windows_quote(argument)).collect::<Vec<_>>().join(" ");
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n\
         <!-- Written by `terminalx-serve service install`; removed by `terminalx-serve service uninstall`. -->\n\
         <Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n\
         \t<RegistrationInfo>\n\t\t<Description>TerminalX runtime</Description>\n\t</RegistrationInfo>\n\
         \t<Triggers>\n\t\t<LogonTrigger>\n\t\t\t<Enabled>true</Enabled>\n\t\t\t<UserId>{user}</UserId>\n\t\t</LogonTrigger>\n\t</Triggers>\n\
         \t<Principals>\n\t\t<Principal id=\"Author\">\n\t\t\t<UserId>{user}</UserId>\n\t\t\t<LogonType>InteractiveToken</LogonType>\n\t\t\t<RunLevel>LeastPrivilege</RunLevel>\n\t\t</Principal>\n\t</Principals>\n\
         \t<Settings>\n\
         \t\t<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n\
         \t\t<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n\
         \t\t<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n\
         \t\t<AllowHardTerminate>true</AllowHardTerminate>\n\
         \t\t<StartWhenAvailable>true</StartWhenAvailable>\n\
         \t\t<AllowStartOnDemand>true</AllowStartOnDemand>\n\
         \t\t<Enabled>true</Enabled>\n\
         \t\t<Hidden>false</Hidden>\n\
         \t\t<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n\
         \t\t<Priority>7</Priority>\n\
         \t\t<RestartOnFailure>\n\t\t\t<Interval>PT1M</Interval>\n\t\t\t<Count>999</Count>\n\t\t</RestartOnFailure>\n\
         \t</Settings>\n\
         \t<Actions Context=\"Author\">\n\t\t<Exec>\n\t\t\t<Command>{}</Command>\n\t\t\t<Arguments>{}</Arguments>\n\t\t</Exec>\n\t</Actions>\n\
         </Task>\n",
        xml_escape(&command),
        xml_escape(&arguments),
        user = xml_escape(user),
    )
}

/// One argument of a Windows command line, quoted as `CommandLineToArgvW`
/// (and so the runtime's own argument parsing) reads it back: spaces and
/// quotes stay part of the argument.
pub fn windows_quote(argument: &str) -> String {
    if !argument.is_empty() && !argument.contains([' ', '\t', '"']) {
        return argument.to_owned();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0;
    for character in argument.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            other => {
                quoted.push_str(&"\\".repeat(backslashes));
                quoted.push(other);
                backslashes = 0;
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

/// The bytes a definition is kept in: UTF-16 with a byte order mark on
/// Windows, which is what Task Scheduler reads a task's XML as.
fn encode_definition(text: &str) -> Vec<u8> {
    if cfg!(windows) {
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        bytes
    } else {
        text.as_bytes().to_vec()
    }
}

/// An installed definition, read back as [`encode_definition`] wrote it.
fn read_definition(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    match bytes.strip_prefix(&[0xFF, 0xFE]) {
        Some(wide) => {
            let units: Vec<u16> = wide.as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
            String::from_utf16(&units).map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
        }
        None => String::from_utf8(bytes).map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
    }
}

/// Where the service's definition lives under `home`.
pub fn definition_path(home: &Path) -> PathBuf {
    if cfg!(windows) {
        return home.join(super::INSTALL_DIR).join("service").join("terminalx-runtime.task.xml");
    }
    if cfg!(target_os = "macos") {
        home.join("Library/LaunchAgents").join(format!("{LABEL}.plist"))
    } else {
        let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|path| path.is_absolute()).unwrap_or_else(|| home.join(".config"));
        config.join("systemd/user").join(UNIT)
    }
}

/// The definition of the service for `plan` on this system.
pub fn definition(plan: &Plan) -> String {
    if cfg!(windows) {
        return scheduled_task(plan, &user_name().unwrap_or_default());
    }
    if cfg!(target_os = "macos") {
        launch_agent(plan)
    } else {
        systemd_unit(plan)
    }
}

/// Whether `text`, an installed definition, runs the runtime of `data`.
pub fn serves(text: &str, data: &Path) -> bool {
    let data = data.to_string_lossy();
    if cfg!(windows) {
        return text.contains(&format!("--data-dir {} ", xml_escape(&windows_quote(&data))));
    }
    if cfg!(target_os = "macos") {
        text.contains(&format!("<string>--data-dir</string>\n\t\t<string>{}</string>", xml_escape(&data)))
    } else {
        text.contains(&format!("\"--data-dir\" {}", systemd_quote(&data)))
    }
}

/// Run `terminalx-serve service` with the arguments after its name.
pub fn run(args: &[String]) -> i32 {
    match dispatch(args) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("terminalx-serve service: {error:#}");
            1
        }
    }
}

fn dispatch(args: &[String]) -> Result<i32> {
    let (flag, rest) = super::take_data_dir(args)?;
    let action = match rest.as_slice() {
        [action] => action.as_str(),
        [] => {
            eprintln!("{USAGE}");
            return Ok(2);
        }
        [_, extra, ..] => {
            eprintln!("terminalx-serve service: unexpected argument {extra:?}\n\n{USAGE}");
            return Ok(2);
        }
    };
    if !matches!(action, "install" | "status" | "uninstall") {
        if matches!(action, "-h" | "--help" | "help") {
            println!("{USAGE}");
            return Ok(0);
        }
        eprintln!("terminalx-serve service: unknown action {action:?}\n\n{USAGE}");
        return Ok(2);
    }
    if !cfg!(any(target_os = "macos", target_os = "linux", windows)) {
        bail!("a user service is set up on Linux (systemd), macOS (launchd) and Windows (Task Scheduler) only");
    }
    let data = super::resolve_data_dir(flag.as_deref())?;
    let home = dirs::home_dir().context("this user has no home directory")?;
    let plan = Plan::new(&super::install_root()?, data, std::env::current_exe().context("find this executable")?);
    match action {
        "install" => install(&home, &plan),
        "status" => status(&home, &plan),
        _ => uninstall(&home, &plan),
    }
}

fn install(home: &Path, plan: &Plan) -> Result<i32> {
    if let Some(logs) = plan.log.parent() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::create_dir_all(logs).with_context(|| format!("create {}", logs.display()))?;
            std::fs::set_permissions(logs, std::fs::Permissions::from_mode(0o700))?;
        }
        #[cfg(windows)]
        crate::win::fs::create_private_dir_all(logs).with_context(|| format!("create {}", logs.display()))?;
    }
    let path = definition_path(home);
    let text = definition(plan);
    let changed = read_definition(&path).ok().as_deref() != Some(text.as_str());
    if let Some(parent) = path.parent() {
        #[cfg(unix)]
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        #[cfg(windows)]
        crate::win::fs::create_private_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    if changed {
        crate::store::write_atomic(&path, &encode_definition(&text)).with_context(|| format!("write {}", path.display()))?;
    }
    // A running service is never restarted here: that would end every agent
    // and terminal it runs. A changed definition applies at its next start.
    #[cfg(windows)]
    let deferred = task::install(&path, changed)?;
    #[cfg(unix)]
    let deferred = if cfg!(target_os = "macos") { launchd::install(&path, changed)? } else { systemd::install(changed)? };
    println!("Installed the TerminalX runtime as a user service ({}).", path.display());
    println!("It starts at boot and runs: {}", plan.arguments().join(" "));
    if deferred {
        println!("The service runs now, so its new definition applies when it next starts (after a reboot), not now: restarting it would stop its agents and terminals.");
    }
    // Installed again over a running runtime (the installer run a second
    // time): the running one is handed over to this version in place, as
    // `update` does, rather than restarted, which would end its agents.
    #[cfg(unix)]
    match super::handover::hand_over(&plan.data, &plan.executable, env!("CARGO_PKG_VERSION")) {
        Ok(super::handover::Outcome::NotRunning | super::handover::Outcome::Current) => {}
        Ok(outcome) => {
            super::handover::report(&outcome, env!("CARGO_PKG_VERSION"));
        }
        Err(error) => eprintln!("warning: the running runtime was not handed over to this version ({error:#}); it runs its old version until it restarts."),
    }
    println!("Other computers may not operate this server until you run `terminalx-serve pair`.");
    Ok(0)
}

fn status(home: &Path, plan: &Plan) -> Result<i32> {
    let path = definition_path(home);
    let Ok(text) = read_definition(&path) else {
        println!("Service    not installed (`terminalx-serve service install` installs it)");
        return Ok(3);
    };
    println!("Service    installed at {}", path.display());
    if !serves(&text, &plan.data) {
        println!("           it runs another data directory than {}", plan.data.display());
    }
    #[cfg(windows)]
    let state = task::state();
    #[cfg(unix)]
    let state = if cfg!(target_os = "macos") { launchd::state() } else { systemd::state() };
    println!("State      {}", state.describe());
    if let Some(boot) = state.boot.as_deref() {
        println!("At boot    {boot}");
    }
    let hosting = hosting(&plan.data);
    println!("Hosting    {}", match hosting {
        Some(true) => "on: paired computers may operate this server",
        Some(false) => "off (`terminalx-serve pair` turns it on)",
        None => "unknown: the settings file cannot be read",
    });
    println!("Data       {}", plan.data.display());
    println!("Log        {}", plan.log.display());
    Ok(if state.running { 0 } else { 3 })
}

fn uninstall(home: &Path, plan: &Plan) -> Result<i32> {
    let path = definition_path(home);
    if !path.exists() {
        println!("No TerminalX service is installed.");
        return Ok(0);
    }
    #[cfg(windows)]
    task::uninstall();
    #[cfg(unix)]
    if cfg!(target_os = "macos") {
        launchd::uninstall();
    } else {
        systemd::uninstall();
    }
    std::fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
    #[cfg(unix)]
    if !cfg!(target_os = "macos") {
        let _ = systemd::systemctl(&["daemon-reload"]);
    }
    println!("Removed the TerminalX service. The data directory {} is kept.", plan.data.display());
    Ok(0)
}

/// `machines.allowOperating` in the settings of `data`.
fn hosting(data: &Path) -> Option<bool> {
    let text = match std::fs::read_to_string(data.join("settings.json")) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(false),
        Err(_) => return None,
    };
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(value["machines"]["allowOperating"].as_bool().unwrap_or(false))
}

/// Start the installed service if it runs the runtime of `data`. `false`
/// when no such service is installed.
pub fn start_for(data: &Path) -> Result<bool> {
    let Some(home) = dirs::home_dir() else { return Ok(false) };
    let path = definition_path(&home);
    let Ok(text) = read_definition(&path) else { return Ok(false) };
    if !serves(&text, data) {
        return Ok(false);
    }
    #[cfg(windows)]
    task::start()?;
    #[cfg(unix)]
    if cfg!(target_os = "macos") {
        launchd::start(&path)?;
    } else {
        systemd::systemctl(&["start", UNIT])?;
    }
    Ok(true)
}

/// Restart the installed service if it runs the runtime of `data`, so it
/// runs the version `current` names again: what an update that failed after
/// its handover does (PRO-354). It ends the process the service runs, and
/// everything that process started. `false` when no such service is
/// installed.
pub fn restart_for(data: &Path) -> Result<bool> {
    let Some(home) = dirs::home_dir() else { return Ok(false) };
    let path = definition_path(&home);
    let Ok(text) = read_definition(&path) else { return Ok(false) };
    if !serves(&text, data) {
        return Ok(false);
    }
    #[cfg(windows)]
    task::restart()?;
    #[cfg(unix)]
    if cfg!(target_os = "macos") {
        launchd::restart(&path)?;
    } else {
        systemd::systemctl(&["restart", UNIT])?;
    }
    Ok(true)
}

/// What the service manager says.
struct State {
    running: bool,
    said: String,
    boot: Option<String>,
}

impl State {
    fn describe(&self) -> String {
        format!("{} ({})", if self.running { "running" } else { "not running" }, self.said)
    }
}

/// A command's output, or why it failed.
fn output(program: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(program).args(args).output().with_context(|| format!("run {program}"))?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        bail!("`{program} {}` failed: {}", args.join(" "), if error.is_empty() { &text } else { &error });
    }
    Ok(text)
}

/// This user's account as Task Scheduler names it: `DOMAIN\\user`.
#[cfg(windows)]
fn user_name() -> Option<String> {
    let user = std::env::var("USERNAME").ok().filter(|name| !name.is_empty())?;
    Some(match std::env::var("USERDOMAIN").ok().filter(|domain| !domain.is_empty()) {
        Some(domain) => format!("{domain}\\{user}"),
        None => user,
    })
}

/// This user's login name.
#[cfg(unix)]
fn user_name() -> Option<String> {
    if let Some(name) = std::env::var("USER").ok().filter(|name| !name.is_empty()) {
        return Some(name);
    }
    // SAFETY: getpwuid returns null or a record valid until the next call;
    // its name is copied before anything else can call it.
    unsafe {
        let record = libc::getpwuid(libc::getuid());
        if record.is_null() || (*record).pw_name.is_null() {
            return None;
        }
        Some(std::ffi::CStr::from_ptr((*record).pw_name).to_string_lossy().into_owned())
    }
}

/// The Task Scheduler task, through `schtasks`, which registers and runs
/// tasks of the calling user's without administrator rights.
#[cfg(windows)]
mod task {
    use super::*;

    fn schtasks(args: &[&str]) -> Result<String> {
        output("schtasks", args)
    }

    fn registered() -> Option<String> {
        schtasks(&["/Query", "/TN", TASK, "/V", "/FO", "LIST"]).ok()
    }

    /// Whether a changed definition waits for the task's next start.
    pub(super) fn install(path: &Path, changed: bool) -> Result<bool> {
        let running = registered().is_some_and(|said| said.lines().any(|line| line.trim_start().starts_with("Status:") && line.contains("Running")));
        if registered().is_none() || changed {
            // /F replaces a registered definition; it does not stop what runs.
            schtasks(&["/Create", "/TN", TASK, "/XML", &path.to_string_lossy(), "/F"])
                .context("Task Scheduler would not register the service")?;
        }
        if !running {
            schtasks(&["/Run", "/TN", TASK])?;
        }
        Ok(running && changed)
    }

    pub(super) fn start() -> Result<()> {
        schtasks(&["/Run", "/TN", TASK]).map(drop)
    }

    /// End the running instance and start it again.
    pub(super) fn restart() -> Result<()> {
        let _ = schtasks(&["/End", "/TN", TASK]);
        schtasks(&["/Run", "/TN", TASK]).map(drop)
    }

    pub(super) fn state() -> State {
        match registered() {
            Some(said) => {
                let field = |name: &str| said.lines().find_map(|line| line.trim().strip_prefix(name).map(|rest| rest.trim().to_string()));
                let status = field("Status:").unwrap_or_else(|| "state unknown".into());
                State {
                    running: status == "Running",
                    said: format!("registered as {TASK}, {status}"),
                    boot: Some("starts when this user logs on; a Windows service would be needed to start before anyone logs on".into()),
                }
            }
            None => State { running: false, said: "not registered".into(), boot: None },
        }
    }

    pub(super) fn uninstall() {
        let _ = schtasks(&["/End", "/TN", TASK]);
        if let Err(error) = schtasks(&["/Delete", "/TN", TASK, "/F"]) {
            log::warn!("remove the service: {error:#}");
        }
    }
}

#[cfg(unix)]
mod systemd {
    use super::*;

    pub(super) fn systemctl(args: &[&str]) -> Result<String> {
        let mut full = vec!["--user"];
        full.extend_from_slice(args);
        output("systemctl", &full)
    }

    fn lingering(user: &str) -> bool {
        output("loginctl", &["show-user", user, "--property=Linger", "--value"]).is_ok_and(|said| said == "yes")
    }

    /// Whether a changed unit waits for the service's next start.
    pub(super) fn install(changed: bool) -> Result<bool> {
        // Without lingering, the user's services start at their first login,
        // not at boot, and stop at their last logout.
        match user_name() {
            Some(user) if !lingering(&user) => {
                if let Err(error) = output("loginctl", &["enable-linger", &user]) {
                    println!("The service starts at boot only while {user} lingers, which needs an administrator ({error:#}). Run:");
                    println!("  sudo loginctl enable-linger {user}");
                }
            }
            Some(_) => {}
            None => println!("Could not tell this user's name to let the service start at boot; run `sudo loginctl enable-linger <user>`."),
        }
        systemctl(&["daemon-reload"]).context("the systemd user manager is not reachable; log in again or run `sudo loginctl enable-linger $USER` first")?;
        systemctl(&["enable", UNIT])?;
        let active = systemctl(&["is-active", UNIT]).is_ok_and(|said| said == "active");
        if !active {
            systemctl(&["start", UNIT])?;
        }
        // Loaded by `daemon-reload`; used from the next start. A restart
        // would kill the unit's whole control group: every agent.
        Ok(active && changed)
    }

    pub(super) fn state() -> State {
        let said = systemctl(&["is-active", UNIT]).unwrap_or_else(|error| error.to_string().rsplit(": ").next().unwrap_or("unknown").to_string());
        let enabled = systemctl(&["is-enabled", UNIT]).unwrap_or_else(|_| "disabled".into());
        let boot = match user_name() {
            Some(user) if enabled == "enabled" && lingering(&user) => "starts at boot (enabled, and the user lingers)".to_string(),
            Some(user) if enabled == "enabled" => format!("starts at login only: run `sudo loginctl enable-linger {user}` to start it at boot"),
            _ => format!("does not start by itself ({enabled})"),
        };
        State { running: said == "active", said, boot: Some(boot) }
    }

    pub(super) fn uninstall() {
        if let Err(error) = systemctl(&["disable", "--now", UNIT]) {
            log::warn!("stop the service: {error:#}");
        }
    }
}

#[cfg(unix)]
mod launchd {
    use super::*;

    fn uid() -> u32 {
        // SAFETY: getuid has no preconditions.
        unsafe { libc::getuid() }
    }

    /// `gui/<uid>` when the user has a login session, else `user/<uid>`,
    /// which a headless Mac reached over SSH has.
    fn domains() -> [String; 2] {
        [format!("gui/{}", uid()), format!("user/{}", uid())]
    }

    fn loaded() -> Option<(String, String)> {
        domains().into_iter().find_map(|domain| output("launchctl", &["print", &format!("{domain}/{LABEL}")]).ok().map(|said| (domain, said)))
    }

    fn bootstrap(path: &Path) -> Result<()> {
        let path = path.to_string_lossy();
        let mut failures = Vec::new();
        for domain in domains() {
            match output("launchctl", &["bootstrap", &domain, &path]) {
                Ok(_) => return Ok(()),
                Err(error) => failures.push(format!("{error:#}")),
            }
        }
        bail!("launchd would not load the service: {}", failures.join("; "))
    }

    /// Whether a changed definition waits for the service's next start.
    pub(super) fn install(path: &Path, changed: bool) -> Result<bool> {
        match loaded() {
            // Booting it out to load the new one would end what it runs; the
            // file is read again at the next login.
            Some(_) => Ok(changed),
            None => bootstrap(path).map(|()| false),
        }
    }

    pub(super) fn start(path: &Path) -> Result<()> {
        match loaded() {
            Some((domain, _)) => output("launchctl", &["kickstart", &format!("{domain}/{LABEL}")]).map(drop),
            None => bootstrap(path),
        }
    }

    /// End the running job and start it again (`kickstart -k`).
    pub(super) fn restart(path: &Path) -> Result<()> {
        match loaded() {
            Some((domain, _)) => output("launchctl", &["kickstart", "-k", &format!("{domain}/{LABEL}")]).map(drop),
            None => bootstrap(path),
        }
    }

    pub(super) fn state() -> State {
        match loaded() {
            Some((domain, said)) => {
                let field = |name: &str| said.lines().find_map(|line| line.trim().strip_prefix(name).map(|rest| rest.trim_start_matches([' ', '=']).trim().to_string()));
                let running = field("state").as_deref() == Some("running");
                let detail = match field("pid") {
                    Some(pid) if running => format!("loaded in {domain}, pid {pid}"),
                    _ => format!("loaded in {domain}, {}", field("state").unwrap_or_else(|| "state unknown".into())),
                };
                State { running, said: detail, boot: Some("starts when this user's launchd domain does (RunAtLoad)".into()) }
            }
            None => State { running: false, said: "not loaded".into(), boot: None },
        }
    }

    pub(super) fn uninstall() {
        if let Some((domain, _)) = loaded() {
            if let Err(error) = output("launchctl", &["bootout", &format!("{domain}/{LABEL}")]) {
                log::warn!("stop the service: {error:#}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> Plan {
        Plan {
            executable: PathBuf::from("/home/sam/.terminalx/current/terminalx-serve"),
            data: PathBuf::from("/home/sam/.terminalx/data"),
            log: PathBuf::from("/home/sam/.terminalx/logs/runtime.log"),
        }
    }

    #[test]
    fn the_service_runs_the_current_install_else_this_binary() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let built = PathBuf::from("/src/target/release/terminalx-serve");
        let plan = Plan::new(root.path(), data.clone(), built.clone());
        assert_eq!(plan.executable, built, "a hand-built binary runs itself");
        assert_eq!(plan.log, root.path().join("logs/runtime.log"));
        std::fs::create_dir_all(root.path().join("versions/0.2.40")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.path().join("versions/0.2.40"), root.path().join("current")).unwrap();
        #[cfg(windows)]
        std::fs::create_dir_all(root.path().join("current")).unwrap();
        let plan = Plan::new(root.path(), data.clone(), built);
        let name = if cfg!(windows) { "terminalx-serve.exe" } else { "terminalx-serve" };
        assert_eq!(plan.executable, root.path().join("current").join(name), "an install runs `current`, so an update swaps it");
        assert_eq!(plan.arguments()[1..], ["--data-dir".to_string(), data.display().to_string(), "--log-file".into(), root.path().join("logs").join("runtime.log").display().to_string()]);
    }

    #[test]
    fn the_systemd_unit_starts_at_boot_and_restarts_only_after_a_failure() {
        let unit = systemd_unit(&plan());
        assert!(unit.contains("ExecStart=\"/home/sam/.terminalx/current/terminalx-serve\" \"--data-dir\" \"/home/sam/.terminalx/data\" \"--log-file\" \"/home/sam/.terminalx/logs/runtime.log\"\n"), "{unit}");
        assert!(unit.contains("Restart=on-failure\n"));
        assert!(unit.contains("WantedBy=default.target\n"));
        assert!(!unit.contains("allowOperating"), "installing never turns hosting on");
        assert!(serves(&unit, Path::new("/home/sam/.terminalx/data")) || !cfg!(target_os = "linux"), "a unit is what Linux reads");
        assert!(!serves(&unit, Path::new("/srv/other")));
    }

    #[test]
    fn odd_paths_stay_literal() {
        assert_eq!(systemd_quote("/home/a b/\"q\"\\%h$HOME"), "\"/home/a b/\\\"q\\\"\\\\%%h$$HOME\"");
        let mut odd = plan();
        odd.data = PathBuf::from("/Users/a&b/<data>");
        let agent = launch_agent(&odd);
        assert!(agent.contains("<string>/Users/a&amp;b/&lt;data&gt;</string>"), "{agent}");
    }

    #[test]
    fn the_launch_agent_runs_at_load_and_is_kept_alive_only_after_a_failure() {
        let agent = launch_agent(&plan());
        assert!(agent.contains(&format!("<key>Label</key>\n\t<string>{LABEL}</string>")));
        assert!(agent.contains("<key>RunAtLoad</key>\n\t<true/>"));
        assert!(agent.contains("<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>"));
        assert!(agent.contains("\t\t<string>/home/sam/.terminalx/current/terminalx-serve</string>\n\t\t<string>--data-dir</string>\n\t\t<string>/home/sam/.terminalx/data</string>\n"));
        if cfg!(target_os = "macos") {
            assert!(serves(&agent, Path::new("/home/sam/.terminalx/data")));
            assert!(!serves(&agent, Path::new("/home/sam/.terminalx/dat")));
        }
        // A well-formed property list.
        if cfg!(target_os = "macos") {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("agent.plist");
            std::fs::write(&path, agent).unwrap();
            assert!(Command::new("plutil").arg("-lint").arg(&path).status().unwrap().success());
        }
    }

    #[test]
    fn the_definition_lives_where_the_service_manager_looks() {
        let path = definition_path(Path::new("/home/sam"));
        if cfg!(windows) {
            assert_eq!(path, Path::new("/home/sam").join(".terminalx").join("service").join("terminalx-runtime.task.xml"));
        } else if cfg!(target_os = "macos") {
            assert_eq!(path, Path::new("/home/sam/Library/LaunchAgents/ai.terminalx.serve.plist"));
        } else if std::env::var_os("XDG_CONFIG_HOME").is_none() {
            assert_eq!(path, Path::new("/home/sam/.config/systemd/user/terminalx.service"));
        }
    }

    #[test]
    fn the_scheduled_task_starts_at_logon_as_this_user_and_restarts_after_a_failure() {
        let plan = Plan {
            executable: PathBuf::from(r"C:\Users\Sam Q\.terminalx\current\terminalx-serve.exe"),
            data: PathBuf::from(r"C:\Users\Sam Q\.terminalx\data"),
            log: PathBuf::from(r"C:\Users\Sam Q\.terminalx\logs\runtime.log"),
        };
        let task = scheduled_task(&plan, r"HOST\sam");
        assert!(task.contains("<LogonTrigger>\n\t\t\t<Enabled>true</Enabled>\n\t\t\t<UserId>HOST\\sam</UserId>"), "{task}");
        assert!(task.contains("<LogonType>InteractiveToken</LogonType>"), "no password is stored");
        assert!(task.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(task.contains("<RestartOnFailure>"));
        assert!(task.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(task.contains(r"<Command>C:\Users\Sam Q\.terminalx\current\terminalx-serve.exe</Command>"));
        assert!(task.contains(r#"<Arguments>--data-dir &quot;C:\Users\Sam Q\.terminalx\data&quot; --log-file &quot;C:\Users\Sam Q\.terminalx\logs\runtime.log&quot;</Arguments>"#), "{task}");
        assert!(!task.contains("allowOperating"), "installing never turns hosting on");
        if cfg!(windows) {
            assert!(serves(&task, Path::new(r"C:\Users\Sam Q\.terminalx\data")));
            assert!(!serves(&task, Path::new(r"C:\Users\Sam Q\.terminalx\dat")));
        }
    }

    #[test]
    fn windows_arguments_read_back_as_they_were() {
        assert_eq!(windows_quote("plain"), "plain");
        assert_eq!(windows_quote(""), "\"\"");
        assert_eq!(windows_quote(r"C:\a b\"), r#""C:\a b\\""#);
        assert_eq!(windows_quote(r#"say "hi""#), r#""say \"hi\"""#);
    }

    #[test]
    fn hosting_is_read_from_the_settings_and_off_without_them() {
        let data = tempfile::tempdir().unwrap();
        assert_eq!(hosting(data.path()), Some(false));
        std::fs::write(data.path().join("settings.json"), r#"{"machines":{"allowOperating":true},"other":1}"#).unwrap();
        assert_eq!(hosting(data.path()), Some(true));
        std::fs::write(data.path().join("settings.json"), "{not json").unwrap();
        assert_eq!(hosting(data.path()), None);
    }

    #[test]
    fn usage_errors_exit_two() {
        let args = |list: &[&str]| list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        assert_eq!(run(&args(&[])), 2);
        assert_eq!(run(&args(&["restart"])), 2);
        assert_eq!(run(&args(&["install", "now"])), 2);
    }
}
