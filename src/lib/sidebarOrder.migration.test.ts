import { beforeEach, describe, expect, it, vi } from "vitest";

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
const migrations = [
  { name: "browser", legacy: { linkBrowser: "terminalx" } },
  { name: "shortcut", legacy: { shortcuts: { "session.stop": ["shift+escape"] } } },
];

describe.each(migrations)("custom order through the $name preference migration", ({ legacy }) => {
  it.each(["restart", "storage event"])("keeps inherited Rust Custom after a %s without choosing a sort", async (refresh) => {
    localStorage.setItem("raccoon.prefs", JSON.stringify(legacy));
    let window = await openWindow();
    expect(window.prefs.getSidebarSortChoice()).toBeNull();
    expect(window.order.getSidebarOrder()).toMatchObject(saved);
    // The unrelated migration actually ran; a later read must still distinguish
    // an absent sort from an explicitly chosen Updated sort.
    const migrated = JSON.parse(localStorage.getItem("raccoon.prefs")!);
    expect(migrated).not.toEqual(legacy);
    if (refresh === "restart") {
      vi.resetModules();
      window = await openWindow();
    } else {
      sharedStorageEvent();
    }
    expect(window.prefs.getSidebarSortChoice()).toBeNull();
    expect(window.order.getSidebarOrder()).toMatchObject(saved);
    expect(JSON.parse(localStorage.getItem("raccoon.prefs")!)).not.toHaveProperty("sidebarSort");
  });
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

describe.each(["legacy", "window"])("explicit %s sort choices", (location) => {
  it.each(["updated", "created", "custom"] as const)("preserves %s through an unrelated migration, storage event and restart", async (sort) => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ linkBrowser: "terminalx", ...(location === "legacy" ? { sidebarSort: sort } : {}) }));
    if (location === "window") localStorage.setItem("raccoon.prefs.sidebar.main", JSON.stringify({ sidebarSort: sort }));
    const window = await openWindow();
    sharedStorageEvent();
    expect(window.prefs.getSidebarSortChoice()).toBe(sort);
    expect(window.order.getSidebarOrder()).toMatchObject({ ...saved, custom: sort === "custom" });
    vi.resetModules();
    const restarted = await openWindow();
    expect(restarted.prefs.getSidebarSortChoice()).toBe(sort);
    expect(restarted.order.getSidebarOrder()).toMatchObject({ ...saved, custom: sort === "custom" });
    // A window's override must not become the inherited choice for other windows.
    if (location === "window") expect(JSON.parse(localStorage.getItem("raccoon.prefs")!)).not.toHaveProperty("sidebarSort");
  });
});
