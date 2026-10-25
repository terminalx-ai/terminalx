//! Bounded owner-side mobile terminal observations. Taps use the same ordered
//! replay/live boundary as desktop views; slow phones lose the subscription,
//! never stall a detached command indefinitely or silently skip output.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

const PER_VIEW: usize = 1024 * 1024;
const LIVE_PACKET: usize = 64 * 1024;
const TOTAL: usize = 8 * 1024 * 1024;
static BUFFERED: Mutex<usize> = Mutex::new(0);

#[derive(Default)]
struct Buffer {
    bytes: Vec<u8>,
    failed: bool,
    received: u64,
    carry: Vec<u8>,
}
impl Buffer {
    fn push(&mut self, bytes: &[u8]) -> bool {
        if self.failed { return false; }
        let mut total = BUFFERED.lock().unwrap();
        if self.bytes.len() + bytes.len() > PER_VIEW || *total + bytes.len() > TOTAL {
            self.failed = true;
            return false;
        }
        *total += bytes.len();
        self.bytes.extend_from_slice(bytes);
        self.received += bytes.len() as u64;
        true
    }
    fn take(&mut self, limit: usize) -> Result<(String,u64)> {
        if self.failed { bail!("Mobile terminal observation fell behind. Subscribe again for retained scrollback."); }
        let count = self.bytes.len().min(limit);
        *BUFFERED.lock().unwrap() -= count;
        let mut bytes = std::mem::take(&mut self.carry);
        bytes.extend(self.bytes.drain(..count));
        // Keep a split UTF-8 character for the next packet, without delaying
        // complete characters or altering the terminal's raw retained history.
        let mut complete = bytes.len();
        let mut cursor = 0;
        while cursor < bytes.len() {
            match std::str::from_utf8(&bytes[cursor..]) {
                Ok(_) => break,
                Err(error) => match error.error_len() {
                    Some(length) => cursor += error.valid_up_to() + length,
                    None => { complete = cursor + error.valid_up_to(); break; }
                }
            }
        }
        self.carry = bytes.split_off(complete);
        Ok((String::from_utf8_lossy(&bytes).into_owned(),self.received - self.bytes.len() as u64))
    }
}
impl Drop for Buffer {
    fn drop(&mut self) { *BUFFERED.lock().unwrap() -= self.bytes.len(); }
}

struct View {
    terminals: Arc<crate::pty::Terminals>,
    session: String,
    tab: String,
    pane: String,
    token: String,
    buffer: Arc<Mutex<Buffer>>,
}
impl View {
    fn read(&self, limit: usize) -> Result<String> {
        let (text,drawn) = self.buffer.lock().unwrap().take(limit)?;
        // Never acquire the tap lock while holding the buffer: emitters acquire
        // them in the other direction. Acknowledgements include raw byte counts.
        self.terminals.ack(&self.pane,&self.token,drawn);
        Ok(text)
    }
}
impl Drop for View {
    fn drop(&mut self) { self.terminals.detach(&self.pane,&self.token); }
}

#[derive(Default)]
pub struct Observations(Mutex<HashMap<String,View>>);
impl Observations {
    pub(crate) fn clear(&self) { self.0.lock().unwrap().clear(); }
    pub(crate) fn subscribe(&self, manager: &crate::session::SessionManager, session: &str, tab: &str) -> Result<Value> {
        let mut views = self.0.lock().unwrap();
        if views.len() >= 8 { bail!("Too many mobile terminal observations."); }
        let entry = crate::store::index::get(session)?;
        let entry_tab = entry.tab(tab).context("The tab does not belong to this session.")?;
        let pane = manager.pane_of(session,tab).map(|pane|pane.pane_id).unwrap_or_else(||entry_tab.pane_id());
        let terminals = manager.terminals();
        if terminals.read_output(&pane).is_none() { bail!("Terminal output is unavailable."); }
        let token = uuid::Uuid::new_v4().to_string();
        let buffer = Arc::new(Mutex::new(Buffer::default()));
        let output = buffer.clone();
        let view = View { terminals:terminals.clone(),session:session.into(),tab:tab.into(),pane,token:token.clone(),buffer };
        terminals.attach(&format!("mobile-{token}"),&view.pane,&token,Box::new(move |bytes| output.lock().unwrap().push(bytes)));
        let initial = view.read(usize::MAX)?;
        views.insert(token.clone(),view);
        Ok(json!({"subscriptionId":token,"type":"scrollback","serialized":initial}))
    }
    pub(crate) fn unsubscribe(&self, id: &str) -> bool { self.0.lock().unwrap().remove(id).is_some() }
    pub(crate) fn poll(&self) -> Result<Value> {
        let views = self.0.lock().unwrap();
        let mut packets = Vec::new();
        for (id,view) in views.iter() {
            if crate::store::index::get(&view.session)?.tab(&view.tab).is_none() { bail!("The observed tab was closed."); }
            let text = view.read(LIVE_PACKET)?;
            if !text.is_empty() { packets.push(json!({"subscriptionId":id,"text":text})); }
        }
        Ok(json!(packets))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mobile_output_packets_bound_memory_and_ack_only_drained_bytes() {
        let mut buffer = Buffer::default();
        let source = "x".repeat(LIVE_PACKET * 2 + 7);
        assert!(buffer.push(source.as_bytes()));
        let (first, first_ack) = buffer.take(LIVE_PACKET).unwrap();
        assert_eq!(first.len(), LIVE_PACKET);
        assert_eq!(first_ack, LIVE_PACKET as u64);
        let (second, second_ack) = buffer.take(LIVE_PACKET).unwrap();
        assert_eq!(second.len(), LIVE_PACKET);
        assert_eq!(second_ack, (LIVE_PACKET * 2) as u64);
        let (last, last_ack) = buffer.take(LIVE_PACKET).unwrap();
        assert_eq!(last.len(), 7);
        assert_eq!(last_ack, source.len() as u64);
        assert_eq!(format!("{first}{second}{last}"), source);
    }
    #[test]
    fn mobile_output_keeps_split_utf8_and_reports_overflow_instead_of_skipping_bytes() {
        let mut buffer = Buffer::default();
        assert!(buffer.push(&[b'a',0xf0,0x9f]));
        assert_eq!(buffer.take(usize::MAX).unwrap(),("a".into(),3));
        assert!(buffer.push(&[0x98,0x80,b'b']));
        assert_eq!(buffer.take(usize::MAX).unwrap(),("😀b".into(),6));
        assert!(buffer.push(&vec![b'x';PER_VIEW]));
        assert!(!buffer.push(b"overflow"));
        assert!(buffer.take(usize::MAX).is_err());
    }
}
