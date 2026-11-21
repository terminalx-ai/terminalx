//! `terminalx bots post` and `terminalx bots reply` (PRO-480). Only a bot
//! posts, from its own sessions: the bot is the one [`Caller`] places the
//! command in, never one the command names. A paused bot posts nothing. What
//! it posts is signed as its own, on its owner's behalf (`bots::channels`).

use serde_json::Value;

use super::{Caller, ControlError, ControlService};

impl ControlService {
    pub(super) fn bot_channels(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        use crate::bots::{self, BotError};
        if !bots::enabled() {
            return Err(ControlError::new("bots_off", bots::OFF_MESSAGE, Some("Ask the person to turn Bots on; do not edit settings.json for them.".into())));
        }
        let failed = |error: anyhow::Error| match bots::refusal(&error) {
            Some(BotError::Refused(message)) => ControlError::invalid(message.clone()),
            Some(BotError::NotFound(_)) => ControlError::not_found(format!("{error}")),
            Some(BotError::Off) => ControlError::new("bots_off", bots::OFF_MESSAGE, None::<String>),
            None => ControlError::internal(error),
        };
        let action = command.trim_start_matches("bots.");
        let caller = Caller::of(&self.manager, &params);
        caller.refuse_gone()?;
        let bot = match (caller.verified_bot(), caller.bot.as_deref()) {
            (Some(own), _) => bots::get(&own).map_err(failed)?,
            (None, Some(_)) => {
                return Err(ControlError::new(
                    "unauthorized",
                    "This command says it runs in a bot's session, but its tab could not prove it.",
                    Some("Run it from the bot's own session as TerminalX started it.".into()),
                ))
            }
            (None, None) => {
                return Err(ControlError::new(
                    "forbidden",
                    "Only a bot posts with `terminalx bots post` and `reply`, from its own sessions, so each post says which bot wrote it. Post as yourself with `gh` or `terminalx issues comment`.",
                    None::<String>,
                ))
            }
        };
        caller.refuse_while_paused("post on GitHub or Linear")?;
        crate::bots::channels::cli(&bot, caller.session.clone(), action, &params).map_err(failed)
    }
}

#[cfg(test)]
#[path = "control_bot_channels_tests.rs"]
mod tests;
