//! Accepted PRO-125 wire values. Cursor strings never pass through floating point.
use serde::{Deserialize, Deserializer, Serialize};
use std::io::{BufRead, BufReader, Read};

pub fn valid_cursor(value: &str) -> bool {
    !value.is_empty()
        && (value == "0" || !value.starts_with('0'))
        && value.bytes().all(|b| b.is_ascii_digit())
        && value.parse::<i64>().is_ok()
}

fn cursor<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if valid_cursor(&value) {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("invalid inbox cursor"))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum InboxEvent {
    #[serde(rename = "workspace.share-added")]
    ShareAdded {
        #[serde(deserialize_with = "cursor")]
        id: String,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "organizationId")]
        organization_id: String,
        payload: EmptyPayload,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    // Deliberately no organization or payload, even if an unexpected server sends them.
    #[serde(rename = "workspace.share-removed")]
    ShareRemoved {
        #[serde(deserialize_with = "cursor")]
        id: String,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "workspace.read-marker-changed")]
    ReadMarkerChanged {
        #[serde(deserialize_with = "cursor")]
        id: String,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "organizationId")]
        organization_id: String,
        payload: ReadMarker,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "workspace.presence-changed")]
    PresenceChanged {
        #[serde(deserialize_with = "cursor")]
        id: String,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "organizationId")]
        organization_id: String,
        payload: EmptyPayload,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "workspace.reassigned")]
    Reassigned {
        #[serde(deserialize_with = "cursor")]
        id: String,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "organizationId")]
        organization_id: String,
        payload: ReassignedPayload,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    /// Requested with `mentions=1` (PRO-141). Ids only: the message is read from the local transcript.
    #[serde(rename = "workspace.mentioned")]
    Mentioned {
        #[serde(deserialize_with = "cursor")]
        id: String,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "organizationId")]
        organization_id: String,
        payload: MentionedPayload,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "workspace.nudged")]
    Nudged {
        #[serde(deserialize_with = "cursor")]
        id: String,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "organizationId")]
        organization_id: String,
        payload: NudgedPayload,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
}
impl InboxEvent {
    pub fn id(&self) -> &str {
        match self {
            Self::ShareAdded { id, .. }
            | Self::ShareRemoved { id, .. }
            | Self::ReadMarkerChanged { id, .. }
            | Self::PresenceChanged { id, .. }
            | Self::Reassigned { id, .. }
            | Self::Mentioned { id, .. }
            | Self::Nudged { id, .. } => id,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EmptyPayload {}

/// Notes are plain text, delivered only to the target by authorized inbox replay.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReassignedPayload {
    pub actor_id: String,
    pub previous_owner_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Who mentioned this person, and where. Never the message text.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionedPayload {
    pub actor_id: String,
    pub session_id: String,
    pub tab_id: String,
    pub message_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NudgedPayload {
    pub actor_id: String,
    pub session_id: String,
    #[serde(default, deserialize_with = "nudge_text", skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

impl std::fmt::Debug for NudgedPayload {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("NudgedPayload").finish_non_exhaustive()
    }
}

fn nudge_text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    let text = Option::<String>::deserialize(deserializer)?;
    Ok(text.filter(|text| (1..=240).contains(&text.chars().count()) && !text.chars().any(char::is_control)))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadMarker {
    pub session_id: String,
    pub read_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxPage {
    pub v: u8,
    #[serde(deserialize_with = "cursor")]
    pub cursor: String,
    pub has_more: bool,
    pub events: Vec<InboxEvent>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct InboxReceipt {
    pub acknowledged: bool,
}

/// One SSE page: caller applies/deduplicates events before persisting cursor.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct InboxStreamPage {
    pub cursor: String,
    pub events: Vec<InboxEvent>,
}

/// Stop at the first checkpoint so IPC stays bounded. An incomplete page is
/// discarded: poll from the last committed cursor after any close/error.
pub fn read_stream(reader: impl Read) -> Result<InboxStreamPage, ()> {
    let mut reader = BufReader::new(reader.take(2 * 1024 * 1024));
    let (mut kind, mut id, mut data) = (String::new(), String::new(), String::new());
    let mut events = Vec::new();
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).map_err(|_| ())? == 0 {
            return Err(());
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            if kind == "inbox" {
                let event: InboxEvent = serde_json::from_str(data.trim_end()).map_err(|_| ())?;
                if event.id() != id || events.len() >= 100 {
                    return Err(());
                }
                events.push(event);
            } else if kind == "checkpoint" {
                #[derive(Deserialize)]
                struct Checkpoint {
                    #[serde(deserialize_with = "cursor")]
                    cursor: String,
                }
                let checkpoint: Checkpoint =
                    serde_json::from_str(data.trim_end()).map_err(|_| ())?;
                if checkpoint.cursor != id
                    || events.iter().any(|event: &InboxEvent| {
                        event.id().parse::<i64>().unwrap()
                            > checkpoint.cursor.parse::<i64>().unwrap()
                    })
                {
                    return Err(());
                }
                return Ok(InboxStreamPage {
                    cursor: checkpoint.cursor,
                    events,
                });
            }
            kind.clear();
            id.clear();
            data.clear();
        } else if let Some((key, value)) = line.split_once(':') {
            let value = value.strip_prefix(' ').unwrap_or(value);
            match key {
                "event" => kind = value.into(),
                "id" => id = value.into(),
                "data" => {
                    data.push_str(value);
                    data.push('\n');
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
#[test]
fn phase2_team_nudges_decode_live_and_redacted_events_without_logging_text() {
    use serde_json::{json, to_value};
    let event = |text: Option<&str>| {
        let mut payload = json!({"actorId":"actor", "sessionId":"session"});
        if let Some(text) = text { payload["text"] = json!(text); }
        serde_json::from_value::<InboxEvent>(json!({
            "id":"21", "type":"workspace.nudged", "organizationId":"org",
            "workspaceId":"workspace", "createdAt":"2026-11-25T10:00:00Z", "payload":payload
        })).unwrap()
    };
    let live = event(Some("private text"));
    assert!(!format!("{live:?}").contains("private text"));
    assert_eq!(to_value(live).unwrap()["payload"]["text"], "private text");
    for event in [event(None), event(Some("invalid\ntext"))] {
        assert!(to_value(event).unwrap()["payload"].get("text").is_none());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase2_presence_and_reassigned_payloads_survive_checkpoint_without_private_extras() {
        let presence = serde_json::json!({"id":"9007199254740993","type":"workspace.presence-changed","organizationId":"org","workspaceId":"workspace","payload":{},"createdAt":"2026-11-15T12:00:00Z"});
        let wire = format!("event: inbox\nid: 9007199254740993\ndata: {}\n\nevent: checkpoint\nid: 9007199254740994\ndata: {{\"cursor\":\"9007199254740994\"}}\n\n", presence);
        let page = read_stream(wire.as_bytes()).unwrap();
        assert_eq!(page.cursor, "9007199254740994");
        assert_eq!(serde_json::to_value(&page.events[0]).unwrap(), presence);
        let event: InboxEvent = serde_json::from_value(serde_json::json!({"id":"4","type":"workspace.reassigned","organizationId":"org","workspaceId":"workspace","createdAt":"2026-11-15T12:00:00Z","payload":{"actorId":"actor","previousOwnerId":"old","note":"Away until Monday\nPlease finish.","receiptDigest":"must-not-cross"}})).unwrap();
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["payload"], serde_json::json!({"actorId":"actor","previousOwnerId":"old","note":"Away until Monday\nPlease finish."}));
    }

    #[test]
    fn phase2_mention_event_carries_ids_only_and_drops_anything_else() {
        let mention = serde_json::json!({"id":"21","type":"workspace.mentioned","organizationId":"org","workspaceId":"workspace","createdAt":"2026-11-25T10:00:00Z",
            "payload":{"actorId":"actor","sessionId":"session-1","tabId":"tab-1","messageId":"msg-1","text":"must-not-cross"}});
        let event: InboxEvent = serde_json::from_value(mention).unwrap();
        assert_eq!(event.id(), "21");
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["type"], "workspace.mentioned");
        assert_eq!(value["payload"], serde_json::json!({"actorId":"actor","sessionId":"session-1","tabId":"tab-1","messageId":"msg-1"}));
        let incomplete = serde_json::json!({"id":"22","type":"workspace.mentioned","organizationId":"org","workspaceId":"workspace","createdAt":"2026-11-25T10:00:00Z","payload":{"actorId":"actor"}});
        assert!(serde_json::from_value::<InboxEvent>(incomplete).is_err());
    }

    #[test]
    fn phase2_desktop_contract_sse_rejects_mismatched_or_incomplete_checkpoints() {
        for invalid in [
            "event: checkpoint\nid: 2\ndata: {\"cursor\":\"3\"}\n\n",
            "event: checkpoint\nid: 2\ndata: {\"cursor\":2}\n\n",
            "event: checkpoint\nid: 2\ndata: {\"cursor\":\"2\"}",
            "event: inbox\nid: 2\ndata: {\"id\":\"3\",\"type\":\"workspace.share-removed\",\"workspaceId\":\"w\",\"createdAt\":\"2026-11-14T12:00:00Z\"}\n\n",
        ] {
            assert!(read_stream(invalid.as_bytes()).is_err());
        }
    }
}
