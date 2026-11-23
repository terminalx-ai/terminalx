//! PRO-481: the Telegram connector against a local server that answers as the
//! Bot API does: the address with the token, getMe, getUpdates with a message
//! and a button press, sendMessage with a reply, buttons and no sound, the
//! press answered, and errors that never carry the token.

use serde_json::json;

use super::*;
use crate::bots::chat_apps::Button;

use crate::bots::chat_app_test_server as server;

const TOKEN: &str = "123456789:AAE_secret-part-0123456789abcdefghij";

fn ok(result: serde_json::Value) -> server::Answer {
    (200, Vec::new(), json!({"ok": true, "result": result}).to_string())
}

#[test]
fn messages_and_presses_arrive_by_long_polling_and_replies_go_out_as_the_bot_api_takes_them() {
    let server = server::serve(|request| {
        let method = request.path.rsplit('/').next().unwrap_or_default();
        match method {
            "getMe" => ok(json!({"id": 42, "is_bot": true, "first_name": "Atlas", "username": "atlas_tx_bot"})),
            "getUpdates" => ok(json!([
                {"update_id": 10, "message": {"message_id": 5, "from": {"id": 7, "is_bot": false, "first_name": "Paresh", "last_name": "D", "username": "paresh"}, "chat": {"id": 7, "type": "private", "first_name": "Paresh"}, "date": 1_763_715_600, "text": "/start ABC234"}},
                {"update_id": 11, "callback_query": {"id": "cb-1", "from": {"id": 7, "is_bot": false, "first_name": "Paresh"}, "message": {"message_id": 9, "chat": {"id": 7, "type": "private"}, "date": 1_763_715_601}, "chat_instance": "ci", "data": "tx:r1:1"}},
                {"update_id": 12, "edited_message": {"message_id": 5, "chat": {"id": 7, "type": "private"}, "date": 1_763_715_600, "edit_date": 1_763_715_700, "text": "edited"}},
                {"update_id": 13, "message": {"message_id": 6, "from": {"id": 8, "is_bot": false, "first_name": "Ankit"}, "chat": {"id": -100, "type": "supergroup", "title": "Kestrel team"}, "date": 1_763_715_602, "text": "@atlas_tx_bot is CI green?"}},
                {"update_id": 14, "message": {"message_id": 7, "chat": {"id": 7, "type": "private"}, "date": 1_763_715_603, "photo": []}}
            ])),
            "sendMessage" => ok(json!({"message_id": 100 + request.body.len() % 7, "chat": {"id": 7, "type": "private"}, "date": 1_763_715_604})),
            "answerCallbackQuery" | "editMessageReplyMarkup" => ok(json!(true)),
            _ => (404, Vec::new(), json!({"ok": false, "error_code": 404, "description": "Not Found"}).to_string()),
        }
    });
    let client = Client::new(&server.base, TOKEN);

    assert_eq!(client.get_me().unwrap(), ("42".into(), "@atlas_tx_bot".into(), "Atlas".into()));
    let updates = client.get_updates(0, 0).unwrap();
    let parsed: Vec<Incoming> = updates.iter().map(incoming).collect();
    match &parsed[0] {
        Incoming::Message { id, chat, direct, message, sender, text, at, .. } => {
            assert_eq!((id.as_str(), chat.as_str(), *direct, message.as_str(), text.as_str()), ("telegram:10", "7", true, "5", "/start ABC234"));
            assert_eq!((sender.id.as_str(), sender.name.as_str(), sender.handle.as_deref(), sender.automated), ("7", "Paresh D", Some("@paresh"), false));
            assert_eq!(at, "2025-11-21T09:00:00Z");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(parsed[1], Incoming::Press { id: "cb-1".into(), chat: "7".into(), message: "9".into(), sender: Sender { id: "7".into(), name: "Paresh".into(), handle: None, email: None, automated: false }, data: "tx:r1:1".into() });
    assert_eq!(parsed[2], Incoming::Ignored, "an edited message is never taken in");
    assert!(matches!(&parsed[3], Incoming::Message { chat_name, direct: false, .. } if chat_name == "Kestrel team"));
    assert_eq!(parsed[4], Incoming::Ignored, "no text, nothing to take");

    // A long reply goes in parts: the first answers the message, the buttons go under the last, all with no sound.
    let long = format!("{}\n{}", "a".repeat(3000), "b".repeat(2000));
    let buttons = [Button { label: "Restart it".into(), data: "tx:r1:0".into(), primary: true }, Button { label: "Leave it".into(), data: "tx:r1:1".into(), primary: false }];
    client.send("7", &long, Some("5"), &buttons, true).unwrap();
    client.answer_press("cb-1", "You chose: Leave it").unwrap();
    client.clear_buttons("7", "9").unwrap();

    let requests = server.requests();
    assert!(requests.iter().all(|request| request.method == "POST" && request.path.starts_with(&format!("/bot{TOKEN}/"))), "every call is POST /bot<token>/METHOD");
    assert!(requests.iter().all(|request| request.header("content-type") == Some("application/json")));
    let poll = requests.iter().find(|request| request.path.ends_with("/getUpdates")).unwrap().json();
    assert_eq!(poll, json!({"offset": 0, "limit": 100, "timeout": 0, "allowed_updates": ["message", "callback_query"]}));
    let sent: Vec<serde_json::Value> = requests.iter().filter(|request| request.path.ends_with("/sendMessage")).map(server::Request::json).collect();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0]["chat_id"], json!(7));
    assert_eq!(sent[0]["reply_parameters"], json!({"message_id": 5, "allow_sending_without_reply": true}));
    assert!(sent[0].get("reply_markup").is_none() && sent[1].get("reply_parameters").is_none());
    assert_eq!(sent[1]["reply_markup"], json!({"inline_keyboard": [[{"text": "Restart it", "callback_data": "tx:r1:0"}], [{"text": "Leave it", "callback_data": "tx:r1:1"}]]}));
    assert!(sent.iter().all(|body| body["disable_notification"] == json!(true) && body["text"].as_str().unwrap().chars().count() <= PART_CHARS));
    assert_eq!(sent.iter().map(|body| body["text"].as_str().unwrap().len()).sum::<usize>(), 5000, "nothing lost between the parts");
    let pressed = requests.iter().find(|request| request.path.ends_with("/answerCallbackQuery")).unwrap().json();
    assert_eq!(pressed, json!({"callback_query_id": "cb-1", "text": "You chose: Leave it"}));
    let cleared = requests.iter().find(|request| request.path.ends_with("/editMessageReplyMarkup")).unwrap().json();
    assert_eq!(cleared, json!({"chat_id": 7, "message_id": 9, "reply_markup": {"inline_keyboard": []}}));
}

#[test]
fn errors_say_what_telegram_answered_and_never_carry_the_token() {
    let server = server::serve(|request| match request.path.rsplit('/').next().unwrap_or_default() {
        "getUpdates" => (409, Vec::new(), json!({"ok": false, "error_code": 409, "description": "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"}).to_string()),
        "sendMessage" => (429, Vec::new(), json!({"ok": false, "error_code": 429, "description": "Too Many Requests: retry after 7", "parameters": {"retry_after": 7}}).to_string()),
        "getMe" => (401, Vec::new(), json!({"ok": false, "error_code": 401, "description": "Unauthorized"}).to_string()),
        _ => (200, Vec::new(), "not json".into()),
    });
    let client = Client::new(&server.base, TOKEN);
    let conflict = client.get_updates(3, 0).unwrap_err();
    assert!(matches!(&conflict, Error::Api { code: 409, .. }), "{conflict:?}");
    let flood = client.send("7", "hi", None, &[], false).unwrap_err();
    assert!(matches!(flood, Error::Api { code: 429, retry_after: Some(7), .. }));
    let refused = client.get_me().unwrap_err();
    assert!(refused.to_string().contains("refused the bot's token"));
    assert!(matches!(client.answer_press("x", "y").unwrap_err(), Error::Network(_)), "an answer that is not the Bot API's");
    // Nothing listens here: the failure names its kind, never the address.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    let unreachable = Client::new(&address, TOKEN).get_me().unwrap_err();
    for error in [conflict, flood, refused, unreachable] {
        let shown = format!("{error} {error:?}");
        assert!(!shown.contains(TOKEN) && !shown.contains("secret-part"), "{shown}");
    }
    assert!(!format!("{client:?}").contains("secret-part"));
}

#[test]
fn tokens_texts_and_links_have_the_shapes_telegram_gives_and_takes() {
    assert!(token_shape(TOKEN));
    assert!(!token_shape("123456789"), "no secret");
    assert!(!token_shape("abc:AAE_secret-part-0123456789abcdefghij"), "a bot's number is digits");
    assert!(!token_shape("123:short"));
    assert!(!token_shape("123:AAE secret part 0123456789abcdefghij"), "no spaces");
    assert_eq!(parts("one", 10), ["one"]);
    assert_eq!(parts("", 10), ["…"], "Telegram takes no empty message");
    let broken = parts("first line here\nsecond line here", 20);
    assert_eq!(broken, ["first line here", "second line here"], "broken at the line");
    assert!(parts(&"é".repeat(9000), PART_CHARS).iter().all(|part| part.chars().count() <= PART_CHARS));
    assert_eq!(start_link("@atlas_tx_bot", "ABC234").as_deref(), Some("https://t.me/atlas_tx_bot?start=ABC234"));
    assert_eq!(start_link("", "ABC234"), None);
}
