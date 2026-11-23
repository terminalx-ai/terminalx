import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #1404: with Orchestration runs on (Settings → Experimental), only a session that leads a run, or has its Run
// view open, has the Run | Lead chat strip and the run pill. The real session stores run against the in-memory
// backend of `@/test/tabsBackend`; whether runs are on and the run the session leads are this file's.
const mocks = vi.hoisted(() => ({ on: true, run: null as unknown }));
vi.mock("@tauri-apps/api/core", async () => {
  const { backend } = await import("@/test/tabsBackend");
  return { Channel: class {}, invoke: (command: string, args: Record<string, unknown> = {}) => backend.invoke(command, args) };
});
vi.mock("@tauri-apps/api/event", async () => {
  const { backend } = await import("@/test/tabsBackend");
  return { listen: backend.listen };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(async () => undefined), openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: async () => true, requestPermission: async () => "granted", sendNotification: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: async () => undefined, label: "main" }) }));
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ resolvedMode: "dark" }) }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set<string>() }));
vi.mock("@/lib/models", async (original) => ({ ...(await original<typeof import("@/lib/models")>()), useModels: () => [], loadModels: vi.fn() }));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: ({ id }: { id: string }) => <div data-testid="xterm">{id}</div>, createTerminal: () => undefined }));
vi.mock("@/components/browser/BrowserView", () => ({ BrowserView: () => <div data-testid="browser-view" /> }));
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonRunner: () => null, RaccoonScene: () => null }));
vi.mock("@/components/chat/Composer", () => ({ Composer: () => <div data-testid="composer" /> }));
vi.mock("@/components/orchestration/RunView", () => ({ RunView: () => <div data-testid="run-view" /> }));
vi.mock("@/lib/experimentalSettings", async (original) => ({
  ...(await original<typeof import("@/lib/experimentalSettings")>()),
  useExperimentalSettings: () => ({ nativeCodex: false, orchestratorRuns: mocks.on }),
}));
vi.mock("@/lib/orchestration", async (original) => ({
  ...(await original<typeof import("@/lib/orchestration")>()),
  useRun: (sessionId: string | undefined, enabled = true) => (enabled && sessionId ? mocks.run : undefined),
}));

const { backend, MAIN, session: sessionEntry } = await import("@/test/tabsBackend");
const { bootSessions, refreshEverything, getSessionStore } = await import("@/lib/sessions");
const { setPrefs } = await import("@/lib/prefs");
const { showRunView } = await import("@/lib/orchestration");
const { SessionView } = await import("./SessionView");
const { TooltipProvider } = await import("@/components/ui/tooltip");

const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const running = { id: "run-1", lead: { sessionId: "plain" }, state: "running", pieces: [{ id: "a", title: "A", state: "running", dependsOn: [], tries: [] }], inTurn: 1 };

async function show() {
  backend.sessions = [sessionEntry("plain", MAIN, [], { title: "Work" })];
  await bootSessions();
  await act(async () => { await refreshEverything(); });
  const session = getSessionStore().sessions.find((entry) => entry.id === "plain")!;
  render(<TooltipProvider><SessionView session={session} sidebarOpen onToggleSidebar={() => undefined} /></TooltipProvider>);
  await flush();
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  backend.reset();
  mocks.on = true;
  mocks.run = null;
  setPrefs({ tabStrip: false, panelOpen: false, shortcuts: {} });
});

afterEach(() => {
  act(() => showRunView("plain", false));
  cleanup();
});

describe("a session's Run strip and run pill (#1404)", () => {
  it("are not on a session that leads no run: it looks like any other session", async () => {
    await show();
    expect(screen.queryByTestId("run-strip")).toBeNull();
    expect(screen.queryByTestId("run-pill")).toBeNull();
    expect(screen.queryByText("Lead chat")).toBeNull();
    expect(screen.queryByTestId("run-view")).toBeNull();
  });

  it("are on a session that leads a run", async () => {
    mocks.run = running;
    await show();
    expect(screen.getByTestId("run-strip")).toBeTruthy();
    expect(screen.getByTestId("run-pill").textContent).toBe("1 worker running");
  });

  it("the strip comes with the Run view opened on a session with no run (Go → Run View), and goes with it", async () => {
    await show();
    act(() => showRunView("plain", true));
    expect(screen.getByTestId("run-view")).toBeTruthy();
    expect(screen.getByTestId("run-strip")).toBeTruthy();
    expect(screen.queryByTestId("run-pill")).toBeNull();
    act(() => screen.getByRole("tab", { name: "Lead chat" }).click());
    expect(screen.queryByTestId("run-view")).toBeNull();
    expect(screen.queryByTestId("run-strip")).toBeNull();
  });

  it("neither is there while runs are off, even for a session that leads one", async () => {
    mocks.on = false;
    mocks.run = running;
    await show();
    expect(screen.queryByTestId("run-strip")).toBeNull();
    expect(screen.queryByTestId("run-pill")).toBeNull();
  });
});
