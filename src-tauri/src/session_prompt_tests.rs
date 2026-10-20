//! Whose prompt it is, and how many times the chat is told (#250).
//!
//! A prompt reaches a PTY-first tab one of two ways. The composer publishes
//! what it sends and then types it; the CLI's own record of it arrives later
//! and must not be drawn again. A prompt typed straight into the terminal
//! view never touches the composer, so the CLI's record is the only one
//! there will ever be and must be drawn. Either way the chat gets exactly one
//! `user_message`, ahead of the reply to it.
//!
//! Every test runs against both CLIs, each writing its own record shapes:
//! Claude Code's as of 2.1.287, Codex's as of 0.153.4.
use super::*;

const BOTH: [CliKind; 2] = [CliKind::Claude, CliKind::Codex];

/// What each CLI writes into its transcript, cut down to what the decoders
/// read. Escape prompt text so fixtures can include paste tags and newlines.
struct Cli(CliKind);

impl Cli {
    /// A prompt the CLI took while idle: the start of a turn.
    fn prompt(&self, text: &str) -> String {
        let encoded = serde_json::to_string(text).unwrap();
        let escaped = &encoded[1..encoded.len() - 1];
        match self.0 {
            CliKind::Claude => format!(
                r#"{{"parentUuid":null,"isSidechain":false,"type":"user","uuid":"u-{escaped}","userType":"external","cwd":"/w","sessionId":"s","origin":{{"kind":"human"}},"message":{{"role":"user","content":"{escaped}"}}}}
"#
            ),
            CliKind::Codex => format!(
                r#"{{"type":"event_msg","payload":{{"type":"task_started","turn_id":"t-{escaped}"}}}}
{}"#,
                self.steer(text)
            ),
        }
    }

    /// A prompt the CLI took while a turn was running. Codex writes the same
    /// item it writes for any prompt; Claude Code writes an attachment and no
    /// `user` record at all.
    fn steer(&self, text: &str) -> String {
        let encoded = serde_json::to_string(text).unwrap();
        let escaped = &encoded[1..encoded.len() - 1];
        match self.0 {
            CliKind::Claude => format!(
                r#"{{"parentUuid":"a","isSidechain":false,"attachment":{{"type":"queued_command","prompt":"{escaped}","source_uuid":"s-{escaped}","commandMode":"prompt","origin":{{"kind":"human"}},"humanTurn":true}},"type":"attachment","uuid":"q-{escaped}","userType":"external","cwd":"/w","sessionId":"s"}}
"#
            ),
            CliKind::Codex => format!(
                r#"{{"type":"event_msg","payload":{{"type":"item_completed","item":{{"type":"UserMessage","id":"user-{escaped}","content":[{{"type":"text","text":"{escaped}","text_elements":[]}}]}}}}}}
"#
            ),
        }
    }

    fn reply(&self, text: &str) -> String {
        match self.0 {
            CliKind::Claude => format!(
                r#"{{"parentUuid":"u","isSidechain":false,"type":"assistant","uuid":"a-{text}","cwd":"/w","sessionId":"s","message":{{"id":"m-{text}","role":"assistant","content":[{{"type":"text","text":"{text}"}}]}}}}
"#
            ),
            CliKind::Codex => format!(
                r#"{{"type":"event_msg","payload":{{"type":"item_completed","item":{{"type":"AgentMessage","id":"assistant-{text}","content":[{{"type":"Text","text":"{text}"}}],"phase":"final_answer"}}}}}}
"#
            ),
        }
    }

    /// How each CLI labels a pasted image in the prompt it records.
    fn with_image(&self, text: &str) -> String {
        match self.0 {
            CliKind::Claude => format!("[Image #1]{text}"),
            CliKind::Codex => format!("[Image #1] {text}"),
        }
    }
}

impl Rig {
    fn compose_confirmed(&self, text: &str) -> std::sync::mpsc::Receiver<std::result::Result<(), String>> {
        let (tx, rx) = std::sync::mpsc::channel();
        let prompt = PromptText { shared_connection: None, author: None, agent: text.into(), display: text.into() };
        self.manager.record_composer_prompt(&mut self.rt.lock().unwrap(), &prompt, Vec::new(), self._dir.path().to_str().unwrap(), Some(tx));
        rx
    }

    fn submitted(&self) {
        if let Engine::Cli(p) = &mut self.rt.lock().unwrap().engine {
            p.echoed.back_mut().unwrap().submitted = true;
        }
    }

    /// The production decision after the readiness wait gives up. No clock
    /// sleep or real CLI is needed to exercise the timed-out send path.
    fn readiness_times_out(&self) {
        assert!(self.manager.prepare_prompt(&mut self.rt.lock().unwrap(), Readiness::TimedOut, None));
        self.stamp();
    }

    fn delivery_pending(&self) -> bool {
        matches!(&self.rt.lock().unwrap().engine, Engine::Cli(p) if p.awaiting_delivery.is_some())
    }

    fn cli(&self) -> Cli {
        match &self.rt.lock().unwrap().engine {
            Engine::Cli(p) => Cli(p.harness),
            _ => unreachable!("the rig's tab is a CLI"),
        }
    }

    /// The composer's half of a send: everything `send` does short of
    /// starting the CLI and typing. Says whether the prompt was queued.
    fn compose(&self, text: &str, images: usize) -> bool {
        let prompt = PromptText { shared_connection: None, author: None, agent: text.into(), display: text.into() };
        let images = (0..images).map(|i| ImageRef { url: format!("attachments/s/{i}.png"), media_type: Some("image/png".into()), name: None }).collect();
        let cwd = self._dir.path().to_string_lossy().into_owned();
        let queued = self.manager.record_composer_prompt(&mut self.rt.lock().unwrap(), &prompt, images, &cwd, None).1;
        self.stamp();
        queued
    }

    /// The CLI takes a prompt, however it got there, and replies to it.
    fn cli_takes(&self, prompt: &str) {
        self.hook("UserPromptSubmit", json!({ "prompt": prompt }));
        self.append(&self.cli().prompt(prompt));
    }

    fn cli_replies(&self, reply: &str) {
        self.append(&self.cli().reply(reply));
        self.hook("Stop", json!({ "last_assistant_message": reply }));
    }

    /// The conversation as the chat is told it: every prompt, reply and turn
    /// end, and each queued prompt the CLI took mid-turn, in the order they
    /// were published.
    fn told(&self) -> Vec<String> {
        let events = self.events();
        events
            .iter()
            .filter_map(|e| match &e.payload {
                Payload::UserMessage { text, queued: false, .. } => Some(format!("user: {text}")),
                Payload::UserMessage { text, queued: true, .. } => Some(format!("queued: {text}")),
                Payload::PromptAbsorbed { prompt_seq } => Some(format!("taken: {}", queued_text(&events, *prompt_seq))),
                Payload::AssistantText { text, .. } => Some(format!("reply: {text}")),
                Payload::TurnCompleted { .. } => Some("end".to_string()),
                _ => None,
            })
            .collect()
    }

    /// The composer `seq`s of the prompts the tab would type again for a
    /// "Send now".
    fn held(&self) -> Vec<u64> {
        match &self.rt.lock().unwrap().engine {
            Engine::Cli(p) => p.held.iter().map(|(seq, _)| *seq).collect(),
            _ => Vec::new(),
        }
    }

    /// The `seq` of the queued message the reader sent as `text`.
    fn queued_seq(&self, text: &str) -> u64 {
        self.events()
            .iter()
            .find(|e| matches!(&e.payload, Payload::UserMessage { text: sent, queued: true, .. } if sent == text))
            .unwrap_or_else(|| panic!("no queued message {text:?}"))
            .seq
    }
}

/// The text of the queued message published under `seq`.
fn queued_text(events: &[AgentEvent], seq: u64) -> String {
    events
        .iter()
        .find(|e| e.seq == seq)
        .and_then(|e| match &e.payload {
            Payload::UserMessage { text, queued: true, .. } => Some(text.clone()),
            _ => None,
        })
        .unwrap_or_else(|| format!("no queued message at {seq}"))
}

#[test]
fn revoked_sharing_cancels_the_waiting_writer_without_stalling_the_host_tab() {
    let rig = Rig::new();
    rig.compose("Undelivered guest input", 0);
    let (ready, seq) = {
        let rt = rig.rt.lock().unwrap();
        let Engine::Cli(cli) = &rt.engine else { unreachable!() };
        (cli.ready.clone(), cli.awaiting_delivery.unwrap())
    };
    // No share survives: this is the delayed writer after the kill switch.
    let permit = crate::local_sharing::WritePermit { connection_id: "removed".into(), revision: 0, tab_epoch: 0 };
    rig.manager.type_prompt(&rig.rt, &rig.pane, "Undelivered guest input".into(), vec![], PromptDelivery {
        ready: Some(ready), seq: Some(seq), queued: false, receipt: None, shared: Some((permit, SESSION.into(), TAB.into(), seq)),
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    while rig.delivery_pending() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(5)); }
    let writer = rig.manager.writers.lock().unwrap().get(&rig.pane).unwrap().clone();
    let _finished = writer.lock().unwrap();
    let rt = rig.rt.lock().unwrap();
    assert!(!rt.turn_open);
    assert_eq!(rt.status, TabStatus::Idle);
    assert!(rt.recovery.is_none());
    assert!(matches!(&rt.engine, Engine::Cli(cli) if cli.awaiting_delivery.is_none() && cli.echoed.is_empty()));
}

#[test]
fn timed_out_readiness_then_delivery_never_publishes_a_startup_warning() {
    for kind in BOTH {
        for hook_first in [false, true] {
            let rig = Rig::of(kind, "");
            rig.compose("implement the change", 0);
            rig.readiness_times_out();
            assert!(rig.delivery_pending());
            assert_eq!(rig.kinds(), ["user_message"]);
            if hook_first {
                rig.hook("UserPromptSubmit", json!({ "prompt": "implement the change" }));
                assert!(!rig.delivery_pending(), "a turn hook confirms delivery without waiting for the file");
            }
            let record = match kind {
                CliKind::Claude => rig.cli().prompt("implement the change"),
                CliKind::Codex => rig.cli().steer("implement the change"),
            };
            rig.append(&record);
            assert!(!rig.delivery_pending(), "{kind:?}: the matching transcript prompt confirms delivery");
            rig.append(&rig.cli().reply("working on it"));
            for _ in 0..6 {
                rig.advance(PATIENCE.stall / 2);
                rig.pane_draws();
                rig.tick();
            }
            assert_eq!(rig.status(), TabStatus::InProgress);
            assert_eq!(rig.banner(), None);
            assert_eq!(rig.told(), ["user: implement the change", "reply: working on it"]);
            assert!(!rig.kinds().iter().any(|k| k == "status" || k == "recovery"));
        }
    }
}

#[test]
fn timed_out_readiness_with_only_live_terminal_activity_never_warns() {
    let rig = Rig::of(CliKind::Codex, "");
    rig.compose("a long task", 0);
    rig.readiness_times_out();
    // Even with hooks and transcript unavailable, terminal activity is
    // enough to withhold a delivery doubt or timeout.
    for _ in 0..6 {
        rig.advance(PATIENCE.stall / 2);
        rig.pane_draws();
        rig.tick();
    }
    assert_eq!(rig.status(), TabStatus::InProgress);
    assert_eq!(rig.kinds(), ["user_message"]);
}

#[test]
fn an_unconfirmed_prompt_gets_one_recoverable_warning_and_late_evidence_clears_it() {
    for evidence in ["echo", "hook", "session", "reply", "task", "reasoning", "terminal"] {
        let rig = Rig::of(CliKind::Codex, "");
        rig.compose("a missed prompt", 0);
        rig.readiness_times_out();
        rig.advance(PATIENCE.stall - MOMENT);
        rig.tick();
        assert_eq!(rig.banner(), None);
        rig.advance(MOMENT);
        rig.tick();
        rig.tick();
        assert_eq!(rig.banner(), Some(RecoveryKind::DeliveryUnconfirmed));
        assert_eq!(rig.status(), TabStatus::Waiting);
        assert_eq!(rig.kinds(), ["user_message", "recovery"], "one message, with no timeout alongside it");
        match evidence {
            "echo" => rig.append(&rig.cli().steer("a missed prompt")),
            "hook" => rig.hook("PostToolUse", json!({})),
            "session" => rig.hook("SessionStart", json!({})),
            "reply" => rig.append(&rig.cli().reply("got it")),
            "task" => rig.append("{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"t\"}}\n"),
            "reasoning" => rig.append("{\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"item\":{\"type\":\"Reasoning\",\"id\":\"r\",\"summary_text\":[\"Thinking about the task\"]}}}\n"),
            "terminal" => {
                rig.advance(MOMENT);
                rig.pane_draws();
                rig.tick();
            }
            _ => unreachable!(),
        }
        assert_eq!(rig.banner(), None, "{evidence}: reload must not resurrect the warning");
        assert_eq!(rig.status(), TabStatus::InProgress, "{evidence}");
        if evidence != "terminal" {
            assert!(!rig.delivery_pending(), "{evidence}: later silence must not become another delivery doubt");
        }
    }
}

#[test]
fn confirmed_delivery_followed_by_silence_is_a_stall_not_a_delivery_doubt() {
    let rig = Rig::of(CliKind::Codex, "");
    rig.compose("accepted then stalled", 0);
    rig.readiness_times_out();
    rig.append(&rig.cli().prompt("accepted then stalled"));
    rig.advance(PATIENCE.stall);
    rig.tick();
    assert_eq!(rig.banner(), Some(RecoveryKind::Timeout));
}

#[test]
fn a_ready_cli_has_not_yet_confirmed_the_prompt() {
    let rig = Rig::of(CliKind::Claude, "");
    rig.compose("not received", 0);
    rig.hook("SessionStart", json!({}));
    assert!(rig.delivery_pending());
    rig.advance(PATIENCE.stall);
    rig.tick();
    assert_eq!(rig.banner(), Some(RecoveryKind::DeliveryUnconfirmed));
}

#[test]
fn readiness_timeout_still_retains_a_continuation_instead_of_sending_it_blindly() {
    let rig = Rig::of(CliKind::Codex, "");
    rig.compose("prepared continuation", 0);
    let (tx, rx) = std::sync::mpsc::channel();
    assert!(!rig.manager.prepare_prompt(&mut rig.rt.lock().unwrap(), Readiness::TimedOut, Some(&tx)));
    assert!(rx.try_recv().unwrap().unwrap_err().contains("Context was not sent"));
    assert_eq!(rig.status(), TabStatus::Idle);
    assert!(!rig.turn_open());
    assert_eq!(rig.kinds(), ["user_message"]);
}

#[test]
fn continuation_submit_hook_confirms_before_the_transcript_and_keeps_echo_deduplication() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        let receipt = rig.compose_confirmed("continue work");
        rig.submitted();
        // Hooks identify the submission even when the provider rewrites the text.
        rig.hook("UserPromptSubmit", json!({ "prompt": "provider reformatted the prompt" }));
        assert_eq!(receipt.try_recv().unwrap(), Ok(()));
        rig.hook("UserPromptSubmit", json!({}));
        assert!(receipt.try_recv().is_err(), "confirmation is sent only once");
        rig.append(&rig.cli().prompt("<pasted_content id=\"1\">\ncontinue   work\n</pasted_content id=\"1\">"));
        assert_eq!(rig.told(), ["user: continue work"]);
    }
}

#[test]
fn continuation_submit_hook_skips_a_receipt_whose_waiter_timed_out() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        let expired = rig.compose_confirmed("old prompt");
        rig.submitted();
        drop(expired);
        rig.hook("Stop", json!({}));
        let receipt = rig.compose_confirmed("continue work");
        rig.submitted();
        rig.hook("UserPromptSubmit", json!({}));
        assert_eq!(receipt.try_recv().unwrap(), Ok(()));
    }
}

#[test]
fn continuation_echo_confirms_wrapped_and_reflowed_long_prompts_without_hooks() {
    let text = format!("Continue work {} Keep history unchanged", "historical context ".repeat(1000));
    for kind in BOTH {
        for echoed in [
            format!("<pasted_content id=\"1\">\n{text}\n</pasted_content>"),
            format!("<pasted_content id=\"1\">\n{text}\n</pasted_content id=\"1\">"),
            text.replace(' ', " \r\n\t"),
        ] {
            let rig = Rig::of(kind, "");
            let receipt = rig.compose_confirmed(&text);
            rig.submitted();
            rig.append(&rig.cli().prompt(&echoed));
            assert_eq!(receipt.try_recv().unwrap(), Ok(()));
            assert_eq!(rig.told(), [format!("user: {text}")]);
        }
    }
}

#[test]
fn continuation_without_submission_or_provider_acceptance_stays_unconfirmed() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        let receipt = rig.compose_confirmed("continue work");
        assert!(rig.turn_open(), "the optimistic app turn is already open");
        rig.hook("SessionStart", json!({}));
        rig.hook("UserPromptSubmit", json!({}));
        assert_eq!(receipt.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty));
        rig.submitted();
        rig.manager.on_hook(HookFrame {
            session: SESSION.into(), tab: TAB.into(), token: "old launch token".into(),
            event: "UserPromptSubmit".into(), payload: json!({}),
        });
        rig.hook("SessionStart", json!({}));
        rig.append(&rig.cli().prompt("unrelated terminal prompt"));
        assert_eq!(receipt.recv_timeout(std::time::Duration::ZERO), Err(std::sync::mpsc::RecvTimeoutError::Timeout));
        assert_eq!(rig.told(), ["user: continue work", "user: unrelated terminal prompt"]);
    }
}

impl Rig {
    /// The Enter of the newest composer prompt has been written, now: what
    /// `type_prompt` records once its last byte is in the pane.
    fn enter_written(&self) {
        if let Engine::Cli(p) = &mut self.rt.lock().unwrap().engine {
            p.echoed.back_mut().unwrap().submitted = true;
            if p.awaiting_delivery.is_some() {
                p.accept_by = Some(self.now.get() + tui::ACCEPT_TIMEOUT);
            }
        }
    }

    /// The stages the tab's diagnostics recorded, in order, and the file.
    fn delivery_stages(&self) -> (Vec<String>, String) {
        let file = std::fs::read_to_string(self._dir.path().join("tab.diagnostics.jsonl")).unwrap_or_default();
        let stages = file
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .filter(|line| line["type"] == "prompt_delivery")
            .map(|line| line["stage"].as_str().unwrap_or("").to_string())
            .collect();
        (stages, file)
    }
}

/// The report (#403): the message is in the CLI's input and the agent never
/// starts. Writing the Enter proves nothing, and neither does the pane
/// drawing — the paste appearing in the composer is a draw. An idle CLI that
/// was given a prompt acknowledges it at once, so one that has not within
/// seconds gets the reader told, not five minutes of "Working".
#[test]
fn a_submitted_prompt_the_cli_never_acknowledges_is_flagged_within_seconds() {
    for kind in BOTH {
        for evidence in ["hook", "echo"] {
            let rig = Rig::of(kind, "");
            rig.compose("a stranded prompt", 0);
            rig.enter_written();
            rig.pane_draws();
            rig.advance(tui::ACCEPT_TIMEOUT - MOMENT);
            rig.tick();
            assert_eq!(rig.banner(), None, "{kind:?}: still within the time an acknowledgement takes");
            assert_eq!(rig.status(), TabStatus::InProgress);

            rig.advance(MOMENT);
            rig.pane_draws();
            rig.tick();
            assert_eq!(rig.banner(), Some(RecoveryKind::DeliveryUnconfirmed), "{kind:?}");
            assert_eq!(rig.status(), TabStatus::Waiting);
            // The pane drawing again is not the CLI taking the prompt.
            rig.advance(MOMENT);
            rig.pane_draws();
            rig.tick();
            assert_eq!(rig.banner(), Some(RecoveryKind::DeliveryUnconfirmed), "{kind:?}: a redraw does not take it back");
            // Told once, and nothing sent again: the prompt is the reader's to
            // submit or recall, wherever it now is.
            assert_eq!(rig.kinds(), ["user_message", "recovery"], "{kind:?}");
            assert_eq!(rig.told(), ["user: a stranded prompt"]);
            assert!(rig.delivery_pending());

            // The reader presses Enter in the terminal; the CLI takes it.
            match evidence {
                "hook" => rig.hook("UserPromptSubmit", json!({ "prompt": "a stranded prompt" })),
                _ => rig.append(&match kind {
                    CliKind::Claude => rig.cli().prompt("a stranded prompt"),
                    CliKind::Codex => rig.cli().steer("a stranded prompt"),
                }),
            }
            assert_eq!(rig.banner(), None, "{kind:?}, {evidence}");
            assert_eq!(rig.status(), TabStatus::InProgress, "{kind:?}, {evidence}");
            assert!(!rig.delivery_pending());
            assert_eq!(rig.told(), ["user: a stranded prompt"], "{kind:?}, {evidence}: still one message");
            let (stages, _) = rig.delivery_stages();
            assert_eq!(stages, ["unconfirmed", "accepted"], "{kind:?}, {evidence}");
        }
    }
}

#[test]
fn a_prompt_acknowledged_in_time_is_never_flagged() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        rig.compose("taken at once", 0);
        rig.enter_written();
        rig.advance(tui::ACCEPT_TIMEOUT / 2);
        rig.hook("UserPromptSubmit", json!({ "prompt": "taken at once" }));
        for _ in 0..4 {
            rig.advance(tui::ACCEPT_TIMEOUT);
            rig.pane_draws();
            rig.tick();
        }
        assert_eq!(rig.banner(), None, "{kind:?}");
        assert_eq!(rig.status(), TabStatus::InProgress, "{kind:?}");
        assert_eq!(rig.kinds(), ["user_message"], "{kind:?}");
    }
}

/// A follow-up sent while a turn runs is the CLI's to hold. If the turn ends
/// and the CLI still has not taken it, it may be sitting in the CLI's input:
/// the reader is told, and the words typed into the terminal afterwards are
/// a message of their own rather than that one's echo.
#[test]
fn a_queued_prompt_the_cli_never_takes_is_flagged_once_its_turn_is_over() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        rig.compose("start", 0);
        rig.cli_takes("start");
        assert!(rig.compose("and then this", 0));
        rig.enter_written();
        rig.tick();
        assert_eq!(rig.banner(), None, "{kind:?}: held behind a running turn is where it belongs");
        rig.cli_replies("one");
        rig.tick();
        assert_eq!(rig.banner(), None, "{kind:?}: the CLI has a moment to take it");

        rig.advance(QUEUED_ECHO_GRACE + Duration::from_secs(60));
        rig.tick();
        rig.tick();
        assert_eq!(rig.banner(), Some(RecoveryKind::DeliveryUnconfirmed), "{kind:?}");
        assert_eq!(rig.kinds().iter().filter(|k| *k == "recovery").count(), 1, "{kind:?}: said once");
        assert_eq!(rig.told(), ["user: start", "queued: and then this", "reply: one", "end"], "{kind:?}: nothing sent again");

        rig.cli_takes("and then this");
        assert_eq!(rig.banner(), None, "{kind:?}");
        assert_eq!(rig.told().last().unwrap(), "user: and then this", "{kind:?}");
    }
}

#[test]
fn a_queued_prompt_the_cli_takes_is_never_flagged() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        rig.compose("start", 0);
        rig.cli_takes("start");
        assert!(rig.compose("while you are at it", 0));
        rig.enter_written();
        rig.append(&rig.cli().steer("while you are at it"));
        rig.cli_replies("both");
        rig.advance(QUEUED_ECHO_GRACE + Duration::from_secs(60));
        rig.tick();
        assert_eq!(rig.banner(), None, "{kind:?}");
        assert!(!rig.kinds().iter().any(|k| k == "recovery"), "{kind:?}");
    }
}

/// The regression for delayed paste processing, against a real pane.
///
/// The program in the pane stands in for a CLI that is busy when the prompt
/// arrives: it does not look at its input for a second and a half, then
/// reads whatever is there in one gulp. Like the TUIs this was written
/// against, it takes a carriage return that arrives in the same read as the
/// paste for part of the paste, and only one read on its own for Enter.
///
/// A fixed pause between the two writes loses to that: both are waiting by
/// the time the program reads, and the prompt is left in its input. The
/// Enter has to wait for the paste to have been *read*. Nothing here is
/// timed against the fix — the program is slow for far longer than any pause
/// the writer takes, and says which of the two it saw.
#[cfg(unix)]
#[test]
fn an_enter_is_not_written_until_a_busy_cli_has_read_the_paste() {
    const PROMPT: &str = "synthetic prompt for a busy cli";
    let rig = Rig::of(CliKind::Claude, "");
    let script = rig._dir.path().join("busy-cli.sh");
    std::fs::write(
        &script,
        r#"stty raw -echo
printf 'CLI-IS-UP'
sleep 1.5
first=$(dd bs=65536 count=1 2>/dev/null | od -An -c | tr -d ' \n')
case "$first" in
  *'[201~\r'*) printf 'PROMPT-LEFT-IN-INPUT' ;;
  *'[201~') dd bs=1 count=1 2>/dev/null | od -An -c | grep -q '\\r' && printf 'PROMPT-SUBMITTED' ;;
  *) printf 'UNEXPECTED-INPUT' ;;
esac
sleep 600
"#,
    )
    .unwrap();
    let screen = |rig: &Rig| String::from_utf8_lossy(&rig.manager.terminals.read_output(&rig.pane).unwrap_or_default()).into_owned();
    let wait_for = |rig: &Rig, needles: &[&str]| {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let seen = screen(rig);
            if let Some(found) = needles.iter().find(|needle| seen.contains(**needle)) {
                return found.to_string();
            }
            assert!(Instant::now() < deadline, "the pane never said any of {needles:?}: {seen:?}");
            std::thread::sleep(Duration::from_millis(10));
        }
    };

    let sink = Arc::new(crate::sink::BroadcastSink::new(256));
    let command = format!("sh '{}'", script.display());
    let spec = pty::PaneSpec { cwd: rig._dir.path().to_str().unwrap(), cols: 80, rows: 24, command: Some(&command), env: &[] };
    rig.manager.terminals.spawn(sink, &rig.pane, spec).unwrap();
    wait_for(&rig, &["CLI-IS-UP"]);

    rig.compose(PROMPT, 0);
    let (ready, seq) = {
        let rt = rig.rt.lock().unwrap();
        let Engine::Cli(cli) = &rt.engine else { unreachable!() };
        (cli.ready.clone(), cli.awaiting_delivery.unwrap())
    };
    ready.mark();
    rig.manager.type_prompt(&rig.rt, &rig.pane, PROMPT.into(), vec![], PromptDelivery { ready: Some(ready), seq: Some(seq), queued: false, receipt: None, shared: None });
    assert_eq!(wait_for(&rig, &["PROMPT-SUBMITTED", "PROMPT-LEFT-IN-INPUT", "UNEXPECTED-INPUT"]), "PROMPT-SUBMITTED");

    // The writer is done once it lets go of the pane.
    let writer = rig.manager.writers.lock().unwrap().get(&rig.pane).unwrap().clone();
    drop(writer.lock().unwrap());
    // Every stage is on record with its timing, and none of the prompt is.
    let (stages, file) = rig.delivery_stages();
    assert_eq!(stages, ["ready", "body_written", "submit_written"]);
    assert!(file.contains(r#""paste":"read""#), "{file}");
    assert!(!file.contains("synthetic") && !file.contains(rig._dir.path().to_str().unwrap()), "{file}");

    // An Enter the program read is still not a prompt the agent took. This
    // one never says so, and the reader hears about it.
    assert!(rig.delivery_pending());
    assert!(matches!(&rig.rt.lock().unwrap().engine, Engine::Cli(cli) if cli.accept_by.is_some()));
    rig.advance(Duration::from_secs(600));
    rig.tick();
    assert_eq!(rig.banner(), Some(RecoveryKind::DeliveryUnconfirmed));
    assert_eq!(rig.told(), [format!("user: {PROMPT}")]);
}

impl Rig {
    /// The queued messages the log says a later turn was started by.
    fn taken_as_prompts(&self) -> Vec<String> {
        let events = self.events();
        events
            .iter()
            .filter_map(|e| match &e.payload {
                Payload::TurnStarted { prompt_seq: Some(seq), .. } => Some(queued_text(&events, *seq)),
                _ => None,
            })
            .collect()
    }

    /// The reader stops the turn: Escape in the CLI.
    fn interrupt(&self) {
        match self.cli().0 {
            CliKind::Claude => self.append(
                r#"{"parentUuid":"u","isSidechain":false,"type":"user","uuid":"int","cwd":"/w","sessionId":"s","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}
"#,
            ),
            CliKind::Codex => self.hook("Interrupt", json!({})),
        }
    }
}

/// The report: the reader types into the agent's own prompt in the terminal
/// view. The composer never sees it, so nothing was published when it was
/// sent, and the CLI's record is all there is.
#[test]
fn a_prompt_typed_in_the_terminal_is_one_message_ahead_of_its_reply() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        rig.cli_takes("typed in the terminal");
        assert_eq!(rig.told(), ["user: typed in the terminal"], "{kind:?}: there as soon as the CLI records it, not when the turn ends");
        assert_eq!(rig.status(), TabStatus::InProgress);
        rig.cli_replies("done");

        assert_eq!(rig.told(), ["user: typed in the terminal", "reply: done", "end"], "{kind:?}");
        assert_eq!(rig.status(), TabStatus::Completed);
        // Nothing the composer adds: the chat has to draw it from its text.
        let events = rig.events();
        let Payload::UserMessage { images, baseline, .. } = &events[0].payload else { panic!("{kind:?}: {:?}", events[0].payload) };
        assert!(images.is_empty() && baseline.is_none());
    }
}

#[test]
fn a_prompt_sent_from_the_composer_is_one_message_not_two() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        assert!(!rig.compose("from the composer", 0));
        // The CLI's own record of the same prompt, a moment later.
        rig.cli_takes("from the composer");
        rig.cli_replies("done");
        assert_eq!(rig.told(), ["user: from the composer", "reply: done", "end"], "{kind:?}");

        // With an image the CLI records its own label in front of the text.
        assert!(!rig.compose("look at this", 1));
        rig.cli_takes(&rig.cli().with_image("look at this"));
        rig.cli_replies("seen");
        assert_eq!(rig.told()[3..], ["user: look at this", "reply: seen", "end"], "{kind:?}");
        let events = rig.events();
        let pictured = events.iter().filter(|e| matches!(&e.payload, Payload::UserMessage { images, .. } if images.len() == 1)).count();
        assert_eq!(pictured, 1, "{kind:?}: the composer's copy, with the image, is the one kept");
    }
}

#[test]
fn a_composer_prompt_and_then_a_terminal_prompt_are_two_messages_in_order() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        rig.compose("first from the composer", 0);
        rig.cli_takes("first from the composer");
        rig.cli_replies("one");
        rig.cli_takes("second from the terminal");
        rig.cli_replies("two");
        // And the same words again, typed this time: the composer's echo was
        // used up by the composer's own send, so this one is not swallowed.
        rig.cli_takes("first from the composer");
        rig.cli_replies("three");
        assert_eq!(
            rig.told(),
            [
                "user: first from the composer",
                "reply: one",
                "end",
                "user: second from the terminal",
                "reply: two",
                "end",
                "user: first from the composer",
                "reply: three",
                "end",
            ],
            "{kind:?}"
        );
    }
}

/// A prompt typed into the terminal while a turn runs. Claude Code records
/// it as a `queued_command` attachment and never as a `user` record, which
/// is why it was missing from the chat; Codex records the usual item.
#[test]
fn a_prompt_typed_in_the_terminal_mid_turn_is_one_message() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        rig.cli_takes("start");
        rig.append(&rig.cli().steer("and one more thing"));
        assert!(rig.turn_open());
        rig.cli_replies("both");
        assert_eq!(rig.told(), ["user: start", "user: and one more thing", "reply: both", "end"], "{kind:?}");
        assert_eq!(rig.status(), TabStatus::Completed);
    }
}

/// A composer prompt sent while a turn runs is published as queued, and the
/// CLI holds it. When the CLI takes it mid-turn, its record is the message
/// the composer already published — it used to be drawn again as a new turn.
/// The chat is told it was taken, there and then (#551): it had gone on
/// showing it as waiting, and folded it away with the tool calls once the
/// turn was over.
#[test]
fn a_queued_composer_prompt_the_cli_takes_mid_turn_is_one_message() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        rig.compose("start", 0);
        rig.cli_takes("start");
        assert!(rig.compose("while you are at it", 0), "{kind:?}: a turn is running, so it is queued");
        let seq = rig.queued_seq("while you are at it");
        assert_eq!(rig.held(), [seq], "{kind:?}: waiting, so it can still be sent now");

        rig.append(&rig.cli().steer("while you are at it"));
        assert_eq!(rig.told(), ["user: start", "queued: while you are at it", "taken: while you are at it"], "{kind:?}");
        assert!(rig.held().is_empty(), "{kind:?}: the CLI has it; nothing is left to send now");

        // A "Send now" that crossed the take: the turn goes on, and nothing is typed again.
        assert!(rig.manager.send_queued_now(SESSION, TAB, seq).is_err(), "{kind:?}");
        assert!(rig.turn_open(), "{kind:?}: not interrupted");
        assert!(matches!(&rig.rt.lock().unwrap().engine, Engine::Cli(p) if p.resend_after_abort.is_none()), "{kind:?}");

        rig.cli_replies("both");
        assert_eq!(rig.told(), ["user: start", "queued: while you are at it", "taken: while you are at it", "reply: both", "end"], "{kind:?}");
        assert!(rig.taken_as_prompts().is_empty(), "{kind:?}: taken within the turn, it starts no turn of its own");
    }
}

impl Rig {
    /// A pane that takes whatever is typed into it and draws nothing, for a
    /// test where the tab types a prompt again.
    fn with_pane(self) -> Self {
        let sink = Arc::new(crate::sink::BroadcastSink::new(256));
        let spec = pty::PaneSpec { cwd: self._dir.path().to_str().unwrap(), cols: 80, rows: 24, command: Some("sh -c 'cat > /dev/null'"), env: &[] };
        self.manager.terminals.spawn(sink, &self.pane, spec).unwrap();
        self
    }
}

/// "Send now" on the second of two queued prompts: the turn is stopped, that
/// one is typed again as a prompt of its own, and the first behind it,
/// queued. The chat is told the new turn is the chosen message's answer, and
/// that the other was taken when the CLI takes it (#551). Neither used to be
/// said: the chosen message stayed a queued card in the stopped turn, with a
/// Send now that could only answer that the agent had taken it. And with the
/// echoes awaited in the order they were first sent, the chosen one's record
/// dropped the other's echo as missed, and drew it again when it came.
#[test]
fn a_queued_prompt_sent_now_starts_the_turn_it_is_typed_again_for() {
    for kind in BOTH {
        let rig = Rig::of(kind, "").with_pane();
        rig.compose("start", 0);
        rig.cli_takes("start");
        assert!(rig.compose("first held", 0) && rig.compose("second held", 0), "{kind:?}");
        let (first, second) = (rig.queued_seq("first held"), rig.queued_seq("second held"));

        rig.manager.send_queued_now(SESSION, TAB, second).unwrap();
        rig.interrupt();
        assert!(rig.turn_open(), "{kind:?}: the chosen message opens a turn of its own");
        assert_eq!(rig.held(), [first], "{kind:?}: the other is held behind it");

        rig.cli_takes("second held");
        assert_eq!(rig.taken_as_prompts(), ["second held"], "{kind:?}: the log says which message the new turn answers");
        assert_eq!(rig.held(), [first], "{kind:?}");
        rig.append(&rig.cli().steer("first held"));
        assert!(rig.held().is_empty(), "{kind:?}");
        rig.cli_replies("both");
        assert_eq!(
            rig.told(),
            ["user: start", "queued: first held", "queued: second held", "end", "taken: first held", "reply: both", "end"],
            "{kind:?}: each message once, and the one taken mid-turn said so"
        );
    }
}

/// A "Send now" that crosses a take the tab has not read yet: the CLI wrote
/// that it took the message mid-turn just before the Escape went in. That
/// record is still the take, not the prompt typed again: the turn it is read
/// in is not over, and nothing has been typed. Read as the retyped prompt,
/// it opened a turn inside the running one, which never closed.
///
/// What else was queued is not typed again either. The CLI still holds it,
/// and stopped with a message queued it sends that at once as its next
/// prompt ("Escape interrupts; only Stop ends the process" in PTY-FIRST.md);
/// typed again as well, it would go to the agent twice.
#[test]
fn a_send_now_that_crosses_an_unread_mid_turn_take_is_still_that_take() {
    for kind in BOTH {
        let rig = Rig::of(kind, "").with_pane();
        rig.compose("start", 0);
        rig.cli_takes("start");
        assert!(rig.compose("use staging", 0) && rig.compose("then deploy", 0), "{kind:?}");
        let (chosen, other) = (rig.queued_seq("use staging"), rig.queued_seq("then deploy"));

        rig.manager.send_queued_now(SESSION, TAB, chosen).unwrap();
        rig.append(&rig.cli().steer("use staging"));
        assert!(rig.turn_open(), "{kind:?}");
        assert!(rig.taken_as_prompts().is_empty(), "{kind:?}: no turn of its own inside the running one");
        assert_eq!(rig.told(), ["user: start", "queued: use staging", "queued: then deploy", "taken: use staging"], "{kind:?}");

        // The Escape still stops the turn, and nothing is typed again to open another.
        rig.interrupt();
        assert!(!rig.turn_open(), "{kind:?}");
        assert_eq!(rig.held(), [other], "{kind:?}: still the CLI's to send");

        rig.cli_takes("then deploy");
        assert_eq!(rig.taken_as_prompts(), ["then deploy"], "{kind:?}: its record starts the next turn, as behind any stopped turn");
        assert!(rig.held().is_empty(), "{kind:?}");
        assert_eq!(rig.told(), ["user: start", "queued: use staging", "queued: then deploy", "taken: use staging", "end"], "{kind:?}: each message once");
    }
}

/// The CLI can also hold a queued prompt until the turn is over and take it
/// as the next turn's. Still one message, and the turn it starts closes like
/// any other — whether the `UserPromptSubmit` hook or the record of the
/// prompt is heard first. The hook opens the turn but not the latch that
/// lets `Stop` close it; with the record dropped as an echo, nothing did, and
/// the turn stayed "Working" with its reply outside any turn.
#[test]
fn a_queued_composer_prompt_the_cli_takes_after_the_turn_starts_the_next_one() {
    for kind in BOTH {
        for hook_first in [true, false] {
            let case = format!("{kind:?}, {}", if hook_first { "the hook and then the record" } else { "the record alone" });
            let rig = Rig::of(kind, "");
            rig.compose("start", 0);
            rig.cli_takes("start");
            assert!(rig.compose("then this", 0));
            rig.cli_replies("one");
            assert!(!rig.turn_open(), "{case}");
            assert!(rig.taken_as_prompts().is_empty(), "{case}: still only queued");

            if hook_first {
                rig.cli_takes("then this");
            } else {
                rig.append(&rig.cli().prompt("then this"));
            }
            assert!(rig.turn_open(), "{case}");
            assert_eq!(rig.status(), TabStatus::InProgress, "{case}");
            assert_eq!(rig.taken_as_prompts(), ["then this"], "{case}: the log says which message the new turn answers");
            assert!(rig.held().is_empty(), "{case}: it is the new turn's prompt, not one still to send");

            rig.cli_replies("two");
            assert_eq!(rig.told(), ["user: start", "queued: then this", "reply: one", "end", "reply: two", "end"], "{case}");
            assert_eq!(rig.completed_turns(), 2, "{case}");
            assert!(!rig.turn_open(), "{case}");
            assert_eq!(rig.status(), TabStatus::Completed, "{case}: finished and unread, as after any turn");
        }
    }
}

/// The reader queues a prompt from the composer and presses Escape. Both
/// CLIs stop the turn and send what was queued at once, as their next prompt
/// (#427; Claude Code 2.1.296 writes the interruption and then the prompt,
/// Codex 0.153.4 says "Model interrupted to submit steer instructions"). It
/// is the message the reader already sees as queued, so it becomes the
/// prompt of the next turn rather than being drawn a second time.
#[test]
fn a_queued_prompt_the_cli_sends_once_its_turn_was_stopped_starts_the_next_turn() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        rig.compose("start", 0);
        rig.cli_takes("start");
        assert!(rig.compose("continue", 0));
        rig.enter_written();
        rig.interrupt();
        assert!(!rig.turn_open(), "{kind:?}");

        rig.cli_takes("continue");
        assert!(rig.turn_open(), "{kind:?}");
        assert_eq!(rig.status(), TabStatus::InProgress, "{kind:?}");
        rig.cli_replies("continuing");
        assert_eq!(rig.told(), ["user: start", "queued: continue", "end", "reply: continuing", "end"], "{kind:?}: one message, not two");
        assert_eq!(rig.taken_as_prompts(), ["continue"], "{kind:?}");
        rig.advance(QUEUED_ECHO_GRACE + Duration::from_secs(60));
        rig.tick();
        assert_eq!(rig.banner(), None, "{kind:?}");
    }
}

/// Found in the app, with Codex: the message had been queued for a minute
/// behind a reply that was still streaming when Escape was pressed. Nothing
/// is written to the transcript while a reply streams, and the turn was
/// closed by the `Interrupt` hook with nothing new to read, so the wait for
/// the queued message, counted from when it was sent, had already run out.
/// The tab said delivery could not be confirmed and then drew the message a
/// second time when the CLI sent it. The wait starts when the turn ends.
#[test]
fn a_prompt_queued_long_before_its_turn_was_stopped_is_still_expected() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        rig.compose("start", 0);
        rig.cli_takes("start");
        assert!(rig.compose("continue", 0));
        rig.enter_written();
        // Queued five minutes ago, and the transcript has been quiet since.
        if let Engine::Cli(p) = &mut rig.rt.lock().unwrap().engine {
            p.echoed.back_mut().unwrap().sent_at = Instant::now() - Duration::from_secs(300);
        }
        rig.interrupt();
        rig.tick();
        assert_eq!(rig.banner(), None, "{kind:?}: the CLI has a moment to send it, counted from now");
        assert!(!rig.kinds().iter().any(|k| k == "recovery"), "{kind:?}");

        rig.cli_takes("continue");
        rig.cli_replies("continuing");
        assert_eq!(rig.told(), ["user: start", "queued: continue", "end", "reply: continuing", "end"], "{kind:?}: one message, not two");
        assert_eq!(rig.taken_as_prompts(), ["continue"], "{kind:?}");
    }
}

/// A CLI that keeps what was queued in its own input when its turn is
/// stopped (as Claude Code did before it sent it): the reader is told the
/// message was not sent, and the same words typed into the terminal later
/// are a message of their own, not that one's echo.
#[test]
fn a_queued_prompt_the_cli_kept_back_when_its_turn_was_stopped_is_flagged_and_swallows_nothing() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        rig.compose("start", 0);
        rig.cli_takes("start");
        assert!(rig.compose("continue", 0));
        rig.enter_written();
        rig.interrupt();
        rig.tick();
        assert_eq!(rig.banner(), None, "{kind:?}: the CLI has a moment to send it");

        rig.advance(QUEUED_ECHO_GRACE + Duration::from_secs(60));
        rig.tick();
        rig.tick();
        assert_eq!(rig.banner(), Some(RecoveryKind::DeliveryUnconfirmed), "{kind:?}: not silently dropped");
        assert_eq!(rig.kinds().iter().filter(|k| *k == "recovery").count(), 1, "{kind:?}: said once");
        assert_eq!(rig.told(), ["user: start", "queued: continue", "end"], "{kind:?}: nothing sent again");

        rig.cli_takes("continue");
        rig.cli_replies("continuing");
        assert_eq!(rig.banner(), None, "{kind:?}");
        assert_eq!(rig.told(), ["user: start", "queued: continue", "end", "user: continue", "reply: continuing", "end"], "{kind:?}");
    }
}

/// A composer prompt the CLI is slow to record — a long start, a busy
/// machine — is still that prompt when the record lands, however late.
#[test]
fn a_composer_prompt_recorded_long_after_it_was_sent_is_still_one_message() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        rig.compose("slow to land", 0);
        // Sent longer ago than any echo is kept once no turn is running.
        if let Engine::Cli(p) = &mut rig.rt.lock().unwrap().engine {
            for prompt in p.echoed.iter_mut() {
                prompt.sent_at = Instant::now().checked_sub(COMPOSER_ECHO_TTL * 2).unwrap_or(prompt.sent_at);
            }
        }
        rig.cli_takes("slow to land");
        rig.cli_replies("got it");
        assert_eq!(rig.told(), ["user: slow to land", "reply: got it", "end"], "{kind:?}");
    }
}

/// A tab opened on a conversation that already has a history follows the
/// transcript from where it stands: the old prompts are in the tab's log
/// already and are not published a second time.
#[test]
fn a_resumed_conversation_s_old_prompts_are_not_told_again() {
    for kind in BOTH {
        let cli = Cli(kind);
        let history = format!("{}{}{}{}", cli.prompt("an old prompt"), cli.reply("an old reply"), cli.prompt("another"), cli.reply("and its reply"));
        let rig = Rig::of(kind, &history);
        rig.manager.pump(&rig.rt, &rig.tail);
        assert!(rig.told().is_empty(), "{kind:?}: {:?}", rig.told());

        rig.cli_takes("a new prompt in the terminal");
        rig.cli_replies("a new reply");
        assert_eq!(rig.told(), ["user: a new prompt in the terminal", "reply: a new reply", "end"], "{kind:?}");

        // A second resume, at the file's new length, starts as quietly.
        // (One rig at a time: each holds the test home.)
        let written = std::fs::read_to_string(&rig.transcript).unwrap();
        drop(rig);
        let again = Rig::of(kind, &written);
        again.manager.pump(&again.rt, &again.tail);
        assert!(again.told().is_empty(), "{kind:?}");
    }
}

/// What happened in the report. The workspace had been renamed, so the tab
/// derived its transcript's folder from a path the conversation had never
/// been run in; Claude Code went on writing where the conversation began.
/// Every hook named that file and was refused for being outside the tab's
/// folder, so the tail read nothing: no prompt typed in the terminal, no
/// turn end. The replies still showed, because the `Stop` hook carries one.
#[test]
fn a_conversation_the_cli_keeps_in_another_folder_is_still_heard() {
    let rig = Rig::of(CliKind::Claude, "");
    let cli = Cli(CliKind::Claude);
    let projects = rig._dir.path().join("projects");
    let (derived, kept) = (projects.join("-w-renamed"), projects.join("-w-original"));
    std::fs::create_dir_all(&derived).unwrap();
    std::fs::create_dir_all(&kept).unwrap();
    let transcript = kept.join("conversation.jsonl");
    std::fs::write(&transcript, format!("{}{}", cli.prompt("before the rename"), cli.reply("an old reply"))).unwrap();
    let write = |records: &str| {
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&transcript).unwrap().write_all(records.as_bytes()).unwrap();
    };
    let named = |path: &Path| json!({ "transcript_path": path.to_str().unwrap() });
    let follow = |own: Option<crate::hooks::ConversationFile>| {
        if let Engine::Cli(p) = &mut rig.rt.lock().unwrap().engine {
            p.origin.transcript_root = derived.clone();
            p.origin.conversation = own;
        }
        rig.tail.retarget(&derived.join("conversation.jsonl"));
    };

    // As it was: the file the hooks name is not one this tab may follow.
    follow(None);
    rig.hook("SessionStart", named(&transcript));
    rig.hook("UserPromptSubmit", named(&transcript));
    write(&cli.prompt("typed in the terminal"));
    write(&cli.reply("the reply"));
    rig.hook("Stop", json!({ "transcript_path": transcript.to_str().unwrap(), "last_assistant_message": "the reply" }));
    assert_eq!(rig.told(), ["reply: the reply"], "the reply with no question, and a turn that never ends");
    assert!(rig.turn_open());

    // The tab knows its own conversation by name, in the folder it is in.
    follow(Some(crate::hooks::ConversationFile::new(projects.clone(), "conversation.jsonl".into())));
    rig.hook("SessionStart", named(&transcript));
    assert_eq!(rig.tail.path(), transcript);
    assert_eq!(rig.told(), ["reply: the reply"], "what the file already held is history, not news");

    rig.hook("UserPromptSubmit", named(&transcript));
    write(&cli.prompt("typed after the fix"));
    write(&cli.reply("heard"));
    rig.hook("Stop", json!({ "transcript_path": transcript.to_str().unwrap(), "last_assistant_message": "heard" }));
    assert_eq!(rig.told()[1..], ["user: typed after the fix", "reply: heard", "end"]);
    assert!(!rig.turn_open());

    // Another checkout's conversations are not this tab's, in two frames or
    // in one: naming this conversation's id in their folder, where no such
    // file is, hands nothing over.
    let victim = projects.join("-w-victim");
    std::fs::create_dir_all(&victim).unwrap();
    let theirs = victim.join("their-conversation.jsonl");
    std::fs::write(&theirs, format!("{}{}", cli.prompt("their private prompt"), cli.reply("their private reply"))).unwrap();
    rig.hook("SessionStart", named(&victim.join("conversation.jsonl")));
    rig.hook("SessionStart", named(&theirs));
    rig.hook("Stop", named(&theirs));
    assert_eq!(rig.tail.path(), transcript);
    // Nor is a neighbour of this conversation in the folder it is kept in,
    // unless the CLI announces it as the file it has just opened.
    let neighbour = kept.join("neighbour.jsonl");
    std::fs::write(&neighbour, cli.prompt("a neighbour's prompt")).unwrap();
    rig.hook("UserPromptSubmit", named(&neighbour));
    assert_eq!(rig.tail.path(), transcript);
    assert_eq!(rig.told().len(), 4, "nothing of anyone else's was read out: {:?}", rig.told());

    // A `/clear` starts a new file. Whichever of the two folders the CLI
    // opens it in — beside the old file, or under the checkout as it is
    // named now — it is this tab's, and the other folder stays so too.
    for cleared in [kept.join("after-clear.jsonl"), derived.join("after-another-clear.jsonl")] {
        std::fs::write(&cleared, "").unwrap();
        rig.hook("SessionStart", named(&cleared));
        assert_eq!(rig.tail.path(), cleared);
        rig.hook("UserPromptSubmit", named(&cleared));
        std::fs::write(&cleared, cli.prompt("after a clear")).unwrap();
        rig.manager.pump(&rig.rt, &rig.tail);
        rig.hook("Stop", named(&cleared));
    }
    assert_eq!(rig.told()[4..], ["user: after a clear", "end", "user: after a clear", "end"]);
    rig.hook("Stop", named(&transcript));
    assert_eq!(rig.tail.path(), transcript, "and the conversation it began with still is");
}

/// A launch that finds the conversation's file under another folder follows
/// it from the start, with the folder derived from the checkout still
/// allowed beside it.
#[test]
fn a_launch_adopts_the_folder_its_conversation_is_found_in() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let (began, now) = ("/w/original", "/w/renamed");
    let kept = claude::transcript::transcript_in(&projects, began, "abc");
    std::fs::create_dir_all(kept.parent().unwrap()).unwrap();
    std::fs::write(&kept, "{}\n").unwrap();
    let derived = claude::transcript::transcript_in(&projects, now, "abc");
    std::fs::create_dir_all(derived.parent().unwrap()).unwrap();

    let path = claude::transcript::locate_in(&projects, now, "abc");
    assert_eq!(path, kept);
    let mut conversation = crate::hooks::ConversationFile::new(projects.clone(), "abc.jsonl".into());
    assert!(conversation.adopt(&path));
    let mut origin = Origin { token: crate::hooks::mint_token(), transcript_root: derived.parent().unwrap().to_path_buf(), conversation: Some(conversation) };
    let frame = |event: &str, path: &Path| HookFrame { tab: TAB.into(), session: SESSION.into(), token: String::new(), event: event.into(), payload: json!({ "transcript_path": path.to_str().unwrap() }) };

    assert_eq!(origin.transcript(&frame("Stop", &kept)), Some(kept.as_path()));
    for cleared in [kept.with_file_name("new.jsonl"), derived.with_file_name("new.jsonl")] {
        assert_eq!(origin.transcript(&frame("SessionStart", &cleared)), Some(cleared.as_path()), "{}", cleared.display());
    }
}

/// A slash command typed in the terminal reads as it was typed, once; what
/// it printed is not a message. One the app typed for itself (the model
/// picker's `/model`) is nobody's message at all.
#[test]
fn a_slash_command_is_shown_as_typed_and_the_app_s_own_is_not_shown() {
    let rig = Rig::of(CliKind::Claude, "");
    let record = |content: &str| {
        format!(
            r#"{{"parentUuid":"a","isSidechain":false,"type":"user","uuid":"c-{}","userType":"external","cwd":"/w","sessionId":"s","message":{{"role":"user","content":"{content}"}}}}
"#,
            content.len()
        )
    };
    let model = |args: &str| record(&format!(r"<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>{args}</command-args>"));
    let printed = record("<local-command-stdout>Set model to opus</local-command-stdout>");

    rig.append(&model("opus"));
    rig.append(&printed);
    assert_eq!(rig.told(), ["user: /model opus"]);

    // Sent from the composer, the CLI's record is the composer's message.
    rig.hook("Stop", json!({}));
    rig.compose("/model sonnet", 0);
    rig.append(&model("sonnet"));
    rig.append(&printed);
    assert_eq!(rig.told()[1..], ["end", "user: /model sonnet"]);

    // Typed by the app when the reader picks a model: recorded by the CLI
    // with or without the argument, and drawn in neither case.
    for recorded in ["haiku", ""] {
        if let Engine::Cli(p) = &mut rig.rt.lock().unwrap().engine {
            rig.manager.type_command(p, &rig.rt, "/model haiku".into());
        }
        rig.append(&model(recorded));
        rig.append(&printed);
    }
    assert_eq!(rig.told().len(), 3, "{:?}", rig.told());
}

impl Rig {
    /// Put the open turn's start `by` further back, as if that long had passed.
    fn turn_began_earlier(&self, by: Duration) {
        let mut rt = self.rt.lock().unwrap();
        rt.turn_started_at = Some(rt.turn_started_at.expect("a turn is open") - by);
    }

    /// How long the last turn to end was said to have taken.
    fn last_turn_took(&self) -> Duration {
        let ms = self.events().iter().rev().find_map(|e| match &e.payload {
            Payload::TurnCompleted { duration_ms, .. } => Some(duration_ms.expect("a turn with a start has a duration")),
            _ => None,
        });
        Duration::from_millis(ms.expect("a turn ended"))
    }
}

/// Found in a cloud acceptance pass: a driver sent `/help` from the composer,
/// which the CLI answers on its own screen with no prompt record and no
/// `Stop`, so the turn it opened stayed open. A one-second prompt typed into
/// the terminal minutes later then said "Worked for 5m 27s": its hook and its
/// record found a turn open and kept that turn's start.
#[test]
fn a_prompt_after_a_command_that_never_ends_counts_its_own_time() {
    const LONG_AGO: Duration = Duration::from_secs(5 * 60);
    for kind in BOTH {
        for record_first in [false, true] {
            let case = format!("{kind:?}, {}", if record_first { "the record and then the hook" } else { "the hook and then the record" });
            let rig = Rig::of(kind, "");
            assert!(!rig.compose("/help", 0), "{case}");
            assert!(rig.turn_open(), "{case}");
            rig.turn_began_earlier(LONG_AGO);

            if record_first {
                rig.append(&rig.cli().prompt("typed in the terminal"));
                rig.hook("UserPromptSubmit", json!({ "prompt": "typed in the terminal" }));
            } else {
                rig.cli_takes("typed in the terminal");
            }
            rig.cli_replies("done");
            assert!(rig.last_turn_took() < LONG_AGO, "{case}: {:?}", rig.last_turn_took());

            // From the composer, it is a prompt of its own, not one queued
            // behind a turn that is not running.
            rig.compose("/help", 0);
            rig.turn_began_earlier(LONG_AGO);
            assert!(!rig.compose("from the composer", 0), "{case}");
            rig.cli_takes("from the composer");
            rig.cli_replies("done again");
            assert!(rig.last_turn_took() < LONG_AGO, "{case}: {:?}", rig.last_turn_took());
        }
    }
}

/// What the fix must leave alone: a turn that is working keeps its start
/// through its own hooks and through a prompt typed into it mid-turn.
#[test]
fn a_running_turn_keeps_its_start_through_its_hooks_and_a_mid_turn_prompt() {
    const LONG_AGO: Duration = Duration::from_secs(5 * 60);
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        rig.cli_takes("start");
        rig.turn_began_earlier(LONG_AGO);
        // Codex asks the reader about every tool at `PreToolUse`.
        let tool_hook = if kind == CliKind::Claude { "PreToolUse" } else { "PostToolUse" };
        rig.hook(tool_hook, json!({ "tool_name": "Bash", "tool_input": { "command": "ls" }, "tool_use_id": "t1" }));
        rig.hook("PostToolUse", json!({ "tool_name": "Bash", "tool_input": { "command": "ls" }, "tool_use_id": "t1" }));
        rig.append(&rig.cli().steer("and one more thing"));
        rig.cli_replies("both");
        assert!(rig.last_turn_took() >= LONG_AGO, "{kind:?}: {:?}", rig.last_turn_took());

        // A command that does work of its own is a turn like any other.
        assert!(!rig.compose("/review the last commit", 0));
        rig.turn_began_earlier(LONG_AGO);
        rig.hook("UserPromptSubmit", json!({ "prompt": "/review the last commit" }));
        rig.hook(tool_hook, json!({ "tool_name": "Bash", "tool_input": { "command": "git show" }, "tool_use_id": "t2" }));
        rig.append(&rig.cli().steer("look at the tests too"));
        rig.cli_replies("reviewed");
        assert!(rig.last_turn_took() >= LONG_AGO, "{kind:?}: {:?}", rig.last_turn_took());
    }
}

/// Escape, from the chat and from the agent's own terminal (#427): the same
/// rig and the same two CLIs, and a headless tab beside them.
#[path = "session_interrupt_tests.rs"]
mod interrupts;

/// Turns the agent starts itself, and a message sent while one runs (#540).
#[path = "session_self_started_tests.rs"]
mod self_started;
