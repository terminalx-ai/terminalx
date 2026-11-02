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
    /// The pane size last told to the phone, which emulates the screen at
    /// the size the desktop drew it for and must follow its resizes.
    size: Mutex<Option<(u16,u16)>>,
}
impl View {
    fn read(&self, limit: usize) -> Result<String> {
        let (text,drawn) = self.buffer.lock().unwrap().take(limit)?;
        // Never acquire the tap lock while holding the buffer: emitters acquire
        // them in the other direction. Acknowledgements include raw byte counts.
        self.terminals.ack(&self.pane,&self.token,drawn);
        Ok(text)
    }
    /// The pane size, when it changed since the phone was last told.
    fn resized(&self) -> Option<(u16,u16)> {
        let now = self.terminals.size(&self.pane).ok()?;
        let mut told = self.size.lock().unwrap();
        (*told != Some(now)).then(|| { *told = Some(now); now })
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
        let view = View { terminals:terminals.clone(),session:session.into(),tab:tab.into(),pane,token:token.clone(),buffer,size:Mutex::new(None) };
        terminals.attach(&format!("mobile-{token}"),&view.pane,&token,Box::new(move |bytes| output.lock().unwrap().push(bytes)));
        let initial = view.read(usize::MAX)?;
        let mut reply = json!({"subscriptionId":token,"type":"scrollback","serialized":initial});
        if let Some((cols,rows)) = view.resized() { reply["cols"] = json!(cols); reply["rows"] = json!(rows); }
        views.insert(token.clone(),view);
        Ok(reply)
    }
    pub(crate) fn unsubscribe(&self, id: &str) -> bool { self.0.lock().unwrap().remove(id).is_some() }
    pub(crate) fn poll(&self) -> Result<Value> {
        let views = self.0.lock().unwrap();
        let mut packets = Vec::new();
        for (id,view) in views.iter() {
            if crate::store::index::get(&view.session)?.tab(&view.tab).is_none() { bail!("The observed tab was closed."); }
            // A resize goes ahead of the output drawn for it: a full-screen
            // program redraws the whole screen after one.
            let resized = view.resized();
            let text = view.read(LIVE_PACKET)?;
            if text.is_empty() && resized.is_none() { continue; }
            let mut packet = json!({"subscriptionId":id,"text":text});
            if let Some((cols,rows)) = resized { packet["cols"] = json!(cols); packet["rows"] = json!(rows); }
            packets.push(packet);
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
    /// The phone emulates the screen at the pane's size, so it is told the
    /// size first and then each resize, ahead of the output drawn for it.
    #[test]
    fn mobile_observations_tell_the_phone_the_pane_size_and_each_resize() {
        let _home = crate::store::temp_home();
        let root = crate::store::root().unwrap();
        let entry: crate::store::index::SessionEntry = serde_json::from_value(json!({
            "id":"observed","projectPath":root,"cwd":root,"title":"observed",
            "created":crate::store::index::now(),"modified":crate::store::index::now(),
            "tabs":[{"id":"tab","harness":"codex","created":crate::store::index::now()}]
        })).unwrap();
        crate::store::index::save(&[entry]).unwrap();
        let terminals = Arc::new(crate::pty::Terminals::new());
        let path = root.to_str().unwrap();
        let env = vec![("HOME".to_string(),path.to_string()),("ZDOTDIR".to_string(),path.to_string())];
        terminals.spawn(Arc::new(crate::sink::BroadcastSink::new(64)),"observed-pane",
            crate::pty::PaneSpec { cwd:path,cols:80,rows:24,command:Some("exec /bin/cat"),env:&env }).unwrap();
        let view = View { terminals:terminals.clone(),session:"observed".into(),tab:"tab".into(),pane:"observed-pane".into(),
            token:"view".into(),buffer:Arc::new(Mutex::new(Buffer::default())),size:Mutex::new(None) };
        assert_eq!(view.resized(),Some((80,24)),"the subscription says the size");
        let observations = Observations::default();
        observations.0.lock().unwrap().insert("view".into(),view);
        assert_eq!(observations.poll().unwrap(),json!([]),"nothing changed, nothing is sent");
        terminals.resize("observed-pane",120,40).unwrap();
        assert_eq!(observations.poll().unwrap(),json!([{"subscriptionId":"view","text":"","cols":120,"rows":40}]));
        assert_eq!(observations.poll().unwrap(),json!([]),"a resize is told once");
        observations.clear();
        terminals.kill_all();
    }
}
