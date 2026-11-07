//! Runtime-only MCP initialize probes. Only fixed status codes leave this
//! module; neither response text nor authentication headers are reported.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read};
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::Duration;
use zeroize::Zeroizing;

fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, _, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || a == 0
                || a >= 224
                || a == 100 && (64..=127).contains(&b)
                || a == 192 && matches!(b, 0 | 88)
                || a == 198 && matches!(b, 18 | 19))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4() {
                return public_address(IpAddr::V4(v4));
            }
            let segments = ip.segments();
            (segments[0] & 0xe000) == 0x2000 && segments[0] != 0x2002 && !(segments[0] == 0x2001 && (segments[1] == 0 || segments[1] == 0xdb8))
        }
    }
}

fn resolve(netloc: &str) -> std::io::Result<Vec<SocketAddr>> {
    let addresses: Vec<_> = netloc.to_socket_addrs()?.collect();
    if addresses.is_empty() || addresses.iter().any(|address| !public_address(address.ip())) {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "MCP target is not public"));
    }
    Ok(addresses)
}

fn initialized(value: &str) -> bool {
    serde_json::from_str::<Value>(value)
        .ok()
        .is_some_and(|body| body.get("id") == Some(&json!(1)) && body.get("error").is_none() && body.get("result").is_some_and(|result| result.get("protocolVersion").and_then(Value::as_str).is_some() && result.get("serverInfo").is_some()))
}

pub fn check(url: &str, headers: &BTreeMap<String, Zeroizing<String>>) -> &'static str {
    let Ok(target) = url::Url::parse(url) else {
        return "error";
    };
    if target.scheme() != "https" || !target.username().is_empty() || target.password().is_some() || target.query().is_some() || target.fragment().is_some() {
        return "error";
    }
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(8)).redirects(0).resolver(resolve).build();
    let mut request = agent.post(url).set("Content-Type", "application/json").set("Accept", "application/json, text/event-stream");
    for (key, value) in headers {
        request = request.set(key, value);
    }
    let response = match request.send_json(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "TerminalX status", "version": "1" } } })) {
        Ok(response) => response,
        Err(ureq::Error::Status(401 | 403, _)) => return "needs-reauth",
        Err(_) => return "error",
    };
    let session = response.header("mcp-session-id").map(str::to_owned);
    let sse = response.header("content-type").is_some_and(|value| value.starts_with("text/event-stream"));
    let mut reader = BufReader::new(response.into_reader().take(65536));
    let mut body = String::new();
    let connected = if sse {
        let mut matched = false;
        while reader.read_line(&mut body).ok().is_some_and(|read| read > 0) {
            if let Some(data) = body.strip_prefix("data:") {
                if initialized(data.trim()) {
                    matched = true;
                    break;
                }
            }
            body.clear();
        }
        matched
    } else {
        reader.read_to_string(&mut body).is_ok() && initialized(&body)
    };
    if let Some(session) = session {
        let mut request = agent.delete(url).set("Mcp-Session-Id", &session).set("MCP-Protocol-Version", "2025-11-25");
        for (key, value) in headers {
            request = request.set(key, value);
        }
        let _ = request.call();
    }
    if connected {
        "connected"
    } else {
        "error"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_private_and_transition_addresses() {
        for address in ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2002:a00:1::", "2001:db8::1"] {
            assert!(!public_address(address.parse().unwrap()), "{address}");
        }
        assert!(public_address("1.1.1.1".parse().unwrap()));
    }
    #[test]
    fn requires_an_mcp_initialize_response() {
        assert!(initialized(r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","serverInfo":{"name":"test"}}}"#));
        assert!(!initialized(r#"{"ok":true}"#));
        assert!(!initialized(r#"{"id":1,"error":{"message":"secret"}}"#));
    }
}
