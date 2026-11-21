//! `terminalx bots suggest` (PRO-477). Only a bot suggests, from its own
//! sessions: the bot is the one [`Caller`] places the command in (its session,
//! or a claim its tab's launch secret proves), never one the command names. A
//! paused bot suggests nothing. The owner starts or dismisses a suggestion in
//! the app, on the bot's Home tab.

use serde_json::{json, Value};

use super::{required_string, Caller, ControlError, ControlService};
use crate::store::index;

impl ControlService {
    pub(super) fn bot_suggest(&self, params: Value) -> Result<Value, ControlError> {
        use crate::bots::{self, suggestions, BotError};
        if !bots::enabled() {
            return Err(ControlError::new("bots_off", bots::off_message(), Some("Ask the person to turn Bots on; do not edit settings.json for them.".into())));
        }
        let failed = |error: anyhow::Error| match bots::refusal(&error) {
            Some(BotError::Refused(message)) => ControlError::invalid(message.clone()),
            Some(BotError::NotFound(_)) => ControlError::not_found(format!("{error}")),
            Some(BotError::Off) => ControlError::new("bots_off", bots::off_message(), None::<String>),
            None => ControlError::internal(error),
        };
        let caller = Caller::of(&self.manager, &params);
        caller.refuse_gone()?;
        let own = match (caller.verified_bot(), caller.bot.as_deref()) {
            (Some(own), _) => own,
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
                    "Only a bot makes suggestions, from its own sessions. Give a bot work on its Home tab in TerminalX.",
                    Some("Open the bot in TerminalX.".into()),
                ))
            }
        };
        if params.get("bot").is_some_and(|named| !named.is_null()) {
            return Err(caller.forbidden("suggest for another bot"));
        }
        caller.refuse_while_paused("make suggestions")?;
        let bot = bots::get(&own).map_err(failed)?;
        // Where it was suggested from: a look around's run is counted against that look's limit.
        let entry = caller.session.as_deref().and_then(|session| index::get(session).ok());
        let look = entry.as_ref().and_then(crate::bots::builtins::of_session).filter(|run| run.kind == crate::bots::builtins::Builtin::LookAround);
        let from = suggestions::From {
            kind: if look.is_some() { "lookAround".into() } else { "chat".into() },
            session: caller.session.clone(),
            run: look.as_ref().and_then(|run| run.run.clone()),
            run_number: look.as_ref().and(entry.as_ref()).and_then(|entry| entry.automation.as_ref()).map(|automation| automation.run_number),
            unknown: Default::default(),
        };
        let suggestion = suggestions::suggest(self.sink.as_ref(), &bot, &required_string(&params, "title")?, &required_string(&params, "why")?, from).map_err(failed)?;
        Ok(json!({"bot": bot.id, "suggestion": suggestion, "message": "Suggested. Your owner sees it on your Home tab, and starts it if they want it done."}))
    }
}

#[cfg(test)]
#[path = "control_bot_suggestions_tests.rs"]
mod tests;
