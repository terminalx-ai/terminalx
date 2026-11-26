import { beforeEach, expect, it, vi } from "vitest";
import { CloudApiError, NotSentSignedOutError } from "../cloud/api";
import { accountDeletionText as T, type AccountDeletionAttempt, type AccountDeletionRead } from "./deletion";
import { plainRead } from "./fixtures";

const stored = vi.hoisted(() => ({ value: null as number | null, storage: new Map<string, string>() }));
vi.mock("react-native", () => ({ AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => stored.storage.get(key) ?? null,
  setItem: async (key: string, value: string) => { stored.storage.set(key, value); },
  removeItem: async (key: string) => { stored.storage.delete(key); },
} }));
vi.mock("./pending-deletion", () => ({ rememberPendingDeletion: async (at: number) => { stored.value = at; } }));
const { AccountDeletionFlow } = await import("./useAccountDeletion");
const { readConfirmedDeletion, settleConfirmedDeletion } = await import("./confirmed-deletion");
type ReauthOutcome = import("./useAccountDeletion").ReauthOutcome;

const NOW = Date.UTC(2026, 10, 25, 12);
const attempt = (state: string, extra: Partial<AccountDeletionAttempt> = {}): AccountDeletionAttempt => ({ id: "del_1", kind: "self", state, requestedAt: new Date(NOW).toISOString(), ...extra });

function setup(read: AccountDeletionRead = plainRead()) {
  const api = { accountDeletion: vi.fn(async () => read), requestAccountDeletion: vi.fn(async (_email: string) => attempt("scheduled", { deleteAfter: "2026-12-09T12:00:00.000Z" })) };
  const deps = { api, email: "alex@example.com", userId: "user-alex", online: true, reauthenticate: vi.fn(async (): Promise<ReauthOutcome> => "signed-in"), forgetDeletedAccount: vi.fn(async () => undefined), wait: async (_ms: number): Promise<void> => undefined, providerName: (id: string) => (id === "box" ? "Boat" : id) };
  const flow = new AccountDeletionFlow(deps);
  return { flow, api, deps };
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => { stored.value = null; stored.storage = new Map(); });

const stopping = (deleteAfter?: string) => attempt("stopping", deleteAfter ? { deleteAfter } : {});
const runningRead = (): AccountDeletionRead => {
  const read = plainRead();
  return { ...read, deleted: { ...read.deleted, runningWorkspaces: [{ id: "ws-1", name: "scratch", provider: "box", organizationId: "org-1" }] } };
};

it("a 401 the phone made because it holds no session never reads as scheduled", async () => {
  const { flow, api, deps } = setup();
  await flow.load();
  api.requestAccountDeletion.mockRejectedValueOnce(new CloudApiError("cloud_workspace_unavailable", null, "timeout"));
  flow.confirm("alex@example.com");
  await settled();
  expect(flow.getSnapshot().notice).toEqual({ kind: "unknown" });
  // Check again with the stored session gone: nothing reached the server.
  api.accountDeletion.mockRejectedValueOnce(new NotSentSignedOutError());
  flow.check();
  await settled();
  expect(flow.getSnapshot().phase.kind).toBe("ready");
  expect(flow.getSnapshot().notice).toEqual({ kind: "unknown" });
  expect(deps.forgetDeletedAccount).not.toHaveBeenCalled();
  // The server's own 401, after the confirmation: every device was signed out, so it was scheduled.
  api.accountDeletion.mockRejectedValueOnce(new CloudApiError("unauthorized", 401));
  flow.check();
  await settled();
  expect(flow.getSnapshot().phase.kind).toBe("scheduled");
  expect(deps.forgetDeletedAccount).toHaveBeenCalledTimes(1);
});

it("a 401 the phone made while following a stop does not read as scheduled either", async () => {
  const { flow, api, deps } = setup(runningRead());
  api.requestAccountDeletion.mockResolvedValueOnce(stopping("2026-12-09T12:00:00.000Z"));
  await flow.load();
  api.accountDeletion.mockRejectedValueOnce(new NotSentSignedOutError());
  flow.confirm("alex@example.com");
  await settled();
  await settled();
  expect(flow.getSnapshot().phase.kind).toBe("ready");
  expect(flow.getSnapshot().notice).toEqual({ kind: "unknown" });
  expect(deps.forgetDeletedAccount).not.toHaveBeenCalled();
});

it("keeps a confirmation left during stopping, and settles it after the page closed as the page would", async () => {
  const { flow, api, deps } = setup(runningRead());
  let answer!: () => void;
  deps.wait = () => new Promise<void>((resolve) => { answer = resolve; });
  api.requestAccountDeletion.mockResolvedValueOnce(stopping("2026-12-09T12:00:00.000Z"));
  await flow.load();
  flow.open();
  flow.confirm("alex@example.com");
  await settled();
  expect(await readConfirmedDeletion()).toEqual({ userId: "user-alex", deleteAfter: Date.parse("2026-12-09T12:00:00.000Z") });
  // Leaving the page ends following it.
  flow.close();
  answer();
  await settled();
  expect(deps.forgetDeletedAccount).not.toHaveBeenCalled();
  // Still stopping when the app asks: kept, and asked again later.
  const forget = vi.fn(async () => undefined);
  api.accountDeletion.mockResolvedValueOnce({ ...runningRead(), deletion: stopping("2026-12-09T12:00:00.000Z") });
  expect(await settleConfirmedDeletion({ api, userId: "user-alex", forgetDeletedAccount: forget })).toBe("waiting");
  // A 401 the phone made says nothing.
  api.accountDeletion.mockRejectedValueOnce(new NotSentSignedOutError());
  expect(await settleConfirmedDeletion({ api, userId: "user-alex", forgetDeletedAccount: forget })).toBe("unknown");
  expect(forget).not.toHaveBeenCalled();
  // The server signed the phone out: scheduled, with the stopping attempt's day for Settings.
  api.accountDeletion.mockRejectedValueOnce(new CloudApiError("unauthorized", 401));
  expect(await settleConfirmedDeletion({ api, userId: "user-alex", forgetDeletedAccount: forget })).toBe("scheduled");
  expect(stored.value).toBe(Date.parse("2026-12-09T12:00:00.000Z"));
  expect(forget).toHaveBeenCalledTimes(1);
  expect(await readConfirmedDeletion()).toBeNull();
});

it("forgets a kept confirmation that was refused, or belongs to another account", async () => {
  const { flow, api } = setup();
  api.requestAccountDeletion.mockRejectedValueOnce(new CloudApiError("account_deletion_busy", 409));
  await flow.load();
  flow.confirm("alex@example.com");
  await settled();
  expect(await readConfirmedDeletion()).toBeNull();
  const forget = vi.fn(async () => undefined);
  stored.storage.set("terminalx:account-deletion-confirmed:v1", JSON.stringify({ userId: "user-alex", deleteAfter: null }));
  expect(await settleConfirmedDeletion({ api, userId: "user-sam", forgetDeletedAccount: forget })).toBe("ended");
  expect(forget).not.toHaveBeenCalled();
  expect(await readConfirmedDeletion()).toBeNull();
});

it("opened again while stopping: keeps the attempt's day for when every device is signed out", async () => {
  const { flow, api, deps } = setup({ ...runningRead(), deletion: stopping("2026-12-09T12:00:00.000Z") });
  let answer!: () => void;
  deps.wait = () => new Promise<void>((resolve) => { answer = resolve; });
  await flow.load();
  await settled();
  expect(flow.getSnapshot().sending).toBe("stopping");
  api.accountDeletion.mockRejectedValueOnce(new CloudApiError("unauthorized", 401));
  answer();
  await settled();
  await settled();
  expect(flow.getSnapshot().phase).toEqual({ kind: "scheduled", deleteAfter: Date.parse("2026-12-09T12:00:00.000Z"), graceDays: 14, stopped: 1 });
});

it("a read refused because the final deletion has started says it is being deleted", async () => {
  const { flow, api } = setup();
  api.accountDeletion.mockRejectedValueOnce(new CloudApiError("account_deletion_in_progress", 409));
  await flow.load();
  expect(flow.getSnapshot().phase.kind).toBe("finishing");
});

it("says so when signing in again failed, or the address has no account", async () => {
  const { flow, deps } = setup({ ...plainRead(), recentSignIn: false });
  await flow.load();
  deps.reauthenticate.mockRejectedValueOnce(new Error("state_mismatch"));
  flow.signInAgain();
  await settled();
  expect(flow.getSnapshot().notice).toEqual({ kind: "sign-in-failed" });
  expect(flow.getSnapshot().signingIn).toBe(false);
  deps.reauthenticate.mockResolvedValueOnce("no-account");
  flow.signInAgain();
  await settled();
  expect(flow.getSnapshot().notice).toEqual({ kind: "no-account" });
});

it("schedules a plain account at once, sends what was typed, and forgets the account on the phone", async () => {
  const { flow, api, deps } = setup();
  await flow.load();
  flow.confirm("alex@example.com");
  expect(flow.getSnapshot().sending).toBe("deleting");
  await settled();
  expect(api.requestAccountDeletion).toHaveBeenCalledWith("alex@example.com");
  expect(flow.getSnapshot().phase).toEqual({ kind: "scheduled", deleteAfter: Date.parse("2026-12-09T12:00:00.000Z"), graceDays: 14, stopped: 0 });
  expect(stored.value).toBe(Date.parse("2026-12-09T12:00:00.000Z"));
  expect(deps.forgetDeletedAccount).toHaveBeenCalledTimes(1);
});

it("says it is stopping running cloud workspaces, follows until they stop, then counts them; no day is made up once signed out", async () => {
  const read = plainRead();
  read.deleted.runningWorkspaces = [{ id: "ws_1", name: "notes", provider: "box", organizationId: "org_p" }, { id: "ws_2", name: "site", provider: "box", organizationId: "org_p" }];
  const { flow, api } = setup(read);
  await flow.load();
  api.requestAccountDeletion.mockResolvedValueOnce(attempt("stopping"));
  // Signed out everywhere once scheduled: the next read is refused.
  api.accountDeletion.mockResolvedValueOnce({ ...read, deletion: attempt("stopping") }).mockRejectedValueOnce(new CloudApiError("unauthorized", 401));
  flow.confirm("alex@example.com");
  expect(flow.getSnapshot().sending).toBe("stopping");
  await vi.waitFor(() => expect(flow.getSnapshot().phase.kind).toBe("scheduled"));
  // Every device was signed out before the server said the day: the page says the grace it gave, and Settings remembers nothing.
  expect(flow.getSnapshot().phase).toEqual({ kind: "scheduled", deleteAfter: null, graceDays: 14, stopped: 2 });
  expect(stored.value).toBeNull();
});

it("says the day a stopping answer gave when every device is signed out before the scheduled one is read", async () => {
  const read = plainRead();
  read.deleted.runningWorkspaces = [{ id: "ws_1", name: "notes", provider: "box", organizationId: "org_p" }];
  const { flow, api } = setup(read);
  await flow.load();
  api.requestAccountDeletion.mockResolvedValueOnce(attempt("stopping", { deleteAfter: "2026-12-09T12:00:07.000Z" }));
  api.accountDeletion.mockRejectedValueOnce(new CloudApiError("unauthorized", 401));
  flow.confirm("alex@example.com");
  await vi.waitFor(() => expect(flow.getSnapshot().phase.kind).toBe("scheduled"));
  expect(flow.getSnapshot().phase).toMatchObject({ deleteAfter: Date.parse("2026-12-09T12:00:07.000Z"), stopped: 1 });
  expect(stored.value).toBe(Date.parse("2026-12-09T12:00:07.000Z"));
});

it("takes the day from a scheduled answer read while following", async () => {
  const read = plainRead();
  read.deleted.runningWorkspaces = [{ id: "ws_1", name: "notes", provider: "box", organizationId: "org_p" }];
  const { flow, api } = setup(read);
  await flow.load();
  api.requestAccountDeletion.mockResolvedValueOnce(attempt("stopping"));
  api.accountDeletion.mockResolvedValueOnce({ ...read, deletion: attempt("scheduled", { deleteAfter: "2026-12-09T12:00:05.000Z" }) });
  flow.confirm("alex@example.com");
  await vi.waitFor(() => expect(flow.getSnapshot().phase.kind).toBe("scheduled"));
  expect(flow.getSnapshot().phase).toMatchObject({ deleteAfter: Date.parse("2026-12-09T12:00:05.000Z") });
  expect(stored.value).toBe(Date.parse("2026-12-09T12:00:05.000Z"));
});

it("names the workspace that did not stop and the one that did, schedules nothing, and lets the person try again", async () => {
  const read = plainRead();
  read.deleted.runningWorkspaces = [{ id: "ws_1", name: "checkout-redesign", provider: "box", organizationId: "org_p" }, { id: "ws_2", name: "scratch", provider: "box", organizationId: "org_p" }];
  const { flow, api, deps } = setup(read);
  await flow.load();
  api.requestAccountDeletion.mockResolvedValueOnce(attempt("refused", { failure: { code: "workspace_stop_failed", provider: "box", workspaceId: "ws_2", workspaceName: null, reason: "provider_timed_out", stopped: [{ workspaceId: "ws_1", workspaceName: "checkout-redesign" }] } }));
  flow.confirm("alex@example.com");
  await settled();
  expect(flow.getSnapshot().notice).toEqual({ kind: "refused", tone: "danger", text: `${T.failStop("Boat", "scratch", "the provider is not answering")} ${T.failStopKept(["checkout-redesign"])}` });
  expect(flow.getSnapshot().sending).toBeNull();
  expect(deps.forgetDeletedAccount).not.toHaveBeenCalled();
  flow.confirm("alex@example.com");
  await settled();
  expect(api.requestAccountDeletion).toHaveBeenCalledTimes(2);
  expect(flow.getSnapshot().phase.kind).toBe("scheduled");
});

it("asks to sign in again when the server finds the sign-in no longer recent", async () => {
  const { flow, api } = setup();
  await flow.load();
  api.requestAccountDeletion.mockRejectedValueOnce(new CloudApiError("account_deletion_recent_sign_in_required", 403));
  flow.confirm("alex@example.com");
  await settled();
  expect(flow.getSnapshot().notice).toEqual({ kind: "stale" });
  expect(flow.getSnapshot().read?.recentSignIn).toBe(false);
  // Signing in again reads the page again; the server now says the sign-in is recent.
  flow.signInAgain();
  await settled();
  expect(flow.getSnapshot().notice).toBeNull();
  expect(flow.getSnapshot().read?.recentSignIn).toBe(true);
});

it("a sign-in made before the server kept sign-in times: asks to sign in again, and an earlier read answering late does not undo it", async () => {
  const stale = { ...plainRead(), recentSignIn: false };
  const { flow, api, deps } = setup(stale);
  await flow.load();
  expect(flow.getSnapshot().read?.recentSignIn).toBe(false);
  // Back from the sheet: the app's own read (with the old sign-in) answers after the one Sign in again makes.
  let late!: (value: AccountDeletionRead) => void;
  api.accountDeletion.mockImplementationOnce(() => new Promise((resolve) => { late = resolve; }));
  void flow.load();
  api.accountDeletion.mockResolvedValueOnce(plainRead());
  flow.signInAgain();
  await settled();
  expect(deps.reauthenticate).toHaveBeenCalledTimes(1);
  expect(flow.getSnapshot().read?.recentSignIn).toBe(true);
  late(stale);
  await settled();
  expect(flow.getSnapshot().read?.recentSignIn).toBe(true);
  flow.confirm("alex@example.com");
  await settled();
  expect(api.requestAccountDeletion).toHaveBeenCalledWith("alex@example.com");
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
  flow.confirm("alex@example.com");
  await settled();
  expect(flow.getSnapshot().notice).toEqual({ kind: "blocked" });
  expect(flow.getSnapshot().read?.blockers).toHaveLength(1);
});

it("sends what the person typed, trimmed, so the server checks it; nothing when it does not match", async () => {
  const { flow, api } = setup();
  await flow.load();
  flow.confirm("alex@example.co");
  expect(api.requestAccountDeletion).not.toHaveBeenCalled();
  expect(flow.getSnapshot().mismatch).toBe(true);
  flow.confirm("  Alex@Example.com \n");
  await settled();
  expect(api.requestAccountDeletion).toHaveBeenCalledWith("Alex@Example.com");
});

it("sends nothing while offline", async () => {
  const { flow, api, deps } = setup();
  await flow.load();
  flow.update({ ...deps, online: false });
  flow.confirm("alex@example.com");
  expect(api.requestAccountDeletion).not.toHaveBeenCalled();
  expect(flow.getSnapshot().notice).toEqual({ kind: "offline" });
});

it("checks before trying again when the answer was lost, and finds it scheduled", async () => {
  const { flow, api } = setup();
  await flow.load();
  api.requestAccountDeletion.mockRejectedValueOnce(new CloudApiError("cloud_workspace_unavailable", null, "timeout"));
  flow.confirm("alex@example.com");
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
  flow.confirm("alex@example.com");
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
  flow.confirm("alex@example.com");
  await settled();
  expect(flow.getSnapshot().notice).toEqual({ kind: "refused", tone: "danger", text: T.failRefused });
});

it("shows the deletion running once the final deletion has started", async () => {
  const { flow } = setup({ ...plainRead(), deletion: attempt("deleting", { step: "workspaces" }) });
  await flow.load();
  expect(flow.getSnapshot().phase).toEqual({ kind: "finishing" });
});
