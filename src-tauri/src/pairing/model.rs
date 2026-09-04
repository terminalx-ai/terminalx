use serde::{Deserialize, Serialize};

pub const CAPABILITY: &str = "account-bound-host-pairing.v1";
pub const OFFER_TTL_MS: i64 = 5 * 60 * 1000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEntry {
    pub id: String,
    pub label: String,
    pub platform: String,
    /// SHA-256 of the credential. The credential itself lives in Keychain.
    pub token: String,
    pub scope: DeviceScope,
    #[serde(default)]
    pub provenance: DeviceProvenance,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bound_user_id: Option<String>,
    pub binding_generation: u64,
    #[serde(default)]
    pub public_key: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_request_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceScope {
    Viewer,
    Driver,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceProvenance {
    Automatic,
    #[default]
    Explicit,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DeviceFile {
    pub devices: Vec<DeviceEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountMirror {
    pub user_id: String,
    pub email: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_display_name: Option<String>,
    pub binding_generation: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayPairingOffer {
    pub v: u8,
    pub director_url: String,
    pub cell_url: String,
    pub assignment_epoch: u64,
    pub relay_host_id: String,
    pub invite_token: String,
    pub invite_expires_at: i64,
    pub e2ee_framing: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingOffer {
    pub v: u8,
    pub endpoint: String,
    pub device_token: String,
    pub public_key_b64: String,
    pub paired_device_id: String,
    pub scope: String,
    pub identity_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay: Option<RelayPairingOffer>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    pub pairing_url: String,
    pub expires_at: i64,
    pub connection_mode: PairingConnectionMode,
    pub transport: PairingTransport,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PairingConnectionMode {
    #[default]
    Automatic,
    LocalOnly,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PairingTransport {
    Direct,
    Relay,
}

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RelayPhase {
    #[default]
    Off,
    Connecting,
    Connected,
    Offline,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    pub phase: RelayPhase,
    pub message: Option<String>,
    pub attempt: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMetadata {
    pub host_id: String,
    pub public_key: String,
    pub binding_generation: u64,
    pub display_name: String,
    pub platform: String,
    pub environment_kind: String,
    pub capabilities: Vec<String>,
    pub app_version: String,
    pub last_seen_at: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatus {
    pub relay: RelayStatus,
    pub host: Option<HostMetadata>,
    pub devices: Vec<DeviceEntry>,
    pub active_pairing: Option<PairingCode>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountPairingGrant {
    pub user_id: String,
    pub host_id: String,
    pub client_installation_id: String,
    pub grant_request_id: String,
    pub binding_generation: u64,
    pub installation_generation: u64,
    pub client_ephemeral_public_key: String,
    pub associated_data_version: u8,
    pub associated_data: String,
    pub requested_scope: String,
    pub expires_at: String,
    pub state: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountPairingRevocation {
    pub revocation_id: String,
    pub user_id: String,
    pub host_id: String,
    pub client_installation_id: String,
    pub grant_request_id: String,
    pub binding_generation: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostBindingPayload {
    pub host_id: String,
    pub host_public_key_b64: String,
    pub binding_generation: u64,
    pub display_name: String,
    pub platform: String,
    pub environment_kind: String,
    pub capabilities: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPairingEnvelope {
    pub binding_generation: u64,
    pub version: u8,
    pub algorithm: &'static str,
    pub encapsulated_key: String,
    pub ciphertext: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn binding_payload_has_only_metadata_fields() {
        let value = serde_json::to_value(HostBindingPayload {
            host_id: "abcdefghijklmnop".into(),
            host_public_key_b64: "A".repeat(43) + "=",
            binding_generation: 1,
            display_name: "Mac".into(),
            platform: "darwin".into(),
            environment_kind: "native".into(),
            capabilities: vec![CAPABILITY.into()],
        })
        .unwrap();
        assert_eq!(
            value
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec![
                "bindingGeneration",
                "capabilities",
                "displayName",
                "environmentKind",
                "hostId",
                "hostPublicKeyB64",
                "platform",
            ]
        );
        assert_eq!(value["capabilities"], json!([CAPABILITY]));
    }

    #[test]
    fn absent_provenance_is_explicit_and_never_automatic() {
        let entry: DeviceEntry = serde_json::from_value(json!({
            "id": "one",
            "label": "Phone",
            "platform": "ios",
            "token": "hash",
            "scope": "driver",
            "bindingGeneration": 0,
            "publicKey": "",
            "createdAt": "2026-01-01T00:00:00Z",
            "lastSeenAt": null,
            "revokedAt": null
        }))
        .unwrap();
        assert_eq!(entry.provenance, DeviceProvenance::Explicit);
    }

    #[test]
    fn pairing_connection_mode_is_closed_and_defaults_to_relay_capable() {
        assert_eq!(PairingConnectionMode::default(), PairingConnectionMode::Automatic);
        assert_eq!(
            serde_json::from_str::<PairingConnectionMode>("\"local-only\"").unwrap(),
            PairingConnectionMode::LocalOnly
        );
        assert!(serde_json::from_str::<PairingConnectionMode>("\"direct\"").is_err());
    }
}
