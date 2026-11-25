//! A start that cannot go on says why, in a window of its own, instead of
//! panicking. A release build on Windows has no console, so a panic there
//! was a window that never opened and nothing to say why.

/// What the person is told: which step failed, why, and what to do.
pub fn message(step: &str, error: &str) -> String {
    format!("TerminalX could not {step}.\n\n{error}\n\nFix what this names, then open TerminalX again. If it keeps happening, include this message in a bug report.")
}

/// Log why the start failed, show it, and leave. `error` is written with `{:#}`,
/// so an `anyhow` error carries its whole chain.
pub fn exit(step: &str, error: impl std::fmt::Display) -> ! {
    let text = message(step, &format!("{error:#}"));
    log::error!("{text}");
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("TerminalX could not start")
        .set_description(text)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_message_names_the_step_and_why_it_failed() {
        let error = anyhow::anyhow!("owned by another account").context("open the store under TERMINALX_HOME");
        let text = message("open its browser stores", &format!("{error:#}"));
        assert!(text.starts_with("TerminalX could not open its browser stores.\n\n"), "{text}");
        assert!(text.contains("open the store under TERMINALX_HOME: owned by another account"), "the whole chain: {text}");
        assert!(text.contains("open TerminalX again"), "{text}");
    }
}
