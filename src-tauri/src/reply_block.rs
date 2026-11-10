//! A fenced block in an agent's reply, and the reply it is read from.
//!
//! An agent that hands something over ends its reply with JSON in a fenced
//! code block with a label of ours: the pipeline's `terminalx-status` and
//! `terminalx-review` (`issue_pipeline::verdict`) and a worker's
//! `terminalx-report` (`worker_report`). All of them are found the same way,
//! here, so a reply stays readable in the chat and nothing is guessed from
//! prose.

use serde_json::Value;

use crate::events::{AgentEvent, Payload};

/// The body of the last fenced block labelled `label`. A fence opens and
/// closes on a line of its own, so backticks inside the JSON (a finding that
/// quotes code) do not end the block, and a block shown inside another fenced
/// block, as when instructions are quoted back, is not a report.
pub(crate) fn last_block(text: &str, label: &str) -> Option<String> {
    enum Inside<'a> {
        Nothing,
        /// A block of ours, with its lines so far.
        Labelled(Vec<&'a str>),
        Other,
    }
    let mut found = None;
    let mut inside = Inside::Nothing;
    for line in text.lines() {
        let trimmed = line.trim();
        inside = match inside {
            Inside::Nothing => match trimmed.strip_prefix("```") {
                Some(info) if info.trim().eq_ignore_ascii_case(label) => Inside::Labelled(Vec::new()),
                Some(_) => Inside::Other,
                None => Inside::Nothing,
            },
            Inside::Labelled(lines) if trimmed == "```" => {
                found = Some(lines.join("\n"));
                Inside::Nothing
            }
            Inside::Labelled(mut lines) => {
                lines.push(line);
                Inside::Labelled(lines)
            }
            Inside::Other if trimmed == "```" => Inside::Nothing,
            Inside::Other => Inside::Other,
        };
    }
    found
}

/// The first of `names` the block gives as text; nothing when that is blank.
pub(crate) fn text_field(value: &Value, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| value.get(name).and_then(Value::as_str)).map(str::trim).filter(|text| !text.is_empty()).map(String::from)
}

/// What the tab said in the turn that ends at `events[end]`: the turn's final
/// text, else its last message, with the sequence number of the event that
/// holds it. A subagent's messages are not the tab's.
pub(crate) fn turn_reply(events: &[AgentEvent], end: usize) -> Option<(u64, String)> {
    if let Payload::TurnCompleted { final_text: Some(text), .. } = &events.get(end)?.payload {
        if !text.trim().is_empty() {
            return Some((events[end].seq, text.clone()));
        }
    }
    events[..end]
        .iter()
        .rev()
        .take_while(|event| !matches!(event.payload, Payload::TurnStarted { .. }) && !(event.subagent.is_none() && matches!(event.payload, Payload::TurnCompleted { .. })))
        .find_map(|event| match &event.payload {
            Payload::AssistantText { text, .. } if event.subagent.is_none() && !text.trim().is_empty() => Some((event.seq, text.clone())),
            _ => None,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_block_of_a_label_is_read_whole_and_only_at_the_top_level() {
        let reply = "First.\n\n```terminalx-report\n{\"a\":1}\n```\n\nThen.\n\n```terminalx-report\n{\n  \"a\": \"uses ```js inline\"\n}\n```\n";
        assert_eq!(last_block(reply, "terminalx-report").as_deref(), Some("{\n  \"a\": \"uses ```js inline\"\n}"));
        // Another label's block, an unterminated one and one quoted inside another fence are not it.
        assert_eq!(last_block(reply, "terminalx-status"), None);
        assert_eq!(last_block("```terminalx-report\n{\"a\":1}", "terminalx-report"), None);
        assert_eq!(last_block("```text\n```terminalx-report\n{}\n```\n```", "terminalx-report"), None);
        assert_eq!(last_block("  ```TerminalX-Report  \n{}\n  ```  ", "terminalx-report").as_deref(), Some("{}"));
    }

    #[test]
    fn a_text_field_is_the_first_name_given_and_never_blank() {
        let value = serde_json::json!({"reason": "  ", "summary": " why ", "count": 3});
        assert_eq!(text_field(&value, &["summary"]).as_deref(), Some("why"));
        assert_eq!(text_field(&value, &["reason"]), None);
        assert_eq!(text_field(&value, &["count", "missing"]), None);
    }
}
