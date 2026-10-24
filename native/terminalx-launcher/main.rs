//! Bundled CLI entry point. exec preserves process identity, streams, environment,
//! working directory, signals and the CLI's exit status without a shell layer.
use std::os::unix::process::CommandExt;
use std::{env, process::Command};

fn main() {
    let sibling = match env::current_exe().and_then(|path| path.canonicalize()) {
        Ok(path) => path.with_file_name("raccoon"),
        Err(error) => {
            eprintln!("terminalx: cannot locate launcher: {error}");
            std::process::exit(126);
        }
    };
    let error = Command::new(sibling)
        .arg("terminalx")
        .args(env::args_os().skip(1))
        .exec();
    eprintln!("terminalx: cannot execute sibling raccoon: {error}");
    std::process::exit(if error.kind() == std::io::ErrorKind::NotFound {
        127
    } else {
        126
    });
}
