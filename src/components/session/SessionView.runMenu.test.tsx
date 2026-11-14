import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/types/session";

// PRO-363: the Run menu and Open button in a local session's header, and ⌘R
// there. The real session stores run against the in-memory backend of
// `@/test/tabsBackend`; the project's actions, the runner and the ports are this file's.
const mocks = vi.hoisted(() => ({ project: null as unknown as Project, runs: [] as unknown[] }));
vi.mock("@tauri-apps/api/core", async () => {
  const { backend } = await import("@/test/tabsBackend");
  return {
    Channel: class {},
    invoke: async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "list_projects") return { projects: [mocks.project], lastSelected: mocks.project.path };
      if (command === "action_states") return mocks.runs;
      if (command === "workspace_ports") return [4010, 4011];
      if (command === "action_run") {
        backend.calls.push({ command, args });
        return { run: { sessionId: args.sessionId, actionId: args.actionId, name: "", paneId: `${String(args.sessionId)}:action-1-${String(args.actionId)}`, state: "running", exitCode: null, started: "", ended: null }, started: true };
      }
      return backend.invoke(command, args);
    },
  };
});
vi.mock("@tauri-apps/api/event", async () => {
  const { backend } = await import("@/test/tabsBackend");
  return { listen: backend.listen };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true), message: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(async () => undefined), openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: async () => true, requestPermission: async () => "granted", sendNotification: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: async () => undefined, label: "main" }) }));
vi.mock("@/lib/account", () => {
  const account = { status: { state: "signed-out", identity: null, expiresAt: null, lastError: null, organizations: [] } };
  return { useAccount: () => account, getAccount: () => account, subscribeAccount: () => () => undefined, refreshAccount: vi.fn() };
});
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ resolvedMode: "dark" }) }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set<string>() }));
vi.mock("@/lib/models", async (original) => ({ ...(await original<typeof import("@/lib/models")>()), useModels: () => [], loadModels: vi.fn() }));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: ({ id }: { id: string }) => <div data-testid="xterm">{id}</div>, createTerminal: () => undefined }));
vi.mock("@/components/browser/BrowserView", () => ({ BrowserView: () => <div data-testid="browser-view" /> }));
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonRunner: () => null, RaccoonScene: () => null }));
vi.mock("@/components/chat/Composer", () => ({ Composer: () => <div data-testid="composer" /> }));

const { backend, MAIN, PROJECT, session: sessionEntry } = await import("@/test/tabsBackend");
const { bootSessions, refreshEverything, getSessionStore } = await import("@/lib/sessions");
const { setPrefs } = await import("@/lib/prefs");
const { isMac } = await import("@/lib/shortcuts");
const { SessionView } = await import("./SessionView");
const { TooltipProvider } = await import("@/components/ui/tooltip");

const action = (id: string, name: string, hidden = false) => ({ id, name, icon: "play", command: `pnpm ${id}`, runAfterSetup: false, concurrent: false, hidden });
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

async function show(project: Project, patch: Parameters<typeof sessionEntry>[3] = {}) {
  mocks.project = project;
  backend.sessions = [sessionEntry("runs", MAIN, [], { title: "Work", ...patch })];
  await bootSessions();
  await act(async () => { await refreshEverything(); });
  const session = getSessionStore().sessions.find((entry) => entry.id === "runs")!;
  render(<TooltipProvider><SessionView session={session} sidebarOpen onToggleSidebar={() => undefined} /></TooltipProvider>);
  await flush();
  await flush();
}

const header = () => document.querySelector("header")!;

beforeEach(() => {
  localStorage.clear();
  backend.reset();
  mocks.runs = [];
  setPrefs({ tabStrip: false, panelOpen: false, shortcuts: {} });
});

afterEach(() => cleanup());

describe("the session header's Run menu", () => {
  it("is in a local session's header with the project's visible actions, beside Open", async () => {
    await show({ path: PROJECT, name: "Repo", actions: [action("dev", "Dev"), action("secret", "Secret", true)], previewUrls: [{ id: "web", name: "Web", url: "http://localhost:$PORT" }] });
    const controls = within(header()).getByTestId("run-controls");
    expect(within(controls).getByTestId("run-menu-trigger")).toBeTruthy();
    expect(within(controls).getByRole("button", { name: "Open Web" })).toBeTruthy();
  });

  it("runs the one visible action on the Run key", async () => {
    await show({ path: PROJECT, name: "Repo", actions: [action("secret", "Secret", true), action("dev", "Dev")] });
    fireEvent.keyDown(document.body, { key: "r", code: "KeyR", metaKey: isMac, ctrlKey: !isMac, altKey: !isMac });
    await waitFor(() => expect(backend.callsOf("action_run")).toEqual([{ sessionId: "runs", actionId: "dev", restart: false }]));
  });

  it("is not there when the project has no visible actions or preview URLs", async () => {
    await show({ path: PROJECT, name: "Repo", actions: [action("secret", "Secret", true)] });
    expect(within(header()).queryByTestId("run-controls")).toBeNull();
  });

  it("is not there for a removed workspace", async () => {
    await show({ path: PROJECT, name: "Repo", actions: [action("dev", "Dev")] }, { worktreeRemoved: true });
    expect(within(header()).queryByTestId("run-controls")).toBeNull();
    expect(screen.queryByTestId("run-menu-trigger")).toBeNull();
  });
});
