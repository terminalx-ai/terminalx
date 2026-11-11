//! View changes are requests, never agent failures. Typed, content-free
//! evidence shares the tab's existing diagnostic file, not its transcript.
use super::*;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage { Requested, WaitingForTurn, StoppingOwner, TransportChanged, StartingTerminal, Attaching, Opened, Cancelled, Failed }

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory { Handoff, Start, Attach, ConnectionEnded, OwnerCleanup, ConversationUnavailable, Persistence }

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Surface { Window, Runtime }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalViewReport {
    pub transition_id: uuid::Uuid,
    pub sequence: u32,
    pub elapsed_ms: u64,
    pub stage: Stage,
    pub surface: Surface,
    pub error_category: Option<ErrorCategory>,
}

impl SessionManager {
    /// Best-effort diagnostics: the caller never waits for this to change
    /// views, and a failed write cannot affect the agent or its recovery.
    pub fn note_terminal_view(&self, session: &str, tab: &str, report: &TerminalViewReport) -> Result<()> {
        let runtime = self.runtime(session, tab)?;
        let rt = runtime.lock().unwrap();
        let entry = index::get(session)?;
        let tab = entry.tab(tab).context("tab not found")?;
        record(&rt, tab.transport, report);
        Ok(())
    }
}

pub(super) fn record(rt: &TabRuntime, transport: index::AgentTransport, report: &TerminalViewReport) {
    let engine = match rt.engine { Engine::CodexStdio(_) => "codex_stdio", Engine::Cli(_) => "pty", Engine::None => "none", _ => "headless" };
    // Identifiers must be opaque UUIDs; named fixtures and legacy names are
    // omitted, so even an identifying session/tab name cannot be exported.
    let opaque = |s: &str| uuid::Uuid::parse_str(s).ok();
    let line = serde_json::json!({
        "type": "terminal_view_transition", "v": 1,
        "event_id": uuid::Uuid::now_v7(), "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "build": env!("CARGO_PKG_VERSION"), "session_id": opaque(&rt.session_id), "tab_id": opaque(&rt.tab_id),
        "source_seq": rt.seq, "report": report, "transport": transport, "engine": engine,
        "state": rt.status, "turn_open": rt.turn_open, "pending_decisions": rt.pending.len(),
        "process_present": rt.child.is_some(), "stopping": rt.stopping, "recovery": rt.recovery,
    });
    recovery::append_diagnostic(&rt.diagnostics_path(), &line.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reports_accept_only_opaque_ids_and_fixed_categories() {
        let mut value = serde_json::json!({"transitionId": uuid::Uuid::now_v7(), "sequence": 1, "elapsedMs": 5,
            "stage": "failed", "surface": "window", "errorCategory": "start"});
        assert!(serde_json::from_value::<TerminalViewReport>(value.clone()).is_ok());
        value["errorCategory"] = Value::String("secret prompt /Users/private".into());
        assert!(serde_json::from_value::<TerminalViewReport>(value.clone()).is_err());
        value["errorCategory"] = Value::Null;
        value["transitionId"] = Value::String("/Users/private".into());
        assert!(serde_json::from_value::<TerminalViewReport>(value.clone()).is_err());
        value["transitionId"] = serde_json::json!(uuid::Uuid::now_v7());
        value["prompt"] = Value::String("private".into());
        assert!(serde_json::from_value::<TerminalViewReport>(value).is_err());
    }
}
