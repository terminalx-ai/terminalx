//! Files attached to a message (PRO-290), end to end: stored, sent with a
//! prompt, typed into the CLI as a block of paths after the text, shown once
//! in the chat with its files, rebuilt from Claude Code's own transcript, and
//! gone with the session.
//!
//! The rig is `session_unsent_tests`' own: a real pane, a stand-in for Claude
//! Code that echoes what is typed at it, and Claude Code's transcript written
//! where the CLI writes it.
use super::*;
use crate::attachments::{self, FileInput};

fn pasted(name: &str, data: &[u8]) -> FileInput {
    use base64::Engine as _;
    FileInput { name: name.into(), path: None, data: Some(base64::engine::general_purpose::STANDARD.encode(data)), media_type: None }
}

impl Rig {
    /// A file picked on this computer and one pasted, stored for the session.
    fn stored(&self) -> Vec<FileRef> {
        let picked = self.checkout.join("pr-template.md");
        std::fs::write(&picked, "# Summary\n").unwrap();
        let picked = FileInput { name: "pr-template.md".into(), path: Some(picked.to_string_lossy().into_owned()), data: None, media_type: None };
        attachments::store(SESSION, &[picked, pasted("notes.txt", b"pasted notes")]).unwrap()
    }

    /// The `user_message`s in the tab's log, with their files.
    fn messages(&self) -> Vec<(String, Vec<FileRef>)> {
        store::read_lines::<AgentEvent>(&store::log_path(SESSION, TAB).unwrap())
            .unwrap()
            .into_iter()
            .filter_map(|event| match event.payload {
                Payload::UserMessage { text, files, .. } => Some((text, files)),
                _ => None,
            })
            .collect()
    }
}

/// The prompt as the agent gets it: what was typed, a blank line, the block.
fn agent_text(text: &str, files: &[FileRef]) -> String {
    let paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
    format!("{text}\n\nAttached files:\n{}", paths.join("\n"))
}

#[test]
fn a_message_carries_its_files_and_the_agent_is_handed_their_paths() {
    let rig = Rig::new(claude_tab(None), LISTENS);
    let files = rig.stored();

    let sent = rig.manager.send_pressed(SESSION, TAB, "Review this".into(), Vec::new(), Some(chrono::Utc::now().timestamp_millis()), files.clone()).unwrap();

    // The chat's message is what was typed, with its files beside it.
    let Payload::UserMessage { text, files: carried, images, .. } = &sent.events[0].payload else { panic!("{:?}", sent.events) };
    assert_eq!(text, "Review this", "the paths never show in the message");
    assert!(images.is_empty());
    assert_eq!(carried, &files);
    let wire = serde_json::to_value(&sent.events[0].payload).unwrap();
    assert_eq!(wire["files"][0]["name"], "pr-template.md");
    assert_eq!(wire["files"][1]["mediaType"].as_str(), files[1].media_type.as_deref());
    assert!(wire["files"][0]["path"].as_str().unwrap().ends_with("/pr-template.md"));

    // The agent gets the text, then the block of absolute paths.
    rig.up();
    rig.wait("the prompt and its paths to be typed", || {
        let typed = rig.typed();
        typed.contains("Review this") && typed.contains("Attached files:") && files.iter().all(|file| typed.contains(&file.path))
    });
    let typed = rig.typed();
    assert!(typed.find("Review this").unwrap() < typed.find("Attached files:").unwrap(), "{typed:?}");
    assert!(typed.find("Attached files:").unwrap() < typed.find(&files[0].path).unwrap(), "{typed:?}");
    assert!(typed.find(&files[0].path).unwrap() < typed.find(&files[1].path).unwrap(), "in the order attached: {typed:?}");
    match &rig.rt().lock().unwrap().engine {
        Engine::Cli(p) => assert!(p.echoed.back().is_some_and(|echo| echo.matches("Review this")), "the echo awaited is the text without the block"),
        _ => panic!("the tab runs its CLI"),
    }

    // Claude Code records the prompt as it was handed it, block and all:
    // that record is the composer message's echo, not a second message.
    rig.cli_takes(&agent_text("Review this", &files), "Looked at both.");
    rig.wait("the reply", || rig.said().iter().any(|line| line == "claude: Looked at both."));
    assert_eq!(rig.said(), ["user: Review this", "claude: Looked at both."]);
    assert_eq!(rig.messages(), [("Review this".to_string(), files)]);
}

#[test]
fn files_alone_are_sent_as_the_block_alone() {
    let rig = Rig::new(claude_tab(None), LISTENS);
    let files = rig.stored();
    let sent = rig.manager.send_pressed(SESSION, TAB, String::new(), Vec::new(), None, files.clone()).unwrap();
    assert!(matches!(&sent.events[0].payload, Payload::UserMessage { text, files: carried, .. } if text.is_empty() && carried == &files));
    rig.up();
    rig.wait("the block to be typed", || rig.typed().contains("Attached files:") && rig.typed().contains(&files[1].path));
}

#[test]
fn a_file_that_is_not_this_sessions_attachment_refuses_the_send() {
    let rig = Rig::new(claude_tab(None), LISTENS);
    let loose = rig.checkout.join("secret.env");
    std::fs::write(&loose, "TOKEN=1").unwrap();
    let loose = FileRef { path: loose.to_string_lossy().into_owned(), name: "secret.env".into(), media_type: None, size: None };
    let theirs = attachments::store("another-session", &[pasted("theirs.txt", b"x")]).unwrap();
    let mine = rig.stored();
    let gone = FileRef { path: format!("{}/never-stored.txt", Path::new(&mine[0].path).parent().unwrap().display()), ..mine[0].clone() };

    for (refused, why) in [(vec![loose], "not one of this session’s attachments"), (theirs, "not one of this session’s attachments"), (vec![gone], "no longer in this session’s attachments")] {
        let error = rig.manager.send_pressed(SESSION, TAB, "read this".into(), Vec::new(), None, refused).unwrap_err();
        assert!(error.to_string().contains(why), "{error:#}");
    }
    assert!(rig.said().is_empty(), "nothing was published: {:?}", rig.said());
    assert!(!rig.ran.exists(), "the CLI was not even started");

    let eleven: Vec<FileRef> = (0..11).map(|_| mine[0].clone()).collect();
    assert!(rig.manager.send_pressed(SESSION, TAB, "too many".into(), Vec::new(), None, eleven).unwrap_err().to_string().contains("At most 10"));
}

/// A prompt typed into the terminal, or one whose composer message the chat
/// no longer has, reaches the chat only from Claude Code's transcript: the
/// block comes off the text and the files are files again.
#[test]
fn the_chat_rebuilt_from_the_transcript_shows_the_files_not_the_block() {
    let rig = Rig::new(claude_tab(None), LISTENS);
    let files = rig.stored();
    rig.manager.ensure_started(SESSION, TAB).unwrap();
    rig.up();
    rig.cli_takes(&agent_text("Compare these", &files), "They differ.");
    rig.wait("the reply", || rig.said().iter().any(|line| line == "claude: They differ."));
    assert_eq!(rig.said(), ["user: Compare these", "claude: They differ."]);
    let messages = rig.messages();
    let (text, restored) = &messages[0];
    assert_eq!(text, "Compare these");
    assert_eq!(restored.iter().map(|file| (file.path.as_str(), file.name.as_str(), file.size)).collect::<Vec<_>>(),
        files.iter().map(|file| (file.path.as_str(), file.name.as_str(), file.size)).collect::<Vec<_>>());
}

#[test]
fn a_prompt_sent_again_carries_its_files_again() {
    let rig = Rig::new(claude_tab(None), LISTENS);
    let files = rig.stored();
    rig.logged(1, json!({ "type": "user_message", "text": "Use the template", "queued": false, "files": files }));
    rig.logged(2, json!({ "type": "turn_completed", "status": "aborted", "durationMs": 1433 }));
    rig.logged(3, json!({ "type": "status", "text": "Claude Code exited." }));
    rig.manager.ensure_started(SESSION, TAB).unwrap();
    rig.up();
    let sent = rig.manager.resend_unsent(SESSION, TAB).unwrap();
    assert!(matches!(&sent.events[0].payload, Payload::UserMessage { text, files: carried, .. } if text == "Use the template" && carried == &files));
    rig.wait("the prompt and its paths to be typed again", || rig.typed().contains("Use the template") && rig.typed().contains(&files[0].path));
}

#[test]
fn attachments_go_with_their_session() {
    let rig = Rig::new(claude_tab(None), LISTENS);
    let files = rig.stored();
    let folder = store::attachments_dir(SESSION).unwrap();
    assert!(Path::new(&files[0].path).starts_with(folder.canonicalize().unwrap()));
    let kept = attachments::store("kept", &[pasted("stays.txt", b"x")]).unwrap();

    crate::session_ops::remove_session_entries(&[index::get(SESSION).unwrap()]).unwrap();

    assert!(!folder.exists(), "the session's attachments folder is removed with it");
    assert!(!Path::new(&files[0].path).exists());
    assert!(Path::new(&kept[0].path).exists(), "another session's are not");
}
