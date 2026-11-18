import { describe, expect, it } from "vitest";
import { threeAgentSession, threeAgentTab, threeAgentWorkspace } from "@/components/layout/cloud/cloudSessionFixtures.test-utils";
import { buildCloudSessions, cloudSessionStatus } from "@/lib/cloudSessions";
import type { CloudSessionRow } from "@/lib/cloudSessions";
import { cloudTabRows, cloudTabStatus } from "@/lib/cloudSessionTabs";
import type { TabStatus } from "@/types/session";

const live = (): CloudSessionRow => buildCloudSessions({ item: threeAgentWorkspace(), live: [threeAgentSession()] })[0];
const order: TabStatus[] = ["waiting", "in_progress", "completed", "idle"];
const mostUrgent = (statuses: TabStatus[]) => order.find((status) => statuses.includes(status));
const frontIds = (rows: { tabId: string; front: boolean }[]) => rows.filter((row) => row.front).map((row) => row.tabId);

describe("cloudTabRows", () => {
  it("lists every tab of the live session in order with labels and statuses", () => {
    const rows = cloudTabRows(live());
    expect(rows.map((row) => row.tabId)).toEqual(["tab-codex", "tab-claude", "tab-codex-2"]);
    expect(rows.map((row) => row.harness)).toEqual(["codex", "claude", "codex"]);
    expect(rows.map((row) => row.label)).toEqual(["Fix the flaky build", "Review the fix", "Codex"]);
    expect(rows.map((row) => row.status)).toEqual(["in_progress", "completed", "idle"]);
  });

  it.each([
    { title: null, label: "Claude Code" },
    { title: "  ", label: "Claude Code" },
    { title: "Review the sidebar", label: "Review the sidebar" },
  ])("labels a Claude tab with title $title as $label", ({ title, label }) => {
    const session = threeAgentSession();
    session.tabs = session.tabs.map((tab) => (tab.id === "tab-claude" ? { ...tab, title } : tab));
    const [row] = buildCloudSessions({ item: threeAgentWorkspace(), live: [session] });
    expect(cloudTabRows(row).find((tab) => tab.tabId === "tab-claude")?.label).toBe(label);
  });

  it.each([
    { harness: "constructor", title: null, label: "constructor" },
    { harness: "__proto__", title: null, label: "__proto__" },
    { harness: "constructor", title: "My explicit title", label: "My explicit title" },
  ])("labels a tab with harness $harness and title $title", ({ harness, title, label }) => {
    const row = live();
    row.tabs = row.tabs.map((tab) => tab.tabId === "tab-claude" ? { ...tab, harness, title } : tab);
    expect(cloudTabRows(row).find((tab) => tab.tabId === "tab-claude")?.label).toBe(label);
  });

  it("shows no tab of a stopped workspace's cached list as working", () => {
    const [row] = buildCloudSessions({ item: threeAgentWorkspace({ state: "suspended" }), cached: { sessions: [threeAgentSession()], capabilities: [], at: 1 } });
    expect(row.source).toBe("cache");
    const rows = cloudTabRows(row);
    expect(rows).toHaveLength(3);
    expect(rows.map((entry) => entry.status)).not.toContain("in_progress");
    expect(rows[0].status).toBe("idle");
  });

  it("reads a tab with a pending permission as waiting", () => {
    const [row] = buildCloudSessions({ item: threeAgentWorkspace(), live: [threeAgentSession()], agentTabs: [threeAgentTab("tab-claude", "claude", "idle", 1)] });
    const rows = cloudTabRows(row);
    expect(rows.find((entry) => entry.tabId === "tab-claude")?.status).toBe("waiting");
    expect(cloudSessionStatus(row)).toBe("waiting");
  });

  it("gives no rows for a workspace not shared with the person", () => {
    const [row] = buildCloudSessions({ item: threeAgentWorkspace({ you: { role: "none" }, launch: { sessionId: "agents" } }), live: [threeAgentSession()] });
    expect(row.title).toBe("One");
    expect(cloudTabRows(row)).toEqual([]);
  });

  it("gives no rows for a session with one tab", () => {
    const session = threeAgentSession();
    const [row] = buildCloudSessions({ item: threeAgentWorkspace(), live: [{ ...session, tabs: session.tabs.slice(0, 1) }] });
    expect(row.tabs).toHaveLength(1);
    expect(cloudTabRows(row)).toEqual([]);
  });

  it("takes a projected status over the tab's own, only for tabs it lists", () => {
    const rows = cloudTabRows(live(), { projected: [{ tabId: "tab-codex", status: "waiting" }, { tabId: "tab-claude", status: "idle" }] });
    expect(rows.map((row) => row.status)).toEqual(["waiting", "idle", "idle"]);
    expect(cloudTabRows(live(), { projected: null }).map((row) => row.status)).toEqual(["in_progress", "completed", "idle"]);
  });

  it("has the most urgent row status equal the session's status", () => {
    const rows = cloudTabRows(live());
    expect(mostUrgent(rows.map((row) => row.status))).toBe(cloudSessionStatus(live()));
    const [waiting] = buildCloudSessions({ item: threeAgentWorkspace(), live: [threeAgentSession()], agentTabs: [threeAgentTab("tab-claude", "claude", "idle", 1)] });
    expect(mostUrgent(cloudTabRows(waiting).map((row) => row.status))).toBe(cloudSessionStatus(waiting));
  });

  describe("front", () => {
    it("is the shown agent tab", () => {
      expect(frontIds(cloudTabRows(live(), { shown: { kind: "agent", id: "tab-claude" }, asked: { kind: "agent", id: "tab-codex" } }))).toEqual(["tab-claude"]);
    });
    it("is no row when a tab of another kind is shown", () => {
      expect(frontIds(cloudTabRows(live(), { shown: { kind: "terminal", id: "tab-claude" }, asked: { kind: "agent", id: "tab-codex" } }))).toEqual([]);
    });
    it("is no row when the shown agent is not one of the tabs", () => {
      expect(frontIds(cloudTabRows(live(), { shown: { kind: "agent", id: "gone" } }))).toEqual([]);
    });
    it("is the asked agent tab when nothing is shown", () => {
      expect(frontIds(cloudTabRows(live(), { shown: null, asked: { kind: "agent", id: "tab-codex" } }))).toEqual(["tab-codex"]);
    });
    it("skips an asked tab that is not an agent or not a tab, falling to the active tab", () => {
      expect(frontIds(cloudTabRows(live(), { asked: { kind: "terminal", id: "tab-codex" } }))).toEqual(["tab-codex-2"]);
      expect(frontIds(cloudTabRows(live(), { asked: { kind: "agent", id: "gone" } }))).toEqual(["tab-codex-2"]);
    });
    it("is the active tab by default", () => {
      expect(frontIds(cloudTabRows(live()))).toEqual(["tab-codex-2"]);
    });
    it("is the first tab when the active tab is missing or unknown", () => {
      const row = live();
      expect(frontIds(cloudTabRows({ ...row, activeTab: null }))).toEqual(["tab-codex"]);
      expect(frontIds(cloudTabRows({ ...row, activeTab: "gone" }))).toEqual(["tab-codex"]);
    });
  });
});

describe("cloudTabStatus", () => {
  it("ranks waiting, working, unread reply, idle", () => {
    const [first, second, third] = live().tabs;
    expect(cloudTabStatus(first)).toBe("in_progress");
    expect(cloudTabStatus(second)).toBe("completed");
    expect(cloudTabStatus({ ...second, unread: false })).toBe("idle");
    expect(cloudTabStatus(third)).toBe("idle");
    expect(cloudTabStatus({ ...third, status: "waiting" })).toBe("waiting");
    expect(cloudTabStatus({ ...first, pendingApprovals: 2 })).toBe("waiting");
  });
});
