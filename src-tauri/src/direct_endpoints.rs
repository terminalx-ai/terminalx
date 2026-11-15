//! The addresses this computer offers for direct connections: its LAN,
//! Tailscale and `.local` names. Both builds compile it: a phone's pairing
//! offer carries them (`ws://…:6768`), and a machine's pairing code carries
//! them with the path `/machine/1` (docs/MACHINES.md, "As built (PRO-342)").
//!
//! They are recomputed for every offer, so an address that changed needs no
//! new pairing.

/// The port phones and operating computers reach directly.
pub const DIRECT_PORT: u16 = 6768;

/// A phone's direct endpoints: `ws://<address>:6768`.
pub fn advertised_endpoints() -> Vec<String> {
    endpoints(DIRECT_PORT, "")
}

/// An operating computer's direct endpoints on `port`, each ending in `path`
/// (`crate::machine_wire::MACHINE_PATH`).
pub fn machine_endpoints(port: u16, path: &str) -> Vec<String> {
    endpoints(port, path)
}

fn endpoints(port: u16, path: &str) -> Vec<String> {
    let interfaces = if_addrs::get_if_addrs().unwrap_or_default();
    let addresses: Vec<_> = interfaces
        .into_iter()
        .filter_map(|interface| {
            let std::net::IpAddr::V4(address) = interface.ip() else {
                return None;
            };
            usable_ipv4(address).then_some((interface_rank(&interface.name, address), address))
        })
        .collect();
    let mut endpoints = direct_ipv4_endpoints(addresses, port, path);
    // macOS publishes LocalHostName via its built-in mDNS responder. Resolve it
    // anew on each phone connection so LAN address changes need no new pairing.
    #[cfg(target_os = "macos")]
    if let Ok(output) = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "LocalHostName"])
        .output()
    {
        if output.status.success() {
            if let Ok(name) = String::from_utf8(output.stdout) {
                let name = name.trim();
                if !name.is_empty()
                    && name.len() <= 63
                    && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                {
                    endpoints.push(format!("ws://{name}.local:{port}{path}"));
                }
            }
        }
    }
    if endpoints.is_empty() {
        endpoints.push(format!("ws://127.0.0.1:{port}{path}"));
    }
    endpoints
}

fn direct_ipv4_endpoints(mut addresses: Vec<(u8, std::net::Ipv4Addr)>, port: u16, path: &str) -> Vec<String> {
    addresses.sort_unstable();
    let mut seen = std::collections::HashSet::new();
    addresses.retain(|entry| seen.insert(entry.1));
    addresses
        .into_iter()
        .take(63) // Leave room for Bonjour within the mobile contract limit.
        .map(|(_, address)| format!("ws://{address}:{port}{path}"))
        .collect()
}

fn usable_ipv4(address: std::net::Ipv4Addr) -> bool {
    !address.is_loopback()
        && !address.is_link_local()
        && !address.is_unspecified()
        && !address.is_multicast()
        && !address.is_broadcast()
        && !is_proxy_fake_ipv4(address)
}

fn is_proxy_fake_ipv4(address: std::net::Ipv4Addr) -> bool {
    let octets = address.octets();
    octets[0] == 198 && matches!(octets[1], 18 | 19)
}

fn interface_rank(name: &str, address: std::net::Ipv4Addr) -> u8 {
    let octets = address.octets();
    if octets[0] == 100 && octets[1] & 0xc0 == 0x40 {
        return 0;
    }
    let name = name.to_ascii_lowercase();
    if ["bridge", "docker", "veth", "vmnet", "vbox", "virbr"]
        .iter()
        .any(|marker| name.contains(marker))
    {
        3
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertising_keeps_every_path_and_recomputes_after_network_changes() {
        let lan = "192.168.1.2".parse().unwrap();
        let vpn = "100.93.49.78".parse().unwrap();
        assert_eq!(direct_ipv4_endpoints(vec![(1, lan)], DIRECT_PORT, ""), vec!["ws://192.168.1.2:6768"]);
        assert_eq!(
            direct_ipv4_endpoints(vec![(1, lan), (0, vpn), (3, lan)], DIRECT_PORT, ""),
            vec!["ws://100.93.49.78:6768", "ws://192.168.1.2:6768"]
        );
        assert_eq!(direct_ipv4_endpoints(vec![(0, vpn)], DIRECT_PORT, ""), vec!["ws://100.93.49.78:6768"]);
    }

    #[test]
    fn a_machine_offers_the_same_addresses_with_its_path() {
        let lan = "192.168.1.2".parse().unwrap();
        let vpn = "100.93.49.78".parse().unwrap();
        assert_eq!(
            direct_ipv4_endpoints(vec![(1, lan), (0, vpn)], DIRECT_PORT, "/machine/1"),
            vec!["ws://100.93.49.78:6768/machine/1", "ws://192.168.1.2:6768/machine/1"]
        );
        let every = machine_endpoints(4321, "/machine/1");
        assert!(!every.is_empty(), "at least loopback");
        assert!(every.iter().all(|endpoint| endpoint.starts_with("ws://") && endpoint.ends_with(":4321/machine/1")), "{every:?}");
        assert!(advertised_endpoints().iter().all(|endpoint| endpoint.ends_with(":6768")), "the phone's are unchanged");
    }

    #[test]
    fn direct_candidates_include_lan_and_vpn_but_not_unusable_addresses() {
        for address in ["192.168.1.2", "172.20.10.2", "100.93.49.78"] {
            assert!(usable_ipv4(address.parse().unwrap()));
        }
        for address in ["127.0.0.1", "0.0.0.0", "169.254.1.2", "224.0.0.1", "255.255.255.255", "198.18.2.3", "198.19.1.2"] {
            assert!(!usable_ipv4(address.parse().unwrap()));
        }
    }

    #[test]
    fn direct_pairing_prefers_tailnet_and_avoids_proxy_fake_addresses() {
        assert_eq!(interface_rank("utun4", "100.86.2.3".parse().unwrap()), 0);
        assert_eq!(interface_rank("en0", "192.168.1.2".parse().unwrap()), 1);
        assert_eq!(interface_rank("vmnet8", "172.16.1.2".parse().unwrap()), 3);
        assert!(is_proxy_fake_ipv4("198.18.2.3".parse().unwrap()));
    }
}
