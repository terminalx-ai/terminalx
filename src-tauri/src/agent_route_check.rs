//! Connection checks for personal agent routes (PRO-18): whether an
//! endpoint answers its model list with a credential, and whether a
//! credential helper prints one. The desktop runs the endpoint check from
//! this Mac before a route is saved; a cloud workspace's runtime runs both
//! from the workspace, which is the check that labels a route working
//! (`cloud_grants`).
//!
//! What a check says is an outcome, a code, an HTTP status and model ids:
//! never a response body, a header or anything a helper printed, so nothing
//! a check reports can carry the credential. Redirects are refused, as
//! Claude Code's own gateway model discovery does, so a credential is only
//! ever sent to the address the member set.
//!
//! The model lists read are the ones the CLIs document: Claude Code's
//! gateway discovery `GET /v1/models?limit=1000` (Anthropic format), and
//! `GET /models` under an OpenAI-format provider's base URL. No model id is
//! known here: the endpoint's own answer is the list.

use std::collections::HashSet;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use zeroize::Zeroizing;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// A model list is read up to this much. Large gateways' lists (hundreds of
/// models with descriptions and prices) run to a few MiB.
const RESPONSE_LIMIT_BYTES: u64 = 16 * 1024 * 1024;
/// At most this many ids are reported; the route's model is checked
/// against the whole list.
const MAX_MODELS: usize = 200;
const HELPER_OUTPUT_LIMIT: u64 = 16 * 1024;
pub const HELPER_TIMEOUT: Duration = Duration::from_secs(15);
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Which model list an endpoint answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelList {
    /// `GET <base>/v1/models?limit=1000`, `anthropic-version` set.
    Anthropic,
    /// `GET <base>/models`.
    OpenAi,
}

/// The header the credential travels in, as the CLI would send it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialHeader {
    /// `Authorization: Bearer` (Claude Code's `ANTHROPIC_AUTH_TOKEN`, Codex).
    Bearer,
    /// `x-api-key` (Claude Code's `ANTHROPIC_API_KEY`).
    ApiKey,
    /// Both, as Claude Code sends an `apiKeyHelper`'s output.
    Both,
}

pub struct Probe<'a> {
    pub list: ModelList,
    pub base_url: &'a str,
    pub credential: &'a str,
    pub header: CredentialHeader,
    /// The model the route names, if any: it must be on the list.
    pub model: Option<&'a str>,
}

/// What a check found. `outcome` is `ok` (the endpoint answered its model
/// list with the credential), `unverified` (it answered without a model
/// list, so the credential could not be checked) or `failed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checked {
    pub outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,
}

impl Checked {
    pub fn failed(code: &'static str) -> Self {
        Self { outcome: "failed", code: Some(code), http_status: None, models: Vec::new() }
    }

    fn status(outcome: &'static str, code: Option<&'static str>, status: u16) -> Self {
        Self { outcome, code, http_status: Some(status), models: Vec::new() }
    }

    pub fn passed(&self) -> bool {
        self.outcome == "ok"
    }
}

/// Bedrock routes always bring explicit credentials. Never read this machine's
/// AWS profile, metadata service, or default credential chain for a route.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BedrockCredential {
    api_key: Option<String>,
    access_key_id: Option<String>,
    secret_access_key: Option<String>,
    session_token: Option<String>,
}

impl Drop for BedrockCredential {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        for value in [&mut self.api_key, &mut self.access_key_id, &mut self.secret_access_key, &mut self.session_token].into_iter().flatten() { value.zeroize(); }
    }
}

impl BedrockCredential {
    pub fn parse(raw: &str, scheme: &str) -> Option<Self> {
        if raw.len() > 16384 { return None; }
        let value: Self = serde_json::from_str(raw).ok()?;
        let valid = |part: &Option<String>| part.as_ref().is_some_and(|text| !text.is_empty() && text.bytes().all(|c| (33..=126).contains(&c)));
        let fits = match scheme {
            "bedrock-api-key" => valid(&value.api_key) && value.access_key_id.is_none() && value.secret_access_key.is_none() && value.session_token.is_none(),
            "aws-keys" | "aws-session" => value.api_key.is_none() && valid(&value.access_key_id) && valid(&value.secret_access_key)
                && if scheme == "aws-session" { valid(&value.session_token) } else { value.session_token.is_none() && !value.access_key_id.as_ref().is_some_and(|id| id.starts_with("ASIA")) },
            _ => false,
        };
        fits.then_some(value)
    }

    pub fn env(&self) -> Vec<(String, Option<String>)> {
        [("AWS_BEARER_TOKEN_BEDROCK", &self.api_key), ("AWS_ACCESS_KEY_ID", &self.access_key_id), ("AWS_SECRET_ACCESS_KEY", &self.secret_access_key), ("AWS_SESSION_TOKEN", &self.session_token)]
            .into_iter().map(|(key, value)| (key.to_string(), value.clone())).collect()
    }
}

pub fn valid_bedrock_region(region: &str) -> bool {
    let parts: Vec<_> = region.split('-').collect();
    matches!(parts.first(), Some(&"us" | &"eu" | &"ap" | &"sa" | &"ca" | &"me" | &"af" | &"il" | &"mx" | &"cn"))
        && (parts.len() == 3 || (parts.len() == 4 && parts[1] == "gov"))
        && parts[parts.len() - 2].bytes().all(|b| b.is_ascii_lowercase())
        && !parts[parts.len() - 2].is_empty()
        && parts.last().is_some_and(|part| part.len() == 1 && part.bytes().all(|b| b.is_ascii_digit()))
}

pub fn bedrock_endpoint(region: &str) -> Option<String> {
    valid_bedrock_region(region).then(|| format!("https://bedrock-runtime.{region}.amazonaws.com{}", if region.starts_with("cn-") { ".cn" } else { "" }))
}

/// The Bedrock control plane resolves inference profiles separately from invocation.
pub fn bedrock_control_endpoint(region: &str) -> Option<String> {
    valid_bedrock_region(region).then(|| format!("https://bedrock.{region}.amazonaws.com{}", if region.starts_with("cn-") { ".cn" } else { "" }))
}

/// A model id as the server accepts one: one token, no traversal.
pub fn valid_model_id(value: &str) -> bool {
    let mut chars = value.chars();
    value.len() <= 128
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || "._:/@[]-".contains(c))
        && !value.contains("..")
}

/// An endpoint address as the server accepts one: `https`, or `http` to
/// this machine; no userinfo, query or fragment.
pub fn valid_base_url(value: &str) -> bool {
    if value.len() > 512 || value.chars().any(|c| c.is_whitespace() || c.is_control() || c == '?' || c == '#') {
        return false;
    }
    let Ok(url) = url::Url::parse(value) else { return false };
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    (url.scheme() == "https" || (url.scheme() == "http" && loopback)) && url.username().is_empty() && url.password().is_none() && url.host_str().is_some()
}

/// A helper path as the server accepts one: `./relative` or absolute, made
/// of characters a shell reads as nothing more than a path.
pub fn valid_helper_path(value: &str) -> bool {
    let rest = value.strip_prefix("./").or_else(|| value.strip_prefix('/'));
    let Some(rest) = rest else { return false };
    value.len() <= 256
        && !rest.is_empty()
        && rest.chars().all(|c| c.is_ascii_alphanumeric() || "._/-".contains(c))
        && !value.ends_with('/')
        && !value.contains("//")
        && rest.split('/').all(|segment| segment != ".." && segment != ".")
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(REQUEST_TIMEOUT).redirects(0).user_agent("terminalx-route-check").build()
}

/// Read an endpoint's model list with the credential.
pub fn probe(probe: &Probe<'_>) -> Checked {
    probe_with(&agent(), probe, RESPONSE_LIMIT_BYTES)
}

fn probe_with(agent: &ureq::Agent, probe: &Probe<'_>, limit: u64) -> Checked {
    if !valid_base_url(probe.base_url) {
        return Checked::failed("unreachable");
    }
    let base = probe.base_url.trim_end_matches('/');
    let url = match probe.list {
        ModelList::Anthropic => format!("{base}/v1/models?limit=1000"),
        ModelList::OpenAi => format!("{base}/models"),
    };
    let mut request = agent.get(&url);
    if probe.list == ModelList::Anthropic {
        request = request.set("anthropic-version", ANTHROPIC_VERSION);
    }
    let bearer = Zeroizing::new(format!("Bearer {}", probe.credential));
    if matches!(probe.header, CredentialHeader::Bearer | CredentialHeader::Both) {
        request = request.set("authorization", &bearer);
    }
    if matches!(probe.header, CredentialHeader::ApiKey | CredentialHeader::Both) {
        request = request.set("x-api-key", probe.credential);
    }
    match request.call() {
        Ok(response) if (300..400).contains(&response.status()) => Checked::status("failed", Some("redirect"), response.status()),
        Ok(response) => {
            let status = response.status();
            let mut body = Vec::new();
            if response.into_reader().take(limit + 1).read_to_end(&mut body).is_err() {
                return Checked::status("failed", Some("bad-response"), status);
            }
            // The endpoint answered with the credential, with more than is
            // read: the credential works, the model is not judged.
            if body.len() as u64 > limit {
                return Checked::status("ok", None, status);
            }
            match models_in(&body) {
                None => Checked::status("failed", Some("bad-response"), status),
                Some(models) => {
                    let unlisted = probe.model.is_some_and(|model| !models.is_empty() && !models.contains(model));
                    let mut checked = if unlisted { Checked::status("failed", Some("model-unsupported"), status) } else { Checked::status("ok", None, status) };
                    checked.models = models.iter().filter(|id| valid_model_id(id)).take(MAX_MODELS).cloned().collect();
                    checked
                }
            }
        }
        Err(ureq::Error::Status(status, _)) => match status {
            300..=399 => Checked::status("failed", Some("redirect"), status),
            401 => Checked::status("failed", Some("unauthorized"), status),
            403 => Checked::status("failed", Some("forbidden"), status),
            // Reachable, with no model list: the credential cannot be checked
            // this way, which is not the same as wrong.
            404 => Checked::status("unverified", Some("models-unlisted"), status),
            429 => Checked::status("failed", Some("rate-limited"), status),
            _ => Checked::status("failed", Some("http-error"), status),
        },
        Err(ureq::Error::Transport(transport)) => Checked::failed(transport_code(&transport)),
    }
}

fn transport_code(transport: &ureq::Transport) -> &'static str {
    let text = transport.to_string().to_ascii_lowercase();
    if text.contains("timed out") || text.contains("timeout") {
        return "timeout";
    }
    if text.contains("certificate") || text.contains("tls") || text.contains("handshake") {
        return "tls";
    }
    match transport.kind() {
        ureq::ErrorKind::TooManyRedirects => "redirect",
        _ => "unreachable",
    }
}

/// The ids an endpoint listed, in order, each once.
#[derive(Default)]
struct ListedIds {
    order: Vec<String>,
    seen: HashSet<String>,
}

impl ListedIds {
    fn push(&mut self, id: &str) {
        if self.seen.insert(id.to_string()) {
            self.order.push(id.to_string());
        }
    }

    fn contains(&self, id: &str) -> bool {
        self.seen.contains(id)
    }

    fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    fn iter(&self) -> std::slice::Iter<'_, String> {
        self.order.iter()
    }
}

/// Every id in a model list answer: `{"data":[{"id":…}]}`, the shape both
/// formats share. None when the answer is not that shape at all.
fn models_in(body: &[u8]) -> Option<ListedIds> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let data = value.get("data")?.as_array()?;
    let mut models = ListedIds::default();
    for id in data.iter().filter_map(|entry| entry.get("id").and_then(Value::as_str)) {
        models.push(id);
    }
    Some(models)
}

/// Variables an agent's own credentials travel in. A helper is checked
/// without them, as the agent runs it without them in this mode.
const AGENT_CREDENTIAL_ENV: &[&str] =
    &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY", "CURSOR_API_KEY", "TERMINALX_CODEX_ROUTE_KEY"];

/// Run a credential helper the way the agent would: no stdin, in `cwd`.
/// Its output is the credential: one line, at most 16 KiB, header-safe.
/// Errors are codes; what it printed is never part of one.
pub fn run_helper(program: &Path, cwd: &Path, timeout: Duration) -> Result<Zeroizing<String>, &'static str> {
    let metadata = std::fs::metadata(program).map_err(|_| "helper-not-found")?;
    if !metadata.is_file() {
        return Err("helper-not-found");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err("helper-not-executable");
        }
    }
    let mut command = Command::new(program);
    command.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    for name in AGENT_CREDENTIAL_ENV {
        command.env_remove(name);
    }
    let mut child = command.spawn().map_err(|error| if error.kind() == std::io::ErrorKind::PermissionDenied { "helper-not-executable" } else { "helper-failed" })?;
    let stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut out = Zeroizing::new(Vec::new());
        if let Some(stdout) = stdout {
            let _ = stdout.take(HELPER_OUTPUT_LIMIT + 1).read_to_end(&mut out);
        }
        out
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("helper-timeout");
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return Err("helper-failed"),
        }
    };
    let out = reader.join().map_err(|_| "helper-failed")?;
    if !status.success() {
        return Err("helper-failed");
    }
    if out.len() as u64 > HELPER_OUTPUT_LIMIT {
        return Err("helper-output");
    }
    let text = std::str::from_utf8(&out).map_err(|_| "helper-output")?.trim();
    if text.is_empty() {
        return Err("helper-empty");
    }
    // Claude Code refuses a helper that prints a banner or a log line with
    // the key, and a header cannot carry one either.
    if !text.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
        return Err("helper-output");
    }
    Ok(Zeroizing::new(text.to_string()))
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::net::TcpListener;
    use std::thread;

    use super::*;

    /// One answer to one request; returns the request as text.
    fn serve_once(status: &str, headers: &str, body: &str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let response = format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\n{headers}content-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            while !String::from_utf8_lossy(&request).contains("\r\n\r\n") {
                let read = stream.read(&mut buffer).unwrap_or(0);
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&request).into_owned()
        });
        (base, handle)
    }

    fn anthropic<'a>(base: &'a str, header: CredentialHeader, model: Option<&'a str>) -> Probe<'a> {
        Probe { list: ModelList::Anthropic, base_url: base, credential: "sk-gw-secret-1", header, model }
    }

    #[test]
    fn reads_an_anthropic_model_list_with_the_credential_where_the_cli_sends_it() {
        let (base, server) = serve_once("200 OK", "", r#"{"data":[{"id":"gw-sonnet"},{"id":"gw-opus"},{"id":"bad id"},{"id":"gw-sonnet"}]}"#);
        let checked = probe(&anthropic(&base, CredentialHeader::Bearer, Some("gw-opus")));
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /v1/models?limit=1000 "), "{request}");
        assert!(request.contains("authorization: Bearer sk-gw-secret-1"));
        assert!(!request.contains("x-api-key"));
        assert!(request.contains("anthropic-version: 2023-06-01"));
        assert_eq!(checked, Checked { outcome: "ok", code: None, http_status: Some(200), models: vec!["gw-sonnet".into(), "gw-opus".into()] });

        let (base, server) = serve_once("200 OK", "", r#"{"data":[]}"#);
        probe(&anthropic(&base, CredentialHeader::Both, None));
        let request = server.join().unwrap();
        assert!(request.contains("authorization: Bearer sk-gw-secret-1") && request.contains("x-api-key: sk-gw-secret-1"));
    }

    #[test]
    fn says_clearly_when_the_model_is_not_one_the_endpoint_lists() {
        let (base, server) = serve_once("200 OK", "", r#"{"data":[{"id":"gw-sonnet"}]}"#);
        let checked = probe(&anthropic(&base, CredentialHeader::ApiKey, Some("gw-opus")));
        assert!(server.join().unwrap().contains("x-api-key: sk-gw-secret-1"));
        assert_eq!((checked.outcome, checked.code), ("failed", Some("model-unsupported")));
        assert_eq!(checked.models, vec!["gw-sonnet".to_string()]);
    }

    #[test]
    fn judges_the_model_on_the_whole_list_and_reports_only_the_first_ids() {
        // A large gateway: the route's model is far past the ids reported.
        let ids: Vec<Value> = (0..250).map(|index| serde_json::json!({ "id": format!("gw-model-{index}") })).collect();
        let body = serde_json::json!({ "data": ids }).to_string();
        let (base, server) = serve_once("200 OK", "", &body);
        let checked = probe(&anthropic(&base, CredentialHeader::Bearer, Some("gw-model-240")));
        server.join().unwrap();
        assert!(checked.passed(), "{:?}", (checked.outcome, checked.code));
        assert_eq!(checked.models.len(), 200);
        let (base, server) = serve_once("200 OK", "", &body);
        let checked = probe(&anthropic(&base, CredentialHeader::Bearer, Some("gw-model-999")));
        server.join().unwrap();
        assert_eq!((checked.outcome, checked.code, checked.models.len()), ("failed", Some("model-unsupported"), 200));
    }

    #[test]
    fn a_list_too_large_to_read_passes_the_credential_without_judging_the_model() {
        let body = serde_json::json!({ "data": [{ "id": "gw-sonnet" }, { "id": "gw-haiku" }] }).to_string();
        let (base, server) = serve_once("200 OK", "", &body);
        let checked = probe_with(&agent(), &anthropic(&base, CredentialHeader::Bearer, Some("gw-opus")), 16);
        server.join().unwrap();
        assert_eq!(checked, Checked { outcome: "ok", code: None, http_status: Some(200), models: Vec::new() });
    }

    #[test]
    fn reads_an_openai_model_list_under_the_base_url() {
        let (base, server) = serve_once("200 OK", "", r#"{"object":"list","data":[{"id":"team-model"}]}"#);
        let base = format!("{base}/v1");
        let checked = probe(&Probe { list: ModelList::OpenAi, base_url: &base, credential: "key-1", header: CredentialHeader::Bearer, model: Some("team-model") });
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /v1/models "), "{request}");
        assert!(!request.contains("anthropic-version"));
        assert!(checked.passed());
    }

    #[test]
    fn masks_every_failure_to_a_code_and_never_follows_a_redirect() {
        for (status, outcome, code) in [
            ("401 Unauthorized", "failed", "unauthorized"),
            ("403 Forbidden", "failed", "forbidden"),
            ("404 Not Found", "unverified", "models-unlisted"),
            ("429 Too Many Requests", "failed", "rate-limited"),
            ("500 Internal Server Error", "failed", "http-error"),
        ] {
            let (base, server) = serve_once(status, "", r#"{"error":"bad key sk-gw-secret-1"}"#);
            let checked = probe(&anthropic(&base, CredentialHeader::Bearer, None));
            server.join().unwrap();
            assert_eq!((checked.outcome, checked.code), (outcome, Some(code)), "{status}");
            assert!(!serde_json::to_string(&checked).unwrap().contains("sk-gw-secret-1"));
        }
        let (base, server) = serve_once("307 Temporary Redirect", "location: http://127.0.0.1:9/steal\r\n", "");
        let checked = probe(&anthropic(&base, CredentialHeader::Bearer, None));
        server.join().unwrap();
        assert_eq!((checked.outcome, checked.code), ("failed", Some("redirect")));
        let (base, server) = serve_once("200 OK", "", "<html>login</html>");
        let checked = probe(&anthropic(&base, CredentialHeader::Bearer, None));
        server.join().unwrap();
        assert_eq!(checked.code, Some("bad-response"));
        // Nothing listening.
        let free = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        assert_eq!(probe(&anthropic(&format!("http://{free}"), CredentialHeader::Bearer, None)).code, Some("unreachable"));
        // An address the server would refuse is never called.
        assert_eq!(probe(&anthropic("http://example.com", CredentialHeader::Bearer, None)).code, Some("unreachable"));
    }

    #[test]
    fn shapes_match_the_server() {
        for ok in ["https://llm.example.com", "https://llm.example.com/anthropic", "http://127.0.0.1:4000", "http://localhost:1/v1"] {
            assert!(valid_base_url(ok), "{ok}");
        }
        for bad in ["http://llm.example.com", "https://u:p@llm.example.com", "https://x/?k=1", "https://x/#t", "https://x y", "ftp://x"] {
            assert!(!valid_base_url(bad), "{bad}");
        }
        for ok in ["./scripts/key", "/usr/local/bin/token", "./a-b_c.sh"] {
            assert!(valid_helper_path(ok), "{ok}");
        }
        for bad in ["scripts/key", "./", "/", "./a/../b", "./a/./b", "./a//b", "./a b", "./$(x)", "~/k", "./dir/"] {
            assert!(!valid_helper_path(bad), "{bad}");
        }
        for ok in ["gw-sonnet", "vendor/model[1m]", "us.provider.model-v1:0"] {
            assert!(valid_model_id(ok), "{ok}");
        }
        for bad in ["", "-x", "a b", "a/../b"] {
            assert!(!valid_model_id(bad), "{bad}");
        }
    }

    #[cfg(unix)]
    fn script(dir: &Path, name: &str, body: &str, mode: u32) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt as _;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn runs_a_helper_as_the_agent_would_and_reports_codes_only() {
        let dir = tempfile::tempdir().unwrap();
        let ok = script(dir.path(), "ok", "echo '  sk-helper-1  '", 0o755);
        assert_eq!(run_helper(&ok, dir.path(), HELPER_TIMEOUT).unwrap().as_str(), "sk-helper-1");
        assert_eq!(run_helper(&dir.path().join("missing"), dir.path(), HELPER_TIMEOUT).unwrap_err(), "helper-not-found");
        let plain = script(dir.path(), "plain", "echo x", 0o644);
        assert_eq!(run_helper(&plain, dir.path(), HELPER_TIMEOUT).unwrap_err(), "helper-not-executable");
        let failing = script(dir.path(), "failing", "echo sk-partial; exit 3", 0o755);
        assert_eq!(run_helper(&failing, dir.path(), HELPER_TIMEOUT).unwrap_err(), "helper-failed");
        let empty = script(dir.path(), "empty", "true", 0o755);
        assert_eq!(run_helper(&empty, dir.path(), HELPER_TIMEOUT).unwrap_err(), "helper-empty");
        let chatty = script(dir.path(), "chatty", "echo 'Fetching token...'; echo sk-helper-1", 0o755);
        assert_eq!(run_helper(&chatty, dir.path(), HELPER_TIMEOUT).unwrap_err(), "helper-output");
        let slow = script(dir.path(), "slow", "sleep 5; echo late", 0o755);
        let started = Instant::now();
        assert_eq!(run_helper(&slow, dir.path(), Duration::from_millis(200)).unwrap_err(), "helper-timeout");
        assert!(started.elapsed() < Duration::from_secs(3));
        let here = script(dir.path(), "here", "pwd", 0o755);
        let cwd = dir.path().canonicalize().unwrap();
        assert_eq!(run_helper(&here, &cwd, HELPER_TIMEOUT).unwrap().as_str(), cwd.to_str().unwrap());
    }
}
#[cfg(test)]
mod bedrock_tests {
    use super::*;

    #[test]
    fn aws_credentials_are_exclusive_and_temporary_keys_require_their_token() {
        let raw = r#"{"accessKeyId":"ASIASYNTHETIC","secretAccessKey":"synthetic-secret","sessionToken":"synthetic-session"}"#;
        let parsed = BedrockCredential::parse(raw, "aws-session").unwrap();
        let env = parsed.env();
        assert!(env.contains(&("AWS_SESSION_TOKEN".into(), Some("synthetic-session".into()))));
        assert!(env.contains(&("AWS_BEARER_TOKEN_BEDROCK".into(), None)));
        assert!(BedrockCredential::parse(raw, "aws-keys").is_none());
        assert!(BedrockCredential::parse(r#"{"accessKeyId":"ASIASYNTHETIC","secretAccessKey":"synthetic-secret"}"#, "aws-keys").is_none());
        for bad in [r#"{"apiKey":"secret","sessionToken":"extra"}"#, r#"{"apiKey":"secret","profile":"default"}"#, r#"{"apiKey":"bad\nheader"}"#] {
            assert!(BedrockCredential::parse(bad, "bedrock-api-key").is_none());
        }
        let api = BedrockCredential::parse(r#"{"apiKey":"synthetic-api-key"}"#, "bedrock-api-key").unwrap();
        assert!(api.env().contains(&("AWS_ACCESS_KEY_ID".into(), None)));
    }

    #[test]
    fn bedrock_regions_cannot_redirect_credentials() {
        assert_eq!(bedrock_endpoint("us-east-1").as_deref(), Some("https://bedrock-runtime.us-east-1.amazonaws.com"));
        assert_eq!(bedrock_endpoint("cn-north-1").as_deref(), Some("https://bedrock-runtime.cn-north-1.amazonaws.com.cn"));
        assert_eq!(bedrock_control_endpoint("us-east-1").as_deref(), Some("https://bedrock.us-east-1.amazonaws.com"));
        assert_eq!(bedrock_control_endpoint("cn-north-1").as_deref(), Some("https://bedrock.cn-north-1.amazonaws.com.cn"));
        assert!(bedrock_control_endpoint("us-east-1.evil.example").is_none());
        for bad in ["", "us-east-1.evil.example", "us-east-1/", "https://example.com", "us--1"] { assert!(bedrock_endpoint(bad).is_none(), "{bad}"); }
    }
}
