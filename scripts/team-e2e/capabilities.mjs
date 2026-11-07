// This inventory is intentionally pinned to reviewed source, not to peer branches.
export const inventory = {
  sharing: { available: true, source: "src/components/cloud/CloudShareDialog.tsx", contract: "direct viewer grant, canApprove=false; /cloud-workspaces/:id/shares/:userId" },
  runtime: { available: true, source: "src/lib/cloudCollab.ts", contract: "runtime role and lease enforcement; mailbox rejects a viewer's send with 403" },
  presence: { available: true, source: "src/components/cloud/CloudCollab.tsx", contract: "presence participants/userId/tabId; no synthetic presence injection" },
  invites: { available: true, source: "server:apps/api/src/controllers/desktop/myInvites.ts", contract: "GET /v1/desktop/invites; POST /v1/desktop/invites/:inviteId/accept; verified recipient identity; PRO175 welcome UI unmerged" },
  follow: { available: false, reason: "No landed team-follow UI/transport contract. Following an agent transcript is not following another person's navigation." },
  mentions: { available: false, reason: "No landed person-mention notification contract. File mentions and plain notes do not satisfy this scenario." },
  inbox: { available: false, reason: "PRO125 unmerged: /v1/desktop/inbox/stream, /inbox?cursor=&wait=1, /inbox/receipts; team.events.v1." },
  reassign: { available: false, reason: "No landed assignee mutation contract. Driver lease takeover is not reassignment." },
  nudge: { available: false, reason: "No landed person-nudge contract. Runtime mailbox nudge is not a person notification." },
  "read-markers": { available: false, reason: "PRO125 unmerged: PUT /v1/desktop/orgs/:orgId/cloud-workspaces/:workspaceId/read-markers; monotonic per-user/tab sequence." },
};

export function preflight(config = {}) {
  const blockers = [];
  if (config.hostRecoveryEvidence == null) blockers.push("Host recovery evidence required; no native, VM, browser or computer launch is permitted under the execution hold.");
  if (!config.machineB) blockers.push("A distinct second macOS desktop is not configured. TerminalX Local VM is Linux and cannot satisfy this requirement.");
  // account.rs accepts only dev.terminalx.* in debug builds, including workspace keys.
  if (!config.debugBuilds) blockers.push("Both machines need debug builds honoring TERMINALX_DEV_API_BASE_URL and RACCOON_DEV_KEYCHAIN_SERVICE; a released build always uses production.");
  blockers.push("Native accessibility action bindings and debug-app sign-in must be verified on the recovered two-Mac fixture before execution. No supported end-to-end native driver is certified at this source checkpoint.");
  for (const [name, capability] of Object.entries(inventory)) if (!capability.available) blockers.push(`${name}: ${capability.reason}`);
  return blockers;
}
