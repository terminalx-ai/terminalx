// Scenario requirements are contracts to integrate, not claims of landed/live coverage.
export const inventory = {
  sharing: { state: "pending", review: "Direct viewer grants and revocation on both native desktops" },
  runtime: { state: "pending", review: "Authoritative viewer send, terminal and approval denial" },
  presence: { state: "pending", review: "Authenticated peer identity, tab and disconnect lifecycle" },
  invites: { state: "pending", review: "Unconsumed invite and native accept flow into the same organization" },
  follow: { state: "pending", review: "Person navigation follow and unfollow" },
  mentions: { state: "pending", review: "Person mention delivery and destination" },
  inbox: { state: "pending", review: "Recipient delivery, reconnect and deduplication" },
  reassign: { state: "pending", review: "Assignee mutation without changing viewer rights" },
  nudge: { state: "pending", review: "Person notification, not runtime mailbox activity" },
  "read-markers": { state: "pending", review: "Monotonic per-reader markers on two authenticated surfaces" },
};

export function localOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function preflight(config = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Configuration must be a JSON object");
  const blockers = [];
  if (!localOrigin(config.apiOrigin)) blockers.push("Local server prerequisite: configure apiOrigin as http://127.0.0.1:<port> for a disposable local Docker fixture. Production/remote endpoints are forbidden; no server is started or contacted.");
  if (typeof config.serverCheckout !== "string" || !config.serverCheckout.startsWith("/")) blockers.push("Local server prerequisite: configure an absolute serverCheckout and have its owner review fixture readiness, two disposable accounts, one organization and owned cleanup. Server integration is pending.");
  if (typeof config.machineA !== "string" || !config.machineA.trim() || typeof config.machineB !== "string" || !config.machineB.trim() || config.machineA === config.machineB) blockers.push("Native prerequisite: configure distinct machineA and machineB identifiers for the host Mac and a second Mac or supported macOS VM. A Linux VM or two windows cannot supply native coverage.");
  if (config.debugBuilds !== true) blockers.push("Native prerequisite: supply debug builds on both Macs honoring TERMINALX_DEV_API_BASE_URL and RACCOON_DEV_KEYCHAIN_SERVICE; released builds use production.");
  blockers.push("Native driver prerequisite: review accessibility access, debug-app sign-in, remote loopback forwarding and owned cleanup on both Macs. Native launch/login/scenario bindings and capture recorder are not implemented.");
  for (const [name, capability] of Object.entries(inventory)) blockers.push(`${name}: pending integration review and real baseline/deliberate-break evidence (${capability.review}).`);
  return blockers;
}
