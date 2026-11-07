//! Reads only the global HTTP MCP definitions; credentials and project data
//! never cross from this file into the webview.
use crate::organization_compute::OrganizationComputeError;
use serde_json::{json, Value};
use std::io::Read;
use zeroize::Zeroizing;

const MAX_BYTES: u64 = 2 * 1024 * 1024;

pub fn read_candidates() -> Result<Value, OrganizationComputeError> {
    let error = || OrganizationComputeError::local("organization_mcp_import_failed");
    let path = dirs::home_dir().ok_or_else(error)?.join(".claude.json");
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({ "servers": [], "skipped": 0 })),
        Err(_) => return Err(error()),
    };
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|_| error())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(error());
    }
    candidates(&bytes).ok_or_else(error)
}

fn candidates(bytes: &[u8]) -> Option<Value> {
    let source: Value = serde_json::from_slice(bytes).ok()?;
    let entries = source.get("mcpServers").and_then(Value::as_object);
    let mut servers = Vec::new();
    let mut skipped = 0;
    for (name, value) in entries.into_iter().flatten().take(256) {
        let Some(url) = value.get("url").and_then(Value::as_str).and_then(|raw| url::Url::parse(raw).ok()) else {
            skipped += 1;
            continue;
        };
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || value.get("command").is_some() {
            skipped += 1;
            continue;
        }
        // A copied credential remains local. The administrator chooses OAuth
        // or supplies a new write-only credential in the organisation form.
        servers.push(json!({ "name": name, "url": url.as_str(), "requiresAuth": value.get("headers").and_then(Value::as_object).is_some_and(|headers| !headers.is_empty()) || value.get("oauth").is_some() }));
    }
    Some(json!({ "servers": servers, "skipped": skipped }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_only_remote_metadata() {
        let result = candidates(br#"{"mcpServers":{"remote":{"url":"https://mcp.example/mcp","headers":{"Authorization":"Bearer never-return"}},"local":{"command":"node","args":["secret"]},"query":{"url":"https://mcp.example/?token=never-return"}},"projects":{"secret":"never-return"}}"#).unwrap();
        assert_eq!(result["servers"].as_array().unwrap().len(), 1);
        assert_eq!(result["skipped"], 2);
        assert!(!result.to_string().contains("never-return"));
    }
}
