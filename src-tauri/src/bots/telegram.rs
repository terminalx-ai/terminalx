//! Telegram as a bot's chat app (PRO-481): the Bot API, read by long polling.
//!
//! The owner makes a Telegram bot of their own with @BotFather and pastes its
//! token into the bot's Channels settings. The runtime then asks Telegram for
//! what was sent to it (`getUpdates` with a `timeout`, which Telegram holds
//! open until something arrives): an outbound HTTPS request, so no public
//! address and no relay are needed. A button press comes back the same way, as
//! a callback query. Replies, reports and questions go out with `sendMessage`;
//! a question's answers are an inline keyboard.
//!
//! The token is part of every request's path (`/bot<token>/METHOD`), so no
//! error this module returns is made from the HTTP library's own: that would
//! print the address, token and all. It says what Telegram answered
//! (`description`), or what kind of failure the connection had.
//!
//! Written against the Bot API reference at core.telegram.org/bots/api as of
//! Bot API 10.4 (9 November 2026): `getMe`, `getUpdates`, `sendMessage` with
//! `reply_parameters`, `reply_markup` and `disable_notification`,
//! `answerCallbackQuery`, `editMessageReplyMarkup`, and the error object with
//! `ResponseParameters.retry_after`.

use std::time::Duration;

use serde_json::{json, Value};

use super::chat_apps::{Button, Incoming, Sender};

/// Where the Bot API is served.
pub const API: &str = "https://api.telegram.org";
/// How long one `getUpdates` waits for something to arrive, in seconds.
pub const POLL_SECONDS: u64 = 25;
/// The longest text one message takes is 4096 characters; what is longer goes in parts of at most this many.
pub const PART_CHARS: usize = 3500;

/// What went wrong with a call, in words that never carry the token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Telegram answered `ok: false`: its error code, its description, and how long to wait when it said.
    Api { code: i64, description: String, retry_after: Option<u64> },
    /// Telegram could not be reached, or answered with something that is not the Bot API's answer.
    Network(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Api { code: 401, .. } => write!(f, "Telegram refused the bot's token: make a new one with @BotFather and connect again"),
            Self::Api { code: 409, .. } => write!(f, "Another program reads this Telegram bot's messages, or it sends them to a webhook: stop it, or connect a bot of its own"),
            Self::Api { description, .. } => write!(f, "Telegram said: {description}"),
            Self::Network(what) => write!(f, "Telegram could not be reached: {what}"),
        }
    }
}

impl std::error::Error for Error {}

/// A Bot API client for one token.
pub struct Client {
    base: String,
    token: String,
    agent: ureq::Agent,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client").field("base", &self.base).finish_non_exhaustive()
    }
}

/// A token as @BotFather gives one: the bot's number, a colon, and its secret. The window checks it before saving.
#[cfg_attr(not(any(feature = "desktop", test)), allow(dead_code))]
pub fn token_shape(token: &str) -> bool {
    let Some((id, secret)) = token.split_once(':') else { return false };
    !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit()) && (30..=100).contains(&secret.len()) && secret.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

impl Client {
    /// A client of the Bot API at `base` ([`API`]).
    pub fn new(base: &str, token: &str) -> Self {
        let agent = crate::data_privacy::http_agent().timeout_connect(Duration::from_secs(15)).build();
        Self { base: base.trim_end_matches('/').to_owned(), token: token.trim().to_owned(), agent }
    }

    /// Call `method` with `body` as JSON, and read its `result`.
    fn call(&self, method: &str, body: &Value, wait: Duration) -> Result<Value, Error> {
        let url = format!("{}/bot{}/{method}", self.base, self.token);
        let answer = match self.agent.post(&url).timeout(wait).set("Content-Type", "application/json").send_string(&body.to_string()) {
            Ok(response) => response.into_string(),
            // An error status still carries the Bot API's answer: its description says why.
            Err(ureq::Error::Status(_, response)) => response.into_string(),
            Err(ureq::Error::Transport(transport)) => return Err(Error::Network(transport.kind().to_string())),
        }
        .map_err(|error| Error::Network(format!("its answer could not be read ({})", error.kind())))?;
        let value: Value = serde_json::from_str(&answer).map_err(|_| Error::Network("its answer was not the Bot API's".into()))?;
        if value["ok"].as_bool() == Some(true) {
            return Ok(value["result"].clone());
        }
        Err(Error::Api {
            code: value["error_code"].as_i64().unwrap_or_default(),
            description: super::chat_apps::one_line(value["description"].as_str().unwrap_or("no reason given")),
            retry_after: value["parameters"]["retry_after"].as_u64(),
        })
    }

    #[cfg_attr(not(any(feature = "desktop", test)), allow(dead_code))]
    /// The bot the token is for: its id, `@username` and name. A token of an account that is not a bot is refused.
    pub fn get_me(&self) -> Result<(String, String, String), Error> {
        let me = self.call("getMe", &json!({}), Duration::from_secs(20))?;
        if me["is_bot"].as_bool() != Some(true) {
            return Err(Error::Api { code: 0, description: "the token is not a bot's".into(), retry_after: None });
        }
        let id = me["id"].as_i64().map(|id| id.to_string()).ok_or_else(|| Error::Network("getMe named no bot".into()))?;
        let username = me["username"].as_str().map(|name| format!("@{}", super::chat_apps::one_line(name))).unwrap_or_default();
        Ok((id, username, super::chat_apps::one_line(me["first_name"].as_str().unwrap_or_default())))
    }

    /// What arrived from `offset` on, waiting up to `wait` seconds for something: messages and button presses only.
    pub fn get_updates(&self, offset: i64, wait: u64) -> Result<Vec<Value>, Error> {
        let body = json!({"offset": offset, "limit": 100, "timeout": wait, "allowed_updates": ["message", "callback_query"]});
        // The request is held open for `wait` seconds: the read waits that long and a little more.
        let answer = self.call("getUpdates", &body, Duration::from_secs(wait + 20))?;
        Ok(answer.as_array().cloned().unwrap_or_default())
    }

    /// Send `text` to `chat`: in parts of at most [`PART_CHARS`] characters, the first as a reply to `reply_to` when
    /// given, the buttons (one a row) under the last, silently when `silent`. The last part's message id.
    pub fn send(&self, chat: &str, text: &str, reply_to: Option<&str>, buttons: &[Button], silent: bool) -> Result<String, Error> {
        let chat_id = chat_id(chat);
        let parts = parts(text, PART_CHARS);
        let mut last = String::new();
        for (index, part) in parts.iter().enumerate() {
            let mut body = json!({"chat_id": chat_id, "text": part, "disable_notification": silent, "link_preview_options": {"is_disabled": true}});
            if let Some(message) = reply_to.filter(|_| index == 0).and_then(|id| id.parse::<i64>().ok()) {
                body["reply_parameters"] = json!({"message_id": message, "allow_sending_without_reply": true});
            }
            if index + 1 == parts.len() && !buttons.is_empty() {
                body["reply_markup"] = keyboard(buttons);
            }
            let sent = self.call("sendMessage", &body, Duration::from_secs(30))?;
            last = sent["message_id"].as_i64().map(|id| id.to_string()).unwrap_or_default();
        }
        Ok(last)
    }

    /// Tell Telegram a button press was taken, with a short note the presser sees (at most 200 characters).
    pub fn answer_press(&self, press: &str, note: &str) -> Result<(), Error> {
        let note: String = note.chars().take(200).collect();
        self.call("answerCallbackQuery", &json!({"callback_query_id": press, "text": note}), Duration::from_secs(20)).map(|_| ())
    }

    /// Take the buttons off a message: its question is answered.
    pub fn clear_buttons(&self, chat: &str, message: &str) -> Result<(), Error> {
        let message: i64 = message.parse().map_err(|_| Error::Network("no message to change".into()))?;
        self.call("editMessageReplyMarkup", &json!({"chat_id": chat_id(chat), "message_id": message, "reply_markup": {"inline_keyboard": []}}), Duration::from_secs(20)).map(|_| ())
    }
}

/// A chat id is a number; one that is not (a `@channel` name) is sent as it is.
fn chat_id(chat: &str) -> Value {
    chat.parse::<i64>().map(Value::from).unwrap_or_else(|_| Value::from(chat))
}

/// An inline keyboard of `buttons`, one a row.
pub fn keyboard(buttons: &[Button]) -> Value {
    let rows: Vec<Value> = buttons.iter().map(|button| json!([{"text": button.label, "callback_data": button.data}])).collect();
    json!({"inline_keyboard": rows})
}

/// `text` in parts of at most `limit` characters, broken at a line where one is near.
pub fn parts(text: &str, limit: usize) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() {
        return vec!["…".into()];
    }
    let mut parts = Vec::new();
    let mut rest: Vec<char> = text.chars().collect();
    while rest.len() > limit {
        let window = &rest[..limit];
        // A newline in the second half of the part, else a space there, else the limit.
        let cut = window.iter().rposition(|c| *c == '\n').filter(|at| *at > limit / 2).or_else(|| window.iter().rposition(|c| *c == ' ').filter(|at| *at > limit / 2)).unwrap_or(limit);
        parts.push(rest[..cut].iter().collect::<String>().trim_end().to_owned());
        rest = rest[cut..].iter().copied().skip_while(|c| *c == '\n' || *c == ' ').collect();
    }
    if !rest.is_empty() {
        parts.push(rest.into_iter().collect());
    }
    parts
}

fn sender(user: &Value) -> Sender {
    let first = user["first_name"].as_str().unwrap_or_default();
    let last = user["last_name"].as_str().unwrap_or_default();
    let name = format!("{first} {last}");
    let name = super::chat_apps::one_line(&name);
    let username = user["username"].as_str().map(|name| format!("@{}", super::chat_apps::one_line(name)));
    Sender {
        id: user["id"].as_i64().map(|id| id.to_string()).unwrap_or_default(),
        name: if name.is_empty() { username.clone().unwrap_or_else(|| "someone".into()) } else { name },
        handle: username,
        email: None,
        automated: user["is_bot"].as_bool().unwrap_or(false),
    }
}

/// What one update says: a text message, a button press, or nothing this module takes (an edit, a photo, a
/// member change). An edited message is never taken in: who changed it, and to what, is not a new ask.
pub fn incoming(update: &Value) -> Incoming {
    let id = update["update_id"].as_i64().unwrap_or_default();
    if let Some(press) = update.get("callback_query").filter(|press| press.is_object()) {
        let message = &press["message"];
        return Incoming::Press {
            id: press["id"].as_str().unwrap_or_default().to_owned(),
            chat: message["chat"]["id"].as_i64().map(|chat| chat.to_string()).unwrap_or_default(),
            message: message["message_id"].as_i64().map(|id| id.to_string()).unwrap_or_default(),
            sender: sender(&press["from"]),
            data: press["data"].as_str().unwrap_or_default().to_owned(),
        };
    }
    let Some(message) = update.get("message").filter(|message| message.is_object()) else { return Incoming::Ignored };
    let Some(text) = message["text"].as_str() else { return Incoming::Ignored };
    let chat = &message["chat"];
    let kind = chat["type"].as_str().unwrap_or_default();
    let direct = kind == "private";
    let chat_name = if direct {
        "Direct chat".to_owned()
    } else {
        super::chat_apps::one_line(chat["title"].as_str().or_else(|| chat["username"].as_str()).unwrap_or("A group"))
    };
    Incoming::Message {
        id: format!("telegram:{id}"),
        chat: chat["id"].as_i64().map(|chat| chat.to_string()).unwrap_or_default(),
        chat_name,
        direct,
        message: message["message_id"].as_i64().map(|id| id.to_string()).unwrap_or_default(),
        // Telegram's groups have no threads of their own: a reply goes under the message it answers.
        thread: String::new(),
        sender: if message["from"].is_object() { sender(&message["from"]) } else { Sender { automated: true, ..Sender::default() } },
        text: text.to_owned(),
        at: message["date"].as_i64().and_then(|at| chrono::DateTime::from_timestamp(at, 0)).map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)).unwrap_or_else(crate::store::index::now),
    }
}

/// The deep link that opens the chat with the bot and sends `/start <code>`, linking it at once.
pub fn start_link(username: &str, code: &str) -> Option<String> {
    let username = username.trim_start_matches('@');
    (!username.is_empty() && username.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')).then(|| format!("https://t.me/{username}?start={code}"))
}

#[cfg(test)]
#[path = "telegram_tests.rs"]
mod tests;
