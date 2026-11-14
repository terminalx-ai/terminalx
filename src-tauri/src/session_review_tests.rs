//! Real per-launch hook credentials without starting an agent process.
use super::*;

impl SessionManager {
    pub(crate) fn install_review_test_cli(&self, session: &str, tab: &str, token: &str) {
        self.runtime(session, tab).unwrap().lock().unwrap().engine = Engine::Cli(CliTab {
            usage_account: None,
            harness: CliKind::Claude,
            mode: "default".into(),
            pane_id: format!("{session}-{tab}"),
            generation: 0,
            launched_at: Instant::now(),
            restart_when_idle: false,
            settings_asked_at: None,
            launched_for: None,
            status_names_model: false,
            settings_command_is_ours: false,
            ready: Arc::new(tui::Ready::new(true)),
            recorded: false,
            tail: Arc::new(tui::Tail::opening(
                PathBuf::new(),
                claude::transcript::decode_line,
                Default::default(),
            )),
            echoed: Default::default(),
            awaiting_delivery: None,
            delivery_sent_at: None,
            accept_by: None,
            nudge_by: None,
            nudges_left: 0,
            entered_at: None,
            held: Vec::new(),
            prompts: RecordedPrompts::default(),
            input: InputBox::default(),
            resend_after_abort: None,
            codex_interrupt_hooks_owed: 0,
            codex_prompt_starts_turn: false,
            decisions: HashMap::new(),
            turn_tail: Default::default(),
            transcript_turn: None,
            transcript_end_owed: false,
            command: "claude".into(),
            origin: Origin {
                token: token.to_owned(),
                transcript_root: PathBuf::new(),
                conversation: None,
            },
            by_hand: None,
        });
    }
}
