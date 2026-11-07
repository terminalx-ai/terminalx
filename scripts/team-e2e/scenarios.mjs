// These assertions consume observations of the application, never action acknowledgements.
// Contract-test fixtures are deliberately kept separate from real-run evidence.
export const scenarios = [
  { id: "invite-accept", requires: ["invites"], breaks: "membership-created" },
  { id: "share", requires: ["sharing"], breaks: "viewer-can-read" },
  { id: "viewer-read-only", requires: ["sharing", "runtime"], breaks: "send-denied" },
  { id: "presence-appear", requires: ["presence"], breaks: "peer-appeared" },
  { id: "presence-clear", requires: ["presence"], breaks: "peer-cleared" },
  { id: "follow", requires: ["follow"], breaks: "followed-tab" },
  { id: "mention-notification", requires: ["mentions", "inbox"], breaks: "notification-arrived" },
  { id: "reassign", requires: ["reassign"], breaks: "assignee-changed" },
  { id: "nudge", requires: ["nudge", "inbox"], breaks: "nudge-arrived" },
  { id: "unread-sync", requires: ["read-markers"], breaks: "read-synchronized" },
  { id: "unshare", requires: ["sharing", "runtime"], breaks: "access-revoked" },
];

const has = (rows, id) => Array.isArray(rows) && rows.includes(id);
const exact = (actual, expected) => expected !== undefined && actual === expected;
const positive = (n) => Number.isSafeInteger(n) && n > 0;

/** Named assertions are stable evidence keys and the targets of controlled breaks. */
export function assertions(id, observation, identity) {
  const o = observation ?? {};
  const { accountA: a, accountB: b, orgId, workspaceId, tabId, otherTabId, nonce } = identity;
  const common = {
    "run-owned": exact(o.runId, identity.runId),
    "organization-matches": exact(o.orgId, orgId),
    "distinct-accounts": typeof a === "string" && typeof b === "string" && a !== b,
    "observer-is-peer": exact(o.observerId, b),
  };
  let checks;
  switch (id) {
    case "invite-accept":
      checks = {
        "initially-not-member": o.beforeRole === null && positive(o.pendingInviteCount),
        "membership-created": o.afterRole === "member" && o.acceptedOrgId === orgId && o.inviteeId === b,
        "invite-consumed": o.pendingInviteCountAfter === 0 && o.acceptedInviteId === identity.inviteId,
        "owner-unchanged": o.ownerId === a,
      };
      break;
    case "share":
      checks = {
        "initially-no-access": o.beforeRole === "none" && o.beforeReadStatus === 403,
        "viewer-can-read": o.afterRole === "viewer" && o.afterReadStatus === 200 && exact(o.renderedNonce, nonce),
        "no-approval-grant": o.canApprove === false,
        "workspace-matches": exact(o.workspaceId, workspaceId),
      };
      break;
    case "viewer-read-only":
      checks = {
        "viewer-can-read": o.role === "viewer" && exact(o.renderedNonce, nonce),
        "send-denied": o.sendStatus === 403 && o.sendError === "cloud_workspace_collaboration_forbidden",
        "terminal-denied": o.terminalError === "forbidden",
        "approval-denied": o.approvalStatus === 403,
        "no-side-effects": positive(o.beforeSeq) && o.afterSeq === o.beforeSeq && o.commandRecorded === false,
        "composer-disabled": o.composerEnabled === false,
      };
      break;
    case "presence-appear":
      checks = {
        "initially-absent": Array.isArray(o.beforeParticipants) && !has(o.beforeParticipants, a),
        "peer-appeared": has(o.afterParticipants, a) && exact(o.peerTabId, tabId),
        "identity-visible": exact(o.displayedPeerId, a),
      };
      break;
    case "presence-clear":
      checks = {
        "initially-present": has(o.beforeParticipants, a),
        "peer-cleared": Array.isArray(o.afterParticipants) && !has(o.afterParticipants, a),
        "observer-still-connected": o.observerConnected === true,
      };
      break;
    case "follow":
      checks = {
        "different-start-tab": exact(o.beforeTabId, tabId) && tabId !== otherTabId,
        "followed-tab": exact(o.afterTabId, otherTabId) && exact(o.followedUserId, a),
        "unfollow-stops-tracking": exact(o.afterUnfollowTabId, otherTabId) && exact(o.leaderFinalTabId, tabId),
      };
      break;
    case "mention-notification":
    case "nudge": {
      const event = o.received;
      checks = {
        "initially-no-event": o.matchingBefore === 0,
        [id === "nudge" ? "nudge-arrived" : "notification-arrived"]:
          o.matchingAfter === 1 && event?.actorId === a && event?.recipientId === b &&
          exact(event?.nonce, nonce) && exact(event?.workspaceId, workspaceId) &&
          event?.kind === (id === "nudge" ? "nudge" : "mention"),
        "destination-opens": exact(o.openedWorkspaceId, workspaceId) && exact(o.openedTabId, tabId),
        "no-duplicate-on-reconnect": o.matchingAfterReconnect === 1,
      };
      break;
    }
    case "reassign":
      checks = {
        "initial-assignee": exact(o.beforeAssigneeId, a),
        "assignee-changed": exact(o.afterAssigneeId, b) && exact(o.peerAssigneeId, b),
        "workspace-matches": exact(o.workspaceId, workspaceId),
        "permissions-preserved": o.viewerSendStatus === 403 && o.viewerCanApprove === false,
      };
      break;
    case "unread-sync":
      checks = {
        "initially-unread": positive(o.messageSeq) && Number.isSafeInteger(o.beforeReadSeq) && o.beforeReadSeq < o.messageSeq && o.beforeUnread === true,
        "read-synchronized": o.afterReadSeq === o.messageSeq && o.peerReadSeq === o.messageSeq && o.peerUnread === false,
        "marker-monotonic": o.afterStaleReadSeq === o.messageSeq,
        "other-account-independent": o.accountAReadSeqAfter === o.accountAReadSeqBefore && Number.isSafeInteger(o.accountAReadSeqBefore),
        "same-reader-second-surface": exact(o.readerId, b) && exact(o.peerReaderId, b) && o.readerSurface !== o.peerReaderSurface && typeof o.readerSurface === "string" && typeof o.peerReaderSurface === "string",
      };
      break;
    case "unshare":
      checks = {
        "initially-readable": o.beforeReadStatus === 200 && exact(o.renderedNonceBefore, nonce),
        "access-revoked": o.afterReadStatus === 403 && o.afterRole === "none" && o.renderedNonceAfter === null,
        "existing-connection-revoked": o.connectionRevoked === true && o.sendStatus === 403,
        "owner-retains-access": o.ownerReadStatus === 200,
      };
      break;
    default: throw new Error(`Unknown scenario: ${id}`);
  }
  return Object.entries({ ...common, ...checks }).map(([name, ok]) => ({ section: id, name, ok: ok === true }));
}

/** Contract-test mutations only; these are NOT real deliberate-break runs. */
export function corruptObservation(id, observation) {
  const o = structuredClone(observation);
  switch (id) {
    case "invite-accept": o.afterRole = null; break;
    case "share": o.afterReadStatus = 403; break;
    case "viewer-read-only": o.sendStatus = 202; break;
    case "presence-appear": o.afterParticipants = []; break;
    case "presence-clear": o.afterParticipants = o.beforeParticipants; break;
    case "follow": o.afterTabId = o.beforeTabId; break;
    case "mention-notification": case "nudge": o.matchingAfter = 0; break;
    case "reassign": o.afterAssigneeId = o.beforeAssigneeId; break;
    case "unread-sync": o.peerReadSeq = o.beforeReadSeq; break;
    case "unshare": o.afterReadStatus = 200; break;
    default: throw new Error(`Unknown scenario: ${id}`);
  }
  return o;
}
