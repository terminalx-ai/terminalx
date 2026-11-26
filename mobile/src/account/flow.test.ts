import { beforeEach, expect, it, vi } from "vitest";
import { CloudApiError } from "../cloud/api";
import { accountDeletionText as T, type AccountDeletionAttempt, type AccountDeletionRead } from "./deletion";
import { plainRead } from "./fixtures";

const stored = vi.hoisted(() => ({ value: null as number | null }));
vi.mock("react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
vi.mock("./pending-deletion", () => ({ rememberPendingDeletion: async (at: number) => { stored.value = at; } }));
const { AccountDeletionFlow } = await import("./useAccountDeletion");

const NOW = Date.UTC(2026, 10, 25, 12);
const attempt = (state: string, extra: Partial<AccountDeletionAttempt> = {}): AccountDeletionAttempt => ({ id: "del_1", kind: "self", state, requestedAt: new Date(NOW).toISOString(), ...extra });

function setup(read: AccountDeletionRead = plainRead()) {
  const api = { accountDeletion: vi.fn(async () => read), requestAccountDeletion: vi.fn(async (_email: string) => attempt("scheduled", { deleteAfter: "2026-12-09T12:00:00.000Z" })) };
  const deps = { api, email: "alex@example.com", online: true, reauthenticate: vi.fn(async () => "signed-in" as const), forgetDeletedAccount: vi.fn(async () => undefined), now: () => NOW, wait: async () => undefined, providerName: (id: string) => (id === "box" ? "Boat" : id) };
  const flow = new AccountDeletionFlow(deps);
  return { flow, api, deps };
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => { stored.value = null; });

it("schedules a plain account at once, sends the account's own address, and forgets the account on the phone", async () => {
  const { flow, api, deps } = setup();
  await flow.load();
  flow.confirm();
  expect(flow.getSnapshot().sending).toBe("deleting");
  await settled();
  expect(api.requestAccountDeletion).toHaveBeenCalledWith("alex@example.com");
  expect(flow.getSnapshot().phase).toEqual({ kind: "scheduled", deleteAfter: Date.parse("2026-12-09T12:00:00.000Z"), stopped: 0 });
  expect(stored.value).toBe(Date.parse("2026-12-09T12:00:00.000Z"));
  expect(deps.forgetDeletedAccount).toHaveBeenCalledTimes(1);
});

it("says it is stopping running cloud workspaces, follows until they stop, then counts them", async () => {
  const read = plainRead();
  read.deleted.runningWorkspaces = [{ id: "ws_1", name: "notes", provider: "box", organizationId: "org_p" }, { id: "ws_2", name: "site", provider: "box", organizationId: "org_p" }];
  const { flow, api } = setup(read);
  await flow.load();
  api.requestAccountDeletion.mockResolvedValueOnce(attempt("stopping"));
  // Signed out everywhere once scheduled: the next read is refused.
  api.accountDeletion.mockResolvedValueOnce({ ...read, deletion: attempt("stopping") }).mockRejectedValueOnce(new CloudApiError("unauthorized", 401));
  flow.confirm();
  expect(flow.getSnapshot().sending).toBe("stopping");
  await vi.waitFor(() => expect(flow.getSnapshot().phase.kind).toBe("scheduled"));
  expect(flow.getSnapshot().phase).toEqual({ kind: "scheduled", deleteAfter: NOW + 14 * 86_400_000, stopped: 2 });
});

it("names the workspace that did not stop and the one that did, schedules nothing, and lets the person try again", async () => {
  const read = plainRead();
  read.deleted.runningWorkspaces = [{ id: "ws_1", name: "checkout-redesign", provider: "box", organizationId: "org_p" }, { id: "ws_2", name: "scratch", provider: "box", organizationId: "org_p" }];
  const { flow, api, deps } = setup(read);
  await flow.load();
  api.requestAccountDeletion.mockResolvedValueOnce(attempt("refused", { failure: { code: "workspace_stop_failed", provider: "box", workspaceId: "ws_2", workspaceName: null, reason: "provider_timed_out", stopped: [{ workspaceId: "ws_1", workspaceName: "checkout-redesign" }] } }));
  flow.confirm();
  await settled();
  expect(flow.getSnapshot().notice).toEqual({ kind: "refused", tone: "danger", text: `${T.failStop("Boat", "scratch", "the provider is not answering")} ${T.failStopKept(["checkout-redesign"])}` });
  expect(flow.getSnapshot().sending).toBeNull();
  expect(deps.forgetDeletedAccount).not.toHaveBeenCalled();
  flow.confirm();
  await settled();
  expect(api.requestAccountDeletion).toHaveBeenCalledTimes(2);
  expect(flow.getSnapshot().phase.kind).toBe("scheduled");
});

it("asks to sign in again when the server finds the sign-in no longer recent", async () => {
  const { flow, api } = setup();
  await flow.load();
  api.requestAccountDeletion.mockRejectedValueOnce(new CloudApiError("account_deletion_recent_sign_in_required", 403));
  flow.confirm();
  await settled();
  expect(flow.getSnapshot().notice).toEqual({ kind: "stale" });
  expect(flow.getSnapshot().read?.recentSignIn).toBe(false);
  // Signing in again reads the page again; the server now says the sign-in is recent.
  flow.signInAgain();
  await settled();
  expect(flow.getSnapshot().notice).toBeNull();
  expect(flow.getSnapshot().read?.recentSignIn).toBe(true);
});

it("says so when the sign-in again came back as someone else", async () => {
  const { flow, deps } = setup();
  await flow.load();
  deps.reauthenticate.mockResolvedValueOnce("other-account" as never);
  flow.signInAgain();
  await settled();
  expect(flow.getSnapshot().notice).toEqual({ kind: "other-account" });
});

it("reads the list again when something now stands in the way", async () => {
  const { flow, api } = setup();
  await flow.load();
  const blocked = { ...plainRead(), blockers: [{ code: "sole_owner_with_members", organizationId: "org_1", organizationName: "Northwind", otherMembers: 4 }] };
  api.requestAccountDeletion.mockRejectedValueOnce(new CloudApiError("account_deletion_blocked", 409));
  api.accountDeletion.mockResolvedValueOnce(blocked);
  flow.confirm();
  await settled();
  expect(flow.getSnapshot().notice).toEqual({ kind: "blocked" });
  expect(flow.getSnapshot().read?.blockers).toHaveLength(1);
});

it("sends nothing while offline", async () => {
  const { flow, api, deps } = setup();
  await flow.load();
  flow.update({ ...deps, online: false });
  flow.confirm();
  expect(api.requestAccountDeletion).not.toHaveBeenCalled();
  expect(flow.getSnapshot().notice).toEqual({ kind: "offline" });
});

it("checks before trying again when the answer was lost, and finds it scheduled", async () => {
  const { flow, api } = setup();
  await flow.load();
  api.requestAccountDeletion.mockRejectedValueOnce(new CloudApiError("cloud_workspace_unavailable", null, "timeout"));
  flow.confirm();
  await settled();
  expect(flow.getSnapshot().notice).toEqual({ kind: "unknown" });
  api.accountDeletion.mockRejectedValueOnce(new CloudApiError("unauthorized", 401));
  flow.check();
  await settled();
  expect(flow.getSnapshot().phase).toMatchObject({ kind: "scheduled" });
});

it("finds nothing scheduled after a lost answer and lets the person confirm again", async () => {
  const { flow, api } = setup();
  await flow.load();
  api.requestAccountDeletion.mockRejectedValueOnce(new CloudApiError("cloud_workspace_unavailable", 502));
  flow.confirm();
  await settled();
  flow.check();
  await settled();
  expect(flow.getSnapshot().notice).toBeNull();
  expect(flow.getSnapshot().phase.kind).toBe("ready");
});

it("shows a refusal the server answered as not deleted", async () => {
  const { flow, api } = setup();
  await flow.load();
  api.requestAccountDeletion.mockRejectedValueOnce(new CloudApiError("account_deletion_busy", 409));
  flow.confirm();
  await settled();
  expect(flow.getSnapshot().notice).toEqual({ kind: "refused", tone: "danger", text: T.failRefused });
});

it("shows the deletion running once the final deletion has started", async () => {
  const { flow } = setup({ ...plainRead(), deletion: attempt("deleting", { step: "workspaces" }) });
  await flow.load();
  expect(flow.getSnapshot().phase).toEqual({ kind: "finishing" });
});
