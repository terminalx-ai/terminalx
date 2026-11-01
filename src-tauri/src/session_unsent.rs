//! Prompts no CLI ever took (#663).
//!
//! The app mints a Claude Code conversation's id before the CLI has written a
//! byte, and the CLI makes the conversation's file only once it takes a
//! prompt. A tab whose first prompt never got there still holds the id of a
//! conversation that does not exist, and `--resume` of it exits at once.
//! Codex names its rollout the same way, once a prompt makes one. So a
//! launch whose conversation has no file starts it afresh, and the tab's own
//! log says what that cost:
//!
//! - nothing, when nothing was ever said in it;
//! - the prompts the CLI never took, when its agent never answered. One that
//!   carried another conversation's context in (Continue in New Session) is
//!   the tab's whole brief, and is sent again at once. Any other is offered
//!   back to the reader, as the recovery banner's "Resend last prompt";
//! - the whole conversation, when its agent did answer and its file has gone
//!   since.
//!
//! A fork with no file of its own is made from its parent again, so what its
//! agent answered is still there, in the parent's.

use super::*;

/// A prompt the tab sent, as its log has it.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Sent {
    pub seq: u64,
    pub text: String,
    pub images: Vec<ImageRef>,
}

/// What a tab's log says of one of its conversations.
#[derive(Debug, Default, PartialEq)]
pub(super) struct Said {
    /// Whether its agent ever said anything in it.
    pub answered: bool,
    /// The prompts sent since its agent last said anything, oldest first.
    pub since: Vec<Sent>,
}

/// What a launch whose conversation has no file has to do about it.
#[derive(Debug, PartialEq)]
pub(super) enum Restart {
    /// Its agent answered in it once, and its file has gone since.
    Lost,
    /// The CLI never took the prompt that briefs the tab: it is sent again.
    Resend(Sent),
    /// The CLI never took the reader's prompts. The last is offered again.
    Unsent(Sent),
}

/// What the app writes into a conversation itself. None of it says a CLI
/// ever had the conversation; anything else there came from its agent.
fn the_apps_own(payload: &Value) -> bool {
    match payload["type"].as_str() {
        Some("status" | "recovery" | "error" | "settings_changed") => true,
        // A CLI that exits with a turn open has the turn closed for it.
        Some("turn_completed") => payload["status"].as_str() != Some("ok"),
        _ => false,
    }
}

/// One of a tab's conversations, read from the tab's log. `conversation` is
/// the marker its events come under, absent for the one the tab began with.
/// Only a launch that finds no file reads this, so the cost of reading a
/// long log is paid only when something has already gone wrong.
pub(super) fn said_in(log: &Path, conversation: Option<&str>) -> Said {
    use std::io::BufRead;
    let mut said = Said::default();
    let Ok(file) = std::fs::File::open(log) else { return said };
    let mut under: Option<String> = None;
    for line in std::io::BufReader::new(file).lines().map_while(std::result::Result::ok) {
        let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
        let payload = &event["payload"];
        if payload["type"] == "conversation" {
            under = payload["id"].as_str().map(String::from);
            continue;
        }
        if under.as_deref() != conversation {
            continue;
        }
        let subagent = !event["subagent"].is_null();
        match event["seq"].as_u64() {
            Some(seq) if payload["type"] == "user_message" && !subagent => said.since.push(Sent {
                seq,
                text: payload["text"].as_str().unwrap_or_default().to_string(),
                images: serde_json::from_value(payload["images"].clone()).unwrap_or_default(),
            }),
            _ if subagent || !the_apps_own(payload) => {
                said.answered = true;
                said.since.clear();
            }
            _ => {}
        }
    }
    said
}

/// What a launch does about a conversation with no file. `its_own` is
/// whether what its agent answered would have been in that file: not so for
/// a fork made again from its parent, nor for a Codex tab that never had a
/// rollout and holds a forked log. `continuation` is the tab's.
pub(super) fn restart(said: Said, continuation: Option<u64>, its_own: bool) -> Option<Restart> {
    if said.answered && its_own {
        return Some(Restart::Lost);
    }
    let mut since = said.since;
    // Prompts sent after the brief, while it went unanswered, were sent to an
    // agent that had not read it: the brief is what goes again.
    if let Some(at) = continuation.and_then(|seq| since.iter().position(|sent| sent.seq == seq)) {
        return Some(Restart::Resend(since.swap_remove(at)));
    }
    since.pop().map(Restart::Unsent)
}

/// An image the reader sent, read back from where it was archived, to be
/// sent again as it was.
fn image_input(image: &ImageRef) -> Result<ImageInput> {
    use base64::Engine as _;
    let bytes = std::fs::read(&image.url).with_context(|| format!("An image in that prompt is no longer on this machine ({}).", image.name.as_deref().unwrap_or("unnamed")))?;
    Ok(ImageInput {
        media_type: image.media_type.clone().unwrap_or_else(|| "image/png".into()),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        name: image.name.clone(),
    })
}

impl SessionManager {
    /// Say what a launch found, and act on it. Run once the CLI is in the
    /// tab, so a prompt sent again is typed into it. `prompting` is whether a
    /// prompt of the reader's is about to follow this launch: the banner
    /// would only be gone again the moment it is.
    pub(super) fn restarted(&self, rt: &mut TabRuntime, rt_arc: &Arc<Mutex<TabRuntime>>, restart: Restart, prompting: bool) {
        let agent = agent_name(&rt.harness);
        match restart {
            Restart::Lost => {
                let text = format!("The previous {agent} conversation is no longer on this machine; starting a new one.");
                self.publish(rt, Payload::Status { text }, None);
            }
            Restart::Resend(sent) => {
                let text = format!("{agent} never received the context carried over from the earlier conversation; sending it again.");
                self.publish(rt, Payload::Status { text }, None);
                self.redeliver(rt, rt_arc, sent);
            }
            Restart::Unsent(_) if prompting => {
                let text = format!("{agent} never received your earlier prompt, so its conversation starts with this one.");
                self.publish(rt, Payload::Status { text }, None);
            }
            // Said when the CLI was last started, or when the tab was opened
            // (`load_events`), and still standing.
            Restart::Unsent(_) if rt.recovery == Some(RecoveryKind::Unsent) => {}
            Restart::Unsent(_) => self.needs_recovery(rt, RecoveryKind::Unsent),
        }
    }

    /// Type a prompt the chat already has into the CLI again, as the prompt
    /// it was: no second message is published, and the CLI's record of it is
    /// that message's echo. Delivery is held to the same proof as any
    /// composer prompt's.
    fn redeliver(&self, rt: &mut TabRuntime, rt_arc: &Arc<Mutex<TabRuntime>>, sent: Sent) {
        let Engine::Cli(p) = &rt.engine else { return };
        let (pane, ready) = (p.pane_id.clone(), p.ready.clone());
        let queued = rt.turn_open && !rt.turn_by_command;
        let echo = ComposerEcho { queued, seq: sent.seq, ..ComposerEcho::new(sent.text.clone(), sent.images.len()) };
        self.await_composer_echo(rt, echo, &sent.text);
        let attachments = sent.images.iter().map(|image| image.url.clone()).collect();
        self.type_prompt(rt_arc, &pane, sent.text, attachments, PromptDelivery { ready: Some(ready), seq: Some(sent.seq), queued, ..Default::default() });
    }

    /// "Resend last prompt": the last prompt the tab's agent never answered,
    /// sent again as the reader sent it, images and all. Experimental Codex
    /// sends nothing again by itself, so its unanswered brief (Continue in New
    /// Session) goes first, as a PTY launch would send it.
    pub fn resend_unsent(&self, session_id: &str, tab_id: &str) -> Result<SendOutcome> {
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).ok_or_else(|| anyhow!("tab not found"))?;
        let log = store::log_path(session_id, tab_id)?;
        let mut said = said_in(&log, tab.follow.conversation.as_deref());
        let last = if codex_stdio::selected(tab) {
            match restart(said, tab.continuation, false) {
                Some(Restart::Resend(sent) | Restart::Unsent(sent)) => Some(sent),
                _ => None,
            }
        } else { said.since.pop() };
        let last = last.ok_or_else(|| anyhow!("There is no unanswered prompt to send again."))?;
        let images = last.images.iter().map(image_input).collect::<Result<Vec<_>>>()?;
        self.send(session_id, tab_id, last.text, images)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(seq: u64, payload: Value) -> String {
        format!("{}\n", serde_json::json!({ "id": format!("e{seq}"), "sessionId": "s", "tabId": "t", "harness": "claude", "seq": seq, "ts": "2026-10-29T06:13:46Z", "payload": payload }))
    }

    fn prompt(seq: u64, text: &str) -> String {
        line(seq, serde_json::json!({ "type": "user_message", "text": text, "queued": false }))
    }

    fn sent(seq: u64, text: &str) -> Sent {
        Sent { seq, text: text.into(), images: Vec::new() }
    }

    fn log(lines: &[String]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tab.jsonl");
        std::fs::write(&path, lines.concat()).unwrap();
        (dir, path)
    }

    /// The tab #663 was found on, as its log had it: a handoff written and
    /// never submitted, a prompt queued behind it, hours of warnings, and
    /// "continue" sent to a CLI that exited at once.
    #[test]
    fn a_conversation_its_agent_never_answered_is_the_prompts_it_was_sent() {
        let (_dir, path) = log(&[
            prompt(1, "Continue work from the prior TerminalX conversation using the context below."),
            line(2, serde_json::json!({ "type": "user_message", "text": "yo", "queued": true })),
            line(3, serde_json::json!({ "type": "recovery", "kind": "delivery_unconfirmed" })),
            line(4, serde_json::json!({ "type": "recovery", "kind": null })),
            prompt(35, "continue"),
            line(37, serde_json::json!({ "type": "turn_completed", "status": "aborted", "durationMs": 1433 })),
            line(38, serde_json::json!({ "type": "status", "text": "Claude Code exited." })),
        ]);
        let said = said_in(&path, None);
        assert!(!said.answered);
        assert_eq!(said.since.iter().map(|sent| sent.seq).collect::<Vec<_>>(), [1, 2, 35]);
        assert_eq!(said.since[1].text, "yo");

        // The brief goes again; what was sent while it went unread does not.
        let restart_of = |continuation| restart(said_in(&path, None), continuation, true);
        assert!(matches!(restart_of(Some(1)), Some(Restart::Resend(sent)) if sent.seq == 1 && sent.text.starts_with("Continue work")));
        // With no brief, the reader's last prompt is the one offered again.
        assert_eq!(restart_of(None), Some(Restart::Unsent(sent(35, "continue"))));
        // A continuation that is not among them was taken long ago.
        assert_eq!(restart_of(Some(99)), Some(Restart::Unsent(sent(35, "continue"))));
    }

    #[test]
    fn an_answered_conversation_with_no_file_is_lost_unless_its_answers_are_elsewhere() {
        let (_dir, path) = log(&[
            prompt(1, "first"),
            line(2, serde_json::json!({ "type": "assistant_text", "text": "done" })),
            line(3, serde_json::json!({ "type": "turn_completed", "status": "ok", "durationMs": 10 })),
            prompt(4, "and then"),
        ]);
        let said = said_in(&path, None);
        assert!(said.answered);
        assert_eq!(said.since, [sent(4, "and then")]);
        // Its file had all of it.
        assert_eq!(restart(said_in(&path, None), Some(1), true), Some(Restart::Lost));
        // A fork made again from its parent still has what was answered; only
        // what was sent since is missing.
        assert_eq!(restart(said_in(&path, None), Some(1), false), Some(Restart::Unsent(sent(4, "and then"))));
    }

    #[test]
    fn nothing_said_is_nothing_lost() {
        let (_dir, path) = log(&[line(1, serde_json::json!({ "type": "status", "text": "Codex could not install its hooks here." }))]);
        assert_eq!(restart(said_in(&path, None), None, true), None);
        assert_eq!(restart(said_in(&path.with_file_name("missing.jsonl"), None), None, true), None);
        // A fork's copied history, answered, with nothing sent since.
        let (_dir, forked) = log(&[prompt(1, "first"), line(2, serde_json::json!({ "type": "assistant_text", "text": "done" }))]);
        assert_eq!(restart(said_in(&forked, None), None, false), None);
    }

    /// A tab holds every conversation it had, one after another, each under
    /// its own marker (#437); only the one asked about counts.
    #[test]
    fn only_the_conversation_asked_about_is_read() {
        let (_dir, path) = log(&[
            prompt(1, "to the first"),
            line(2, serde_json::json!({ "type": "assistant_text", "text": "answered" })),
            line(3, serde_json::json!({ "type": "conversation", "id": "second", "harness": "claude", "resumed": false })),
            prompt(4, "to the second"),
            line(5, serde_json::json!({ "type": "conversation", "id": null, "harness": "claude", "resumed": true })),
            prompt(6, "to the first again"),
            line(7, serde_json::json!({ "type": "conversation", "id": "second", "harness": "claude", "resumed": true })),
            line(8, serde_json::json!({ "type": "tool_call_started", "callId": "c", "name": "Bash", "toolType": "shell", "input": {} })),
            prompt(9, "after its tool"),
        ]);
        let first = said_in(&path, None);
        assert!(first.answered);
        assert_eq!(first.since, [sent(6, "to the first again")]);
        let second = said_in(&path, Some("second"));
        assert!(second.answered, "its agent ran a tool");
        assert_eq!(second.since, [sent(9, "after its tool")]);
    }

    #[test]
    fn a_subagent_s_words_are_the_agent_s() {
        let subagent = format!("{}\n", serde_json::json!({ "id": "e2", "sessionId": "s", "tabId": "t", "harness": "claude", "seq": 2, "ts": "t", "subagent": { "id": "a", "kind": "task" }, "payload": { "type": "user_message", "text": "a task's prompt" } }));
        let (_dir, path) = log(&[prompt(1, "go"), subagent]);
        let said = said_in(&path, None);
        assert!(said.answered && said.since.is_empty(), "{said:?}");
    }

    #[test]
    fn a_prompt_s_images_are_kept_to_be_sent_again() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("shot.png");
        std::fs::write(&image, b"\x89PNG fixture").unwrap();
        let (_log_dir, path) = log(&[line(1, serde_json::json!({ "type": "user_message", "text": "look", "queued": false, "images": [{ "url": image, "mediaType": "image/png", "name": "shot.png" }] }))]);
        let said = said_in(&path, None);
        let input = image_input(&said.since[0].images[0]).unwrap();
        assert_eq!((input.media_type.as_str(), input.name.as_deref()), ("image/png", Some("shot.png")));
        use base64::Engine as _;
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(input.data).unwrap(), b"\x89PNG fixture");
        std::fs::remove_file(&image).unwrap();
        assert!(image_input(&said.since[0].images[0]).unwrap_err().to_string().contains("shot.png"));
    }
}
