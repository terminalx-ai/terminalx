# Relay outage diagnosis

These light and dark captures render the real `DevicesTab` component with an
isolated synthetic service-unavailable status (attempt 12), an empty device list,
and no pairing offer. They demonstrate UI presentation, not a production outage.
No account, device, host, network, token, or pairing data is present.

- [Light](outage-light.png)
- [Dark](outage-dark.png)

The service-specific explanation remains visible, Relay pairing stays disabled,
and the LAN option remains available.
