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
/// read. Text is plain words, so it needs no JSON escaping.
struct Cli(CliKind);

impl Cli {
    /// A prompt the CLI took while idle: the start of a turn.
    fn prompt(&self, text: &str) -> String {
        match self.0 {
            CliKind::Claude => format!(
                r#"{{"parentUuid":null,"isSidechain":false,"type":"user","uuid":"u-{text}","userType":"external","cwd":"/w","sessionId":"s","origin":{{"kind":"human"}},"message":{{"role":"user","content":"{text}"}}}}
"#
            ),
            CliKind::Codex => format!(
                r#"{{"type":"event_msg","payload":{{"type":"task_started","turn_id":"t-{text}"}}}}
{}"#,
                self.steer(text)
            ),
        }
    }

    /// A prompt the CLI took while a turn was running. Codex writes the same
    /// item it writes for any prompt; Claude Code writes an attachment and no
    /// `user` record at all.
    fn steer(&self, text: &str) -> String {
        match self.0 {
            CliKind::Claude => format!(
                r#"{{"parentUuid":"a","isSidechain":false,"attachment":{{"type":"queued_command","prompt":"{text}","source_uuid":"s-{text}","commandMode":"prompt","origin":{{"kind":"human"}},"humanTurn":true}},"type":"attachment","uuid":"q-{text}","userType":"external","cwd":"/w","sessionId":"s"}}
"#
            ),
            CliKind::Codex => format!(
                r#"{{"type":"event_msg","payload":{{"type":"item_completed","item":{{"type":"UserMessage","id":"user-{text}","content":[{{"type":"text","text":"{text}","text_elements":[]}}]}}}}}}
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
        let prompt = PromptText { agent: text.into(), display: text.into() };
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
    /// end, in the order they were published.
    fn told(&self) -> Vec<String> {
        self.events()
            .iter()
            .filter_map(|e| match &e.payload {
                Payload::UserMessage { text, queued: false, .. } => Some(format!("user: {text}")),
                Payload::UserMessage { text, queued: true, .. } => Some(format!("queued: {text}")),
                Payload::AssistantText { text, .. } => Some(format!("reply: {text}")),
                Payload::TurnCompleted { .. } => Some("end".to_string()),
                _ => None,
            })
            .collect()
    }
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

impl Rig {
    /// The queued messages the log says a later turn was started by.
    fn taken_as_prompts(&self) -> Vec<String> {
        let events = self.events();
        let text_at = |seq: u64| events.iter().find(|e| e.seq == seq).and_then(|e| match &e.payload {
            Payload::UserMessage { text, queued: true, .. } => Some(text.clone()),
            _ => None,
        });
        events
            .iter()
            .filter_map(|e| match &e.payload {
                Payload::TurnStarted { prompt_seq: Some(seq), .. } => Some(text_at(*seq).unwrap_or_else(|| format!("no queued message at {seq}"))),
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
#[test]
fn a_queued_composer_prompt_the_cli_takes_mid_turn_is_one_message() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        rig.compose("start", 0);
        rig.cli_takes("start");
        assert!(rig.compose("while you are at it", 0), "{kind:?}: a turn is running, so it is queued");
        rig.append(&rig.cli().steer("while you are at it"));
        rig.cli_replies("both");
        assert_eq!(rig.told(), ["user: start", "queued: while you are at it", "reply: both", "end"], "{kind:?}");
        assert!(rig.taken_as_prompts().is_empty(), "{kind:?}: taken within the turn, it starts no turn of its own");
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

            rig.cli_replies("two");
            assert_eq!(rig.told(), ["user: start", "queued: then this", "reply: one", "end", "reply: two", "end"], "{case}");
            assert_eq!(rig.completed_turns(), 2, "{case}");
            assert!(!rig.turn_open(), "{case}");
            assert_eq!(rig.status(), TabStatus::Completed, "{case}: finished and unread, as after any turn");
        }
    }
}

/// The reader queues a prompt from the composer, stops the turn, and then
/// types the same words into the terminal. The CLI never sent what was
/// queued, so its echo must not be left to swallow what was typed.
#[test]
fn a_queued_prompt_the_cli_never_sent_does_not_swallow_the_same_words_typed_later() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        rig.compose("start", 0);
        rig.cli_takes("start");
        assert!(rig.compose("continue", 0));
        rig.interrupt();
        assert!(!rig.turn_open(), "{kind:?}");

        rig.cli_takes("continue");
        rig.cli_replies("continuing");
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
