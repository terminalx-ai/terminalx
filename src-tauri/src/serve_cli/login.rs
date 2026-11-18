//! `terminalx-serve login` and `logout`: sign this machine in to the person's
//! TerminalX account with a device code, or out again (PRO-353). The account
//! is what lets a machine register with the relay (PRO-368), so a paired
//! computer reaches it with no inbound port; pairing by code needs none.
//!
//! The session is kept in `<data dir>/account/session.json`, mode 0600
//! (`crate::machine_account`).

use std::path::Path;

use anyhow::{anyhow, Result};

use crate::machine_account::{self, Api, Refused};

const LOGIN_USAGE: &str = "\
Usage: terminalx-serve login [--data-dir <dir>]

Sign this machine in to your TerminalX account. It shows a code to enter at
the address it prints, on any device where you are signed in, and waits until
you approve it there.";

const LOGOUT_USAGE: &str = "\
Usage: terminalx-serve logout [--data-dir <dir>]

Sign this machine out of your TerminalX account. Computers paired by code
keep working over this network and Tailscale.";

/// Run `terminalx-serve login` with the arguments after its name.
pub fn run(args: &[String]) -> i32 {
    command("login", LOGIN_USAGE, args, login)
}

/// Run `terminalx-serve logout` with the arguments after its name.
pub fn run_logout(args: &[String]) -> i32 {
    command("logout", LOGOUT_USAGE, args, logout)
}

fn command(name: &str, usage: &str, args: &[String], act: fn(&Path) -> Result<i32>) -> i32 {
    let result = super::take_data_dir(args).and_then(|(flag, rest)| match rest.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        [] => act(&super::resolve_data_dir(flag.as_deref())?),
        ["-h" | "--help" | "help"] => {
            println!("{usage}");
            Ok(0)
        }
        _ => {
            eprintln!("{usage}");
            Ok(2)
        }
    });
    result.unwrap_or_else(|error| {
        eprintln!("terminalx-serve {name}: {error:#}");
        1
    })
}

fn login(data: &Path) -> Result<i32> {
    machine_account::directory::ensure_no_pending_sign_out(data)?;
    if let Some(session) = machine_account::load(data)? {
        println!("This machine is already signed in as {}.", session.who());
        println!("To use another account, run `terminalx-serve logout` first.");
        return Ok(0);
    }
    let api = Api::new(&machine_account::api_base_url());
    let code = api.device_code(&machine_label(), platform())?;
    println!("To sign this machine in, open this address on any device where you are signed in:");
    println!();
    println!("  {}", code.verification_uri_complete.as_deref().unwrap_or(&code.verification_uri));
    println!();
    println!("and check that it shows the code {}. It works for {} minutes.", code.user_code, code.expires_in.div_ceil(60));
    println!("Waiting for you to approve it...");
    let session = match api.wait_for_session(&code, std::thread::sleep) {
        Ok(session) => session,
        Err(error) => {
            let refused = error.downcast::<Refused>()?;
            eprintln!("Not signed in: {refused}. Run `terminalx-serve login` to try again.");
            return Ok(1);
        }
    };
    machine_account::locked(data, || {
        machine_account::directory::ensure_no_pending_sign_out(data)?;
        if machine_account::load(data)?.is_some() {
            return Err(anyhow!("This machine signed in while the code was pending."));
        }
        machine_account::save(data, &session)
    })?;
    println!("Signed in as {}.", session.who());
    Ok(0)
}

fn logout(data: &Path) -> Result<i32> {
    let api = Api::new(&machine_account::api_base_url());
    let Some(session) = machine_account::directory::sign_out(&api, data)
        .map_err(|error| anyhow!("Could not finish signing out ({error:#}). Run `terminalx-serve logout` to retry."))? else {
        println!("This machine is not signed in.");
        return Ok(0);
    };
    // Forgotten here whatever the service says: a machine that cannot reach
    // it must still be able to sign out. The session then lapses there.
    let told = api.logout(&session);
    println!("Signed out {} on this machine.", session.who());
    if let Err(error) = told {
        eprintln!("warning: the account service was not told ({error:#}); the session ends there when it expires.");
    }
    Ok(0)
}

/// The name the console shows before anyone approves: the machine's name.
fn machine_label() -> String {
    crate::machine_name::recent_computer_name().unwrap_or_else(|| "TerminalX server".into())
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}
