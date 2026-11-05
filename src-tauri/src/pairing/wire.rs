//! How much one paired-device connection carries in a WebSocket message, and
//! how a larger message crosses it (#669).
//!
//! The relay cell closes both legs of a connection on any message over its
//! `maxPayloadLength`, so a reply that was fine on the same Wi-Fi took every
//! request on a Relay connection down with it. Each message now either fits
//! its connection or, once the phone has said it reassembles them, crosses as
//! fragments. A message neither can carry never reaches the socket.
//!
//! A fragment is one binary E2EE frame. Each is sealed on its own, so the
//! nonce counter stays strictly in order, and binary frames are not base64
//! encoded, so fragments cost less on the wire than the text frame they
//! replace. Its plaintext is a 12 byte header, then that part of the message:
//!
//! | bytes | value |
//! |---|---|
//! | 0 | `0x66` (`f`; terminal stream frames start with `t`) |
//! | 1 | version, 1 |
//! | 2..4 | zero |
//! | 4..8 | length of the whole message, u32 little endian |
//! | 8..12 | offset of this part in it, u32 little endian |
//!
//! A sender writes one message's fragments back to back, in order, from
//! offset 0. The message is complete when a part ends at its length.

use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{bail, Result};
use serde_json::{json, Value};

use super::PAIRING_MESSAGE_BYTES_LIMIT;

/// The relay cell's `maxPayloadLength` (`terminalx-server`,
/// `apps/relay/src/cell/cell-server.ts`). One larger message closes both legs.
pub(super) const RELAY_MESSAGE_BYTES_LIMIT: usize = 1024 * 1024;
/// The largest message either side reassembles from fragments: the same as
/// the largest single message a direct connection reads.
pub(super) const FRAGMENTED_MESSAGE_BYTES_LIMIT: usize = PAIRING_MESSAGE_BYTES_LIMIT;
/// The version of fragments this desktop sends and reads.
pub(super) const FRAGMENTS_VERSION: u8 = 1;
/// Nonce, Poly1305 tag and the sealed header: session id, direction, kind and counter.
const E2EE_FRAME_OVERHEAD: usize = 24 + 16 + 32 + 1 + 1 + 8;
const FRAGMENT_MAGIC: u8 = b'f';
const FRAGMENT_HEADER_BYTES: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Transport {
    Direct,
    Relay,
}

impl Transport {
    /// The largest WebSocket message this desktop sends on the transport.
    const fn wire_budget(self) -> usize {
        match self {
            // The pairing socket's own limit, less 2 MiB for WebSocket framing
            // and control frames buffered behind a message.
            Transport::Direct => PAIRING_MESSAGE_BYTES_LIMIT - 2 * 1024 * 1024,
            // Headroom only: the cell counts the payload, not the frame header.
            Transport::Relay => RELAY_MESSAGE_BYTES_LIMIT - 4 * 1024,
        }
    }

    /// The largest plaintext that crosses as one text frame: sealed, then base64 encoded.
    pub(super) const fn text_plaintext_limit(self) -> usize {
        self.wire_budget() / 4 * 3 - E2EE_FRAME_OVERHEAD
    }

    const fn fragment_data_limit(self) -> usize {
        self.wire_budget() - E2EE_FRAME_OVERHEAD - FRAGMENT_HEADER_BYTES
    }

    fn describe(self) -> &'static str {
        match self {
            Transport::Direct => "to this phone",
            Transport::Relay => "over Relay",
        }
    }
}

/// How large a transcript reply may be. Both include the whole RPC response.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ReplyLimits {
    /// A page of events. It always fits one frame: quick to show, and within
    /// reach of a phone that does not reassemble fragments.
    pub page: usize,
    /// One event too large for a page is sent alone, up to this; a larger one
    /// is cut down to it.
    pub single: usize,
}

/// One connection's transport, and whether its phone reassembles fragments.
pub(super) struct Wire {
    transport: Transport,
    fragments: AtomicBool,
}

/// What becomes of one outgoing message.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Delivery {
    Frame,
    Fragments,
    TooLarge,
}

impl Wire {
    pub(super) fn new(transport: Transport) -> Self {
        Self { transport, fragments: AtomicBool::new(false) }
    }

    /// The phone asked for fragments. True when this desktop sends them.
    pub(super) fn negotiate(&self, version: Option<u64>) -> bool {
        let agreed = version == Some(u64::from(FRAGMENTS_VERSION));
        if agreed {
            self.fragments.store(true, Ordering::SeqCst);
        }
        agreed
    }

    pub(super) fn fragments(&self) -> bool {
        self.fragments.load(Ordering::SeqCst)
    }

    /// The largest message this connection carries in any form.
    pub(super) fn message_limit(&self) -> usize {
        if self.fragments() {
            FRAGMENTED_MESSAGE_BYTES_LIMIT
        } else {
            self.transport.text_plaintext_limit()
        }
    }

    pub(super) fn reply_limits(&self, cap: usize) -> ReplyLimits {
        let page = self.transport.text_plaintext_limit().min(cap);
        ReplyLimits { page, single: if self.fragments() { cap.max(page) } else { page } }
    }

    pub(super) fn delivery(&self, plaintext_bytes: usize) -> Delivery {
        if plaintext_bytes <= self.transport.text_plaintext_limit() {
            Delivery::Frame
        } else if self.fragments() && plaintext_bytes <= FRAGMENTED_MESSAGE_BYTES_LIMIT {
            Delivery::Fragments
        } else {
            Delivery::TooLarge
        }
    }

    pub(super) fn fragments_of<'a>(&self, message: &'a [u8]) -> impl Iterator<Item = Vec<u8>> + 'a {
        encode_fragments(message, self.transport.fragment_data_limit())
    }

    /// Sent instead of a reply this connection cannot carry: that request
    /// fails, the connection stays up.
    pub(super) fn too_large_response(&self, id: &str, plaintext_bytes: usize) -> Value {
        let advice = match (self.transport, self.fragments()) {
            (Transport::Relay, false) => " Update TerminalX on this phone, or connect on the same Wi-Fi as your Mac.",
            _ => " Open it on your Mac instead.",
        };
        json!({
            "id": id,
            "ok": false,
            "error": {
                "code": "message_too_large",
                "message": format!(
                    "This reply is too large to send {} ({}; the limit is {}).{advice}",
                    self.transport.describe(),
                    megabytes(plaintext_bytes),
                    megabytes(self.message_limit()),
                ),
            },
            "_meta": { "runtimeId": "desktop" },
        })
    }
}

pub(super) fn megabytes(bytes: usize) -> String {
    format!("{:.1} MB", bytes as f64 / 1_000_000.0)
}

fn encode_fragments(message: &[u8], data_limit: usize) -> impl Iterator<Item = Vec<u8>> + '_ {
    let total = u32::try_from(message.len()).expect("a fragmented message is bounded well below 4 GiB");
    message.chunks(data_limit).scan(0u32, move |offset, data| {
        let mut fragment = Vec::with_capacity(FRAGMENT_HEADER_BYTES + data.len());
        fragment.extend_from_slice(&[FRAGMENT_MAGIC, FRAGMENTS_VERSION, 0, 0]);
        fragment.extend_from_slice(&total.to_le_bytes());
        fragment.extend_from_slice(&offset.to_le_bytes());
        fragment.extend_from_slice(data);
        *offset += data.len() as u32;
        Some(fragment)
    })
}

/// Rebuilds the messages a phone sent as fragments.
#[derive(Default)]
pub(super) struct Reassembly {
    message: Option<(usize, Vec<u8>)>,
}

impl Reassembly {
    /// One binary frame's plaintext. A whole message once its last part
    /// arrives; `None` for an earlier part, or for a binary frame that is not
    /// a fragment. A malformed or out of order part is an error.
    pub(super) fn push(&mut self, frame: &[u8]) -> Result<Option<Vec<u8>>> {
        if frame.first() != Some(&FRAGMENT_MAGIC) {
            return Ok(None);
        }
        if frame.len() <= FRAGMENT_HEADER_BYTES || frame[1] != FRAGMENTS_VERSION || frame[2..4] != [0, 0] {
            bail!("malformed message fragment");
        }
        let total = u32::from_le_bytes(frame[4..8].try_into().unwrap()) as usize;
        let offset = u32::from_le_bytes(frame[8..12].try_into().unwrap()) as usize;
        let data = &frame[FRAGMENT_HEADER_BYTES..];
        if total > FRAGMENTED_MESSAGE_BYTES_LIMIT {
            bail!("fragmented message is larger than {}", megabytes(FRAGMENTED_MESSAGE_BYTES_LIMIT));
        }
        let (expected, mut message) = match self.message.take() {
            None if offset == 0 => (total, Vec::with_capacity(total)),
            Some((expected, message)) if offset != 0 && expected == total && message.len() == offset => (expected, message),
            _ => bail!("message fragment arrived out of order"),
        };
        if offset + data.len() > expected {
            bail!("message fragment runs past its message");
        }
        message.extend_from_slice(data);
        if message.len() == expected {
            return Ok(Some(message));
        }
        self.message = Some((expected, message));
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_limits_leave_room_for_encryption_and_base64() {
        for transport in [Transport::Direct, Transport::Relay] {
            let plaintext = transport.text_plaintext_limit();
            let sealed = plaintext + E2EE_FRAME_OVERHEAD;
            assert!(sealed.div_ceil(3) * 4 <= transport.wire_budget());
            assert!((sealed + 3).div_ceil(3) * 4 > transport.wire_budget());
            assert!(transport.fragment_data_limit() + FRAGMENT_HEADER_BYTES + E2EE_FRAME_OVERHEAD <= transport.wire_budget());
        }
        assert!(Transport::Relay.wire_budget() < RELAY_MESSAGE_BYTES_LIMIT);
        // The 6 MiB a transcript reply was always held to on a direct connection.
        assert_eq!(Transport::Direct.text_plaintext_limit(), 6 * 1024 * 1024 - E2EE_FRAME_OVERHEAD);
    }

    #[test]
    fn a_message_is_sent_whole_in_fragments_or_not_at_all() {
        let relay = Wire::new(Transport::Relay);
        let limit = Transport::Relay.text_plaintext_limit();
        assert_eq!(relay.delivery(limit), Delivery::Frame);
        assert_eq!(relay.delivery(limit + 1), Delivery::TooLarge);
        assert!(!relay.negotiate(Some(2)));
        assert!(!relay.negotiate(None));
        assert!(!relay.fragments());
        assert!(relay.negotiate(Some(FRAGMENTS_VERSION.into())));
        assert_eq!(relay.delivery(limit + 1), Delivery::Fragments);
        assert_eq!(relay.delivery(FRAGMENTED_MESSAGE_BYTES_LIMIT), Delivery::Fragments);
        assert_eq!(relay.delivery(FRAGMENTED_MESSAGE_BYTES_LIMIT + 1), Delivery::TooLarge);
        let direct = Wire::new(Transport::Direct);
        assert_eq!(direct.delivery(8 * 1024 * 1024), Delivery::TooLarge);
    }

    #[test]
    fn reply_limits_keep_pages_to_one_frame() {
        let cap = Transport::Direct.text_plaintext_limit();
        let relay = Wire::new(Transport::Relay);
        let page = Transport::Relay.text_plaintext_limit();
        assert_eq!(relay.reply_limits(cap), ReplyLimits { page, single: page });
        relay.negotiate(Some(FRAGMENTS_VERSION.into()));
        assert_eq!(relay.reply_limits(cap), ReplyLimits { page, single: cap });
        assert_eq!(Wire::new(Transport::Direct).reply_limits(cap), ReplyLimits { page: cap, single: cap });
    }

    #[test]
    fn fragments_rebuild_the_message_and_each_fits_the_relay() {
        let message: Vec<u8> = (0..3 * RELAY_MESSAGE_BYTES_LIMIT + 17).map(|byte| (byte % 251) as u8).collect();
        let wire = Wire::new(Transport::Relay);
        let fragments: Vec<_> = wire.fragments_of(&message).collect();
        assert_eq!(fragments.len(), 4);
        let mut reassembly = Reassembly::default();
        for (index, fragment) in fragments.iter().enumerate() {
            assert!(fragment.len() + E2EE_FRAME_OVERHEAD <= Transport::Relay.wire_budget());
            let rebuilt = reassembly.push(fragment).unwrap();
            assert_eq!(rebuilt.is_some(), index == fragments.len() - 1);
            if let Some(rebuilt) = rebuilt {
                assert_eq!(rebuilt, message);
            }
        }
        // Ready for the next message.
        let next: Vec<_> = wire.fragments_of(b"{\"id\":\"next\"}").collect();
        assert_eq!(reassembly.push(&next[0]).unwrap().unwrap(), b"{\"id\":\"next\"}");
    }

    #[test]
    fn fragment_layout_is_the_one_the_phone_reads() {
        // The same bytes mobile/src/transport/wire.test.ts expects for a 2,000,000 byte message over Relay.
        let message = vec![0; 2_000_000];
        let fragments: Vec<_> = Wire::new(Transport::Relay).fragments_of(&message).collect();
        assert_eq!(fragments.len(), 2);
        assert_eq!(fragments[0][..12], [0x66, 1, 0, 0, 0x80, 0x84, 0x1e, 0x00, 0, 0, 0, 0]);
        assert_eq!(fragments[1][..12], [0x66, 1, 0, 0, 0x80, 0x84, 0x1e, 0x00, 0xa2, 0xef, 0x0f, 0x00]);
    }

    #[test]
    fn reassembly_refuses_parts_out_of_order_oversized_or_malformed() {
        let message = vec![b'x'; 40];
        let fragments: Vec<_> = encode_fragments(&message, 16).collect();
        assert_eq!(fragments.len(), 3);
        // A binary frame that is not a fragment is left alone.
        assert_eq!(Reassembly::default().push(&[0x74, 1, 0, 0]).unwrap(), None);
        // A later part first, a part twice, a part skipped.
        assert!(Reassembly::default().push(&fragments[1]).is_err());
        let mut repeated = Reassembly::default();
        repeated.push(&fragments[0]).unwrap();
        assert!(repeated.push(&fragments[0]).is_err());
        let mut skipped = Reassembly::default();
        skipped.push(&fragments[0]).unwrap();
        assert!(skipped.push(&fragments[2]).is_err());
        // A part claiming another message's length.
        let mut other = Reassembly::default();
        other.push(&fragments[0]).unwrap();
        let mut changed = fragments[1].clone();
        changed[4] = 41;
        assert!(other.push(&changed).is_err());
        // Larger than any message, or running past its own.
        let mut huge = fragments[0].clone();
        huge[4..8].copy_from_slice(&(FRAGMENTED_MESSAGE_BYTES_LIMIT as u32 + 1).to_le_bytes());
        assert!(Reassembly::default().push(&huge).is_err());
        let mut short = fragments[0].clone();
        short[4..8].copy_from_slice(&8u32.to_le_bytes());
        assert!(Reassembly::default().push(&short).is_err());
        // Another version, a header without data.
        let mut version = fragments[0].clone();
        version[1] = 2;
        assert!(Reassembly::default().push(&version).is_err());
        assert!(Reassembly::default().push(&fragments[0][..FRAGMENT_HEADER_BYTES]).is_err());
    }

    #[test]
    fn a_reply_too_large_for_relay_fails_only_its_request() {
        let wire = Wire::new(Transport::Relay);
        let response = wire.too_large_response("request-1", 1_400_000);
        assert_eq!(response["id"], "request-1");
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "message_too_large");
        let message = response["error"]["message"].as_str().unwrap();
        assert!(message.contains("over Relay (1.4 MB; the limit is 0.8 MB)"), "{message}");
        assert!(message.contains("same Wi-Fi"));
    }
}
