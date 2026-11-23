import { describe, expect, it } from "vitest";
import type { DashboardSession, DashboardTabStatus } from "@/lib/dashboard";
import { bucketSessions, isUnread } from "@/lib/dashboard";
import { machineDashboardSession, sessionPassesFilter, SIDEBAR_FILTERS } from "./sidebarFilter";
import type { MachineSessionRow, MachineSessionTab } from "@/lib/machineCatalog";

const session = (id: string, statuses: DashboardTabStatus[], fields: Partial<DashboardSession> = {}): DashboardSession => ({
  id,
  projectPath: "/repos/a",
  cwd: "/repos/a",
  title: id,
  modified: "2026-10-03T10:00:00.000Z",
  archived: false,
  tabs: statuses.map((status) => ({ harness: "claude", status })),
  ...fields,
});

describe("the sidebar's session filter", () => {
  const waiting = session("waiting", ["idle", "waiting"]);
  const working = session("working", ["in_progress", "completed"]);
  const unread = session("unread", ["completed", "idle"]);
  const read = session("read", ["idle"]);
  const all = [waiting, working, unread, read];

  it("shows everything by default", () => {
    expect(all.every((entry) => sessionPassesFilter("all", entry))).toBe(true);
    expect(sessionPassesFilter("all", session("archived", ["idle"], { archived: true }))).toBe(true);
  });

  it("Needs you is exactly the dashboard's Needs you column", () => {
    const needs = bucketSessions(all).needs.map((entry) => entry.id);
    expect(all.filter((entry) => sessionPassesFilter("needs", entry)).map((entry) => entry.id)).toEqual(needs);
    expect(needs).toEqual(["waiting"]);
  });

  it("Unread is a finished answer nobody has read: not one still working, not one waiting", () => {
    expect(all.filter((entry) => sessionPassesFilter("unread", entry)).map((entry) => entry.id)).toEqual(["unread"]);
    expect(all.filter(isUnread).map((entry) => entry.id)).toEqual(["unread"]);
  });

  it("never shows an archived session or one with no tab under a filter", () => {
    for (const filter of ["unread", "needs"] as const) {
      expect(sessionPassesFilter(filter, session("archived", ["waiting", "completed"], { archived: true }))).toBe(false);
      expect(sessionPassesFilter(filter, session("empty", []))).toBe(false);
    }
  });

  it("names each filter and what it says when nothing matches", () => {
    expect(SIDEBAR_FILTERS.map((entry) => [entry.id, entry.label, entry.empty])).toEqual([
      ["all", "All sessions", ""],
      ["unread", "Unread", "No unread sessions."],
      ["needs", "Needs you", "Nothing needs you."],
    ]);
  });
});

describe("machine sessions under the filter (PRO-346)", () => {
  const tab = (fields: Partial<MachineSessionTab> = {}): MachineSessionTab => ({ tabId: "t", harness: "claude", title: null, status: "idle", unread: false, pendingApprovals: 0, live: true, ...fields });
  const row = (tabs: MachineSessionTab[], fields: Partial<MachineSessionRow> = {}): MachineSessionRow => ({
    key: "machine:m1:p1:s1",
    machineId: "m1",
    projectId: "p1",
    sessionId: "s1",
    title: "Bisect",
    branch: null,
    worktreeName: null,
    created: "2026-11-15T10:00:00Z",
    modified: "2026-11-15T10:00:00Z",
    pinned: false,
    archived: false,
    tabs,
    activeTab: null,
    source: "live",
    ...fields,
  });

  it("is keyed by the session's machine key under its machine project", () => {
    const session = machineDashboardSession(row([tab()]));
    expect(session.id).toBe("machine:m1:p1:s1");
    expect(session.projectPath).toBe("machine:m1:p1");
  });

  it("needs you while a tab asks or has approvals pending", () => {
    expect(sessionPassesFilter("needs", machineDashboardSession(row([tab({ status: "waiting" })])))).toBe(true);
    expect(sessionPassesFilter("needs", machineDashboardSession(row([tab({ status: "in_progress", pendingApprovals: 1 })])))).toBe(true);
    expect(sessionPassesFilter("needs", machineDashboardSession(row([tab({ status: "in_progress" })])))).toBe(false);
  });

  it("is unread only while a finished answer is unread, and never while archived", () => {
    expect(sessionPassesFilter("unread", machineDashboardSession(row([tab({ status: "completed", unread: true })])))).toBe(true);
    expect(sessionPassesFilter("unread", machineDashboardSession(row([tab({ status: "completed", unread: false })])))).toBe(false);
    expect(sessionPassesFilter("unread", machineDashboardSession(row([tab({ status: "completed", unread: true })], { archived: true })))).toBe(false);
  });
});
