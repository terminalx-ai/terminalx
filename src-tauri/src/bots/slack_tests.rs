//! PRO-481: the Slack connector against a local Web API and a local Socket
//! Mode socket that answer as Slack does: each token in its header, the
//! socket's address from apps.connections.open, hello, a DM and a button
//! press as envelopes acknowledged by their id, a disconnect, posts in a
//! thread with Block Kit buttons, and errors that never carry a token.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};

use super::*;

use crate::bots::chat_app_test_server as server;

const BOT_TOKEN: &str = "xoxb-1111-2222-secretbotpart";
const APP_TOKEN: &str = "xapp-1-A111-3333-secretapppart";

/// A Socket Mode endpoint: on connection it sends `hello`, then each of `envelopes`, reading the acknowledgement
/// after each one, then a `disconnect`. The acknowledgements it read.
fn socket(envelopes: Vec<Value>) -> (String, std::sync::mpsc::Receiver<Vec<Value>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("ws://{}/link/?ticket=secret-ticket", listener.local_addr().unwrap());
    let (done, acks) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async move {
            listener.set_nonblocking(true).unwrap();
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let hello = json!({"type": "hello", "num_connections": 1, "debug_info": {"host": "applink-1", "build_number": 54, "approximate_connection_time": 18060}, "connection_info": {"app_id": "A111"}});
            let _ = ws.send(Frame::Text(hello.to_string().into())).await;
            let mut read = Vec::new();
            for envelope in envelopes {
                let _ = ws.send(Frame::Text(envelope.to_string().into())).await;
                loop {
                    match ws.next().await {
                        Some(Ok(Frame::Text(text))) => {
                            read.push(serde_json::from_str::<Value>(&text).unwrap());
                            break;
                        }
                        Some(Ok(_)) => continue,
                        _ => break,
                    }
                }
            }
            let disconnect = json!({"type": "disconnect", "reason": "refresh_requested", "debug_info": {"host": "applink-1"}});
            let _ = ws.send(Frame::Text(disconnect.to_string().into())).await;
            let _ = done.send(read);
            // Held open until the client closes it.
            while let Some(Ok(_)) = ws.next().await {}
        });
    });
    (address, acks)
}

fn web_api(socket_url: String) -> server::Server {
    server::serve(move |request| {
        let ok = |value: Value| (200, Vec::new(), value.to_string());
        let method = request.path.trim_start_matches('/').split('?').next().unwrap_or_default().to_owned();
        match method.as_str() {
            "auth.test" => ok(json!({"ok": true, "url": "https://kestrel.slack.com/", "team": "Kestrel Studio", "user": "atlas", "team_id": "T111", "user_id": "U0BOT", "bot_id": "B111"})),
            "apps.connections.open" => ok(json!({"ok": true, "url": socket_url})),
            "users.info" => ok(json!({"ok": true, "user": {"id": "U2", "name": "ankit", "real_name": "Ankit Kumar", "is_bot": false, "profile": {"display_name": "", "email": "ankit@example.com"}}})),
            "conversations.info" => ok(json!({"ok": true, "channel": {"id": "C1", "name": "eng"}})),
            "chat.postMessage" => ok(json!({"ok": true, "channel": "D1", "ts": "1763715600.000200", "message": {"text": "x"}})),
            "chat.update" => ok(json!({"ok": true, "channel": "D1", "ts": "1763715600.000200", "text": "x"})),
            _ => ok(json!({"ok": false, "error": "unknown_method"})),
        }
    })
}

#[test]
fn a_socket_mode_session_acknowledges_each_envelope_and_hands_on_what_it_carries() {
    let dm = json!({
        "envelope_id": "env-1", "type": "events_api", "accepts_response_payload": false,
        "payload": {"token": "x", "team_id": "T111", "api_app_id": "A111", "type": "event_callback", "event_id": "Ev1", "event_time": 1_763_715_600,
            "event": {"type": "message", "channel": "D1", "user": "U1", "text": "is CI green? &lt;please&gt;", "ts": "1763715600.000100", "event_ts": "1763715600.000100", "channel_type": "im"}},
    });
    let press = json!({
        "envelope_id": "env-2", "type": "interactive", "accepts_response_payload": false,
        "payload": {"type": "block_actions", "user": {"id": "U1", "username": "paresh", "team_id": "T111"}, "team": {"id": "T111", "domain": "kestrel"}, "api_app_id": "A111",
            "container": {"type": "message", "message_ts": "1763715600.000200", "channel_id": "D1", "is_ephemeral": false}, "trigger_id": "t", "channel": {"id": "D1", "name": "directmessage"},
            "message": {"bot_id": "B111", "type": "message", "text": "Restart?", "user": "U0BOT", "ts": "1763715600.000200"},
            "actions": [{"action_id": "terminalx_answer_1", "block_id": "b", "text": {"type": "plain_text", "text": "Leave it"}, "value": "tx:r1:1", "type": "button", "action_ts": "1763715601.1"}]},
    });
    let (url, acks) = socket(vec![dm, press]);
    let api = web_api(url);
    let client = Client::new(&api.base, BOT_TOKEN, APP_TOKEN);
    let identity = client.auth_test().unwrap();
    assert_eq!(identity, Identity { team_id: "T111".into(), team: "Kestrel Studio".into(), user_id: "U0BOT".into(), bot_id: "B111".into() });
    let address = client.open_connection().unwrap();

    let mut hellos = 0;
    let mut got = Vec::new();
    let ended = listen(&address, &|| true, &mut || hellos += 1, &mut |kind, payload| got.push(incoming(kind, payload, "U0BOT"))).unwrap();
    assert_eq!(ended, Ended::Reconnect("refresh_requested".into()));
    assert_eq!(hellos, 1);
    assert_eq!(acks.recv().unwrap(), [json!({"envelope_id": "env-1"}), json!({"envelope_id": "env-2"})], "each envelope is acknowledged by its id alone");
    match &got[0] {
        Incoming::Message { id, chat, direct, thread, message, sender, text, at, .. } => {
            assert_eq!((id.as_str(), chat.as_str(), *direct, thread.as_str(), message.as_str()), ("slack:Ev1", "D1", true, "", "1763715600.000100"));
            assert_eq!((sender.id.as_str(), sender.automated, text.as_str(), at.as_str()), ("U1", false, "is CI green? <please>", "2025-11-21T09:00:00Z"));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(got[1], Incoming::Press { id: String::new(), chat: "D1".into(), message: "1763715600.000200".into(), sender: Sender { id: "U1".into(), name: "paresh".into(), handle: None, email: None, automated: false }, data: "tx:r1:1".into() });

    // Out: a reply in the thread it was asked in, a question with buttons, its buttons taken off; who someone is.
    let buttons = [Button { label: "Restart it".into(), data: "tx:r1:0".into(), primary: true }, Button { label: "Leave it".into(), data: "tx:r1:1".into(), primary: false }];
    assert_eq!(client.send("C1", "CI is green <@U999> & fine", Some("1763715600.000100"), &[]).unwrap(), "1763715600.000200");
    client.send("D1", "Restart the runner?", None, &buttons).unwrap();
    client.settle("D1", "1763715600.000200", "Restart the runner?", "You chose: Leave it").unwrap();
    assert_eq!(client.user_info("U2").unwrap(), ("Ankit Kumar".into(), Some("ankit@example.com".into()), false));
    assert_eq!(client.channel_name("C1").unwrap(), "#eng");

    let requests = api.requests();
    let token_of = |method: &str| requests.iter().find(|request| request.path.trim_start_matches('/').starts_with(method)).and_then(|request| request.header("authorization").map(str::to_owned));
    assert_eq!(token_of("apps.connections.open").as_deref(), Some(format!("Bearer {APP_TOKEN}").as_str()), "the socket is opened with the app-level token");
    for method in ["auth.test", "chat.postMessage", "chat.update", "users.info", "conversations.info"] {
        assert_eq!(token_of(method).as_deref(), Some(format!("Bearer {BOT_TOKEN}").as_str()), "{method} with the bot token");
    }
    assert!(requests.iter().all(|request| !request.path.contains("xox") && !request.path.contains("xapp") && !request.body.contains("secret")), "no token in an address or a body");
    let user = requests.iter().find(|request| request.path.starts_with("/users.info")).unwrap();
    assert_eq!((user.method.as_str(), user.path.as_str()), ("GET", "/users.info?user=U2"));
    let posts: Vec<Value> = requests.iter().filter(|request| request.path == "/chat.postMessage").map(server::Request::json).collect();
    assert!(requests.iter().filter(|request| request.method == "POST").all(|request| request.header("content-type") == Some("application/json; charset=utf-8")));
    assert_eq!(posts[0], json!({"channel": "C1", "text": "CI is green &lt;@U999&gt; &amp; fine", "thread_ts": "1763715600.000100", "unfurl_links": false, "unfurl_media": false}), "escaped, so nothing in it pings anyone");
    assert_eq!(posts[1]["blocks"][1]["elements"], json!([
        {"type": "button", "action_id": "terminalx_answer_0", "value": "tx:r1:0", "text": {"type": "plain_text", "text": "Restart it"}, "style": "primary"},
        {"type": "button", "action_id": "terminalx_answer_1", "value": "tx:r1:1", "text": {"type": "plain_text", "text": "Leave it"}},
    ]));
    assert_eq!(posts[1]["blocks"][0], json!({"type": "section", "text": {"type": "mrkdwn", "text": "Restart the runner?"}}));
    let update = requests.iter().find(|request| request.path == "/chat.update").unwrap().json();
    assert_eq!((update["channel"].clone(), update["ts"].clone()), (json!("D1"), json!("1763715600.000200")));
    assert_eq!(update["blocks"][1], json!({"type": "context", "elements": [{"type": "mrkdwn", "text": "You chose: Leave it"}]}), "the buttons go, and what was chosen is said");
}

#[test]
fn a_session_that_is_no_longer_wanted_closes() {
    let (url, _acks) = socket(Vec::new());
    let ended = listen(&url, &|| false, &mut || {}, &mut |_, _| {}).unwrap();
    assert_eq!(ended, Ended::Stopped);
}

#[test]
fn only_messages_to_the_app_are_asks_and_a_mention_is_answered_in_its_thread() {
    let event = |event: Value| json!({"event_id": "Ev9", "team_id": "T111", "event": event});
    let mention = incoming("events_api", &event(json!({"type": "app_mention", "user": "U1", "text": "<@U0BOT> look at CI", "ts": "1763715600.000300", "channel": "C1", "event_ts": "1763715600.000300"})), "U0BOT");
    assert!(matches!(&mention, Incoming::Message { direct: false, thread, text, chat, .. } if thread == "1763715600.000300" && text == "look at CI" && chat == "C1"), "{mention:?}");
    let in_thread = incoming("events_api", &event(json!({"type": "app_mention", "user": "U1", "text": "<@U0BOT> and now?", "ts": "1763715600.000400", "thread_ts": "1763715600.000300", "channel": "C1"})), "U0BOT");
    assert!(matches!(&in_thread, Incoming::Message { thread, .. } if thread == "1763715600.000300"));
    for ignored in [
        json!({"type": "message", "subtype": "message_changed", "channel": "D1", "channel_type": "im", "ts": "1"}),
        json!({"type": "message", "channel": "C1", "channel_type": "channel", "user": "U1", "text": "chatter", "ts": "1"}),
        json!({"type": "reaction_added", "user": "U1"}),
    ] {
        assert_eq!(incoming("events_api", &event(ignored.clone()), "U0BOT"), Incoming::Ignored, "{ignored}");
    }
    let from_a_bot = incoming("events_api", &event(json!({"type": "message", "channel": "D1", "channel_type": "im", "user": "U5", "bot_id": "B9", "text": "hi", "ts": "1"})), "U0BOT");
    assert!(matches!(from_a_bot, Incoming::Message { sender: Sender { automated: true, .. }, .. }));
    let own = incoming("events_api", &event(json!({"type": "message", "channel": "D1", "channel_type": "im", "user": "U0BOT", "text": "my own post", "ts": "1"})), "U0BOT");
    assert!(matches!(own, Incoming::Message { sender: Sender { automated: true, .. }, .. }));
    assert_eq!(incoming("interactive", &json!({"type": "block_actions", "actions": [{"action_id": "someone_elses", "value": "x"}]}), "U0BOT"), Incoming::Ignored);
}

#[test]
fn errors_say_what_slack_answered_and_never_carry_a_token() {
    let api = server::serve(|request| match request.path.trim_start_matches('/') {
        "auth.test" => (200, Vec::new(), json!({"ok": false, "error": "invalid_auth"}).to_string()),
        "chat.postMessage" => (429, vec![("Retry-After".into(), "12".into())], String::new()),
        "apps.connections.open" => (200, Vec::new(), json!({"ok": true}).to_string()),
        _ => (200, Vec::new(), json!({"ok": false, "error": "missing_scope", "needed": "users:read.email"}).to_string()),
    });
    let client = Client::new(&api.base, BOT_TOKEN, APP_TOKEN);
    let refused = client.auth_test().unwrap_err();
    assert!(refused.to_string().contains("refused the token (invalid_auth)"));
    let limited = client.send("C1", "hi", None, &[]).unwrap_err();
    assert_eq!(limited, Error::Api { error: "ratelimited".into(), retry_after: Some(12) });
    assert!(matches!(client.open_connection().unwrap_err(), Error::Network(_)), "no address to open");
    assert!(client.user_info("U1").unwrap_err().to_string().contains("missing_scope"));
    let shown = format!("{refused} {refused:?} {limited} {client:?}");
    assert!(!shown.contains("secret"), "{shown}");
    assert!(token_shape(BOT_TOKEN, "xoxb-") && token_shape(APP_TOKEN, "xapp-"));
    assert!(!token_shape(APP_TOKEN, "xoxb-") && !token_shape("xoxb-short", "xoxb-") && !token_shape("xoxb-1111-2222-has space-in-it", "xoxb-"));
    assert_eq!(escape("<!channel> & <@U1>"), "&lt;!channel&gt; &amp; &lt;@U1&gt;");
    let label = blocks("q", &[Button { label: "x".repeat(100), data: "d".into(), primary: false }]);
    assert_eq!(label[1]["elements"][0]["text"]["text"].as_str().unwrap().chars().count(), LABEL_CHARS);
}
