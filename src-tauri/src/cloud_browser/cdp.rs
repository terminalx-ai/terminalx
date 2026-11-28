//! Chrome's DevTools protocol over `--remote-debugging-pipe` (PRO-209): Chrome
//! reads commands on its fd 3 and writes replies on its fd 4, each message
//! ending in a NUL. Only the runtime holds the other ends, so no port, file or
//! socket lets another process in the workspace drive Chrome.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;

const CALL_TIMEOUT: Duration = Duration::from_secs(20);

type Pending = Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>;

pub(crate) struct Cdp {
    write: Mutex<std::fs::File>,
    pending: Arc<Pending>,
    next: AtomicU64,
    closed: Arc<AtomicBool>,
}

/// The two pipes, before Chrome starts: Chrome's ends go to its fds 3 and 4.
pub(crate) struct ChromePipes {
    chrome_reads: OwnedFd,
    chrome_writes: OwnedFd,
    ours_write: OwnedFd,
    ours_read: OwnedFd,
}

impl ChromePipes {
    pub(crate) fn new() -> std::io::Result<Self> {
        let (chrome_reads, ours_write) = std::io::pipe()?;
        let (ours_read, chrome_writes) = std::io::pipe()?;
        Ok(Self { chrome_reads: chrome_reads.into(), chrome_writes: chrome_writes.into(), ours_write: ours_write.into(), ours_read: ours_read.into() })
    }

    /// Give Chrome its ends as fds 3 and 4, and nothing else.
    pub(crate) fn hand_to(&self, command: &mut tokio::process::Command) {
        let (reads, writes) = (self.chrome_reads.as_raw_fd(), self.chrome_writes.as_raw_fd());
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            command.pre_exec(move || {
                // Out of the way of 3 and 4 first, whichever numbers they had.
                let reads = libc::fcntl(reads, libc::F_DUPFD, 10);
                let writes = libc::fcntl(writes, libc::F_DUPFD, 10);
                if reads < 0 || writes < 0 || libc::dup2(reads, 3) < 0 || libc::dup2(writes, 4) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                libc::close(reads);
                libc::close(writes);
                Ok(())
            });
        }
    }

    /// After Chrome started: drop its ends here and talk on ours.
    pub(crate) fn connect(self) -> Arc<Cdp> {
        let Self { chrome_reads, chrome_writes, ours_write, ours_read } = self;
        drop((chrome_reads, chrome_writes));
        let pending: Arc<Pending> = Arc::default();
        let closed = Arc::new(AtomicBool::new(false));
        let (answers, ended) = (pending.clone(), closed.clone());
        std::thread::Builder::new().name("cloud-browser-cdp".into()).spawn(move || {
            let mut reader = BufReader::new(std::fs::File::from(ours_read));
            let mut message = Vec::new();
            while matches!(reader.read_until(0, &mut message), Ok(read) if read > 0) {
                if message.last() == Some(&0) {
                    message.pop();
                }
                if let Ok(value) = serde_json::from_slice::<Value>(&message) {
                    if let Some(answer) = value["id"].as_u64().and_then(|id| answers.lock().unwrap().remove(&id)) {
                        let _ = answer.send(match value.get("error") {
                            Some(error) => Err(error["message"].as_str().unwrap_or("Chrome refused the call").to_string()),
                            None => Ok(value["result"].clone()),
                        });
                    }
                }
                message.clear();
            }
            // Chrome exited: every waiting call fails now, not at its timeout.
            ended.store(true, Ordering::SeqCst);
            answers.lock().unwrap().clear();
        }).expect("start the DevTools reader");
        Arc::new(Cdp { write: Mutex::new(std::fs::File::from(ours_write)), pending, next: AtomicU64::new(1), closed })
    }
}

impl Cdp {
    /// Chrome has gone: the browser session it held is over.
    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub(crate) async fn call(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, String> {
        if self.is_closed() {
            return Err("Chrome on the cloud desktop has closed.".into());
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (answer, wait) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, answer);
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        let mut bytes = message.to_string().into_bytes();
        bytes.push(0);
        if self.write.lock().unwrap().write_all(&bytes).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err("Chrome on the cloud desktop has closed.".into());
        }
        match tokio::time::timeout(CALL_TIMEOUT, wait).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Chrome on the cloud desktop has closed.".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("Chrome did not answer {method} in time."))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in Chrome: reads NUL-ended commands on fd 3, answers on fd 4.
    #[tokio::test]
    async fn speaks_nul_framed_json_on_fds_3_and_4_and_fails_closed_when_chrome_exits() {
        let pipes = ChromePipes::new().unwrap();
        let mut chrome = tokio::process::Command::new("/usr/bin/python3");
        chrome.arg("-c").arg(concat!(
            "import os,json\n",
            "buf=b''\n",
            "while True:\n",
            "  c=os.read(3,4096)\n",
            "  if not c: break\n",
            "  buf+=c\n",
            "  while b'\\0' in buf:\n",
            "    m,buf=buf.split(b'\\0',1); m=json.loads(m)\n",
            "    if m['method']=='Quit': os._exit(0)\n",
            "    os.write(4,json.dumps({'id':m['id'],'result':{'echo':m['method'],'session':m.get('sessionId')}}).encode()+b'\\0')\n",
        ));
        pipes.hand_to(&mut chrome);
        let mut child = chrome.spawn().unwrap();
        let cdp = pipes.connect();
        assert_eq!(cdp.call("Target.getTargets", json!({}), None).await.unwrap(), json!({"echo": "Target.getTargets", "session": null}));
        assert_eq!(cdp.call("Page.enable", json!({}), Some("s1")).await.unwrap()["session"], "s1");
        assert!(cdp.call("Quit", json!({}), None).await.is_err());
        child.wait().await.unwrap();
        for _ in 0..50 {
            if cdp.is_closed() { break; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(cdp.is_closed());
        assert!(cdp.call("Page.enable", json!({}), None).await.is_err());
    }
}
