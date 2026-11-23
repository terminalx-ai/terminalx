//! Slack as a bot's chat app (PRO-481): a Slack app of the owner's own, over Socket Mode.
//!
//! The owner makes a Slack app, turns Socket Mode on, and pastes two tokens
//! into the bot's Channels settings: the bot token (`xoxb-`, for the Web API)
//! and an app-level token (`xapp-`, for the socket). The runtime asks for a
//! socket address (`apps.connections.open`) and opens a WebSocket to it: an
//! outbound connection, so no public address and no relay are needed.
//! Messages (`message.im`, `app_mention`) and button presses (`block_actions`)
//! arrive on it as envelopes, each acknowledged at once with its
//! `envelope_id`. Replies, reports and questions go out with
//! `chat.postMessage`; a question's answers are Block Kit buttons, taken off
//! with `chat.update` once one is chosen.
//!
//! No token is ever part of an address here (each goes in the `Authorization`
//! header), and no error this module returns is made from the HTTP library's
//! own: it says what Slack answered (`error`), or what kind of failure the
//! connection had.
//!
//! Written against docs.slack.dev as of November 2026: Socket Mode (`hello`,
//! `disconnect`, envelopes and their acknowledgement), `apps.connections.open`,
//! `auth.test`, `users.info`, `chat.postMessage`, `chat.update`, the
//! `app_mention` and `message.im` events, the `block_actions` payload, and
//! Block Kit's section, actions and button limits.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message as Frame;

use super::chat_apps::{Button, Incoming, Sender};

/// Where the Web API is served.
pub const API: &str = "https://slack.com/api";
/// The text Slack recommends a message stays within is 4,000 characters; what is longer goes in parts of at most this many.
pub const PART_CHARS: usize = 3500;
/// A section block's text is at most 3,000 characters; a button's label at most 75.
pub const SECTION_CHARS: usize = 2900;
pub const LABEL_CHARS: usize = 75;
/// The prefix of a button's `action_id`: `terminalx_answer_<n>`.
pub const ACTION: &str = "terminalx_answer_";
/// How often a quiet socket checks whether it is still wanted.
const CHECK: Duration = Duration::from_secs(5);

/// What went wrong with a call, in words that never carry a token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Slack answered `ok: false` (or 429, with how long to wait).
    Api { error: String, retry_after: Option<u64> },
    /// Slack could not be reached, or answered with something that is not the Web API's answer.
    Network(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Api { error, .. } if error == "invalid_auth" || error == "not_authed" || error == "account_inactive" || error == "token_revoked" => {
                write!(f, "Slack refused the token ({error}): make a new one in the Slack app's settings and connect again")
            }
            Self::Api { error, .. } if error == "missing_scope" => write!(f, "The Slack app lacks a scope it needs (missing_scope): add the scopes Channels settings lists, reinstall it, and connect again"),
            Self::Api { error, .. } if error == "ratelimited" => write!(f, "Slack asked to wait (ratelimited)"),
            Self::Api { error, .. } => write!(f, "Slack said: {error}"),
            Self::Network(what) => write!(f, "Slack could not be reached: {what}"),
        }
    }
}

impl std::error::Error for Error {}

/// A Web API client for one Slack app: its bot token and its app-level token.
pub struct Client {
    base: String,
    bot_token: String,
    app_token: String,
    agent: ureq::Agent,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client").field("base", &self.base).finish_non_exhaustive()
    }
}

/// A token of the kind `prefix` names (`xoxb-`, `xapp-`), with nothing in it that could not be a token's.
#[cfg_attr(not(any(feature = "desktop", test)), allow(dead_code))]
pub fn token_shape(token: &str, prefix: &str) -> bool {
    token.starts_with(prefix) && (20..=400).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Who the bot token is: the workspace's id and name, the app's bot user, and the bot's id.
#[cfg_attr(not(any(feature = "desktop", test)), allow(dead_code))]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    pub team_id: String,
    pub team: String,
    pub user_id: String,
    pub bot_id: String,
}

impl Client {
    /// A client of the Web API at `base` ([`API`]).
    pub fn new(base: &str, bot_token: &str, app_token: &str) -> Self {
        let agent = crate::data_privacy::http_agent().timeout_connect(Duration::from_secs(15)).timeout(Duration::from_secs(30)).build();
        Self { base: base.trim_end_matches('/').to_owned(), bot_token: bot_token.trim().to_owned(), app_token: app_token.trim().to_owned(), agent }
    }

    fn read(answer: Result<ureq::Response, ureq::Error>) -> Result<Value, Error> {
        let (retry_after, body) = match answer {
            Ok(response) => (None, response.into_string()),
            Err(ureq::Error::Status(status, response)) => {
                let wait = response.header("retry-after").and_then(|value| value.trim().parse().ok());
                if status == 429 {
                    return Err(Error::Api { error: "ratelimited".into(), retry_after: wait.or(Some(30)) });
                }
                (wait, response.into_string())
            }
            Err(ureq::Error::Transport(transport)) => return Err(Error::Network(transport.kind().to_string())),
        };
        let body = body.map_err(|error| Error::Network(format!("its answer could not be read ({})", error.kind())))?;
        let value: Value = serde_json::from_str(&body).map_err(|_| Error::Network("its answer was not the Web API's".into()))?;
        if value["ok"].as_bool() == Some(true) {
            return Ok(value);
        }
        Err(Error::Api { error: super::chat_apps::one_line(value["error"].as_str().unwrap_or("unknown_error")), retry_after })
    }

    /// POST `body` as JSON to `method` with `token` in the `Authorization` header.
    fn post(&self, method: &str, token: &str, body: &Value) -> Result<Value, Error> {
        let request = self.agent.post(&format!("{}/{method}", self.base)).set("Authorization", &format!("Bearer {token}")).set("Content-Type", "application/json; charset=utf-8");
        Self::read(request.send_string(&body.to_string()))
    }

    #[cfg_attr(not(any(feature = "desktop", test)), allow(dead_code))]
    /// Who the bot token belongs to (`auth.test`).
    pub fn auth_test(&self) -> Result<Identity, Error> {
        let value = self.post("auth.test", &self.bot_token, &json!({}))?;
        let field = |key: &str| super::chat_apps::one_line(value[key].as_str().unwrap_or_default());
        let identity = Identity { team_id: field("team_id"), team: field("team"), user_id: field("user_id"), bot_id: field("bot_id") };
        if identity.bot_id.is_empty() {
            return Err(Error::Api { error: "not_a_bot_token".into(), retry_after: None });
        }
        Ok(identity)
    }

    /// The address of a new Socket Mode connection (`apps.connections.open`, with the app-level token).
    pub fn open_connection(&self) -> Result<String, Error> {
        let value = self.post("apps.connections.open", &self.app_token, &json!({}))?;
        value["url"].as_str().filter(|url| url.starts_with("wss://") || url.starts_with("ws://")).map(str::to_owned).ok_or_else(|| Error::Network("apps.connections.open gave no socket address".into()))
    }

    /// A person's name and, when the app may read it (`users:read.email`), their email; and whether they are a bot.
    pub fn user_info(&self, user: &str) -> Result<(String, Option<String>, bool), Error> {
        let url = format!("{}/users.info", self.base);
        let request = self.agent.get(&url).query("user", user).set("Authorization", &format!("Bearer {}", self.bot_token));
        let value = Self::read(request.call())?;
        let person = &value["user"];
        let name = person["profile"]["display_name"].as_str().filter(|name| !name.trim().is_empty()).or_else(|| person["real_name"].as_str()).or_else(|| person["name"].as_str()).unwrap_or("someone");
        let email = person["profile"]["email"].as_str().map(str::trim).filter(|email| !email.is_empty()).map(str::to_owned);
        Ok((super::chat_apps::one_line(name), email, person["is_bot"].as_bool().unwrap_or(false)))
    }

    /// A channel's `#name` (`conversations.info`, with `channels:read` or `groups:read`).
    pub fn channel_name(&self, channel: &str) -> Result<String, Error> {
        let url = format!("{}/conversations.info", self.base);
        let request = self.agent.get(&url).query("channel", channel).set("Authorization", &format!("Bearer {}", self.bot_token));
        let value = Self::read(request.call())?;
        let name = value["channel"]["name"].as_str().map(super::chat_apps::one_line).filter(|name| !name.is_empty()).ok_or_else(|| Error::Network("conversations.info named no channel".into()))?;
        Ok(format!("#{name}"))
    }

    /// Post `text` to `channel`, in parts of at most [`PART_CHARS`] characters, in thread `thread` when given, the
    /// buttons under the last part. The last part's `ts`.
    pub fn send(&self, channel: &str, text: &str, thread: Option<&str>, buttons: &[Button]) -> Result<String, Error> {
        let parts = super::telegram::parts(text, PART_CHARS);
        let mut last = String::new();
        for (index, part) in parts.iter().enumerate() {
            let mut body = json!({"channel": channel, "text": escape(part), "unfurl_links": false, "unfurl_media": false});
            if let Some(thread) = thread.filter(|thread| !thread.is_empty()) {
                body["thread_ts"] = json!(thread);
            }
            if index + 1 == parts.len() && !buttons.is_empty() {
                body["blocks"] = blocks(part, buttons);
            }
            let sent = self.post("chat.postMessage", &self.bot_token, &body)?;
            last = sent["ts"].as_str().unwrap_or_default().to_owned();
        }
        Ok(last)
    }

    /// Replace a message's buttons with `note`: its question is answered.
    pub fn settle(&self, channel: &str, ts: &str, text: &str, note: &str) -> Result<(), Error> {
        let section: String = text.chars().take(SECTION_CHARS).collect();
        let body = json!({
            "channel": channel, "ts": ts, "text": escape(&section),
            "blocks": [
                {"type": "section", "text": {"type": "mrkdwn", "text": escape(&section)}},
                {"type": "context", "elements": [{"type": "mrkdwn", "text": escape(note)}]},
            ],
        });
        self.post("chat.update", &self.bot_token, &body).map(|_| ())
    }
}

/// `text` as Slack reads it: `&`, `<` and `>` escaped, so nothing in it becomes a mention or a link of Slack's.
pub fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// What Slack sent, as it was written: its escapes undone.
fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

/// A section with `text`, then the buttons; the first one labelled recommended is primary.
pub fn blocks(text: &str, buttons: &[Button]) -> Value {
    let section: String = text.chars().take(SECTION_CHARS).collect();
    let elements: Vec<Value> = buttons
        .iter()
        .enumerate()
        .map(|(index, button)| {
            let mut element = json!({"type": "button", "action_id": format!("{ACTION}{index}"), "value": button.data, "text": {"type": "plain_text", "text": button.label.chars().take(LABEL_CHARS).collect::<String>()}});
            if button.primary {
                element["style"] = json!("primary");
            }
            element
        })
        .collect();
    json!([{"type": "section", "text": {"type": "mrkdwn", "text": escape(&section)}}, {"type": "actions", "elements": elements}])
}

/// `text` without the mention of `bot_user` (`<@U123>`), so a message that mentions the app reads as written to it.
fn without_mention(text: &str, bot_user: &str) -> String {
    if bot_user.is_empty() {
        return text.trim().to_owned();
    }
    text.replace(&format!("<@{bot_user}>"), "").trim().to_owned()
}

/// What one envelope's payload says. `bot_user` is the app's own user, whose own posts and mentions are not asks.
pub fn incoming(kind: &str, payload: &Value, bot_user: &str) -> Incoming {
    match kind {
        "events_api" => {
            let event = &payload["event"];
            let id = payload["event_id"].as_str().unwrap_or_default();
            let user = event["user"].as_str().unwrap_or_default();
            // Another app's post, the app's own, and every changed or deleted message: none is an ask.
            let automated = event.get("bot_id").is_some_and(|bot| !bot.is_null()) || user.is_empty() || user == bot_user;
            if event.get("subtype").is_some_and(|subtype| !subtype.is_null()) {
                return Incoming::Ignored;
            }
            let direct = match (event["type"].as_str(), event["channel_type"].as_str()) {
                (Some("message"), Some("im")) => true,
                (Some("app_mention"), _) => false,
                _ => return Incoming::Ignored,
            };
            let ts = event["ts"].as_str().unwrap_or_default().to_owned();
            let text = without_mention(&unescape(event["text"].as_str().unwrap_or_default()), bot_user);
            let at = ts.split('.').next().and_then(|seconds| seconds.parse::<i64>().ok()).and_then(|at| chrono::DateTime::from_timestamp(at, 0)).map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)).unwrap_or_else(crate::store::index::now);
            Incoming::Message {
                id: format!("slack:{id}"),
                chat: event["channel"].as_str().unwrap_or_default().to_owned(),
                chat_name: if direct { "Direct message".into() } else { String::new() },
                direct,
                // A reply goes in the thread it was asked in: the thread's, or one under the message itself.
                thread: event["thread_ts"].as_str().filter(|thread| !thread.is_empty()).map(str::to_owned).unwrap_or_else(|| if direct { String::new() } else { ts.clone() }),
                message: ts,
                sender: Sender { id: user.to_owned(), name: String::new(), handle: None, email: None, automated },
                text,
                at,
            }
        }
        "interactive" if payload["type"].as_str() == Some("block_actions") => {
            let Some(action) = payload["actions"].as_array().and_then(|actions| actions.iter().find(|action| action["action_id"].as_str().is_some_and(|id| id.starts_with(ACTION)))) else {
                return Incoming::Ignored;
            };
            Incoming::Press {
                id: String::new(),
                chat: payload["channel"]["id"].as_str().or_else(|| payload["container"]["channel_id"].as_str()).unwrap_or_default().to_owned(),
                message: payload["message"]["ts"].as_str().or_else(|| payload["container"]["message_ts"].as_str()).unwrap_or_default().to_owned(),
                sender: Sender { id: payload["user"]["id"].as_str().unwrap_or_default().to_owned(), name: super::chat_apps::one_line(payload["user"]["username"].as_str().unwrap_or_default()), handle: None, email: None, automated: false },
                data: action["value"].as_str().unwrap_or_default().to_owned(),
            }
        }
        _ => Incoming::Ignored,
    }
}

/// How one socket connection ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ended {
    /// Slack closed it or asked for a new one (`disconnect`): open another.
    Reconnect(String),
    /// It is no longer wanted.
    Stopped,
}

/// One Socket Mode connection, from its address to its end: every envelope is acknowledged at once, then handed to
/// `on` with its type and payload. `connected` is called on Slack's `hello`. `wanted` is asked every few seconds
/// and between envelopes; the connection closes when it says no.
pub fn listen(url: &str, wanted: &dyn Fn() -> bool, connected: &mut dyn FnMut(), on: &mut dyn FnMut(&str, &Value)) -> Result<Ended, Error> {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|error| Error::Network(format!("no runtime for the socket ({})", error.kind())))?;
    runtime.block_on(async {
        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(20), crate::data_privacy::connect(url, None, true))
            .await
            .map_err(|_| Error::Network("the socket did not open in time".into()))?
            .map_err(|error| Error::Network(socket_error(&error)))?;
        loop {
            if !wanted() {
                let _ = socket.close(None).await;
                return Ok(Ended::Stopped);
            }
            let frame = match tokio::time::timeout(CHECK, socket.next()).await {
                Err(_) => continue,
                Ok(None) => return Ok(Ended::Reconnect("the socket closed".into())),
                Ok(Some(Err(error))) => return Err(Error::Network(socket_error(&error))),
                Ok(Some(Ok(frame))) => frame,
            };
            let text = match frame {
                Frame::Text(text) => text.to_string(),
                Frame::Close(_) => return Ok(Ended::Reconnect("Slack closed the socket".into())),
                // Pings are answered by the socket itself; nothing else is Socket Mode's.
                _ => continue,
            };
            let Ok(envelope) = serde_json::from_str::<Value>(&text) else { continue };
            let kind = envelope["type"].as_str().unwrap_or_default().to_owned();
            if let Some(id) = envelope["envelope_id"].as_str() {
                // Acknowledged before it is handled, so Slack does not send it again while it is.
                socket.send(Frame::Text(json!({"envelope_id": id}).to_string().into())).await.map_err(|error| Error::Network(socket_error(&error)))?;
            }
            match kind.as_str() {
                "hello" => connected(),
                "disconnect" => {
                    let _ = socket.close(None).await;
                    return Ok(Ended::Reconnect(super::chat_apps::one_line(envelope["reason"].as_str().unwrap_or("asked to reconnect"))));
                }
                _ => on(&kind, &envelope["payload"]),
            }
        }
    })
}

/// A socket failure in words that carry no address: a Socket Mode address holds a ticket.
fn socket_error(error: &tokio_tungstenite::tungstenite::Error) -> String {
    use tokio_tungstenite::tungstenite::Error as E;
    match error {
        E::ConnectionClosed | E::AlreadyClosed => "the socket closed".into(),
        E::Io(io) => io.kind().to_string(),
        E::Tls(_) => "a secure connection could not be made".into(),
        E::Http(response) => format!("the socket was refused ({})", response.status()),
        E::Url(_) => "the socket address was not one".into(),
        _ => "the socket failed".into(),
    }
}

#[cfg(test)]
#[path = "slack_tests.rs"]
mod tests;
