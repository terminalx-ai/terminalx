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
    }
}

/// The CLI can also hold a queued prompt until the turn is over and take it
/// as the next turn's. Still one message — and the turn it starts is open,
/// though nothing but the dropped record said so, and closes like any other.
#[test]
fn a_queued_composer_prompt_the_cli_takes_after_the_turn_starts_the_next_one() {
    for kind in BOTH {
        let rig = Rig::of(kind, "");
        rig.compose("start", 0);
        rig.cli_takes("start");
        assert!(rig.compose("then this", 0));
        rig.cli_replies("one");
        assert!(!rig.turn_open());

        // No `UserPromptSubmit` here: the record alone has to open the turn.
        rig.append(&rig.cli().prompt("then this"));
        assert!(rig.turn_open(), "{kind:?}");
        assert_eq!(rig.status(), TabStatus::InProgress);
        rig.cli_replies("two");
        assert_eq!(rig.told(), ["user: start", "queued: then this", "reply: one", "end", "reply: two", "end"], "{kind:?}");
        assert_eq!(rig.status(), TabStatus::Completed);
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
    let named = json!({ "transcript_path": transcript.to_str().unwrap() });
    let follow = |own: Option<crate::hooks::ConversationFile>| {
        if let Engine::Cli(p) = &mut rig.rt.lock().unwrap().engine {
            p.origin.transcript_root = derived.clone();
            p.origin.conversation = own;
        }
        rig.tail.retarget(&derived.join("conversation.jsonl"));
    };

    // As it was: the file the hooks name is not one this tab may follow.
    follow(None);
    rig.hook("SessionStart", named.clone());
    rig.hook("UserPromptSubmit", named.clone());
    write(&cli.prompt("typed in the terminal"));
    write(&cli.reply("the reply"));
    rig.hook("Stop", json!({ "transcript_path": transcript.to_str().unwrap(), "last_assistant_message": "the reply" }));
    assert_eq!(rig.told(), ["reply: the reply"], "the reply with no question, and a turn that never ends");
    assert!(rig.turn_open());

    // The tab knows its own conversation by name, whichever folder it is in.
    follow(Some(crate::hooks::ConversationFile { projects: projects.clone(), name: "conversation.jsonl".into() }));
    rig.hook("SessionStart", named.clone());
    assert_eq!(rig.tail.path(), transcript);
    assert_eq!(rig.told(), ["reply: the reply"], "what the file already held is history, not news");

    rig.hook("UserPromptSubmit", named.clone());
    write(&cli.prompt("typed after the fix"));
    write(&cli.reply("heard"));
    rig.hook("Stop", json!({ "transcript_path": transcript.to_str().unwrap(), "last_assistant_message": "heard" }));
    assert_eq!(rig.told()[1..], ["user: typed after the fix", "reply: heard", "end"]);
    assert!(!rig.turn_open());

    // A `/clear` starts a new file beside it, which is this tab's too; a
    // neighbour's conversation in some third folder is not.
    let cleared = kept.join("after-clear.jsonl");
    std::fs::write(&cleared, "").unwrap();
    rig.hook("SessionStart", json!({ "transcript_path": cleared.to_str().unwrap() }));
    assert_eq!(rig.tail.path(), cleared);
    let other = projects.join("-w-other");
    std::fs::create_dir_all(&other).unwrap();
    rig.hook("SessionStart", json!({ "transcript_path": other.join("theirs.jsonl").to_str().unwrap() }));
    assert_eq!(rig.tail.path(), cleared);
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
