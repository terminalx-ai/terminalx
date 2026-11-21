//! `terminalx bots handoff`, `terminalx bots tell` and `terminalx bots
//! handoffs` (PRO-475). Only a bot hands work on or tells another bot, from
//! its own sessions: the bot is the one [`Caller`] places the command in (its
//! session, or a claim its tab's launch secret proves), never one the command
//! names. A paused bot sends nothing. The owner hands an item on and stops a
//! hand-off in the app; their terminal reads a bot's hand-offs with `--bot`.

use serde_json::Value;

use super::{optional_string, Caller, ControlError, ControlService};

impl ControlService {
    pub(super) fn bot_handoffs(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        use crate::bots::{self, BotError, Named};
        if !bots::enabled() {
            return Err(ControlError::new("bots_off", bots::off_message(), Some("Ask the person to turn Bots on; do not edit settings.json for them.".into())));
        }
        let failed = |error: anyhow::Error| match bots::refusal(&error) {
            Some(BotError::Refused(message)) => ControlError::invalid(message.clone()),
            Some(BotError::NotFound(_)) => ControlError::not_found(format!("{error}")),
            Some(BotError::Off) => ControlError::new("bots_off", bots::off_message(), None::<String>),
            None => ControlError::internal(error),
        };
        let action = command.trim_start_matches("bots.");
        let reads = action == "handoffs";
        let caller = Caller::of(&self.manager, &params);
        caller.refuse_gone()?;
        let named = match optional_string(&params, "bot") {
            Some(selector) => Some(match bots::named(&selector).map_err(failed)? {
                Named::One(bot) => *bot,
                Named::Several => return Err(ControlError::new("ambiguous_selector", bots::several_named(&selector), Some("Use the id from `terminalx bots list --json`.".into()))),
                Named::Nobody => return Err(ControlError::not_found(bots::nobody_named(&selector))),
            }),
            None => None,
        };
        let bot = match (caller.verified_bot(), caller.bot.as_deref(), named) {
            // Held to its own bot, whatever it names.
            (Some(own), _, Some(bot)) if bot.id != own => return Err(caller.forbidden("read another bot's hand-offs, or hand work on as another bot")),
            (Some(own), _, _) => bots::get(&own).map_err(failed)?,
            (None, Some(_), _) => {
                return Err(ControlError::new(
                    "unauthorized",
                    "This command says it runs in a bot's session, but its tab could not prove it.",
                    Some("Run it from the bot's own session as TerminalX started it.".into()),
                ))
            }
            (None, None, Some(bot)) if reads => bot,
            (None, None, _) if !reads => {
                return Err(ControlError::new(
                    "forbidden",
                    "Only a bot hands work to another bot or tells it something, from its own sessions. To hand a bot's item to another bot, use Hand to another bot on the item's page in TerminalX.",
                    Some("Open the bot in TerminalX.".into()),
                ))
            }
            (None, None, _) => return Err(ControlError::invalid("Name the bot with --bot BOT, or run this from one of the bot's sessions.")),
        };
        if !reads {
            caller.refuse_while_paused("hand work to other bots or send them messages")?;
        }
        crate::bots::handoffs::cli(&self.manager, &bot, caller.session.clone(), action, &params).map_err(failed)
    }
}

#[cfg(test)]
#[path = "control_bot_handoffs_tests.rs"]
mod tests;
