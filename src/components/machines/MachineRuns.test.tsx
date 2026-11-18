import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineSessionActions } from "@terminalx/portable/workspace";

const invoke = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => null));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/components/cloud/CloudTerminalPane", () => ({ CloudTerminalPane: ({ terminal }: { terminal: { ptyId: string } }) => <div data-testid="cloud-terminal" data-pty={terminal.ptyId} /> }));
vi.mock("@/lib/machineConnections", () => ({ reconnectMachine: vi.fn(), refreshPairedMachines: vi.fn(async () => undefined), isMachineDisconnected: () => false }));
vi.mock("@/lib/sessions", () => ({ selectCloudWorkspace: vi.fn() }));
vi.mock("@/lib/cloudTerminals", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/cloudTerminals")>()), syncCloudTerminals: vi.fn(async () => []) }));
const browser = vi.hoisted(() => ({ open: vi.fn(async (..._args: unknown[]) => "page-1") }));
vi.mock("@/lib/browser", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/browser")>()), openBrowserPage: browser.open }));
const forwards = vi.hoisted(() => ({
  forward: vi.fn(async (_connection: string, port: number) => ({ port, localPort: 51234, reassigned: true, state: "open" as const })),
  enabled: true,
  known: [] as { port: number; localPort: number; reassigned: boolean; state?: "open" | "waiting" }[],
}));
vi.mock("@/lib/portForwards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portForwards")>()),
  forwardPort: forwards.forward,
  portForwardsOf: () => ({ loaded: true, forwards: forwards.known, settings: { enabled: forwards.enabled, auto: false }, processes: new Map() }),
  usePortForwards: () => ({ loaded: true, forwards: forwards.known, settings: { enabled: forwards.enabled, auto: false }, processes: new Map() }),
  forwardsBrowserWorkspace: async () => "/chats/.forwarded-ports",
}));

const { MachineTerminalDock } = await import("./MachineSession");
const { MachineRunMenu } = await import("./MachineRunPanes");
const { RunRestartOffer, dismissRestartOffer } = await import("@/components/session/RunMenu");
const { forwardedUrl, machinePortOf, openMachinePreview, resetMachineRuns } = await import("@/lib/machineRuns");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { setPrefs } = await import("@/lib/prefs");
const { resetCloudTerminals } = await import("@/lib/cloudTerminals");

const KEY = "machine:m1:p1:s1";
const WORKSPACE = "machine:m1";

const saved = (overrides: Partial<MachineSessionActions> = {}): MachineSessionActions => ({
  actions: [
    { id: "dev", name: "Dev server", icon: "play", command: "pnpm dev", runAfterSetup: false, concurrent: false, hidden: false },
    { id: "test", name: "Tests", icon: "check", command: "pnpm test", runAfterSetup: false, concurrent: true, hidden: false },
    { id: "secret", name: "Hidden", icon: "eye", command: "echo hidden", runAfterSetup: false, concurrent: false, hidden: true },
  ],
  previewUrls: [{ id: "web", name: "Web", url: "http://localhost:$PORT/app" }],
  setupScript: "pnpm install",
  setupApplies: true,
  available: true,
  ports: [4100, 4101],
  setup: { paneId: "s1:workspace-setup-1", command: "pnpm install", status: "succeeded", exitCode: 0, error: null, hasPane: true },
  ...overrides,
});

function fakeClient(info: MachineSessionActions, capabilities = ["machine/1", "machine/7", "pty/1", "pty/2", "ports/1"]) {
  return {
    hasCapability: (capability: string) => capabilities.includes(capability),
    sessionActions: vi.fn(async () => info),
    runAction: vi.fn(async (_session: string, actionId: string, restart: boolean) => ({
      started: !(actionId === "dev" && !restart),
      run: { actionId, name: actionId, ptyId: actionId === "dev" && !restart ? "s1:action-old-646576" : `s1:action-new-${actionId}`, state: "running" as const, exitCode: null },
      terminal: null,
    })),
    rerunSetup: vi.fn(async () => info.setup),
    stopSetup: vi.fn(async () => info.setup),
  };
}

const terminal = (ptyId: string, number: number, fields: Record<string, unknown> = {}) => ({
  id: `${WORKSPACE}:${ptyId}`, ptyId, number, title: `Terminal ${number}`, epoch: "e1", pid: 1, exited: false, exitCode: null, control: "you", controllerId: null,
  cols: 120, rows: 30, gone: null, inputError: null, sessionId: "s1", tabId: null, live: false, run: null, createdAt: 1_700_000_000_000 + number, ...fields,
});

function cloudModel(client: ReturnType<typeof fakeClient> | null, terminals: ReturnType<typeof terminal>[] = [], overrides: Record<string, unknown> = {}) {
  return {
    session: { id: KEY },
    machine: { machineId: "m1", projectId: "p1", name: "Mac mini", record: { version: "0.2.33" }, state: { state: "direct" } },
    connected: !!client,
    manage: true,
    client,
    workspaceKey: WORKSPACE,
    terminals,
    terminalBase: () => ({}),
    mayControlTerminals: true,
    openTerminal: vi.fn(async () => undefined),
    ports: { offered: true, connectionId: "conn-1", state: { state: "connected" } },
    ...overrides,
  } as never;
}

beforeEach(() => {
  resetMachineRuns();
  resetCloudTerminals();
  dismissRestartOffer(KEY);
  setPrefs({ panelTerminalOpen: true });
  forwards.enabled = true;
  forwards.known = [];
  vi.clearAllMocks();
});
afterEach(cleanup);

const localRuns = () => invoke.mock.calls.filter(([command]) => command === "action_run" || command === "action_states" || command === "workspace_ports" || command === "workspace_setup");

describe("a machine session's Setup and Run (PRO-403)", () => {
  it("lists the machine project's visible actions under Run and runs one on the machine", async () => {
    const client = fakeClient(saved());
    render(<TooltipProvider><MachineTerminalDock cloud={cloudModel(client)} /></TooltipProvider>);
    fireEvent.click(screen.getByRole("tab", { name: /^Run/ }));
    const pane = await screen.findByTestId("machine-run-pane");
    await waitFor(() => expect(pane.querySelectorAll("li")).toHaveLength(2));
    expect([...pane.querySelectorAll("li")].map((row) => row.getAttribute("data-action-id"))).toEqual(["dev", "test"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Run" })[1]);
    await waitFor(() => expect(client.runAction).toHaveBeenCalledWith("s1", "test", false));
    expect(client.sessionActions).toHaveBeenCalledWith("s1");
    expect(localRuns(), "nothing runs on this computer").toEqual([]);
  });

  it("shows each action's run as a dock tab named by its action, with its state, and the setup under Setup", async () => {
    const client = fakeClient(saved());
    const runs = [
      terminal("remote-pty-1", 1),
      terminal("s1:action-a-646576", 2, { run: { kind: "action", actionId: "dev", name: "Dev server" }, exited: true, exitCode: 3 }),
      terminal("s1:workspace-setup-1", 3, { run: { kind: "setup" }, exited: true, exitCode: 0 }),
    ];
    render(<TooltipProvider><MachineTerminalDock cloud={cloudModel(client, runs)} /></TooltipProvider>);
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["Setup", "Run", "Mac mini terminal 1", "Dev server"]);
    fireEvent.click(screen.getByRole("tab", { name: /^Run/ }));
    await waitFor(() => expect(screen.getByTestId("machine-run-pane").textContent).toContain("Exited 3"));
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByTestId("cloud-terminal").getAttribute("data-pty")).toBe("s1:action-a-646576");
    fireEvent.click(screen.getByRole("tab", { name: /^Setup/ }));
    await waitFor(() => expect(screen.getByTestId("setup-outcome").textContent).toContain("Last setup finished"));
    expect(screen.getByTestId("setup-script").textContent).toBe("pnpm install");
    expect(screen.getByTestId("setup-output").querySelector("[data-pty]")?.getAttribute("data-pty")).toBe("s1:workspace-setup-1");
    fireEvent.click(screen.getByRole("button", { name: "Rerun" }));
    await waitFor(() => expect(client.rerunSetup).toHaveBeenCalledWith("s1"));
    expect(localRuns()).toEqual([]);
  });

  it("offers Restart for a running non-concurrent action, and restarts it on the machine", async () => {
    const client = fakeClient(saved());
    render(
      <TooltipProvider>
        <MachineRunMenu cloud={cloudModel(client)} />
        <RunRestartOffer session={{ id: KEY }} />
      </TooltipProvider>,
    );
    const trigger = await screen.findByTestId("run-menu-trigger");
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByText("Dev server"));
    await waitFor(() => expect(client.runAction).toHaveBeenCalledWith("s1", "dev", false));
    const offer = await screen.findByTestId("run-restart-offer");
    expect(offer.textContent).toContain("Dev server is already running");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Restart/ })));
    await waitFor(() => expect(client.runAction).toHaveBeenCalledWith("s1", "dev", true));
    await waitFor(() => expect(screen.queryByTestId("run-restart-offer")).toBeNull());
  });

  it("shows no Run menu on a machine without machine/7, and says once in the dock to update it", async () => {
    const client = fakeClient(saved(), ["machine/1", "pty/1", "pty/2"]);
    const model = cloudModel(client);
    render(
      <TooltipProvider>
        <MachineRunMenu cloud={model} />
        <MachineTerminalDock cloud={model} />
      </TooltipProvider>,
    );
    expect(screen.queryByTestId("run-menu-trigger")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /^Run/ }));
    expect(screen.getByTestId("machine-run-update").textContent).toBe("Mac mini runs TerminalX 0.2.33. Update it to run its sessions' Setup and Run scripts from here.");
    expect(client.sessionActions).not.toHaveBeenCalled();
  });

  it("says where to save scripts on the machine when it has none", async () => {
    const client = fakeClient(saved({ actions: [], setupScript: null, setup: null }));
    render(<TooltipProvider><MachineTerminalDock cloud={cloudModel(client)} /></TooltipProvider>);
    fireEvent.click(screen.getByRole("tab", { name: /^Setup/ }));
    expect((await screen.findByTestId("setup-empty")).textContent).toContain("No setup script on Mac mini yet");
    fireEvent.click(screen.getByRole("tab", { name: /^Run/ }));
    expect((await screen.findByTestId("run-empty")).textContent).toContain("No run script on Mac mini yet");
  });
});

describe("a machine session's previews (PRO-403)", () => {
  it("opens a preview on the machine's port through a forward to this computer", async () => {
    const model = cloudModel(fakeClient(saved()));
    await openMachinePreview(model, { id: "web", name: "Web", url: "http://localhost:$PORT/app" }, [4100]);
    expect(forwards.forward).toHaveBeenCalledWith("conn-1", 4100, false);
    expect(browser.open).toHaveBeenCalledWith("/chats/.forwarded-ports", "http://127.0.0.1:51234/app");
  });

  it("uses a forward already open, and opens a URL elsewhere as it is", async () => {
    forwards.known = [{ port: 4100, localPort: 4100, reassigned: false, state: "open" }];
    const model = cloudModel(fakeClient(saved()));
    await openMachinePreview(model, { id: "web", name: "Web", url: "http://localhost:$PORT" }, [4100]);
    await openMachinePreview(model, { id: "docs", name: "Docs", url: "https://example.com/docs" }, [4100]);
    expect(forwards.forward).not.toHaveBeenCalled();
    expect(browser.open.mock.calls.map(([, url]) => url)).toEqual(["http://127.0.0.1:4100/", "https://example.com/docs"]);
  });

  it("opens nothing on the machine's port while Forwarding is off", async () => {
    forwards.enabled = false;
    await openMachinePreview(cloudModel(fakeClient(saved())), { id: "web", name: "Web", url: "http://localhost:$PORT" }, [4100]);
    expect(forwards.forward).not.toHaveBeenCalled();
    expect(browser.open).not.toHaveBeenCalled();
  });

  it("reads which URLs name the machine itself", () => {
    expect(machinePortOf("http://localhost:3000/x")).toBe(3000);
    expect(machinePortOf("http://127.0.0.1")).toBe(80);
    expect(machinePortOf("https://0.0.0.0")).toBe(443);
    expect(machinePortOf("https://example.com:8443")).toBeNull();
    expect(machinePortOf("not a url")).toBeNull();
    expect(forwardedUrl("http://localhost:3000/a?b=1#c", 5000)).toBe("http://127.0.0.1:5000/a?b=1#c");
  });
});
