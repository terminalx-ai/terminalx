import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineConnectionView, MachineHostView, PairedMachine } from "@/types/machines";
import { computer, hostView, pairedMachine } from "./machineFixtures.test-utils";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, listener: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, listener);
    return () => mocks.listeners.delete(name);
  }),
}));

type Settings = typeof import("./MachinesSettings");
let MachinesSettings: Settings["MachinesSettings"];
let sessions: typeof import("@/lib/sessions");
let view: MachineHostView;
let machines: PairedMachine[];
let connections: MachineConnectionView[];
let privacy: boolean;
const CODE = { code: "txm2.eyJ2IjoyfQ", expiresAt: Date.now() + 300_000 };
const MINI = "cs1uhCLEB_ttCYaQ";
const STUDIO = "dYd7tB05O1-4RVzm";
const CI = "AAECAwQFBgcICQoL";
const openMenu = (element: HTMLElement) => fireEvent.pointerDown(element, { button: 0, ctrlKey: false, pointerType: "mouse" });

beforeEach(async () => {
  vi.resetModules();
  mocks.listeners.clear();
  privacy = false;
  view = hostView({ allowOperating: false }, { machineId: MINI, computers: [computer({ keyId: STUDIO, route: "lan" })] });
  machines = [
    pairedMachine(),
    pairedMachine({ machineId: STUDIO, name: "Studio", lastSeenAt: Date.now() - 86_400_000 }),
    pairedMachine({ machineId: CI, name: "ci-box", os: { family: "linux", version: "24.04" }, version: "0.2.27", hasWindow: false }),
  ];
  connections = [
    { machineId: MINI, state: { state: "direct", route: { kind: "tailscale", endpoint: "ws://100.64.0.2:6768/machine/1" }, since: Date.now(), rttMs: 9 } },
    { machineId: STUDIO, state: { state: "offline", lastSeenAt: Date.now() - 86_400_000, retryInMs: 10_000 } },
    { machineId: CI, state: { state: "needsUpdate", version: "0.2.27", side: "machine" } },
  ];
  mocks.invoke.mockReset().mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "data_privacy_status") return { enabled: privacy, managed: false };
    if (command === "machines_host_status") return view;
    if (command === "machines_list") return machines;
    if (command === "machines_connections") return connections;
    if (command === "machine_name") return { name: "Paresh’s MacBook Pro", chosen: false, computerName: "Paresh’s MacBook Pro" };
    if (command === "set_machine_name") return { name: args.name, chosen: true, computerName: "Paresh’s MacBook Pro" };
    if (command === "machines_set_allow_operating") return (view = { ...view, allowOperating: args.enabled as boolean });
    if (command === "machines_create_code") {
      view = { ...view, status: { ...view.status!, code: { expiresAt: CODE.expiresAt } } };
      return CODE;
    }
    if (command === "machines_revoke") {
      view = { ...view, status: { ...view.status!, computers: [] } };
      return null;
    }
    if (command === "machines_remove") {
      machines = machines.filter((machine) => machine.machineId !== args.machineId);
      return true;
    }
    if (command === "machines_account_list") return { signedIn: false };
    throw new Error(`unexpected ${command}`);
  });
  ({ MachinesSettings } = await import("./MachinesSettings"));
  sessions = await import("@/lib/sessions");
}, 60_000);
afterEach(cleanup);

const card = async (name: string) => {
  const list = await screen.findByRole("list", { name: "Your machines" });
  return within(list).getByRole("button", { name: `Open ${name}` }).closest("li") as HTMLElement;
};

describe("Settings → Machines (screen 21.02)", () => {
  it("shows the switch, This Mac with its name and key label, your machines and the computers that can operate this Mac", async () => {
    render(<MachinesSettings />);
    const operate = await screen.findByRole("switch", { name: "Let other computers operate this Mac" });
    await waitFor(() => expect(operate.hasAttribute("disabled")).toBe(false));
    expect(operate.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/Connections are end-to-end encrypted; the relay only passes sealed messages\./)).toBeTruthy();
    const thisMac = await screen.findByTestId("this-mac");
    await waitFor(() => expect(thisMac.textContent).toBe("Shown to other computers as Paresh’s MacBook Pro · fingerprint 72CD·6E84"));
    expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /pairing code/ })).toBeNull();
    expect(screen.getByText("Computers this Mac can operate. Each one appears as a section in the sidebar.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a machine" })).toBeTruthy();
    const computers = screen.getByRole("list", { name: "Computers that can operate this Mac" });
    expect(computers.textContent).toContain("Paresh’s MacBook Air");
    expect(computers.textContent).toContain("Connected now");
    expect(computers.textContent).toContain("macOS · Direct on this network · approved Nov 3");
    expect(computers.textContent).toContain("7587·7BB4");
  });

  it("gives each machine a card with its state, system, version, route and key label", async () => {
    render(<MachinesSettings />);
    const mini = await card("Mac mini");
    await waitFor(() => expect(mini.getAttribute("data-state")).toBe("direct"));
    expect(mini.textContent).toContain("Connected");
    expect(mini.textContent).toContain("macOS 26.1 · TerminalX 0.2.33 · Direct over Tailscale");
    expect(mini.textContent).toContain("72CD·6E84");
    const studio = await card("Studio");
    expect(studio.textContent).toContain("Offline");
    expect(studio.textContent).toMatch(/macOS 26\.1 · last seen yesterday at/);
    const ci = await card("ci-box");
    expect(ci.textContent).toContain("Needs update");
    expect(ci.textContent).toContain("TerminalX 0.2.27 · some features are hidden until it is updated");
  });

  it("opens a machine's page from its card, leaving Settings", async () => {
    render(<MachinesSettings />);
    const before = sessions.getSessionStore().navigationVersion;
    fireEvent.click(within(await card("Mac mini")).getByRole("button", { name: "Open Mac mini" }));
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBe(`machine:${MINI}`);
    expect(sessions.getSessionStore().navigationVersion).toBe(before + 1);
  });

  it("removes a machine after a confirmation that says its sessions stay there", async () => {
    render(<MachinesSettings />);
    const studio = await card("Studio");
    openMenu(within(studio).getByRole("button", { name: "More for Studio" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from this Mac…" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Studio?" });
    expect(dialog.textContent).toContain("Sessions on Studio stay there and keep running. Nothing on Studio is changed or deleted.");
    expect(mocks.invoke).not.toHaveBeenCalledWith("machines_remove", expect.anything());
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_remove", { machineId: STUDIO }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open Studio" })).toBeNull());
    expect(screen.queryByRole("dialog", { name: "Remove Studio?" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open Mac mini" })).toBeTruthy();
  });

  it("renames This Mac with the same setting as Account → This Mac’s name", async () => {
    render(<MachinesSettings />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("This Mac’s name"), { target: { value: "Studio desk" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("set_machine_name", { name: "Studio desk" }));
    expect((await screen.findByTestId("this-mac")).textContent).toContain("Shown to other computers as Studio desk");
  });

  it("turns operating on, then makes a pairing code that shows with its expiry", async () => {
    render(<MachinesSettings />);
    const operate = await screen.findByRole("switch", { name: "Let other computers operate this Mac" });
    await waitFor(() => expect(operate.hasAttribute("disabled")).toBe(false));
    fireEvent.click(operate);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_set_allow_operating", { enabled: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Create pairing code" }));
    const code = await screen.findByTestId("machine-pairing-code");
    expect(code.textContent).toContain(CODE.code);
    expect(code.textContent).toMatch(/Expires in [45]:\d\d · works once/);
    expect(screen.getByRole("button", { name: "Create a new code" })).toBeTruthy();
  });

  it("says pairing is paused and does not offer a code then", async () => {
    view = hostView({}, { pausedUntil: Date.now() + 42_000 });
    render(<MachinesSettings />);
    expect(await screen.findByText(/Pairing is paused after too many wrong codes\. Try again in 0:4\d\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create pairing code" }).matches(":disabled")).toBe(true);
  });

  it("Revoke asks once, says it ends the credential and closes the connection without claiming more, then revokes by id", async () => {
    render(<MachinesSettings />);
    const computers = await screen.findByRole("list", { name: "Computers that can operate this Mac" });
    fireEvent.click(within(computers).getByRole("button", { name: "Revoke" }));
    const confirm = within(computers).getByRole("group", { name: "Revoke Paresh’s MacBook Air" });
    expect(confirm.textContent).toContain("Ends Paresh’s MacBook Air’s credential and closes its connection. It does not undo what it already did on this Mac.");
    expect(screen.getByTestId("machines-settings").textContent).not.toMatch(/removes all access|all of its access/);
    expect(mocks.invoke).not.toHaveBeenCalledWith("machines_revoke", expect.anything());
    fireEvent.click(within(confirm).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_revoke", { id: "computer-1" }));
    expect(await screen.findByText("No computer can operate this Mac.")).toBeTruthy();
  });

  it("opens Add a machine on the account tab and lists a machine paired there", async () => {
    render(<MachinesSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a machine" }));
    const dialog = screen.getByRole("dialog", { name: "Add a machine" });
    expect(within(dialog).getByRole("tab", { name: "On your account" }).getAttribute("aria-selected")).toBe("true");
    expect(await within(dialog).findByTestId("account-sign-in")).toBeTruthy();
  });

  it("explains that remote features are off in data privacy mode, as Devices does", async () => {
    privacy = true;
    const { refreshDataPrivacy } = await import("@/lib/dataPrivacy");
    await act(async () => refreshDataPrivacy());
    render(<MachinesSettings />);
    expect(screen.getByRole("status").textContent).toBe("Turned off by data privacy mode");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("machines_host_status");
  });
});

describe("running sessions on a machine's card", () => {
  it("counts sessions whose agent works or waits, not archived or idle ones", async () => {
    const { runningSessionCount, runningText } = await import("./useRunningSessions");
    const tab = (status: "idle" | "in_progress" | "waiting" | "completed") => ({ id: status, harness: "claude", model: "m", permissionMode: "default", status, created: "", modified: "" });
    const session = (id: string, statuses: ("idle" | "in_progress" | "waiting" | "completed")[], archived = false) => ({ id, projectPath: "/p", cwd: "/p", title: id, created: "", modified: "", archived, pinned: false, tabs: statuses.map(tab) });
    expect(runningSessionCount([session("a", ["in_progress"]), session("b", ["idle", "waiting"]), session("c", ["completed"]), session("d", ["in_progress"], true)])).toBe(2);
    expect(runningText(0)).toBe("no sessions running");
    expect(runningText(1)).toBe("1 session running");
    expect(runningText(3)).toBe("3 sessions running");
  });
});
