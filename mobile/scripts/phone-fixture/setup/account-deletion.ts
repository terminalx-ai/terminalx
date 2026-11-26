import type { SetupHandler } from "./types";

/**
 * The fixture's answers for Delete account (PRO-584, board 26.01), in the
 * shapes of terminalx-saas `docs/account-deletion.md`: the read route, the
 * confirm and the notice, under `/v1/mobile/account/deletion`. Placeholder
 * data only. `fixtureDeletion: <state>` (a launch argument) picks the account:
 *
 * | `fixtureDeletion` | The account |
 * | --- | --- |
 * | `plain` | nothing in the way, signed in recently; confirming schedules it after a few seconds |
 * | `running` | two running cloud workspaces; confirming stops them for a few seconds, then schedules it |
 * | `stop-refused` | `running`, and Boat does not stop scratch; checkout-redesign stops |
 * | `blocked` | the only owner of Northwind, which has 4 other members; running workspaces too |
 * | `stale` | the sign-in is not recent until the person signs in again |
 * | `stale-later` | recent when read, refused as no longer recent when confirmed |
 * | `refused` | confirming is refused (`account_deletion_busy`); the next try schedules it |
 * | `unknown` | the confirmation gets no answer; Check again finds nothing scheduled |
 * | `changed` | nothing in the way when read; Northwind stands in the way when confirmed |
 * | `finishing` | the 14 days have passed and the final deletion runs |
 * | `cancelled` | signing in cancelled a deletion; the two stopped at confirm stay stopped |
 */
const PATH = "/v1/mobile/account/deletion";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let signedInAgain = false;
/** The fixture app's "Sign in again" ended: the next read says the sign-in is recent. */
export function markSignedInAgain(): void {
  signedInAgain = true;
}

let confirms = 0;
let confirmedAt: number | null = null;
let scheduled = false;
let blockedNow = false;

const RUNNING = [
  { id: "ws-checkout-redesign", name: "checkout-redesign", provider: "box", organizationId: "org-northwind" },
  { id: "ws-scratch", name: "scratch", provider: "box", organizationId: "org-personal" },
];
const OWNER = { code: "sole_owner_with_members", organizationId: "org-northwind", organizationName: "Northwind", otherMembers: 4 };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function attempt(state: string, extra: Record<string, unknown> = {}) {
  const at = confirmedAt ?? Date.now();
  return { id: "del-fixture", kind: "self", state, step: null, requestedAt: new Date(at).toISOString(), deleteAfter: state === "scheduled" ? new Date(at + 14 * DAY).toISOString() : null, startedAt: null, deletedAt: null, cancelledAt: null, failure: null, workspaces: [], ...extra };
}

function read(state: string) {
  const running = ["running", "stop-refused", "blocked"].includes(state);
  const deletion = state === "finishing"
    ? attempt("deleting", { step: "workspaces", requestedAt: new Date(Date.now() - 14 * DAY - 5 * MINUTE).toISOString(), startedAt: new Date(Date.now() - 5 * MINUTE).toISOString() })
    : state === "cancelled"
      ? attempt("cancelled", { cancelledAt: new Date().toISOString(), workspaces: RUNNING.map((workspace) => ({ workspaceId: workspace.id, workspaceName: workspace.name, provider: workspace.provider, action: "stop", state: "stopped" })) })
      : null;
  return {
    graceDays: 14,
    retentionDays: 90,
    recentSignIn: state === "stale" ? signedInAgain : true,
    blockers: state === "blocked" || blockedNow ? [OWNER] : [],
    deleted: {
      authMethods: ["google", "email"],
      runningWorkspaces: running ? RUNNING : [],
      organizations: [{ id: "org-personal", name: "Alex Rivera", isPersonal: true, workspaces: 2 }],
      leftOrganizations: [{ id: "org-northwind", name: "Northwind" }, { id: "org-contoso", name: "Contoso Labs" }].filter((organization) => running || organization.id === "org-contoso"),
      computeKeys: 1,
      agentLogins: 2,
      githubConnections: 1,
      pairedDevices: 3,
      sessions: 2,
    },
    deletion,
    notice: state === "cancelled" ? "cancelled" : null,
  };
}

export const handle: SetupHandler = async (request) => {
  const state = request.argument("fixtureDeletion");
  if (!state || !request.path.startsWith(PATH)) return undefined;
  // Signed out everywhere once it is scheduled: every request is refused, as the server's are.
  if (scheduled) return request.json(401, { error: "unauthorized" });
  if (request.path === `${PATH}/notice`) return request.json(200, {});
  if (request.method === "GET") {
    // While the running ones stop, a few reads answer "stopping", then the deletion is scheduled.
    if (confirmedAt !== null && (state === "running" || state === "stop-refused")) {
      if (Date.now() - confirmedAt < 9_000) return request.json(200, { ...read(state), deletion: attempt("stopping") });
      if (state === "stop-refused") {
        confirmedAt = null;
        return request.json(200, { ...read(state), deletion: attempt("refused", { failure: { code: "workspace_stop_failed", provider: "box", workspaceId: "ws-scratch", workspaceName: "scratch", reason: "provider_timed_out", stopped: [{ workspaceId: "ws-checkout-redesign", workspaceName: "checkout-redesign", provider: "box" }] } }) });
      }
      scheduled = true;
      return request.json(401, { error: "unauthorized" });
    }
    return request.json(200, read(state));
  }
  if (request.method !== "POST") return undefined;
  confirms += 1;
  if (state === "unknown") {
    await pause(4_000);
    throw new TypeError("Network request failed");
  }
  await pause(3_500);
  if (state === "refused" && confirms === 1) return request.json(409, { error: "account_deletion_busy" });
  if (state === "stale-later") return request.json(403, { error: "account_deletion_recent_sign_in_required" });
  if (state === "changed") {
    blockedNow = true;
    return request.json(409, { error: "account_deletion_blocked", blockers: [OWNER] });
  }
  if (state === "running" || state === "stop-refused") {
    confirmedAt = Date.now();
    return request.json(202, attempt("stopping", { workspaces: RUNNING.map((workspace) => ({ workspaceId: workspace.id, workspaceName: workspace.name, provider: workspace.provider, action: "stop", state: "pending" })) }));
  }
  confirmedAt = Date.now();
  scheduled = true;
  return request.json(202, attempt("scheduled"));
};
