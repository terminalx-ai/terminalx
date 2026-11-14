//! One owned Driver MCP connection per attachment, preserving opaque references.
use super::*;

pub(crate) struct Peer {
    child: OwnedChild,
    closed: AtomicBool,
    next_id: u64,
    pub tools: Value,
}
impl Peer {
    pub(crate) fn artifact_present(base: &Path) -> Result<()> {
        let paths = Paths::guest(base)?;
        if super::super::readiness::executable_sha256(&paths.driver)?
            != super::super::super::bootstrap::DRIVER.executable_sha256
        {
            bail!("Attached desktop requires the pinned guest Driver artifact");
        }
        Ok(())
    }
    pub(crate) fn start(base: &Path, exits: Arc<AtomicBool>) -> Result<Self> {
        Self::artifact_present(base)?;
        let mut paths = Paths::guest(base)?;
        paths.exits = exits;
        let closed = AtomicBool::new(false);
        let checked = finite(
            Path::new("/usr/bin/codesign"),
            &[
                "--verify",
                "--deep",
                "--strict",
                "-R",
                "=identifier \"com.trycua.driver\" and anchor apple generic",
                paths.app.to_str().context("Driver path")?,
            ],
            &paths,
            &closed,
            Duration::from_secs(10),
        )?;
        if checked.code != 0 {
            bail!("Guest Driver signature is unavailable; no MCP connection started");
        }
        Self::start_with(&paths)
    }
    fn start_with(paths: &Paths) -> Result<Self> {
        let closed = AtomicBool::new(false);
        let mut child = OwnedChild::spawn(&paths.driver, &["mcp"], paths, &closed)?;
        child.line_limit = 8 * 1024 * 1024;
        child.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"terminalx-guest-attachment","version":"1"}}}),&closed)?;
        let initialized = child.response(1, &closed)?;
        if initialized["protocolVersion"] != "2025-06-18"
            || !initialized["capabilities"]["tools"].is_object()
        {
            bail!("Guest Driver MCP protocol/capability mismatch");
        }
        child.send(
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            &closed,
        )?;
        child.send(
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            &closed,
        )?;
        let listed = child.response(2, &closed)?;
        if listed.get("nextCursor").is_some_and(|v| !v.is_null()) {
            bail!("Guest Driver discovery requires unsupported pagination");
        }
        let filtered = super::super::super::desktop::filter_response(json!({"result":listed}));
        let tools = filtered["result"]["tools"]
            .as_array()
            .context("Guest tool catalog missing")?;
        if tools.is_empty()
            || tools
                .iter()
                .any(|tool| !tool["name"].is_string() || tool["inputSchema"]["type"] != "object")
        {
            bail!("Invalid guest tool catalog");
        }
        Ok(Self {
            child,
            closed,
            next_id: 3,
            tools: json!(tools),
        })
    }
    pub(crate) fn call(&mut self, tool: &str, arguments: &Value) -> Result<Value> {
        if !self
            .tools
            .as_array()
            .is_some_and(|tools| tools.iter().any(|candidate| candidate["name"] == tool))
        {
            bail!("Tool is absent from this connection's catalog");
        }
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .context("MCP request counter exhausted")?;
        self.child.send(json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":tool,"arguments":arguments}}),&self.closed)?;
        let result = self.child.response(id, &self.closed)?;
        if !result["content"].is_array() {
            bail!("Guest Driver returned an invalid MCP tool receipt");
        }
        Ok(result)
    }
    pub(crate) fn close(&mut self) -> bool {
        self.closed.store(true, Ordering::Release);
        self.child.stop()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn one_mcp_connection_preserves_catalog_and_call_sequence_and_reaps_only_its_helper() {
        let home = tempfile::tempdir().unwrap();
        let driver = home.path().join("driver");
        std::fs::write(&driver,r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$HOME/messages"
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}}}}' ;;
    *'"method":"tools/list"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"list_windows","inputSchema":{"type":"object"}},{"name":"shell","inputSchema":{"type":"object"}}]}}' ;;
    *'"id":3,'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"first"}]}}' ;;
    *'"id":4,'*) printf '%s\n' '{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"second"}]}}' ;;
  esac
done
"#).unwrap();
        std::fs::set_permissions(&driver, std::fs::Permissions::from_mode(0o700)).unwrap();
        let paths = Paths {
            home: home.path().into(),
            driver,
            app: home.path().join("Driver.app"),
            open: "/usr/bin/false".into(),
            codex: None,
            exits: Arc::new(AtomicBool::new(true)),
            verify_signature: false,
            login_allowed: false,
            provider_selection_valid: false,
        };
        let mut peer = Peer::start_with(&paths).unwrap();
        assert_eq!(peer.tools.as_array().unwrap().len(), 1);
        assert!(peer.call("shell", &json!({})).is_err());
        assert_eq!(
            peer.call("list_windows", &json!({})).unwrap()["content"][0]["text"],
            "first"
        );
        assert_eq!(
            peer.call("list_windows", &json!({})).unwrap()["content"][0]["text"],
            "second"
        );
        assert!(peer.close());
        drop(peer);
        let messages = std::fs::read_to_string(home.path().join("messages")).unwrap();
        assert_eq!(
            messages
                .lines()
                .filter(|l| l.contains("\"method\":\"initialize\""))
                .count(),
            1
        );
        assert_eq!(
            messages
                .lines()
                .filter(|l| l.contains("tools/call"))
                .count(),
            2
        );
        assert!(paths.exits.load(Ordering::Acquire));
    }
}
