//! Signing in to an MCP server with OAuth, as the MCP authorization spec
//! describes: the server's protected-resource metadata names its
//! authorization server, TerminalX registers itself there as a public client
//! (or uses the person's own client), and the person signs in in their
//! browser with PKCE. The browser comes back to a one-off listener on this
//! Mac's loopback address; the code never leaves the Mac.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{bail, ensure, Context, Result};
use base64::Engine;
use rand_core::{OsRng, RngCore};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

use super::probe::Http;
use super::Grant;

/// The listener's port. A fixed one, so an own OAuth client can allow it.
const PORT: u16 = 47_219;
const CALLBACK_PATH: &str = "/mcp/oauth/callback";
const SIGN_IN_WAIT: Duration = Duration::from_secs(300);
/// A token this close to running out is refreshed.
const REFRESH_AHEAD: i64 = 300;

pub(crate) fn callback_url() -> String {
    format!("http://127.0.0.1:{PORT}{CALLBACK_PATH}")
}

pub(crate) fn due(grant: &Grant, now: i64) -> bool {
    grant.expires_at.is_some_and(|at| at - now < REFRESH_AHEAD)
}

pub(crate) struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
}

pub(crate) struct Client {
    pub token_endpoint: String,
    pub client_id: String,
}

pub(crate) enum Refused {
    /// The server will not refresh it: sign in again.
    Rejected,
    Failed(anyhow::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Endpoints {
    pub authorization: String,
    pub token: String,
    pub registration: Option<String>,
    pub scope: Option<String>,
}

fn secure(url: &str) -> Result<Url> {
    let parsed = Url::parse(url).context("The server gave an endpoint that is not a URL.")?;
    let loopback = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    ensure!(parsed.scheme() == "https" || parsed.scheme() == "http" && loopback, "The server gave an endpoint that is not https.");
    Ok(parsed)
}

fn get_json(http: &dyn Http, url: &str) -> Option<Value> {
    let response = http.request("GET", url, &[("Accept".into(), "application/json".into())], None).ok()?;
    if !(200..300).contains(&response.status) {
        return None;
    }
    serde_json::from_slice(&response.body).ok()
}

/// `https://host/.well-known/<name><path>` (path inserted after the
/// well-known part, as RFC 8414 and RFC 9728 say), then without the path.
fn well_known(base: &Url, name: &str) -> Vec<String> {
    let origin = base.origin().ascii_serialization();
    let path = base.path().trim_end_matches('/');
    let mut out = Vec::new();
    if !path.is_empty() {
        out.push(format!("{origin}/.well-known/{name}{path}"));
    }
    out.push(format!("{origin}/.well-known/{name}"));
    out
}

/// Where to sign in for the server at `resource`.
pub(crate) fn discover(http: &dyn Http, resource: &str) -> Result<Endpoints> {
    let resource_url = secure(resource)?;
    // The resource's metadata, from the server's own 401 when it names it.
    let mut metadata_urls = Vec::new();
    if let Ok(answer) = http.request("POST", resource, &[("Content-Type".into(), "application/json".into()), ("Accept".into(), "application/json, text/event-stream".into())], Some(super::probe::initialize().to_string().into_bytes())) {
        if let Some(named) = answer.header("www-authenticate").and_then(resource_metadata) {
            metadata_urls.push(named);
        }
    }
    metadata_urls.extend(well_known(&resource_url, "oauth-protected-resource"));
    let protected = metadata_urls.iter().filter(|u| secure(u).is_ok()).find_map(|u| get_json(http, u));
    let issuer = protected
        .as_ref()
        .and_then(|m| m.get("authorization_servers")?.as_array()?.first()?.as_str().map(String::from))
        .unwrap_or_else(|| resource_url.origin().ascii_serialization());
    let issuer_url = secure(&issuer)?;
    let mut candidates = well_known(&issuer_url, "oauth-authorization-server");
    candidates.extend(well_known(&issuer_url, "openid-configuration"));
    candidates.push(format!("{}/.well-known/openid-configuration", issuer.trim_end_matches('/')));
    let server = candidates.iter().find_map(|u| get_json(http, u)).context("The server does not say where to sign in.")?;
    let field = |name: &str| server.get(name).and_then(Value::as_str).map(String::from);
    let authorization = field("authorization_endpoint").context("The server does not say where to sign in.")?;
    let token = field("token_endpoint").context("The server does not say where to sign in.")?;
    secure(&authorization)?;
    secure(&token)?;
    let registration = field("registration_endpoint").filter(|u| secure(u).is_ok());
    let scope = protected
        .as_ref()
        .and_then(|m| m.get("scopes_supported")?.as_array().cloned())
        .map(|scopes| scopes.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "))
        .filter(|s| !s.is_empty());
    Ok(Endpoints { authorization, token, registration, scope })
}

/// `resource_metadata="…"` of a `WWW-Authenticate: Bearer …` header.
fn resource_metadata(header: &str) -> Option<String> {
    let at = header.find("resource_metadata=")? + "resource_metadata=".len();
    let rest = &header[at..];
    let value = match rest.strip_prefix('"') {
        Some(quoted) => &quoted[..quoted.find('"')?],
        None => rest.split([',', ' ']).next()?,
    };
    Some(value.to_string())
}

fn random() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn register(http: &dyn Http, endpoint: &str) -> Result<String> {
    let body = json!({
        "client_name": "TerminalX",
        "redirect_uris": [callback_url()],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none"
    });
    let response = http.request("POST", endpoint, &[("Content-Type".into(), "application/json".into()), ("Accept".into(), "application/json".into())], Some(body.to_string().into_bytes()))?;
    ensure!((200..300).contains(&response.status), "The server would not register TerminalX (HTTP {}). Add your own client under Advanced client identity.", response.status);
    let answer: Value = serde_json::from_slice(&response.body).context("The server's registration answer could not be read.")?;
    answer.get("client_id").and_then(Value::as_str).map(String::from).context("The server's registration answer has no client ID.")
}

fn form(pairs: &[(&str, &str)]) -> Vec<u8> {
    url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs).finish().into_bytes()
}

#[derive(Deserialize)]
struct TokenAnswer {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

fn token_request(http: &dyn Http, endpoint: &str, pairs: &[(&str, &str)]) -> Result<Tokens, Refused> {
    let response = http
        .request("POST", endpoint, &[("Content-Type".into(), "application/x-www-form-urlencoded".into()), ("Accept".into(), "application/json".into())], Some(form(pairs)))
        .map_err(Refused::Failed)?;
    if response.status == 400 || response.status == 401 {
        return Err(Refused::Rejected);
    }
    if !(200..300).contains(&response.status) {
        return Err(Refused::Failed(anyhow::anyhow!("The server answered HTTP {}.", response.status)));
    }
    let answer: TokenAnswer = serde_json::from_slice(&response.body).map_err(|_| Refused::Failed(anyhow::anyhow!("The server's token answer could not be read.")))?;
    if answer.access_token.is_empty() || answer.access_token.contains(['\n', '\r', '\0']) {
        return Err(Refused::Failed(anyhow::anyhow!("The server's token could not be used.")));
    }
    Ok(Tokens { access_token: answer.access_token, refresh_token: answer.refresh_token.filter(|t| !t.is_empty()), expires_in: answer.expires_in })
}

pub(crate) fn refresh(http: &dyn Http, grant: &Grant, refresh_token: &str, client_secret: Option<&str>) -> Result<Tokens, Refused> {
    let mut pairs = vec![("grant_type", "refresh_token"), ("refresh_token", refresh_token), ("client_id", grant.client_id.as_str()), ("resource", grant.resource.as_str())];
    if let Some(secret) = client_secret {
        pairs.push(("client_secret", secret));
    }
    let mut tokens = token_request(http, &grant.token_endpoint, &pairs)?;
    // A server that does not rotate refresh tokens keeps the old one.
    tokens.refresh_token = tokens.refresh_token.or_else(|| Some(refresh_token.to_string()));
    Ok(tokens)
}

/// What the browser brought back to the listener.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Callback {
    Code(String),
    Refused,
    /// Not the sign-in's own request (a favicon, another tab).
    Other,
}

pub(crate) fn parse_callback(request_line: &str, state: &str) -> Callback {
    let Some(target) = request_line.strip_prefix("GET ").and_then(|rest| rest.split(' ').next()) else { return Callback::Other };
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else { return Callback::Other };
    if url.path() != CALLBACK_PATH {
        return Callback::Other;
    }
    let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    if query.get("state").map(String::as_str) != Some(state) {
        return Callback::Other;
    }
    match query.get("code") {
        Some(code) if !code.is_empty() => Callback::Code(code.clone()),
        _ => Callback::Refused,
    }
}

fn reply(mut stream: TcpStream, status: &str, text: &str) {
    let body = format!("<!doctype html><meta charset=utf-8><title>TerminalX</title><body style=\"font:15px -apple-system,sans-serif;padding:3em;text-align:center\"><p>{text}</p></body>");
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
}

fn read_request_line(stream: &mut TcpStream) -> Option<String> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buffer = Vec::new();
    let mut byte = [0u8; 1];
    while buffer.len() < 8192 {
        if stream.read(&mut byte).ok()? == 0 {
            break;
        }
        if byte[0] == b'\n' {
            break;
        }
        buffer.push(byte[0]);
    }
    Some(String::from_utf8_lossy(&buffer).trim_end().to_string())
}

/// Wait for the browser's return with this sign-in's `state`.
fn wait_for_code(listener: &TcpListener, state: &str, deadline: Instant) -> Result<String> {
    listener.set_nonblocking(true)?;
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let line = read_request_line(&mut stream).unwrap_or_default();
                match parse_callback(&line, state) {
                    Callback::Code(code) => {
                        reply(stream, "200 OK", "Signed in. You can close this tab and go back to TerminalX.");
                        return Ok(code);
                    }
                    Callback::Refused => {
                        reply(stream, "200 OK", "The sign-in was not completed. You can close this tab.");
                        bail!("The sign-in was cancelled or refused.");
                    }
                    Callback::Other => reply(stream, "404 Not Found", "Not found."),
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => return Err(error.into()),
        }
    }
    bail!("The sign-in took too long. Try again.")
}

/// Sign in to the server at `resource` in the browser (`open`), with the
/// person's own client when they gave one.
pub(crate) fn sign_in(http: &dyn Http, resource: &str, own_client: Option<&str>, client_secret: Option<&str>, open: &dyn Fn(&str) -> Result<()>) -> Result<(Client, Tokens)> {
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
    let _one = ONE_AT_A_TIME.try_lock().map_err(|_| anyhow::anyhow!("Another MCP sign-in is open in the browser. Finish or close it first."))?;
    let endpoints = discover(http, resource)?;
    let listener = TcpListener::bind(("127.0.0.1", PORT)).with_context(|| format!("Port {PORT} on this Mac is in use, so the browser cannot come back. Try again shortly."))?;
    let client_id = match own_client {
        Some(id) => id.to_string(),
        None => register(http, endpoints.registration.as_deref().context("The server does not let TerminalX register. Add your own client under Advanced client identity.")?)?,
    };
    let verifier = random();
    let state = random();
    let mut url = Url::parse(&endpoints.authorization)?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &client_id)
            .append_pair("redirect_uri", &callback_url())
            .append_pair("code_challenge", &challenge(&verifier))
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("resource", resource);
        if let Some(scope) = &endpoints.scope {
            query.append_pair("scope", scope);
        }
    }
    open(url.as_str())?;
    let code = wait_for_code(&listener, &state, Instant::now() + SIGN_IN_WAIT)?;
    drop(listener);
    let callback = callback_url();
    let mut pairs = vec![
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", callback.as_str()),
        ("client_id", client_id.as_str()),
        ("code_verifier", verifier.as_str()),
        ("resource", resource),
    ];
    if let Some(secret) = client_secret {
        pairs.push(("client_secret", secret));
    }
    let tokens = token_request(http, &endpoints.token, &pairs).map_err(|refused| match refused {
        Refused::Rejected => anyhow::anyhow!("The server refused the sign-in."),
        Refused::Failed(error) => error,
    })?;
    Ok((Client { token_endpoint: endpoints.token, client_id }, tokens))
}
