//! Recovery messages are an allowlist: provider diagnostics never become UI text.
use crate::events::{Payload, TurnStatus};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
/// `Tool` is no longer raised (#400): a failed tool is a row in the transcript,
/// not a state of the session. It stays for the logs that recorded it and for
/// the text a failed tool's result is replaced with.
///
/// `Unsent` is a launch finding the CLI never took the tab's last prompt
/// (#663): the conversation starts without it, and the reader can send it
/// again. It is never what an error classifies as.
pub enum RecoveryKind { Capacity, UsageLimit, Tool, Timeout, DeliveryUnconfirmed, Unsent, Disconnected, PermissionExpired, SignedOut, Failed }

impl RecoveryKind {
    pub fn classify(message: &str) -> Self {
        let text = message.to_ascii_lowercase();
        // The agent's own sign-in lapsed: nothing works again until the user
        // signs in, so retrying first only fails the same way.
        if ["run /login", "authentication_failed", "oauth token has expired", "run codex login", "agent is signed out"].iter().any(|s| text.contains(s)) {
            Self::SignedOut
        } else
        // The user's own plan ran out, not the provider: retrying before the
        // reset fails the same way.
        if ["usage limit", "usage_limit", "hit your", "limit reached", "quota"].iter().any(|s| text.contains(s)) {
            Self::UsageLimit
        } else if ["capacity", "overloaded", "rate limit", "rate_limit", "too many requests", "429", "529"].iter().any(|s| text.contains(s)) {
            Self::Capacity
        } else if ["timeout", "timed out", "no progress"].iter().any(|s| text.contains(s)) {
            Self::Timeout
        } else if ["network", "disconnect", "connection", "broken pipe", "closed", "eof"].iter().any(|s| text.contains(s)) {
            Self::Disconnected
        } else { Self::Failed }
    }
    pub fn message(self) -> &'static str {
        match self {
            Self::Capacity => "The provider is at capacity. Retry or choose another available model.",
            Self::UsageLimit => "Your plan's usage limit is reached. Wait for it to reset, or continue on another model.",
            Self::Tool => "A tool or command failed. Review its outcome before continuing.",
            Self::Timeout => "No progress was confirmed before the timeout. The process outcome is unknown.",
            Self::DeliveryUnconfirmed => "Prompt delivery could not be confirmed. Check the terminal: if your message is still in the agent's input, press Enter there to send it. To resend instead, stop the session, then press Up in the composer to recall your message.",
            Self::Unsent => "The agent never received your last prompt, so its conversation starts without it. Resend it, or send something new.",
            Self::Disconnected => "The connection was lost. The process outcome is unknown.",
            Self::PermissionExpired => "The permission request expired. Check the terminal for a new request or stop the session.",
            Self::SignedOut => "The agent is signed out, or its sign-in expired. Sign in again, then retry.",
            Self::Failed => "The agent encountered an error. Review the conversation before continuing.",
        }
    }
}

/// The most of an agent's own words the chat shows under an error, in characters.
pub const DETAIL_CHARS: usize = 240;

/// The agent's own words for a failure before it ever worked (#667): a launch
/// that was refused, or a CLI that exited during startup. The chat shows them
/// under the allowlisted message, so "update Codex" or "unauthorized (401)"
/// is in sight without opening the terminal. Mid-turn provider text never
/// gets here: the tab's own diagnostics keep that.
///
/// Only the last line, as plain text, with what looks like a credential, an
/// address, a URL's path or a home folder cut out, and at most
/// [`DETAIL_CHARS`]. Reading its own result back gives the same result.
pub fn detail(text: &str) -> Option<String> {
    let plain = plain_text(text);
    let line = plain.lines().map(str::trim).rfind(|line| !line.is_empty())?;
    let line = redact(line);
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    if line.chars().count() <= DETAIL_CHARS {
        return Some(line.to_string());
    }
    Some(line.chars().take(DETAIL_CHARS - 1).chain(std::iter::once('…')).collect())
}

/// What a terminal shows, without its escape sequences or control bytes.
/// A carriage return ends a line, as it does on screen.
fn plain_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                // CSI: parameters up to the final byte.
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                // OSC and the other strings: up to BEL or ESC \.
                Some(']' | 'P' | '_' | '^' | 'X') => {
                    while let Some(c) = chars.next() {
                        if c == '\x07' {
                            break;
                        }
                        if c == '\x1b' {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\r' | '\n' => out.push('\n'),
            '\t' => out.push(' '),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// The words that make a name a credential's: `password`, `api_key`,
/// `refresh_token`, `Set-Cookie`, `OPENAI_API_KEY`.
pub(crate) const CREDENTIAL_WORDS: &str = "token|secret|password|passwd|passphrase|api[_-]?key|apikey|credential|auth|cookie|private[_-]?key";

/// The words a bare `key:` label has to end in to count: `Unauthorized:` or
/// `auth.json:` is an error's own words, `password:` is not.
pub(crate) const CREDENTIAL_ENDS: &str = "token|secret|password|passwd|passphrase|api[_-]?key|apikey|credentials?|auth|authorization|cookie|private[_-]?key";

/// Cut from one line what must not reach a chat: credentials, addresses, a
/// URL's userinfo, path and query, and the account folder in a path. Run
/// until nothing more is cut: what one rule leaves (`[email]`, `~`) can make
/// the next label read as the start of a phrase, so the result read back is
/// the same result.
pub(crate) fn redact(line: &str) -> String {
    let mut line = line.to_string();
    for _ in 0..4 {
        let next = redact_once(&line);
        if next == line {
            break;
        }
        line = next;
    }
    line
}

/// What `redact_once` cuts with, in order: `before`, bare labels, `after`,
/// then long opaque runs.
struct Rules {
    before: [(regex::Regex, &'static str); 7],
    label: regex::Regex,
    after: [(regex::Regex, &'static str); 2],
    opaque: regex::Regex,
}

fn redact_once(line: &str) -> String {
    use regex::Regex;
    use std::sync::OnceLock;
    static RULES: OnceLock<Rules> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        let pattern = |text: &str| Regex::new(text).expect("valid pattern");
        let (words, ends) = (CREDENTIAL_WORDS, CREDENTIAL_ENDS);
        // A value: escaped JSON's `\"…\"`; quoted, escaped quotes and all; an
        // object or a list, two levels deep and with its strings, whole; one
        // of those left open, as a line cut short leaves it, to the end of
        // the line; an auth scheme and its credential (`Bearer abc`,
        // `` `Bearer abc` ``), or the `[redacted]` the Bearer rule left; or
        // bare, up to a space, a comma or a semicolon.
        let string = r#""(?:[^"\\]|\\.)*""#;
        let escaped = r#"\\"(?:[^"\\]|\\[^"])*\\""#;
        let quoted = format!(r"{string}|'(?:[^'\\]|\\.)*'");
        let nested = format!(r#"\{{(?:{string}|[^{{}}"]|\{{(?:{string}|[^{{}}"])*\}})*\}}|\[(?:{string}|[^\[\]"]|\[(?:{string}|[^\[\]"])*\])*\]"#);
        let open = r#"\\?["'{\[].*"#;
        let bare = r#"[^\s,;{\["'][^\s,;]*"#;
        let schemed = format!(r"[`<(]?(?:bearer|basic|token|digest|negotiate|oauth|apikey|ssws|ntlm)\s+(?:\[redacted\][`>)]?|{bare})");
        let value = format!("{escaped}|{quoted}|{nested}|{open}|{schemed}|{bare}");
        // A cookie's `name=value` pairs, a value quoted or left open.
        let cookie_value = format!(r#"(?:{string}|["'].*|[^\s,;"']*)"#);
        let cookie = format!(r#"[^\s,;"'=]+(?:={cookie_value})?(?:;\s*[^\s,;"'=]+={cookie_value})*"#);
        // A flag's value that looks like a secret, with a digit or a mark in
        // it: `--password hunter2`, not `--with-api-key or`.
        let mark = "0-9_+/=@#$%^&*!~.";
        let secretish = format!(r#"(?:[{mark}][^\s,;]*|[^\s,;{{\["'{mark}-][^\s,;{mark}]*[{mark}][^\s,;]*)"#);
        Rules {
            before: [
                // Scheme and host only.
                (pattern(r#"(?i)\b([a-z][a-z0-9+.-]*)://(?:[^\s/@()<>"']*@)?([^\s/?#()<>"']+)[^\s()<>"']*"#), "$1://$2"),
                // A Bearer or Basic credential wherever it is, the quote or
                // the backslash that ends it left in place.
                (pattern(r#"(?i)\b(bearer|basic)\s+[^\s,;"'`\\]+"#), "$1 [redacted]"),
                // An `Authorization` value is a scheme, whatever it is, and
                // the credential after it.
                (pattern(&format!(r#"(?i)(["']?)\b((?:proxy-)?authorization)(["']?\s*[=:]\s*)({escaped}|{quoted}|{nested}|{open}|[`<(]?[a-z][a-z0-9._~+/-]*\s+(?:\[redacted\][`>)]?|{bare})|{bare})"#)), "$1$2$3[redacted]"),
                // A cookie is secret whole: every `name=value` pair of it.
                (pattern(&format!(r#"(?i)(["']?)\b((?:set-)?cookie)(["']?\s*[=:]\s*)({escaped}|{quoted}|{nested}|{open}|{schemed}|{cookie})"#)), "$1$2$3[redacted]"),
                // A quoted key is a key, never prose: any name with a
                // credential word in it, `"key": "value"`, `"key" = "value"`,
                // `"key" => "value"` and escaped JSON's `\"key\":\"value\"`.
                (pattern(&format!(r#"(?i)(\\?["'])([a-z0-9_.-]*(?:{words})[a-z0-9_.-]*)(\\?["']\s*(?:=>|[:=])\s*)({value})"#)), "$1$2$3[redacted]"),
                // `key=value` and `key => value`, for any name with a
                // credential word in it.
                (pattern(&format!(r"(?i)\b([a-z0-9_.-]*(?:{words})[a-z0-9_.-]*)(\s*=>?\s*)({value})")), "$1$2[redacted]"),
                // `--password hunter2`, a flag and its value.
                (pattern(&format!(r#"(?i)(\s|^)(--?[a-z0-9_-]*(?:{words})[a-z0-9_-]*)(\s+)({quoted}|["'].*|{secretish})"#)), "$1$2$3[redacted]"),
            ],
            // `key: value`, cut only where a phrase starts (`cut_labels`).
            label: pattern(&format!(r"(?i)\b([a-z0-9_.-]*(?:{ends}))(\s*:\s*)({value})")),
            after: [
                (pattern(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[email]"),
                (pattern(r"(?i)(?:/Users|/home)/[^/\s]+|/root\b|\b[a-z]:\\Users\\[^\\\s]+"), "~"),
            ],
            // A long run of letters and digits together is a token, a key or an id.
            opaque: pattern(r"[A-Za-z0-9_\-+=.]{24,}"),
        }
    });
    let mut line = line.to_string();
    for (pattern, replacement) in &rules.before {
        line = pattern.replace_all(&line, *replacement).into_owned();
    }
    line = cut_labels(&rules.label, &line);
    for (pattern, replacement) in &rules.after {
        line = pattern.replace_all(&line, *replacement).into_owned();
    }
    rules
        .opaque
        .replace_all(&line, |found: &regex::Captures| {
            let text = &found[0];
            if text.bytes().any(|b| b.is_ascii_digit()) && text.bytes().any(|b| b.is_ascii_alphabetic()) { "[redacted]".to_string() } else { text.to_string() }
        })
        .into_owned()
}

/// Cut `key: value` where a phrase starts: at the start of the line, after a
/// mark (`refused: password: hunter2`, `[redacted] secret: s3`) or after a
/// colon and a space; not after a word (`Failed to refresh token: 401
/// Unauthorized`) or a path's `::` (`codex_core::auth: Failed to refresh`).
/// The text before is read, not taken, so a value just cut still starts the
/// next phrase; and a label passed over is passed over by its key only, so
/// one in its value (`refresh token: id_token: …`) is still read.
fn cut_labels(label: &regex::Regex, line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let (mut kept, mut from) = (0, 0);
    while from < line.len() {
        let Some(found) = label.captures_at(line, from) else { break };
        let (whole, key) = (found.get(0).expect("the match"), found.get(1).expect("the key"));
        if starts_a_phrase(&line[..whole.start()]) {
            out.push_str(&line[kept..whole.start()]);
            out.push_str(key.as_str());
            out.push_str(&found[2]);
            out.push_str("[redacted]");
            kept = whole.end();
            from = whole.end();
        } else {
            from = key.end();
        }
    }
    out.push_str(&line[kept..]);
    out
}

fn starts_a_phrase(before: &str) -> bool {
    let trimmed = before.trim_end();
    match trimmed.chars().next_back() {
        None => true,
        Some(':') => trimmed.len() < before.len(),
        Some(c) => !(c.is_ascii_alphanumeric() || "_.-".contains(c)),
    }
}

/// Whether an agent's own words say its provider refused its sign-in (#667):
/// a 401, "unauthorized", "sign in again", a token that could not be
/// refreshed. Only for words that are the agent's own about its account —
/// what a CLI printed as it exited during startup, or a Codex turn's error,
/// which is about its model request — never a tool's output, where a 401 is
/// that tool's. A refresh that failed for want of a network is not a refusal.
pub fn sign_in_refused(text: &str) -> bool {
    use std::sync::OnceLock;
    static STATUS_401: OnceLock<regex::Regex> = OnceLock::new();
    let text = plain_text(text).to_ascii_lowercase();
    if RecoveryKind::classify(&text) == RecoveryKind::SignedOut {
        return true;
    }
    // 401 as a status, not a line number (`app.rs:401:9`) or a version.
    let status = STATUS_401.get_or_init(|| regex::Regex::new(r"\(401\)|\b(?:status|http|code|error|returned|response)(?: code)?[\s:=]*401\b").expect("valid pattern"));
    const REFUSED: &[&str] = &[
        "unauthorized", "unauthenticated", "invalid_grant", "invalid api key", "invalid_api_key", "invalid_token", "not logged in", "not signed in",
        "sign in again", "sign-in again", "log in again", "login again", "re-authenticate", "reauthenticate", "token expired", "token has expired",
        "token is expired", "token_expired", "token was revoked", "token has been revoked", "token_revoked", "refresh token was already used",
        "refresh_token_reused", "authentication failed", "authentication_error",
    ];
    if status.is_match(&text) || REFUSED.iter().any(|marker| text.contains(marker)) {
        return true;
    }
    const REFRESH: &[&str] = &["refresh token", "token refresh", "could not be refreshed", "failed to refresh", "refresh failed", "please log in", "please sign in", "login required", "sign-in required", "sign in required"];
    const UNREACHED: &[&str] = &[
        "connection refused", "connection reset", "connection closed", "timed out", "timeout", "dns", "error sending request", "network", "could not resolve",
        "failed to lookup", "name resolution", "tls", "certificate", "handshake", "too many requests", "429", "500", "502", "503", "504", "unavailable", "proxy",
    ];
    REFRESH.iter().any(|marker| text.contains(marker)) && !UNREACHED.iter().any(|marker| text.contains(marker))
}

/// What a CLI printed as it exited before it ever worked (#667), read from
/// the end of its pane's output: the line to show, and whether it says the
/// provider refused the agent's sign-in.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EarlyExit {
    pub detail: Option<String>,
    pub sign_in_refused: bool,
}

impl EarlyExit {
    /// The last lines are the error and a hint after it, not the screen a
    /// TUI may have drawn before.
    const LINES: usize = 3;
    const BYTES: usize = 8 * 1024;

    pub fn read(output: &[u8]) -> Self {
        Self::said(&String::from_utf8_lossy(&output[output.len().saturating_sub(Self::BYTES)..]))
    }

    /// The same, of text the agent wrote (a protocol error, its stderr).
    pub fn said(text: &str) -> Self {
        let plain = plain_text(text);
        let lines: Vec<&str> = plain.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
        let tail = lines[lines.len().saturating_sub(Self::LINES)..].join("\n");
        Self { detail: detail(&tail), sign_in_refused: sign_in_refused(&tail) }
    }

    /// What it leaves the tab needing.
    pub fn recovery(&self) -> RecoveryKind {
        if self.sign_in_refused { RecoveryKind::SignedOut } else { RecoveryKind::Failed }
    }
}

/// How long the session watcher waits before it says anything about a turn.
#[derive(Debug, Clone, Copy)]
pub struct Patience {
    /// Silence on every channel for this long is a stall.
    pub stall: std::time::Duration,
    /// How long the hooks get to close a turn the transcript says has ended.
    pub settle: std::time::Duration,
}

impl Patience {
    pub const DEFAULT: Self = Self { stall: std::time::Duration::from_secs(300), settle: std::time::Duration::from_secs(10) };
}

/// Silence is an unknown outcome, never proof that a command failed or exited.
pub fn is_stale(working: bool, quiet: std::time::Duration, patience: Patience) -> bool {
    working && quiet >= patience.stall
}

/// Restore attention after a restart without resurrecting a running claim.
pub const SESSION_CLOSED_MESSAGE: &str = "Session closed. Untracked or remote commands may still be running; verify their outcome before continuing.";

pub fn from_history(events: &[crate::events::AgentEvent]) -> Option<RecoveryKind> {
    let mut recovery = None;
    let mut open = false;
    for event in events.iter().filter(|event| event.subagent.is_none()) {
        match &event.payload {
            // Older logs raised one for every failed tool, mid-turn (#400).
            Payload::Recovery { kind } => recovery = kind.filter(|kind| *kind != RecoveryKind::Tool),
            Payload::UserMessage { queued: false, .. } => { open = true; recovery = None; }
            Payload::TurnCompleted { .. } => open = false,
            Payload::Status { text } if text == SESSION_CLOSED_MESSAGE => { open = false; recovery = None; }
            // Another conversation took the tab's terminal (#437): whatever
            // was owed to the one before is not owed by this one.
            Payload::Conversation { .. } => { open = false; recovery = None; }
            Payload::PermissionDecided { label, .. } if label == "Lapsed" => recovery = Some(RecoveryKind::PermissionExpired),
            _ => {}
        }
    }
    recovery.or(open.then_some(RecoveryKind::Disconnected))
}

/// What ends a turn or stops the agent getting any further. A tool or command
/// that failed is neither: the agent reads the result and carries on, and a
/// turn that ends badly says so itself.
pub fn failure(payload: &Payload) -> Option<RecoveryKind> {
    match payload {
        Payload::Error { message, .. } => Some(RecoveryKind::classify(message)),
        // The agent said its provider refused its sign-in, in whatever words (#667).
        Payload::TurnCompleted { auth_failed: true, .. } => Some(RecoveryKind::SignedOut),
        Payload::TurnCompleted { status: TurnStatus::Error, final_text, .. } => Some(RecoveryKind::classify(final_text.as_deref().unwrap_or(""))),
        // Some providers emit rate-limit warnings while requests still succeed.
        Payload::RateLimited { status, .. } if status.as_deref() == Some("rejected") => Some(RecoveryKind::UsageLimit),
        Payload::ApiRetry { attempt, max_retries, reason } if attempt >= max_retries => Some(RecoveryKind::classify(reason.as_deref().unwrap_or(""))),
        _ => None,
    }
}

pub fn diagnose(path: &std::path::Path, payload: &Payload) {
    if let Ok(line) = serde_json::to_string(payload) {
        append_diagnostic(path, &line);
    }
}

/// Private transport evidence, never a chat event or a lifecycle signal.
pub(crate) fn diagnose_codex_stdio(path: &std::path::Path, detail: serde_json::Value) {
    let line = serde_json::json!({
        "type": "codex_stdio_diagnostic",
        "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "detail": detail,
    });
    append_diagnostic(path, &line.to_string());
}

/// One stage of a composer prompt's way into a PTY-first CLI: `ready`,
/// `body_written`, `submit_written`, then `accepted` or `unconfirmed`.
///
/// Counts and timings only. `seq` is the prompt's own event number in this
/// tab's log; nothing here is the prompt, a path, a command or an id that
/// means anything outside the tab, so the lines can be quoted in a report.
pub fn diagnose_delivery(path: &std::path::Path, seq: u64, stage: &str, elapsed: std::time::Duration, detail: serde_json::Value) {
    let mut line = serde_json::json!({
        "type": "prompt_delivery",
        "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "seq": seq,
        "stage": stage,
        "elapsed_ms": elapsed.as_millis() as u64,
    });
    if let (Some(line), serde_json::Value::Object(detail)) = (line.as_object_mut(), detail) {
        line.extend(detail);
    }
    log::info!("prompt delivery: {line}");
    append_diagnostic(path, &line.to_string());
}

/// Fixed opener labels and elapsed time only, safe to include in bug reports.
pub fn diagnose_stall(path: &std::path::Path, opener: Option<(&'static str, &'static str)>, quiet: std::time::Duration) {
    let (source, kind) = opener.unwrap_or(("unknown", "unknown"));
    let line = serde_json::json!({
        "type": "session_stall",
        "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "opener_source": source,
        "opener_kind": kind,
        "quiet_ms": quiet.as_millis() as u64,
    });
    log::info!("session stall: {line}");
    append_diagnostic(path, &line.to_string());
}

fn append_diagnostic(path: &std::path::Path, line: &str) {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(path) {
        let _ = writeln!(file, "{line}");
    }
}

pub fn sanitize(payload: &mut Payload) {
    match payload {
        Payload::Error { message, detail, .. } => {
            *message = RecoveryKind::classify(message).message().into();
            *detail = detail.as_deref().and_then(self::detail);
        }
        Payload::TurnCompleted { status: TurnStatus::Error, final_text, auth_failed, detail, .. } => {
            let kind = if *auth_failed { RecoveryKind::SignedOut } else { RecoveryKind::classify(final_text.as_deref().unwrap_or("")) };
            *final_text = Some(kind.message().into());
            *detail = detail.as_deref().and_then(self::detail);
        }
        Payload::ToolCallCompleted { result, .. } if result.is_error => {
            result.text = RecoveryKind::Tool.message().into();
            result.structured = None;
            result.images.clear();
        }
        Payload::ApiRetry { reason, .. } => *reason = reason.as_ref().map(|s| RecoveryKind::classify(s).message().into()),
        Payload::RateLimited { message, status, window, .. } => {
            let rejected = status.as_deref() == Some("rejected");
            *message = Some(if rejected { RecoveryKind::UsageLimit } else { RecoveryKind::Capacity }.message().into());
            *status = status.as_ref().map(|s| if s == "rejected" { "rejected".into() } else { "limited".into() });
            // The reset time and the window name are shown; both are kept to known values.
            *window = window.as_ref().filter(|w| matches!(w.as_str(), "five_hour" | "seven_day")).cloned();
        }
        Payload::PermissionDenied { message, .. } => *message = "Permission was denied. Review the request before continuing.".into(),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codex_sign_in_screen_is_a_signed_out_recovery_after_persistence_and_rereading() {
        let mut payload = Payload::Error { message: crate::harness::codex::pty::SIGN_IN_REQUIRED.into(), fatal: false, detail: None };
        // The live event and a subsequent transcript read both sanitize.
        for _ in 0..2 {
            sanitize(&mut payload);
            assert_eq!(failure(&payload), Some(RecoveryKind::SignedOut));
            assert!(matches!(&payload, Payload::Error { message, .. } if message == RecoveryKind::SignedOut.message()));
        }
    }

    #[test]
    fn classifications_do_not_echo_diagnostics() {
        for (raw, expected) in [
            ("at capacity token=secret /Users/private", RecoveryKind::Capacity),
            ("request timed out API_KEY=secret", RecoveryKind::Timeout),
            ("connection closed https://secret", RecoveryKind::Disconnected),
            ("failed /home/private", RecoveryKind::Failed),
        ] {
            assert_eq!(RecoveryKind::classify(raw), expected);
            let mut p = Payload::Error { message: raw.into(), fatal: false, detail: None };
            sanitize(&mut p);
            assert!(matches!(p, Payload::Error { message, .. } if message == expected.message()));
        }
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use crate::events::*;
    fn event(payload: Payload) -> AgentEvent {
        AgentEvent { id: "e".into(), session_id: "s".into(), tab_id: "t".into(), harness: "codex".into(), seq: 1, ts: String::new(), message_ts: None, subagent: None, payload }
    }
    #[test]
    fn silence_only_pauses_work_and_never_expires_a_permission() {
        use std::time::Duration;
        assert!(!is_stale(true, Duration::from_secs(299), Patience::DEFAULT));
        assert!(is_stale(true, Duration::from_secs(300), Patience::DEFAULT));
        assert!(!is_stale(false, Duration::from_secs(3600), Patience::DEFAULT));
    }
    #[test]
    fn restore_failure_stop_and_unknown_delivery() {
        let mut events = vec![event(Payload::Recovery { kind: Some(RecoveryKind::Capacity) })];
        assert_eq!(from_history(&events), Some(RecoveryKind::Capacity));
        events.push(event(Payload::Recovery { kind: None }));
        assert_eq!(from_history(&events), None);
        events.push(event(Payload::UserMessage { author: None, text: "Continue".into(), images: vec![], baseline: None, queued: false, cwd: None }));
        assert_eq!(from_history(&events), Some(RecoveryKind::Disconnected));
        events.push(event(Payload::Status { text: SESSION_CLOSED_MESSAGE.into() }));
        assert_eq!(from_history(&events), None);
        events.push(event(Payload::TurnCompleted { status: TurnStatus::Ok, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false, detail: None }));
        assert_eq!(from_history(&events), None);
    }
    /// A tab follows its terminal (#437): what was owed to the conversation
    /// it held before is not owed by the one that took its place.
    #[test]
    fn another_conversation_in_the_tab_starts_with_nothing_to_recover() {
        let moved_on = Payload::Conversation { id: Some("c2".into()), harness: "codex".into(), resumed: false };
        let lapsed = event(Payload::PermissionDecided { request_id: "r".into(), tool_use_id: None, allowed: false, label: "Lapsed".into(), automatic: true });
        assert_eq!(from_history(&[lapsed.clone(), event(moved_on.clone())]), None);
        let unfinished = event(Payload::UserMessage { author: None, text: "p".into(), images: vec![], baseline: None, queued: false, cwd: None });
        assert_eq!(from_history(std::slice::from_ref(&unfinished)), Some(RecoveryKind::Disconnected));
        assert_eq!(from_history(&[unfinished, event(moved_on.clone())]), None);
        // What goes wrong in the new one is its own.
        assert_eq!(from_history(&[event(moved_on), lapsed]), Some(RecoveryKind::PermissionExpired));
    }

    #[test]
    fn a_tool_failure_an_older_log_recorded_is_not_restored() {
        let events = vec![event(Payload::Recovery { kind: Some(RecoveryKind::Tool) })];
        assert_eq!(from_history(&events), None);
    }
    #[test]
    fn expired_permission_has_recovery_instead_of_working() {
        let events = vec![event(Payload::PermissionDecided { request_id: "r".into(), tool_use_id: None, allowed: false, label: "Lapsed".into(), automatic: true })];
        assert_eq!(from_history(&events), Some(RecoveryKind::PermissionExpired));
    }
    #[test]
    fn a_tool_is_never_a_session_failure_and_failed_details_are_protected() {
        assert_eq!(failure(&Payload::ToolCallCompleted { call_id: "done".into(), result: ToolResult::default() }), None);
        let mut failed = Payload::ToolCallCompleted { call_id: "failed".into(), result: ToolResult { text: "TOKEN=secret /Users/private".into(), is_error: true, structured: Some(serde_json::json!({"request": "secret"})), ..Default::default() } };
        assert_eq!(failure(&failed), None);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("diagnostics.jsonl");
        diagnose(&path, &failed);
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(std::fs::read_to_string(path).unwrap().contains("TOKEN=secret"));
        sanitize(&mut failed);
        let public = serde_json::to_string(&failed).unwrap();
        assert!(!public.contains("secret"));
        assert!(!public.contains("/Users"));
    }
    #[test]
    fn a_turn_that_ends_in_an_error_is_a_failure_and_one_that_ends_well_is_not() {
        let end = |status, final_text: Option<&str>| Payload::TurnCompleted { status, final_text: final_text.map(Into::into), usage: None, duration_ms: None, head: None, auth_failed: false, detail: None };
        assert_eq!(failure(&end(TurnStatus::Ok, None)), None);
        assert_eq!(failure(&end(TurnStatus::Aborted, None)), None);
        assert_eq!(failure(&end(TurnStatus::Error, Some("exited"))), Some(RecoveryKind::Failed));
        assert_eq!(failure(&end(TurnStatus::Error, Some("connection closed"))), Some(RecoveryKind::Disconnected));
    }
    #[test]
    fn a_retry_with_attempts_left_is_not_a_failure() {
        assert_eq!(failure(&Payload::ApiRetry { attempt: 2, max_retries: 10, reason: Some("overloaded".into()) }), None);
        let mut payloads = Vec::new();
        crate::harness::claude::transcript::decode_line(r#"{"type":"system","subtype":"api_error","error":{"message":"Overloaded"},"retryInMs":1000,"retryAttempt":2,"maxRetries":10}"#, &Default::default(), &mut payloads);
        crate::harness::codex::rollout::decode_line(r#"{"type":"event_msg","payload":{"type":"stream_error","message":"Reconnecting... 2/5"}}"#, &Default::default(), &mut payloads);
        assert_eq!(payloads.len(), 2);
        assert!(payloads.iter().all(|payload| failure(payload).is_none()), "{payloads:?}");
        // The last attempt, and an error with no attempts to count, still are.
        payloads.clear();
        crate::harness::claude::transcript::decode_line(r#"{"type":"system","subtype":"api_error","error":{"message":"Overloaded"},"retryAttempt":10,"maxRetries":10}"#, &Default::default(), &mut payloads);
        crate::harness::claude::transcript::decode_line(r#"{"type":"system","subtype":"api_error","error":{"message":"Overloaded"}}"#, &Default::default(), &mut payloads);
        crate::harness::codex::rollout::decode_line(r#"{"type":"event_msg","payload":{"type":"stream_error","message":"Reconnecting... 5/5"}}"#, &Default::default(), &mut payloads);
        crate::harness::codex::rollout::decode_line(r#"{"type":"event_msg","payload":{"type":"error","message":"stream disconnected before completion"}}"#, &Default::default(), &mut payloads);
        assert_eq!(payloads.iter().map(failure).collect::<Vec<_>>(), vec![Some(RecoveryKind::Capacity), Some(RecoveryKind::Capacity), Some(RecoveryKind::Failed), Some(RecoveryKind::Disconnected)]);
    }
    #[test]
    fn warning_limits_are_not_terminal_but_rejected_requests_are() {
        assert_eq!(failure(&Payload::RateLimited { status: Some("allowed_warning".into()), resets_at: None, window: None, message: None }), None);
        assert_eq!(failure(&Payload::RateLimited { status: Some("rejected".into()), resets_at: None, window: None, message: None }), Some(RecoveryKind::UsageLimit));
        assert_eq!(failure(&Payload::ApiRetry { attempt: 3, max_retries: 3, reason: Some("capacity".into()) }), Some(RecoveryKind::Capacity));
    }
    #[test]
    fn a_spent_plan_keeps_its_reset_time_and_window_but_not_the_provider_text() {
        let line = r#"{"type":"assistant","isApiErrorMessage":true,"error":"rate_limit","apiError":"usage_limit_reached","apiErrorStatus":429,"quotaLimits":{"status":"rejected","resetsAt":1791745200,"rateLimitType":"seven_day"},"message":{"content":[{"type":"text","text":"You've hit your weekly limit · resets Oct 11 at 11pm (Asia/Dubai)"}]}}"#;
        let mut payloads = Vec::new();
        crate::harness::claude::transcript::decode_line(line, &Default::default(), &mut payloads);
        assert_eq!(failure(&payloads[0]), Some(RecoveryKind::UsageLimit));
        sanitize(&mut payloads[0]);
        let Payload::RateLimited { status, resets_at, window, message } = &payloads[0] else { panic!("{:?}", payloads[0]) };
        assert_eq!((status.as_deref(), *resets_at, window.as_deref()), (Some("rejected"), Some(1_791_745_200_000), Some("seven_day")));
        assert_eq!(message.as_deref(), Some(RecoveryKind::UsageLimit.message()));
        // The same words from a provider that only gives text still land on the right kind.
        assert_eq!(RecoveryKind::classify("You've hit your weekly limit · resets Oct 11"), RecoveryKind::UsageLimit);
        assert_eq!(RecoveryKind::classify("rate limit exceeded, retry later"), RecoveryKind::Capacity);
    }
    #[test]
    fn a_lapsed_sign_in_is_its_own_kind_and_keeps_no_provider_text() {
        let mut payloads = Vec::new();
        crate::harness::claude::transcript::decode_line(r#"{"type":"assistant","isApiErrorMessage":true,"error":"authentication_failed","message":{"content":[{"type":"text","text":"Login expired · Please run /login"}]}}"#, &Default::default(), &mut payloads);
        assert_eq!(failure(&payloads[0]), Some(RecoveryKind::SignedOut));
        sanitize(&mut payloads[0]);
        assert!(!serde_json::to_string(&payloads[0]).unwrap().contains("Please run"));
        for text in ["Invalid API key · Please run /login", "Not logged in · Please run /login", "Your access token could not be refreshed. Please run codex login", "API Error: 401 OAuth token has expired"] {
            assert_eq!(RecoveryKind::classify(text), RecoveryKind::SignedOut, "{text}");
        }
        // Another service's 401 is that tool's failure, not the agent's sign-in.
        for text in ["GitHub API 401 Unauthorized", "POST /login failed with status 401", "error: 401 from the MCP server", "token expired for the deploy hook", "gh: not logged in to github.com", "Invalid API key for Linear"] {
            assert_ne!(RecoveryKind::classify(text), RecoveryKind::SignedOut, "{text}");
        }
        // Its own text, read back (a sanitized log, the sidebar), is the same kind.
        assert_eq!(RecoveryKind::classify(RecoveryKind::SignedOut.message()), RecoveryKind::SignedOut);
        assert_eq!(serde_json::to_value(RecoveryKind::SignedOut).unwrap(), "signed_out");
    }
    /// #667, seen 2026-10-29 with codex 0.159.1: a revoked org login fails
    /// the TUI's bootstrap in about 2 s.
    const CODEX_REVOKED: &str = "account/read failed during TUI bootstrap: account/read failed: workspace routing discovery unauthorized (401) (code -32603)";

    #[test]
    fn a_codex_that_exits_at_startup_refused_is_a_sign_in_and_says_why() {
        // As the pane has it: colours, an alternate screen left, CRLF.
        let output = format!("\x1b[?1049h\x1b[2J\x1b[H\x1b[1mCodex\x1b[0m\r\n\x1b[?1049l\x1b[31m{CODEX_REVOKED}\x1b[0m\r\n");
        let exit = EarlyExit::read(output.as_bytes());
        assert!(exit.sign_in_refused);
        assert_eq!(exit.detail.as_deref(), Some(CODEX_REVOKED));
        assert_eq!(exit.recovery(), RecoveryKind::SignedOut);
        for text in [
            "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
            "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
            "Error: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
            "Not logged in. Run `codex login` first.",
            "Token refresh failed",
            // Claude Code's own words for the same.
            "Invalid API key · Please run /login",
            "Not logged in · Please run /login",
            "API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"OAuth token has expired.\"}}",
        ] {
            assert!(EarlyExit::read(text.as_bytes()).sign_in_refused, "{text}");
        }
    }

    #[test]
    fn a_network_failure_or_a_crash_at_startup_is_not_a_sign_in() {
        for text in [
            "account/read failed during TUI bootstrap: account/read failed: workspace routing discovery failed: error sending request for url (https://chatgpt.com/backend-api/wham/accounts/check): connection refused (code -32603)",
            "failed to refresh token: error sending request: connection reset by peer",
            "token refresh failed: 503 Service Unavailable",
            "stream error: 429 Too Many Requests",
            "thread 'main' panicked at codex-rs/tui/src/app.rs:401:9: index out of bounds",
            "error: unexpected argument '--no-daemon' found",
            "codex-cli 0.401.2",
        ] {
            let exit = EarlyExit::read(text.as_bytes());
            assert!(!exit.sign_in_refused, "{text}");
            assert_eq!(exit.recovery(), RecoveryKind::Failed);
            assert!(exit.detail.is_some());
        }
        assert_eq!(EarlyExit::read(b"\x1b[2J\r\n  \r\n"), EarlyExit::default());
    }

    #[test]
    fn a_detail_is_the_last_line_with_secrets_addresses_and_homes_cut_out() {
        assert_eq!(
            detail("error: unexpected argument '--no-daemon' found\n\nUsage: codex [OPTIONS] [PROMPT]\n").as_deref(),
            Some("Usage: codex [OPTIONS] [PROMPT]")
        );
        let cut = detail("401 for ada@example.com: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0 api_key=sk-proj-abc OPENAI_API_KEY='x y' at https://user:pw@chatgpt.com/backend-api/wham?token=s3cret in /Users/ada/.codex and /home/ada/x, id 0a1b2c3d4e5f6a7b8c9d0e1f2a3b").unwrap();
        for secret in ["ada@example.com", "eyJ", "sk-proj", "'x y'", "user:pw", "backend-api", "s3cret", "/Users/ada", "/home/ada", "0a1b2c3d4e5f"] {
            assert!(!cut.contains(secret), "{secret} in {cut}");
        }
        assert!(cut.starts_with("401 for [email]: Authorization: [redacted] api_key=[redacted] OPENAI_API_KEY=[redacted] at https://chatgpt.com in ~/.codex and ~/x, id [redacted]"), "{cut}");
        // Short secrets, said as `key: value` or JSON, go too.
        for (said, shown) in [
            ("refused: password: hunter2", "refused: password: [redacted]"),
            (r#"{"refresh_token": "abc", "error": "invalid_grant"}"#, r#"{"refresh_token": [redacted], "error": "invalid_grant"}"#),
            (r#"{"password":"x"}"#, r#"{"password":[redacted]}"#),
            (r#"{"token": "ab\"cd"}"#, r#"{"token": [redacted]}"#),
            (r#"{"credentials": {"access_token": "x"}, "error": "e"}"#, r#"{"credentials": [redacted], "error": "e"}"#),
            (r#""private_key": "-----BEGIN""#, r#""private_key": [redacted]"#),
            ("proxy said Bearer abc", "proxy said Bearer [redacted]"),
            ("X-Api-Key: abc", "X-Api-Key: [redacted]"),
            ("session_cookie: abc", "session_cookie: [redacted]"),
            ("token=abc}def", "token=[redacted]"),
            // A quoted key is a key wherever its credential word is, escaped
            // JSON's among them.
            (r#"{"secret_key": "hunter2"}"#, r#"{"secret_key": [redacted]}"#),
            (r#"{"secretAccessKey": "x", "tokenValue": "y", "password_value": "z"}"#, r#"{"secretAccessKey": [redacted], "tokenValue": [redacted], "password_value": [redacted]}"#),
            (r#"{"passphrase": "hunter2"}"#, r#"{"passphrase": [redacted]}"#),
            (r#"body: "{\"password\":\"hunter2\"}""#, r#"body: "{\"password\":[redacted]}""#),
            (r#""password" = "hunter2X""#, r#""password" = [redacted]"#),
            (r#"'password'="Token hunter2X""#, "'password'=[redacted]"),
            // An `Authorization` value goes with its scheme, whatever the
            // scheme, as a `key=value` with a scheme does.
            ("Authorization: Token abc123", "Authorization: [redacted]"),
            ("Authorization: OAuth abc123", "Authorization: [redacted]"),
            ("Authorization: SSWS abc123, next", "Authorization: [redacted], next"),
            ("Authorization=Bearer abc123", "Authorization=[redacted]"),
            ("{Authorization=Bearer abc123, user=ada}", "{Authorization=[redacted], user=ada}"),
            ("auth_header=Basic dXNlcjpwYXNz", "auth_header=[redacted]"),
            ("secret=`Bearer abc`", "secret=[redacted]"),
            (r#"token: \"Bearer abc\""#, "token: [redacted]"),
            ("password=<Basic dXNlcjpwYXNz>", "password=[redacted]"),
            // A cookie, every pair of it, whatever shape its value has.
            ("Cookie: lang=en; sid=s3cr3t", "Cookie: [redacted]"),
            (r#"Cookie: sid="abc"; lang=en"#, "Cookie: [redacted]"),
            (r#"Cookie: sid="abc"#, "Cookie: [redacted]"),
            ("Set-Cookie: sid=abc; Path=/; HttpOnly", "Set-Cookie: [redacted]; HttpOnly"),
            ("Cookie=Bearer abc", "Cookie=[redacted]"),
            (r#"cookie={"sid":"abc"}"#, "cookie=[redacted]"),
            (r#"Cookie=["abc"]"#, "Cookie=[redacted]"),
            (r#"cookie=\"sid=abc\""#, "cookie=[redacted]"),
            // What one rule leaves makes the next label a phrase's start.
            ("login for ada@example.com password: hunter2", "login for [email] password: [redacted]"),
            // A value just cut starts the next phrase; a label passed over
            // still lets one in its value be read.
            (r#"token: "abc" secret: hunter2"#, "token: [redacted] secret: [redacted]"),
            (r#"Failed to refresh token: id_token: {hunter2X"}"#, "Failed to refresh token: id_token: [redacted]"),
            // `=>`, and an escaped quote left open.
            (r#"{"token" => "abc"}"#, r#"{"token" => [redacted]}"#),
            (r#"{\"api_key\":\"Bearer abc123"#, r#"{\"api_key\":[redacted]"#),
            (r#"Cookie=\"abc123"#, "Cookie=[redacted]"),
            (r"token=\'Bearer abc\'", "token=[redacted]"),
            // The Bearer rule leaves a quote that closes a value in place.
            (r#""Authorization": "Bearer $MY_TOKEN"). Only variables listed"#, r#""Authorization": [redacted]). Only variables listed"#),
            // A flag and its value.
            ("Command failed: codex login --password hunter2 --verbose", "Command failed: codex login --password [redacted] --verbose"),
            // An object or a list goes whole, strings and all, and one left
            // open, or a quote left open, goes to the end of the line.
            (r#"token={"value":"abc123"} then"#, "token=[redacted] then"),
            (r#"token={"v":"a}b"} then"#, "token=[redacted] then"),
            ("secret=[1, 2, 3] then", "secret=[redacted] then"),
            (r#""tokens": 1, "token": ["a b", "c"]"#, r#""tokens": [redacted], "token": [redacted]"#),
            (r#"auth: {"user": "x", "pw": {"v": "y"}}"#, "auth: [redacted]"),
            (r#"auth: {"user": "x", "pw": "y""#, "auth: [redacted]"),
            (r#"refused: password: "hunter2"#, "refused: password: [redacted]"),
            (r#"{"refresh_token": "abc\""#, r#"{"refresh_token": [redacted]"#),
            ("token='abc def", "token=[redacted]"),
            (r#"Cookie: "sid=abc"#, "Cookie: [redacted]"),
        ] {
            assert_eq!(detail(said).as_deref(), Some(shown), "{said}");
            assert_eq!(detail(shown).as_deref(), Some(shown), "read back: {shown}");
        }
        // An error's own words stay: a label that only starts with a
        // credential word, and one inside a phrase, as Codex's own
        // `Failed to refresh token: ` and `failed to load auth: ` are.
        for said in [
            "token refresh failed: invalid_grant",
            r#"HTTP 401 Unauthorized: {"error":{"message":"Your token has been revoked"}}"#,
            "failed to read ~/.codex/auth.json: No such file or directory",
            "Failed to authenticate: API Error: 401",
            "apiKeyHelper: command not found",
            "Failed to refresh token: 401 Unauthorized",
            r#"Failed to refresh token: {"error":"invalid_grant","error_description":"refresh token revoked"}"#,
            "failed to load auth: No such file or directory",
            "ERROR codex_core::auth: Failed to refresh token: refresh_token_reused",
            // A flag that takes no value keeps the word after it.
            "Choose one login credential source: --with-api-key or --with-access-token.",
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 100000 > 64000"}}"#,
        ] {
            assert_eq!(detail(said).as_deref(), Some(said), "{said}");
        }
        // Bounded, and the same when read back (as `sanitize` does).
        let long = detail(&"word ".repeat(200)).unwrap();
        assert_eq!(long.chars().count(), DETAIL_CHARS);
        assert!(long.ends_with('…'));
        for text in [long.as_str(), cut.as_str(), CODEX_REVOKED] {
            let once = detail(text).unwrap();
            assert_eq!(detail(&once).as_deref(), Some(once.as_str()));
        }
        // What TerminalX says of a Codex too old for an isolated launch is shown whole.
        let old = "TerminalX requires Codex's --no-daemon option to keep each session isolated. Update Codex to a version with this option (0.164.0 is verified), then retry. No agent was started.";
        assert_eq!(detail(old).as_deref(), Some(old));
    }

    #[test]
    fn a_refused_turn_keeps_its_kind_and_its_detail_through_sanitizing() {
        let refused = Payload::TurnCompleted { status: TurnStatus::Error, final_text: Some("exited".into()), usage: None, duration_ms: None, head: None, auth_failed: true, detail: Some(CODEX_REVOKED.into()) };
        assert_eq!(failure(&refused), Some(RecoveryKind::SignedOut));
        let mut public = refused.clone();
        sanitize(&mut public);
        let Payload::TurnCompleted { final_text, detail, auth_failed, .. } = &public else { unreachable!() };
        assert_eq!(final_text.as_deref(), Some(RecoveryKind::SignedOut.message()));
        assert_eq!(detail.as_deref(), Some(CODEX_REVOKED));
        assert!(*auth_failed);
        // A detail set anywhere is bounded and redacted on the way out.
        let mut error = Payload::Error { message: "Codex is not installed".into(), fatal: false, detail: Some("token=hunter2 at /Users/ada".into()) };
        sanitize(&mut error);
        assert!(matches!(&error, Payload::Error { detail: Some(detail), .. } if detail == "token=[redacted] at ~"), "{error:?}");
        // The wire: `authFailed` and `detail`, which an older log has neither of.
        let wire = serde_json::to_value(&public).unwrap();
        assert_eq!((wire["authFailed"].as_bool(), wire["detail"].as_str()), (Some(true), Some(CODEX_REVOKED)));
        let old: Payload = serde_json::from_value(serde_json::json!({"type": "turn_completed", "status": "error"})).unwrap();
        assert!(matches!(old, Payload::TurnCompleted { auth_failed: false, detail: None, .. }));
    }

    #[test]
    fn provider_capacity_records_reach_recovery() {
        let mut payloads = Vec::new();
        crate::harness::claude::transcript::decode_line(r#"{"type":"assistant","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"The model is at capacity. TOKEN=secret"}]}}"#, &Default::default(), &mut payloads);
        assert_eq!(failure(&payloads[0]), Some(RecoveryKind::Capacity));
        sanitize(&mut payloads[0]);
        assert!(!serde_json::to_string(&payloads[0]).unwrap().contains("secret"));
    }
}
