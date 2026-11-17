import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineAction, MachineSetupRun, PtyInfo, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { CloudSessionModel } from "@/lib/cloudSession";

// PRO-403: a machine session's Setup and Run tabs in the dock, its Run menu, ⌘R
// and the restart offer, over the real `scripts` model and terminal store,
// against a fake machine. Nothing may run on this computer: every local
// command goes through `invoke`, which is watched.
const mocks = vi.hoisted(() => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  return { invoke: vi.fn(async (_command: string, _args?: unknown) => null) };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/components/cloud/CloudTerminalPane", () => ({
  CloudTerminalPane: ({ terminal }: { terminal: { ptyId: string } }) => <div data-testid="cloud-terminal" data-pty={terminal.ptyId} />,
}));
// The terminals' xterm is not drawn here: the fake machine never streams.
vi.mock("@/lib/terminal", async (original) => ({ ...(await original<typeof import("@/lib/terminal")>()), getInstance: () => ({ term: {} }) }));

const { MachineTerminalDock } = await import("./MachineSession");
const { MachineRunMenu, MachineRunRestartOffer, dismissRestartOffer, offersMachineRunMenu } = await import("@/components/session/RunMenu");
const { useMachineSessionScripts } = await import("@/lib/machineSessionRuns");
const { sessionTerminals, syncCloudTerminals, useCloudTerminals, cloudTerminalsOf } = await import("@/lib/cloudTerminals");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { getPrefs, setPrefs } = await import("@/lib/prefs");
const { getErrorToasts } = await import("@/lib/errorToasts");

const SESSION = "machine:m1:p1:s1";
const base = () => ({}) as never;

const action = (id: string, name: string, patch: Partial<MachineAction> = {}): MachineAction => ({ id, name, icon: "play", command: `pnpm ${id}`, runAfterSetup: false, concurrent: false, hidden: false, ...patch });

/** A machine with one session `s1`: its saved actions, setup and terminals, as its runtime keeps them. */
function fakeMachine(options: { actions?: MachineAction[]; setupScript?: string | null; capabilities?: string[] } = {}) {
  const actions = options.actions ?? [action("dev", "Dev server"), action("test", "Test")];
  const capabilities = new Set(options.capabilities ?? ["machine/7", "pty/2"]);
  const ptys: PtyInfo[] = [];
  let setup: MachineSetupRun | null = null;
  let clock = 100;
  const pty = (ptyId: string, run: PtyInfo["run"]): PtyInfo => ({
    ptyId, number: ptys.length + 1, epoch: "e1", pid: 1, cwd: "/srv/repo/.raccoon/worktrees/s1", cols: 80, rows: 24, createdAt: clock++, offset: 0, exited: false, exitCode: null, control: "none", sessionId: "s1", run,
  });
  const runningOf = (actionId: string) => ptys.find((info) => info.run?.kind === "action" && info.run.actionId === actionId && !info.exited);
  const client = {
    hasCapability: (name: string) => capabilities.has(name),
    listPtys: vi.fn(async () => ({ epoch: "e1", terminals: [...ptys] })),
    attachPty: vi.fn(async () => {
      throw new Error("not streamed in this test");
    }),
    sessionActions: vi.fn(async () => ({ actions, previewUrls: [], setupScript: options.setupScript === undefined ? "pnpm install" : options.setupScript, setupApplies: true, available: true, ports: [41000], setup })),
    runAction: vi.fn(async (_sessionId: string, actionId: string, restart: boolean) => {
      const saved = actions.find((entry) => entry.id === actionId)!;
      const running = runningOf(actionId);
      if (running && !saved.concurrent && !restart) {
        return { started: false, run: { actionId, name: saved.name, ptyId: running.ptyId, state: "running" as const, exitCode: null }, terminal: running };
      }
      if (running && restart) ptys.splice(ptys.indexOf(running), 1);
      const info = pty(`s1:action-${actionId}-${clock}`, { kind: "action", actionId, name: saved.name });
      ptys.push(info);
      return { started: true, run: { actionId, name: saved.name, ptyId: info.ptyId, state: "running" as const, exitCode: null }, terminal: info };
    }),
    rerunSetup: vi.fn(async () => {
      const info = pty(`s1:workspace-setup-${clock}`, { kind: "setup" });
      ptys.push(info);
      setup = { paneId: info.ptyId, command: "pnpm install", status: "running", exitCode: null, error: null, hasPane: true };
      return setup;
    }),
    stopSetup: vi.fn(async (_sessionId: string, paneId: string) => {
      if (setup?.paneId === paneId) setup = { ...setup, status: "stopped", exitCode: 130 };
      return setup;
    }),
  };
  return {
    client,
    rpc: client as unknown as WorkspaceRpcClient,
    /** The run of `actionId` ends on the machine. */
    exit(actionId: string, code: number) {
      const running = runningOf(actionId);
      if (running) Object.assign(running, { exited: true, exitCode: code });
    },
    /** A shell the person opened on the machine. */
    shell() {
      ptys.push(pty(`s1:shell-${clock}`, undefined));
    },
  };
}

let workspace = 0;
function Harness({ machine, manage = true, connected = true, workspaceKey }: { machine: ReturnType<typeof fakeMachine>; manage?: boolean; connected?: boolean; workspaceKey: string }) {
  const all = useCloudTerminals(workspaceKey).terminals;
  const terminals = useMemo(() => sessionTerminals(all, "s1"), [all]);
  const client = connected ? machine.rpc : null;
  const scripts = useMachineSessionScripts({ client, connected, manage, name: "Mac mini", sessionId: "s1", generation: connected ? "g1" : null, workspaceKey, terminals, terminalBase: base });
  const cloud = {
    session: { id: SESSION, tabs: [] },
    workspaceKey,
    machine: { machineId: "m1", projectId: "p1", name: "Mac mini" },
    terminals,
    client,
    connected,
    manage,
    mayControlTerminals: manage,
    terminalBase: base,
    openTerminal: vi.fn(async () => undefined),
    scripts,
  } as unknown as CloudSessionModel;
  return (
    <TooltipProvider>
      <div data-testid="offered">{String(offersMachineRunMenu(cloud))}</div>
      <MachineRunMenu cloud={cloud} />
      <MachineRunRestartOffer cloud={cloud} />
      <MachineTerminalDock cloud={cloud} />
    </TooltipProvider>
  );
}

async function renderSession(machine: ReturnType<typeof fakeMachine>, props: { manage?: boolean; connected?: boolean } = {}) {
  const workspaceKey = `machine:m1#${++workspace}`;
  await act(async () => {
    await syncCloudTerminals(workspaceKey, machine.rpc, base);
  });
  const view = render(<Harness machine={machine} workspaceKey={workspaceKey} {...props} />);
  if (props.connected !== false) await waitFor(() => expect(machine.client.sessionActions).toHaveBeenCalledWith("s1"));
  return { ...view, workspaceKey };
}

const openMenu = (element: HTMLElement) => fireEvent.pointerDown(element, { button: 0, ctrlKey: false, pointerType: "mouse" });
const pressRun = () => fireEvent.keyDown(window, { key: "r", code: "KeyR", metaKey: true });
const tabNames = () => within(screen.getByRole("tablist", { name: "Terminals" })).getAllByRole("tab").map((tab) => tab.textContent);
/** Nothing of the session's scripts ran on this computer. */
const ranNothingHere = () => expect(mocks.invoke.mock.calls.map(([command]) => command).filter((command) => /action|setup|pty|spawn/.test(String(command)))).toEqual([]);

beforeEach(() => {
  mocks.invoke.mockClear();
  setPrefs({ panelTerminalOpen: false, panelOpen: false });
});
afterEach(() => {
  cleanup();
  act(() => dismissRestartOffer(SESSION));
});

describe("a machine session's dock: Setup and Run beside the machine's terminals (21.08, PRO-403)", () => {
  it("shows Setup and Run before the machine's numbered shells, and keeps script runs out of the shells", async () => {
    const machine = fakeMachine();
    machine.shell();
    await machine.client.runAction("s1", "dev", false);
    await renderSession(machine);
    expect(tabNames()).toEqual(["Setup", "Run", "Mac mini terminal 1"]);
    expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Setup not run" })).toBeTruthy();
  });

  it("lists the machine project's actions under Run, and runs one on the machine with its output shown there", async () => {
    const machine = fakeMachine();
    await renderSession(machine);
    fireEvent.click(screen.getByRole("tab", { name: /^Run/ }));
    const pane = screen.getByTestId("run-pane");
    expect(pane.textContent).toContain("Run on Mac mini");
    expect(pane.textContent).toContain("Dev server");
    expect(pane.textContent).toContain("pnpm dev");
    fireEvent.click(within(pane.querySelector('[data-action-id="dev"]') as HTMLElement).getByRole("button", { name: "Run" }));
    await waitFor(() => expect(machine.client.runAction).toHaveBeenCalledWith("s1", "dev", false));
    await waitFor(() => expect(screen.getByTestId("run-output").querySelector("[data-pty]")?.getAttribute("data-pty")).toMatch(/^s1:action-dev-/));
    // Running and not concurrent: the button restarts it on the machine.
    const row = screen.getByTestId("run-pane").querySelector('[data-action-id="dev"]') as HTMLElement;
    expect(row.textContent).toContain("Running");
    fireEvent.click(within(row).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(machine.client.runAction).toHaveBeenLastCalledWith("s1", "dev", true));
    ranNothingHere();
  });

  it("shows the machine's setup script and reruns and stops it on the machine, with its terminal as the output", async () => {
    const machine = fakeMachine();
    await renderSession(machine);
    setPrefs({ panelTerminalOpen: true });
    fireEvent.click(screen.getByRole("tab", { name: /^Setup/ }));
    expect(screen.getByTestId("setup-script").textContent).toBe("pnpm install");
    expect(screen.getByRole("status").textContent).toBe("Not run in this workspace yet.");
    fireEvent.click(screen.getByRole("button", { name: "Run setup" }));
    await waitFor(() => expect(machine.client.rerunSetup).toHaveBeenCalledWith("s1"));
    await waitFor(() => expect(screen.getByTestId("setup-outcome").textContent).toBe("Setup running…"));
    await waitFor(() => expect(screen.getByTestId("setup-output").querySelector("[data-pty]")?.getAttribute("data-pty")).toMatch(/^s1:workspace-setup-/));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(machine.client.stopSetup).toHaveBeenCalledWith("s1", expect.stringMatching(/^s1:workspace-setup-/)));
    await waitFor(() => expect(screen.getByTestId("setup-outcome").textContent).toBe("Last setup stopped · exit 130"));
    expect(screen.getByRole("img", { name: "Setup stopped" })).toBeTruthy();
    ranNothingHere();
  });

  it("says where to add a setup script on the machine when it has none", async () => {
    await renderSession(fakeMachine({ setupScript: null }));
    setPrefs({ panelTerminalOpen: true });
    fireEvent.click(screen.getByRole("tab", { name: /^Setup/ }));
    expect(screen.getByTestId("setup-empty").textContent).toContain("No setup script on Mac mini yet.");
  });

  it("says why a computer that may only view cannot start the machine's scripts", async () => {
    const machine = fakeMachine();
    await renderSession(machine, { manage: false });
    setPrefs({ panelTerminalOpen: true });
    fireEvent.click(screen.getByRole("tab", { name: /^Run/ }));
    expect(screen.getByTestId("run-blocked").textContent).toBe("Only a computer paired with Mac mini runs its scripts");
    const run = within(screen.getByTestId("run-pane").querySelector('[data-action-id="dev"]') as HTMLElement).getByRole("button", { name: "Run" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
  });

  it("says an older machine has no Setup and Run for its sessions", async () => {
    const machine = fakeMachine({ capabilities: ["pty/2"] });
    const workspaceKey = `machine:m1#${++workspace}`;
    render(<Harness machine={machine} workspaceKey={workspaceKey} />);
    setPrefs({ panelTerminalOpen: true });
    fireEvent.click(screen.getByRole("tab", { name: /^Run/ }));
    expect(screen.getByTestId("run-pane").textContent).toContain("older TerminalX without Setup and Run");
    expect(screen.getByTestId("offered").textContent).toBe("false");
    expect(machine.client.sessionActions).not.toHaveBeenCalled();
  });
});

describe("a machine session's Run menu and restart offer (PRO-403)", () => {
  it("lists the machine's visible actions, runs one there and shows its terminal under the dock's Run", async () => {
    const machine = fakeMachine({ actions: [action("dev", "Dev server"), action("secret", "Secret", { hidden: true }), action("test", "Test")] });
    await renderSession(machine);
    expect(screen.getByTestId("offered").textContent).toBe("true");
    openMenu(screen.getByTestId("run-menu-trigger"));
    const menu = await screen.findByTestId("run-menu");
    expect(menu.textContent).toContain("Run on Mac mini");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.getAttribute("data-action-id"))).toEqual(["dev", "test"]);
    fireEvent.click(within(menu).getByText("Test"));
    await waitFor(() => expect(machine.client.runAction).toHaveBeenCalledWith("s1", "test", false));
    await waitFor(() => expect(getPrefs().panelTerminalOpen).toBe(true));
    expect(getPrefs().panelOpen).toBe(true);
    await waitFor(() => expect(screen.getByTestId("run-output").querySelector("[data-pty]")?.getAttribute("data-pty")).toMatch(/^s1:action-test-/));
    expect(within(screen.getByRole("tablist", { name: "Terminals" })).getByRole("tab", { name: /^Run/ }).getAttribute("aria-selected")).toBe("true");
    ranNothingHere();
  });

  it("marks what runs on the machine, and follows a run that ended there", async () => {
    const machine = fakeMachine();
    await machine.client.runAction("s1", "dev", false);
    const { workspaceKey } = await renderSession(machine);
    expect(screen.getByRole("button", { name: "Run, 1 running" })).toBeTruthy();
    machine.exit("dev", 1);
    await act(async () => {
      await syncCloudTerminals(workspaceKey, machine.rpc, base);
    });
    await waitFor(() => expect(screen.getByTestId("run-menu-trigger").getAttribute("aria-label")).toBe("Run"));
    openMenu(screen.getByTestId("run-menu-trigger"));
    const menu = await screen.findByTestId("run-menu");
    expect(menu.querySelector('[data-action-id="dev"] [data-testid="run-state"]')?.textContent).toBe("Exited 1");
  });

  it("⌘R runs the one action on the machine", async () => {
    const machine = fakeMachine({ actions: [action("dev", "Dev server")] });
    await renderSession(machine);
    pressRun();
    await waitFor(() => expect(machine.client.runAction).toHaveBeenCalledWith("s1", "dev", false));
  });

  it("⌘R opens the menu as a picker when the machine's project has several", async () => {
    const machine = fakeMachine();
    await renderSession(machine);
    pressRun();
    const menu = await screen.findByTestId("run-menu");
    expect(within(menu).getByTestId("run-menu-picker-key")).toBeTruthy();
    expect(machine.client.runAction).not.toHaveBeenCalled();
  });

  it("offers to restart an action already running on the machine, and restarts the machine's run terminal", async () => {
    const machine = fakeMachine();
    await machine.client.runAction("s1", "dev", false);
    const first = (await machine.client.listPtys()).terminals[0].ptyId;
    const { workspaceKey } = await renderSession(machine);
    openMenu(screen.getByTestId("run-menu-trigger"));
    fireEvent.click(within(await screen.findByTestId("run-menu")).getByText("Dev server"));
    const offer = await screen.findByTestId("run-restart-offer");
    expect(offer.textContent).toContain("Dev server is already running on Mac mini; its terminal is shown.");
    expect(screen.getByTestId("run-output").querySelector("[data-pty]")?.getAttribute("data-pty")).toBe(first);
    fireEvent.click(within(offer).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(machine.client.runAction).toHaveBeenLastCalledWith("s1", "dev", true));
    await waitFor(() => expect(screen.queryByTestId("run-restart-offer")).toBeNull());
    const runs = cloudTerminalsOf(workspaceKey).terminals.filter((terminal) => terminal.run?.kind === "action" && !terminal.gone);
    expect(runs.map((terminal) => terminal.ptyId)).not.toContain(first);
    await waitFor(() => expect(screen.getByTestId("run-output").querySelector("[data-pty]")?.getAttribute("data-pty")).toBe(runs.at(-1)!.ptyId));
    ranNothingHere();
  });

  it("says why ⌘R does not run while the computer may only view", async () => {
    const machine = fakeMachine({ actions: [action("dev", "Dev server")] });
    await renderSession(machine, { manage: false });
    pressRun();
    await waitFor(() => expect(getErrorToasts().some((toast) => toast.action === "Couldn't run Dev server" && toast.cause === "Only a computer paired with Mac mini runs its scripts")).toBe(true));
    expect(machine.client.runAction).not.toHaveBeenCalled();
  });

  it("is not offered while the machine is away", async () => {
    await renderSession(fakeMachine(), { connected: false });
    expect(screen.getByTestId("offered").textContent).toBe("false");
    expect(screen.queryByTestId("run-menu-trigger")).toBeNull();
  });
});
