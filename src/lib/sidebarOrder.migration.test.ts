import { beforeEach, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ custom: true, sessions: ["older", "newer"], projects: ["/b", "/a"], revision: 3 }));
vi.mock("@/lib/api", () => ({
  errorMessage: String,
  invoke: vi.fn(async (command: string) => {
    if (command !== "sidebar_order") throw new Error(`Unexpected command: ${command}`);
    return saved;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function openWindow() {
  const prefs = await import("./prefs");
  const order = await import("./sidebarOrder");
  await order.bootSidebarOrder();
  return { prefs, order };
}
function sharedStorageEvent() {
  window.dispatchEvent(new StorageEvent("storage", { key: "raccoon.prefs", storageArea: localStorage }));
}
it("keeps inherited Rust Custom across browser & shortcut preference migrations on restart and storage events", async () => {
  for (const legacy of [{ linkBrowser: "terminalx" }, { shortcuts: { "session.stop": ["shift+escape"] } }]) {
    localStorage.clear();
    vi.resetModules();
    localStorage.setItem("raccoon.prefs", JSON.stringify(legacy));
    let win = await openWindow();
    expect(win.prefs.getSidebarSortChoice()).toBeNull();
    expect(win.order.getSidebarOrder()).toMatchObject(saved);
    expect(JSON.parse(localStorage.getItem("raccoon.prefs")!)).not.toEqual(legacy);
    sharedStorageEvent();
    expect(win.prefs.getSidebarSortChoice()).toBeNull();
    expect(win.order.getSidebarOrder()).toMatchObject(saved);
    vi.resetModules();
    win = await openWindow();
    expect(win.prefs.getSidebarSortChoice()).toBeNull();
    expect(win.order.getSidebarOrder()).toMatchObject(saved);
    expect(JSON.parse(localStorage.getItem("raccoon.prefs")!)).not.toHaveProperty("sidebarSort");
  }
});

it("keeps inherited Custom when legacyUserPreferences migrates a newly encountered legacy record", async () => {
  const window = await openWindow();
  localStorage.setItem("raccoon.prefs", JSON.stringify({ linkBrowser: "terminalx" }));
  expect(window.prefs.legacyUserPreferences()).toEqual({ linkBrowser: "system" });
  sharedStorageEvent();
  expect(window.prefs.getSidebarSortChoice()).toBeNull();
  expect(window.order.getSidebarOrder()).toMatchObject(saved);
  vi.resetModules();
  const restarted = await openWindow();
  expect(restarted.prefs.getSidebarSortChoice()).toBeNull();
  expect(restarted.order.getSidebarOrder()).toMatchObject(saved);
});

it("preserves explicit legacy and per-window sort choices through unrelated migration, storage event and restart", async () => {
  for (const [location, sort] of [["legacy", "updated"], ["legacy", "custom"], ["window", "created"], ["window", "custom"]] as const) {
    localStorage.clear();
    vi.resetModules();
    localStorage.setItem("raccoon.prefs", JSON.stringify({ linkBrowser: "terminalx", ...(location === "legacy" ? { sidebarSort: sort } : {}) }));
    if (location === "window") localStorage.setItem("raccoon.prefs.sidebar.main", JSON.stringify({ sidebarSort: sort }));
    const win = await openWindow();
    sharedStorageEvent();
    expect(win.prefs.getSidebarSortChoice()).toBe(sort);
    expect(win.order.getSidebarOrder()).toMatchObject({ ...saved, custom: sort === "custom" });
    vi.resetModules();
    const restarted = await openWindow();
    expect(restarted.prefs.getSidebarSortChoice()).toBe(sort);
    expect(restarted.order.getSidebarOrder()).toMatchObject({ ...saved, custom: sort === "custom" });
    if (location === "window") expect(JSON.parse(localStorage.getItem("raccoon.prefs")!)).not.toHaveProperty("sidebarSort");
  }
});
