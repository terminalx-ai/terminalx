import test from "node:test";
import assert from "node:assert/strict";
import { assertions, corruptObservation, scenarios } from "./scenarios.mjs";
import { evaluateRun, exitCode } from "./results.mjs";

const identity = {
  runId: "team-12345678-1234-1234-1234-123456789abc", accountA: "alice", accountB: "bob",
  orgId: "org", workspaceId: "workspace", inviteId: "invite", tabId: "one", otherTabId: "two", nonce: "this-run-only",
  machineA: "mac-a", machineB: "mac-b", platformA: "darwin", platformB: "darwin",
  desktopHeadA: "a".repeat(40), desktopHeadB: "a".repeat(40), serverHead: "b".repeat(40),
};
const observations = {
  "invite-accept": { beforeRole: null, pendingInviteCount: 1, afterRole: "member", acceptedOrgId: "org", inviteeId: "bob", pendingInviteCountAfter: 0, acceptedInviteId: "invite", ownerId: "alice" },
  share: { beforeRole: "none", beforeReadStatus: 403, afterRole: "viewer", afterReadStatus: 200, renderedNonce: "this-run-only", canApprove: false, workspaceId: "workspace" },
  "viewer-read-only": { role: "viewer", renderedNonce: "this-run-only", sendStatus: 403, sendError: "cloud_workspace_collaboration_forbidden", terminalError: "forbidden", approvalStatus: 403, beforeSeq: 5, afterSeq: 5, commandRecorded: false, composerEnabled: false },
  "presence-appear": { beforeParticipants: ["bob"], afterParticipants: ["alice", "bob"], peerTabId: "one", displayedPeerId: "alice" },
  "presence-clear": { beforeParticipants: ["alice", "bob"], afterParticipants: ["bob"], observerConnected: true },
  follow: { beforeTabId: "one", afterTabId: "two", followedUserId: "alice", afterUnfollowTabId: "two", leaderFinalTabId: "one" },
  "mention-notification": { matchingBefore: 0, matchingAfter: 1, received: { actorId: "alice", recipientId: "bob", nonce: "this-run-only", workspaceId: "workspace", kind: "mention" }, openedWorkspaceId: "workspace", openedTabId: "one", matchingAfterReconnect: 1 },
  reassign: { beforeAssigneeId: "alice", afterAssigneeId: "bob", peerAssigneeId: "bob", workspaceId: "workspace", viewerSendStatus: 403, viewerCanApprove: false },
  nudge: { matchingBefore: 0, matchingAfter: 1, received: { actorId: "alice", recipientId: "bob", nonce: "this-run-only", workspaceId: "workspace", kind: "nudge" }, openedWorkspaceId: "workspace", openedTabId: "one", matchingAfterReconnect: 1 },
  "unread-sync": { messageSeq: 10, beforeReadSeq: 4, beforeUnread: true, afterReadSeq: 10, peerReadSeq: 10, peerUnread: false, afterStaleReadSeq: 10, accountAReadSeqAfter: 3, accountAReadSeqBefore: 3, readerId: "bob", peerReaderId: "bob", readerSurface: "desktop-b", peerReaderSurface: "authenticated-api-observer-b" },
  unshare: { beforeReadStatus: 200, renderedNonceBefore: "this-run-only", afterReadStatus: 403, afterRole: "none", renderedNonceAfter: null, connectionRevoked: true, sendStatus: 403, ownerReadStatus: 200 },
};
const observationFor = (id) => ({ runId: identity.runId, orgId: "org", observerId: "bob", ...observations[id] });
const artifactMetadata = ["screenshot", "log"].map((kind) => ({ kind, path: `${kind}.fixture`, sha256: "c".repeat(64) }));
const attempts = scenarios.flatMap((scenario) => ["baseline", "deliberate-break"].map((phase) => ({
  id: `${scenario.id}-${phase}`, scenario: scenario.id, phase, status: "completed", source: "terminalx-native",
  observation: phase === "baseline" ? observationFor(scenario.id) : corruptObservation(scenario.id, observationFor(scenario.id)),
  artifacts: artifactMetadata, break: phase === "baseline" ? undefined : { installed: true, restored: true, target: scenario.breaks, runId: identity.runId },
})));
const evaluate = (overrides = {}) => evaluateRun({ runId: identity.runId, identity, attempts, cleanup: [{ name: "owned-fixtures-removed", ok: true }], mode: "real", ...overrides });

for (const scenario of scenarios) {
  test(`${scenario.id}: discriminates its exact controlled contract mutation`, () => {
    assert.equal(assertions(scenario.id, observationFor(scenario.id), identity).every((c) => c.ok), true);
    assert.deepEqual(assertions(scenario.id, corruptObservation(scenario.id, observationFor(scenario.id)), identity).filter((c) => !c.ok).map((c) => c.name), [scenario.breaks]);
  });
  test(`${scenario.id}: empty/other-run observations fail`, () => {
    assert.equal(assertions(scenario.id, {}, identity).every((c) => c.ok), false);
    assert.equal(assertions(scenario.id, { ...observationFor(scenario.id), runId: "another-run" }, identity).find((c) => c.name === "run-owned").ok, false);
  });
}

test("schema-valid observations exercise the result evaluator, not real E2E", () => {
  assert.equal(evaluate().assertionStatus, "passed"); // Pure assertion evaluation only.
  assert.equal(evaluate().status, "incomplete");
  assert.equal(evaluate().certification.state, "unverified");
  assert.equal(evaluate({ mode: "contract-test" }).assertionStatus, "incomplete");
  assert.equal(exitCode(evaluate({ mode: "contract-test" })), 2);
});
test("missing or skipped required scenarios cannot turn green", () => {
  for (const status of ["skipped", "not-run", "incomplete", "failed", "timed-out"]) {
    const rows = structuredClone(attempts); rows[0].status = status;
    assert.notEqual(evaluate({ attempts: rows }).assertionStatus, "passed");
  }
  assert.equal(evaluate({ attempts: [] }).assertionStatus, "incomplete");
  assert.equal(evaluate({ attempts: attempts.filter((a) => a.phase !== "deliberate-break") }).assertionStatus, "incomplete");
});
test("retain first failure even if a retry passes", () => {
  const failed = { ...attempts[0], id: "initial-failure", observation: {} };
  const result = evaluate({ attempts: [failed, ...attempts] });
  assert.equal(result.assertionStatus, "failed");
  assert.ok(result.failures.some((failure) => failure.includes("initial-failure")));
});
test("identity mismatch, Linux second desktop, missing head or cleanup never pass", () => {
  for (const change of [{ machineB: "mac-a" }, { platformB: "linux" }, { desktopHeadB: "branch-main" }, { runId: "wrong" }, { accountB: "alice" }]) {
    assert.notEqual(evaluate({ identity: { ...identity, ...change } }).assertionStatus, "passed");
  }
  assert.equal(evaluate({ cleanup: [] }).assertionStatus, "incomplete");
  assert.equal(evaluate({ cleanup: [{ name: "volume-remains", ok: false }] }).assertionStatus, "failed");
});
test("unrelated break failure, unrestored fault or lost evidence is not a successful detection", () => {
  for (const modify of [
    (a) => { a.observation.orgId = "wrong"; },
    (a) => { a.break.restored = false; },
    (a) => { a.break.runId = "wrong"; },
    (a) => { a.artifacts = []; },
    (a) => { a.source = "webkit-stub"; },
    (a) => { a.observation = observationFor(a.scenario); },
  ]) {
    const rows = structuredClone(attempts); modify(rows[1]);
    assert.equal(evaluate({ attempts: rows }).assertionStatus, "failed");
  }
});
test("unread sync is per reader, not an inappropriate cross-account shared read marker", () => {
  const o = observationFor("unread-sync"); o.peerReaderId = "alice";
  assert.equal(assertions("unread-sync", o, identity).find((c) => c.name === "same-reader-second-surface").ok, false);
});
test("a suppressed accept detects the regression even though the invite also remains pending", () => {
  const rows = structuredClone(attempts);
  const attempt = rows.find((a) => a.scenario === "invite-accept" && a.phase === "deliberate-break");
  attempt.observation.pendingInviteCountAfter = 1;
  attempt.observation.acceptedInviteId = null;
  assert.equal(evaluate({ attempts: rows }).assertionStatus, "passed");
});
test("a failed notification delivery includes the absent destination and absent reconnect event", () => {
  const rows = structuredClone(attempts);
  const attempt = rows.find((a) => a.scenario === "mention-notification" && a.phase === "deliberate-break");
  attempt.observation.openedWorkspaceId = null;
  attempt.observation.matchingAfterReconnect = 0;
  assert.equal(evaluate({ attempts: rows }).assertionStatus, "passed");
});
test("an unrelated permission regression is never an accepted consequence of a suppressed invite", () => {
  const rows = structuredClone(attempts);
  const attempt = rows.find((a) => a.scenario === "invite-accept" && a.phase === "deliberate-break");
  attempt.observation.ownerId = "wrong-owner";
  assert.equal(evaluate({ attempts: rows }).assertionStatus, "failed");
});
test("the viewer negative control cannot conceal a real permission side effect", () => {
  const rows = structuredClone(attempts);
  const attempt = rows.find((a) => a.scenario === "viewer-read-only" && a.phase === "deliberate-break");
  attempt.observation.afterSeq++;
  attempt.observation.commandRecorded = true;
  assert.equal(evaluate({ attempts: rows }).assertionStatus, "failed");
});
test("suppressing a read update does not misdiagnose unchanged markers as a monotonicity regression", () => {
  const rows = structuredClone(attempts);
  const attempt = rows.find((a) => a.scenario === "unread-sync" && a.phase === "deliberate-break");
  attempt.observation.afterReadSeq = attempt.observation.beforeReadSeq;
  attempt.observation.afterStaleReadSeq = attempt.observation.beforeReadSeq;
  assert.equal(evaluate({ attempts: rows }).assertionStatus, "passed");
});
test("wrong notification recipient, duplicate notification and stale nonce fail", () => {
  for (const change of [{ recipientId: "alice" }, { nonce: "old-run" }, { workspaceId: "elsewhere" }]) {
    const o = observationFor("mention-notification"); o.received = { ...o.received, ...change };
    assert.equal(assertions("mention-notification", o, identity).find((c) => c.name === "notification-arrived").ok, false);
  }
});
