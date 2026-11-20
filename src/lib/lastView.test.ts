import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type View = "home" | "welcome" | "new" | "issues" | "agents" | "automations" | "skills" | "project";
interface FakeSession { id: string; projectPath: string; kind?: string; archived: boolean }

// The session store as the last view reads it, with its subscribers, and the ways to navigate it.
const app = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const store = {
    loaded: true,
    navigationVersion: 0,
    view: "welcome" as View,
    selectedSessionId: null as string | null,
    selectedCloudWorkspace: null as string | null,
    selectedProject: null as string | null,
    projects: [] as { path: string; archived?: boolean }[],
    sessions: [] as FakeSession[],
  };
  const change = (patch: Partial<typeof store>) => {
    Object.assign(store, patch);
    for (const listener of [...listeners]) listener();
  };
  return {
    store, listeners, change, window: "main",
    select: (id: string) => change({ selectedSessionId: id, view: "welcome", navigationVersion: store.navigationVersion + 1 }),
    overview: (path: string) => change({ selectedSessionId: null, view: "project", selectedProject: path, navigationVersion: store.navigationVersion + 1 }),
    page: (view: View) => () => change({ selectedSessionId: null, view }),
  };
});
vi.mock("@/lib/appWindow", () => ({ appWindow: () => app.window }));
vi.mock("@/lib/sessions", () => ({
  getSessionStore: () => app.store,
  subscribeSessionStore: (listener: () => void) => { app.listeners.add(listener); return () => app.listeners.delete(listener); },
  selectSession: vi.fn((id: string) => app.select(id)),
  openProjectOverview: vi.fn((path: string) => app.overview(path)),
  openHome: vi.fn(() => app.page("home")()),
  openIssues: vi.fn(() => app.page("issues")()),
  openAgents: vi.fn(() => app.page("agents")()),
  openAutomations: vi.fn(() => app.page("automations")()),
  openSkills: vi.fn(() => app.page("skills")()),
}));
vi.mock("@/lib/sessionTabs", () => ({ activatePeer: vi.fn() }));

const sessions = await import("@/lib/sessions");
const { bootLastView, readLastView, resetLastView, restoreLastView, savePanelTab, savedPanelTab } = await import("./lastView");
const { rememberPanelTab, rememberedPanelTab, resetPanelTabs } = await import("./panelTab");

const KEY = "raccoon.lastView";
const saved = () => JSON.parse(localStorage.getItem(KEY) ?? "null");
const settle = async () => { for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const save = (view: object) => localStorage.setItem(KEY, JSON.stringify({ sessionId: null, view: "welcome", projectPath: null, panelTabs: {}, ...view }));

beforeEach(() => {
  vi.clearAllMocks();
  resetPanelTabs();
  app.listeners.clear();
  app.window = "main";
  Object.assign(app.store, {
    loaded: true, navigationVersion: 0, view: "welcome", selectedSessionId: null, selectedCloudWorkspace: null, selectedProject: null,
    projects: [{ path: "/code/web" }, { path: "/code/api" }],
    sessions: [
      { id: "s1", projectPath: "/code/web", archived: false },
      { id: "s2", projectPath: "/code/api", archived: false },
      { id: "gone-soon", projectPath: "/code/api", archived: true },
      { id: "quick-1", projectPath: "/scratch", kind: "quick", archived: false },
    ],
  });
});
afterEach(() => resetLastView());

describe("reopening the last view on launch (PRO-130)", () => {
  it("reopens the session that was on screen", () => {
    expect(restoreLastView({ sessionId: "s2", view: "welcome", projectPath: "/code/api", panelTabs: {} })).toEqual({ sessionId: "s2" });
    expect(sessions.selectSession).toHaveBeenCalledExactlyOnceWith("s2");
  });

  it("falls back to the project's overview, quietly, when the session was archived while the app was closed", () => {
    expect(restoreLastView({ sessionId: "gone-soon", view: "welcome", projectPath: "/code/api", panelTabs: {} })).toEqual({ view: "project", projectPath: "/code/api" });
    expect(sessions.selectSession).not.toHaveBeenCalled();
    expect(sessions.openProjectOverview).toHaveBeenCalledExactlyOnceWith("/code/api");
  });

  it("falls back to the saved project's overview when the session was deleted, and to welcome when the project went too", () => {
    expect(restoreLastView({ sessionId: "deleted", view: "welcome", projectPath: "/code/web", panelTabs: {} })).toEqual({ view: "project", projectPath: "/code/web" });
    expect(sessions.openProjectOverview).toHaveBeenCalledWith("/code/web");
    vi.clearAllMocks();
    expect(restoreLastView({ sessionId: "deleted", view: "welcome", projectPath: "/code/removed", panelTabs: {} })).toBeNull();
    expect(sessions.openProjectOverview).not.toHaveBeenCalled();
    expect(app.store.view).toBe("project");
  });

  it("reopens the page that was on screen", () => {
    expect(restoreLastView({ sessionId: null, view: "issues", projectPath: null, panelTabs: {} })).toEqual({ view: "issues" });
    expect(sessions.openIssues).toHaveBeenCalled();
    expect(restoreLastView({ sessionId: null, view: "project", projectPath: "/code/api", panelTabs: {} })).toEqual({ view: "project", projectPath: "/code/api" });
    expect(restoreLastView({ sessionId: null, view: "project", projectPath: "/code/removed", panelTabs: {} })).toBeNull();
    expect(restoreLastView({ sessionId: null, view: "welcome", projectPath: null, panelTabs: {} })).toBeNull();
  });

  it("reads back only what it could have written", () => {
    localStorage.setItem(KEY, JSON.stringify({ sessionId: 7, view: "new", projectPath: "", panelTabs: { s1: "changes", s2: "nonsense" } }));
    expect(readLastView()).toEqual({ sessionId: null, view: "welcome", projectPath: null, panelTabs: { s1: "changes" } });
    localStorage.setItem(KEY, "{not json");
    expect(readLastView()).toEqual({ sessionId: null, view: "welcome", projectPath: null, panelTabs: {} });
  });
});

describe("keeping the last view", () => {
  it("restores at launch, then saves each session and page the person goes to", async () => {
    save({ sessionId: "s1", projectPath: "/code/web" });
    bootLastView();
    await settle();
    expect(sessions.selectSession).toHaveBeenCalledWith("s1");

    app.select("s2");
    expect(saved()).toMatchObject({ sessionId: "s2", view: "welcome", projectPath: "/code/api" });
    app.overview("/code/web");
    expect(saved()).toMatchObject({ sessionId: null, view: "project", projectPath: "/code/web" });
    app.page("skills")();
    expect(saved()).toMatchObject({ sessionId: null, view: "skills", projectPath: null });
  });

  it("reopens on Home when the app last closed on the Stats view, now a page of Settings (PRO-463)", () => {
    save({ sessionId: null, view: "stats", projectPath: null });
    expect(readLastView().view).toBe("home");
    expect(restoreLastView()).toEqual({ view: "home" });
    expect(sessions.openHome).toHaveBeenCalled();
  });

  it("keeps the session behind a new-session draft, a cloud session or a cloud workspace", async () => {
    save({ sessionId: "s1", projectPath: "/code/web" });
    bootLastView();
    await settle();
    app.change({ selectedSessionId: null, view: "new" });
    app.change({ selectedSessionId: "cloud:org:ws:s9" });
    app.change({ selectedSessionId: null, view: "welcome", selectedCloudWorkspace: "cloud:org:ws" });
    expect(saved()).toMatchObject({ sessionId: "s1", projectPath: "/code/web" });
  });

  it("writes where a gone session fell back to, so the next launch opens there", async () => {
    save({ sessionId: "gone-soon", projectPath: "/code/api" });
    bootLastView();
    await settle();
    expect(saved()).toMatchObject({ sessionId: null, view: "project", projectPath: "/code/api" });
  });

  it("restores nothing when a link or a click went somewhere before the sessions were read", async () => {
    save({ sessionId: "s1", projectPath: "/code/web" });
    app.store.loaded = false;
    bootLastView();
    app.select("s2");
    app.change({ loaded: true });
    await settle();
    expect(sessions.selectSession).not.toHaveBeenCalled();
    expect(saved()).toMatchObject({ sessionId: "s2" });
  });

  it("is the main window's alone: a chat window neither restores nor saves", async () => {
    app.window = "chat-1";
    save({ sessionId: "s1", projectPath: "/code/web" });
    bootLastView();
    await settle();
    app.select("s2");
    savePanelTab("s2", "files");
    expect(sessions.selectSession).not.toHaveBeenCalledWith("s1");
    expect(saved()).toMatchObject({ sessionId: "s1", panelTabs: {} });
  });
});

describe("each session's panel tab", () => {
  it("is kept per session and outlives the window's memory of it", () => {
    rememberPanelTab("s1", "files");
    rememberPanelTab("s2", "browser");
    expect(rememberedPanelTab("s1")).toBe("files");
    expect(saved().panelTabs).toEqual({ s1: "files", s2: "browser" });
    // A relaunch: nothing in memory, the saved tabs still there.
    const stored = localStorage.getItem(KEY)!;
    resetPanelTabs();
    localStorage.setItem(KEY, stored);
    expect(rememberedPanelTab("s2")).toBe("browser");
    expect(savedPanelTab("s3")).toBeNull();
  });

  it("keeps the most recent sessions' tabs only", () => {
    for (let n = 0; n < 205; n += 1) savePanelTab(`s${n}`, "changes");
    const kept = Object.keys(saved().panelTabs);
    expect(kept).toHaveLength(200);
    expect(kept[0]).toBe("s5");
    // Shown again, a session's tab is the newest kept.
    savePanelTab("s5", "files");
    expect(Object.keys(saved().panelTabs).at(-1)).toBe("s5");
  });
});
