//! Native terminal operations against the pinned process owner. Raw output
//! subscriptions and cumulative acknowledgements use Desktop's window bridges.

use std::sync::Arc;

use anyhow::Result;
use base64::Engine as _;
use serde_json::json;

use super::client::Client;

#[derive(Clone)]
pub struct Terminals(Arc<Client>);

impl Terminals {
    pub fn mobile_drivers(&self) -> Result<Vec<String>> { self.0.call("runtime.pty.mobileDrivers", serde_json::json!({})) }

    pub fn new(client: Arc<Client>) -> Self { Self(client) }

    pub fn spawn(&self, id: &str, cwd: &str, cols: u16, rows: u16, command: Option<&str>, title: Option<&str>) -> Result<()> {
        self.0.call("runtime.pty.spawn", json!({"id":id,"cwd":cwd,"cols":cols,"rows":rows,"command":command,"title":title}))
    }

    pub fn write(&self, id: &str, bytes: &[u8]) -> Result<()> {
        self.0.call("runtime.pty.write", json!({"id":id,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        self.0.call("runtime.pty.resize", json!({"id":id,"cols":cols,"rows":rows}))
    }

    pub fn rename(&self, id: &str, title: &str) -> Result<()> {
        self.0.call("runtime.pty.rename", json!({"id":id,"title":title}))
    }

    pub fn kill(&self, id: &str) -> Result<()> {
        self.0.call("runtime.pty.kill", json!({"id":id}))
    }

    pub fn shells(&self) -> Result<Vec<crate::pty::ShellPane>> {
        self.0.call("runtime.pty.visibleShells", json!({}))
    }

    pub fn busy(&self, ids: &[String]) -> Result<Vec<String>> {
        self.0.call("runtime.pty.busyMany", json!({"ids":ids}))
    }

    pub fn stats(&self) -> Result<crate::pty::TerminalStats> {
        self.0.call("runtime.pty.stats", json!({}))
    }
}
