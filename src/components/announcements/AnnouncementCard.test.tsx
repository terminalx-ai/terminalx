import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AnnouncementCard } from "./AnnouncementCard";
import { ANNOUNCEMENT_INTERVAL_MS, parseAnnouncement, startAnnouncementChecks } from "@/lib/announcements";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), open: vi.fn(), version: vi.fn(),
  privacy: { enabled: false, ready: true }, privacyListeners: new Set<() => void>(),
  account: { status: { state: "signed-out" } } as { status: Record<string, unknown> }, accountListeners: new Set<() => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.version }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.open }));
vi.mock("@/lib/dataPrivacy", () => ({
  bootDataPrivacy: vi.fn(), getDataPrivacy: () => mocks.privacy,
  subscribeDataPrivacy: (fn: () => void) => { mocks.privacyListeners.add(fn); return () => mocks.privacyListeners.delete(fn); },
}));
vi.mock("@/lib/account", () => ({
  getAccount: () => mocks.account,
  subscribeAccount: (fn: () => void) => { mocks.accountListeners.add(fn); return () => mocks.accountListeners.delete(fn); },
}));
const item = { id: "one", title: "Welcome back", body: "New features", link: "https://terminalx.ai/changelog", isNew: true };
let stop: (() => void) | undefined;
const settle = async () => { await act(async () => { await Promise.resolve(); }); };
const policy = async (enabled: boolean, ready = true) => {
  await act(async () => { mocks.privacy = { enabled, ready }; for (const listener of mocks.privacyListeners) listener(); });
};
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  localStorage.removeItem("terminalx.announcements.v1");
  window.dispatchEvent(new StorageEvent("storage", { key: "terminalx.announcements.v1" }));
  mocks.privacy = { enabled: false, ready: true };
  mocks.account = { status: { state: "signed-out" } };
  mocks.version.mockResolvedValue("0.2.25"); mocks.invoke.mockResolvedValue(item); mocks.open.mockResolvedValue(undefined);
});
afterEach(() => { stop?.(); stop = undefined; cleanup(); vi.useRealTimers(); });

it("fetches immediately and hourly, with the actual app version, while the sidebar is hidden", async () => {
  stop = startAnnouncementChecks(); await settle();
  expect(mocks.invoke).toHaveBeenCalledWith("announcements_current", { appVersion: "0.2.25" });
  mocks.invoke.mockResolvedValue({ ...item, id: "two", title: "Second release" });
  await act(async () => vi.advanceTimersByTimeAsync(ANNOUNCEMENT_INTERVAL_MS));
  render(<AnnouncementCard />);
  expect(screen.getByText("Second release")).toBeTruthy();
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});

it("persists read and dismissal per id, leaving newer announcements visible", async () => {
  stop = startAnnouncementChecks(); await settle(); render(<AnnouncementCard />);
  expect(screen.getByText("NEW")).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Read the changelog" })));
  expect(mocks.open).toHaveBeenCalledWith(item.link);
  expect(screen.queryByText("NEW")).toBeNull();
  expect(JSON.parse(localStorage.getItem("terminalx.announcements.v1")!).lastSeen.id).toBe("one");
  fireEvent.click(screen.getByLabelText("Dismiss announcement"));
  expect(screen.queryByLabelText("Announcement")).toBeNull();
  stop(); stop = startAnnouncementChecks(); await settle();
  expect(screen.queryByLabelText("Announcement")).toBeNull();
  mocks.invoke.mockResolvedValue({ ...item, id: "two" });
  await act(async () => vi.advanceTimersByTimeAsync(ANNOUNCEMENT_INTERVAL_MS));
  expect(screen.getByText("NEW")).toBeTruthy();
});

it("does not mark a failed link open as read", async () => {
  mocks.open.mockRejectedValue(new Error("offline"));
  stop = startAnnouncementChecks(); await settle(); render(<AnnouncementCard />);
  await act(async () => fireEvent.click(screen.getByText("Read the changelog")));
  expect(screen.getByRole("alert")).toBeTruthy(); expect(screen.getByText("NEW")).toBeTruthy();
});

it("fails closed until privacy is known and drops an in-flight result on activation", async () => {
  mocks.privacy = { enabled: false, ready: false };
  stop = startAnnouncementChecks(); await settle();
  expect(mocks.invoke).not.toHaveBeenCalled();
  let resolve!: (value: unknown) => void;
  mocks.invoke.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await policy(false);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  await policy(true);
  await act(async () => resolve(item));
  render(<AnnouncementCard />);
  expect(screen.queryByLabelText("Announcement")).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(ANNOUNCEMENT_INTERVAL_MS));
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  await policy(false); await settle();
  expect(screen.getByText(item.title)).toBeTruthy();
});

it("ignores a request from a stopped owner and retries quiet failures", async () => {
  let resolve!: (value: unknown) => void;
  mocks.invoke.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  stop = startAnnouncementChecks(); await settle(); stop();
  mocks.invoke.mockRejectedValueOnce(new Error("offline"));
  stop = startAnnouncementChecks(); await settle();
  await act(async () => resolve({ ...item, title: "Stale request" }));
  render(<AnnouncementCard />); expect(screen.queryByText("Stale request")).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(ANNOUNCEMENT_INTERVAL_MS));
  expect(screen.getByText(item.title)).toBeTruthy();
});

it("gates targeted content on the active organization's flag and reacts to revocation", async () => {
  mocks.invoke.mockResolvedValue({ ...item, requiredFlag: "team.events.v1" });
  stop = startAnnouncementChecks(); await settle(); render(<AnnouncementCard />);
  expect(screen.queryByLabelText("Announcement")).toBeNull();
  await act(async () => {
    mocks.account.status = { state: "signed-in", identity: { organizationId: "org" }, organizations: [{ id: "org", cloud: { flags: { "team.events.v1": true } } }] };
    for (const listener of mocks.accountListeners) listener();
  });
  expect(screen.getByText(item.title)).toBeTruthy();
  await act(async () => { mocks.account.status = { state: "signed-out" }; for (const listener of mocks.accountListeners) listener(); });
  expect(screen.queryByLabelText("Announcement")).toBeNull();
});

it("rejects unsafe links and malformed responses, including missing NEW state", () => {
  for (const link of ["javascript:alert(1)", "file:///etc/passwd", "http://terminalx.ai", "https://user:pass@terminalx.ai"]) expect(parseAnnouncement({ ...item, link })).toBeNull();
  expect(parseAnnouncement({ ...item, isNew: undefined })).toBeNull();
  expect(parseAnnouncement(null)).toBeNull();
  expect(parseAnnouncement({ ...item, title: "x".repeat(161) })).toBeNull();
});


it("catches up on focus after sleeping past an hour without duplicating an in-flight fetch", async () => {
  stop = startAnnouncementChecks(); await settle();
  const before = Date.now();
  vi.setSystemTime(before + ANNOUNCEMENT_INTERVAL_MS + 1);
  let resolve!: (value: unknown) => void;
  mocks.invoke.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await act(async () => window.dispatchEvent(new Event("focus")));
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
  await act(async () => resolve({ ...item, id: "awake", title: "While you were away" }));
  render(<AnnouncementCard />);
  expect(screen.getByText("While you were away")).toBeTruthy();
});

it("honors a dismissal made in another window", async () => {
  stop = startAnnouncementChecks(); await settle(); render(<AnnouncementCard />);
  act(() => {
    localStorage.setItem("terminalx.announcements.v1", JSON.stringify({ seen: ["one"], dismissed: ["one"], lastSeen: null }));
    window.dispatchEvent(new StorageEvent("storage", { key: "terminalx.announcements.v1" }));
  });
  expect(screen.queryByLabelText("Announcement")).toBeNull();
});
