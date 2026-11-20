import { beforeEach, expect, it, vi } from "vitest";
import type { RuntimeSession } from "@terminalx/portable/workspace";

const mocks = vi.hoisted(() => ({ update: vi.fn(), remove: vi.fn(), release: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/cloudConnections", async (original) => ({
  ...(await original<typeof import("@/lib/cloudConnections")>()),
  retainCloudConnection: async () => ({ release: mocks.release }),
  waitCloudConnected: async () => ({ updateSession: mocks.update, deleteSession: mocks.remove }),
}));

const { deleteCloudSession, updateCloudSession } = await import("./cloudSessions");
const { getTabState, layoutOf, saveTabLayout } = await import("./tabLayouts");
const { getSessionStore, selectCloudSession, openIssues } = await import("./sessions");
const row = {
  key: "cloud:org:ws:session" as const, orgId: "org", workspaceId: "ws", sessionId: "session",
  title: "Work", branch: null, worktreeName: null, created: "", modified: "", pinned: false, archived: false, tabs: [], source: "live" as const,
};
const archived = { id: "session", archived: true } as RuntimeSession;
beforeEach(() => { vi.clearAllMocks(); selectCloudSession(row.key); mocks.update.mockResolvedValue(archived); });

it("returns the selected cloud session to welcome after successful archival", async () => {
  await updateCloudSession(row, { archived: true });
  expect(getSessionStore()).toMatchObject({ view: "welcome", selectedSessionId: null });
  expect(mocks.update).toHaveBeenCalledWith("session", { archived: true });
  expect(mocks.release).toHaveBeenCalled();
});

it.each(["other session", "same session reselected", "issues"])("preserves %s navigation while archival is pending", async (destination) => {
  let finish!: (session: RuntimeSession) => void;
  mocks.update.mockReturnValueOnce(new Promise<RuntimeSession>((resolve) => { finish = resolve; }));
  const pending = updateCloudSession(row, { archived: true });
  await vi.waitFor(() => expect(mocks.update).toHaveBeenCalled());
  if (destination === "issues") openIssues();
  else selectCloudSession(destination === "other session" ? "cloud:org:ws:other" : row.key);
  const chosen = getSessionStore();
  finish(archived);
  await pending;
  expect(getSessionStore()).toMatchObject({ selectedSessionId: chosen.selectedSessionId, view: chosen.view });
});

it("keeps selection when the runtime refuses archival", async () => {
  mocks.update.mockRejectedValueOnce(new Error("Offline"));
  await expect(updateCloudSession(row, { archived: true })).rejects.toThrow("Offline");
  expect(getSessionStore().selectedSessionId).toBe(row.key);
});

it("does not leave for unarchive or other edits", async () => {
  await updateCloudSession(row, { archived: false });
  await updateCloudSession(row, { title: "Renamed" });
  expect(getSessionStore().selectedSessionId).toBe(row.key);
});

it("forgets this viewer's layout of each deleted session's tabs (#1325)", async () => {
  const arranged = { order: ["agent:t-2", "agent:t-1"], pinned: ["agent:t-2"], muted: [], titles: {} };
  saveTabLayout("remote:cloud:org:ws:session", arranged);
  saveTabLayout("remote:cloud:org:ws:kept", arranged);
  mocks.remove.mockResolvedValueOnce({ deleted: ["session"] });
  await deleteCloudSession(row);
  expect(layoutOf(getTabState(), "remote:cloud:org:ws:session").order).toEqual([]);
  expect(layoutOf(getTabState(), "remote:cloud:org:ws:kept").pinned).toEqual(["agent:t-2"]);
});
