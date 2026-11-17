import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineActivityEntry, MachineConnectionView, MachineHostView, PairedMachine } from "@/types/machines";
import { computer, hostView, pairedMachine } from "./machineFixtures.test-utils";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  // The opener plugin calls the Tauri internals itself, not @tauri-apps/api/core.
  openUrl: vi.fn(async (_url: string) => undefined),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
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
let activity: MachineActivityEntry[];
const CODE = { code: "txm2.eyJ2IjoyfQ", expiresAt: Date.now() + 300_000 };
const MINI = "cs1uhCLEB_ttCYaQ";
const STUDIO = "dYd7tB05O1-4RVzm";
const CI = "AAECAwQFBgcICQoL";
const openMenu = (element: HTMLElement) => fireEvent.pointerDown(element, { button: 0, ctrlKey: false, pointerType: "mouse" });

beforeEach(async () => {
  vi.resetModules();
  mocks.listeners.clear();
  privacy = false;
  activity = [];
  mocks.openUrl.mockClear();
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
    if (command === "machines_activity") return activity;
    if (command === "machines_disconnect" || command === "machines_let_back") {
      const held = command === "machines_disconnect" ? Date.now() : null;
      view = { ...view, status: { ...view.status!, computers: view.status!.computers.map((one) => (one.id === args.id ? { ...one, connected: false, route: null, disconnectedAt: held } : one)) } };
      return view;
    }
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

describe("Settings → Machines with no machine paired (PRO-360)", () => {
  it("says how to start in three steps and links the guide, in place of an empty list", async () => {
    machines = [];
    connections = [];
    render(<MachinesSettings />);
    const firstRun = await screen.findByTestId("machines-first-run");
    expect(screen.queryByRole("list", { name: "Your machines" })).toBeNull();
    expect(within(firstRun).getByText("No machines yet")).toBeTruthy();
    const steps = within(within(firstRun).getByRole("list", { name: "How to add a machine" })).getAllByRole("listitem");
    expect(steps.map((step) => step.querySelector(".font-medium")?.textContent)).toEqual(["Get the other computer ready", "Add it here", "Start a session there"]);
    expect(steps[0].textContent).toContain("“Let other computers operate this Mac”");
    expect(steps[0].textContent).toContain("terminalx-serve pair");
    // Add a machine stays the page's one primary button.
    expect(screen.getAllByRole("button", { name: "Add a machine" })).toHaveLength(1);
    fireEvent.click(within(firstRun).getByRole("button", { name: "Machines guide" }));
    const { MACHINES_GUIDE_URL } = await import("./MachinesSettings");
    await waitFor(() => expect(mocks.openUrl.mock.calls).toEqual([[MACHINES_GUIDE_URL]]));
    expect(MACHINES_GUIDE_URL).toMatch(/\/blob\/main\/docs\/MACHINES-GUIDE\.md$/);
  });

  it("keeps the guide linked under the page's lead once machines are paired", async () => {
    render(<MachinesSettings />);
    await card("Mac mini");
    expect(screen.queryByTestId("machines-first-run")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Machines guide" }));
    const { MACHINES_GUIDE_URL } = await import("./MachinesSettings");
    await waitFor(() => expect(mocks.openUrl.mock.calls).toEqual([[MACHINES_GUIDE_URL]]));
  });
});

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
    // A Mac has the icon the sidebar and the machine's view give it, and Add a machine is the page's primary button (PRO-398).
    expect(computers.querySelector("[data-icon]")!.getAttribute("data-icon")).toBe("monitor");
    expect(screen.getByRole("button", { name: "Add a machine" }).className).toContain("bg-primary");
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
    const create = await screen.findByRole("button", { name: "Create pairing code" });
    // The code is made with the computers that can operate this Mac: nothing sits between This Mac and Your machines (PRO-398).
    const yours = screen.getByRole("heading", { name: "Your machines" });
    expect(yours.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Computers that can operate this Mac" }).compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(create);
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

  it("says data privacy mode turns off both operating and being operated", async () => {
    privacy = true;
    const { privacyBlocksCommand, refreshDataPrivacy } = await import("@/lib/dataPrivacy");
    await act(async () => refreshDataPrivacy());
    render(<MachinesSettings />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Turned off by data privacy mode");
    expect(status.textContent).toContain("This Mac neither operates other computers nor lets them operate it.");
    expect(status.textContent).toContain("no connection to a machine is made");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("machines_host_status");
    for (const command of ["machines_pair", "machines_create_code", "machines_approve", "machines_let_back", "machines_reconnect", "machine_remote_attach"]) {
      expect(privacyBlocksCommand(command), command).toBe(true);
    }
    for (const command of ["machines_list", "machines_host_status", "machines_connections", "machines_activity", "machines_set_allow_operating", "machine_name", "set_machine_name"]) {
      expect(privacyBlocksCommand(command), command).toBe(false);
    }
  });

  it("Disconnect closes a connected computer at once and holds it off until Let back (PRO-357)", async () => {
    render(<MachinesSettings />);
    const computers = await screen.findByRole("list", { name: "Computers that can operate this Mac" });
    expect(within(computers).getByTestId("computer-connected").textContent).toBe("Connected now");
    fireEvent.click(within(computers).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_disconnect", { id: "computer-1" }));
    expect((await within(computers).findByTestId("computer-disconnected")).textContent).toBe("Disconnected");
    expect(within(computers).queryByTestId("computer-connected")).toBeNull();
    expect(within(computers).getByText(/until you let it back/)).toBeTruthy();
    expect(within(computers).queryByRole("button", { name: "Disconnect" })).toBeNull();
    fireEvent.click(within(computers).getByRole("button", { name: "Let back" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_let_back", { id: "computer-1" }));
    await waitFor(() => expect(within(computers).queryByTestId("computer-disconnected")).toBeNull());
  });

  it("shows no Disconnect for a computer that is not connected", async () => {
    view = hostView({ allowOperating: true }, { machineId: MINI, computers: [computer({ connected: false, route: null })] });
    render(<MachinesSettings />);
    const computers = await screen.findByRole("list", { name: "Computers that can operate this Mac" });
    expect(within(computers).getByRole("button", { name: "Revoke" })).toBeTruthy();
    expect(within(computers).queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  it("lists the activity log under the computers, newest first, with the computer and the time", async () => {
    const at = Date.now() - 60_000;
    activity = [
      { at: at + 3, kind: "terminalOpened", computerId: "computer-1", computer: "Paresh’s MacBook Air", detail: "raccoon" },
      { at: at + 2, kind: "sessionCreated", computerId: "computer-1", computer: "Paresh’s MacBook Air", detail: "raccoon" },
      { at: at + 1, kind: "connected", computerId: "computer-1", computer: "Paresh’s MacBook Air", detail: "relay" },
      { at, kind: "paired", computerId: "computer-1", computer: "Paresh’s MacBook Air" },
    ];
    render(<MachinesSettings />);
    const list = await screen.findByRole("list", { name: "Activity on this Mac" });
    const rows = within(list).getAllByRole("listitem").map((row) => row.textContent);
    expect(rows[0]).toContain("Paresh’s MacBook Air opened a terminal in raccoon");
    expect(rows[1]).toContain("Paresh’s MacBook Air started a session in raccoon");
    expect(rows[2]).toContain("Paresh’s MacBook Air connected through Relay");
    expect(rows[3]).toContain("Paresh’s MacBook Air was allowed to operate this Mac");
    expect(rows[0]).toMatch(/today at \d\d:\d\d/);
    // It sits in the computers' own section (21.02).
    const section = screen.getByRole("list", { name: "Computers that can operate this Mac" }).closest("section")!;
    expect(section.contains(list)).toBe(true);
  });

  it("words every kind of activity without anything but names, projects, routes and versions", async () => {
    const { activityText } = await import("./MachinesSettings");
    const one = (kind: MachineActivityEntry["kind"], detail?: string) => activityText({ at: 1, kind, computer: "Air", detail });
    expect(one("connected", "lan")).toBe("Air connected on this network");
    expect(one("connected", "tailscale")).toBe("Air connected over Tailscale");
    expect(one("disconnected")).toBe("Air disconnected");
    expect(one("update", "0.2.34")).toBe("Air asked to update TerminalX to 0.2.34");
    expect(one("revoked")).toBe("Air’s access was revoked");
    expect(one("expired")).toBe("Air’s access expired after 90 days unused");
    expect(one("held")).toBe("Air was disconnected until let back");
    expect(one("letBack")).toBe("Air was let back");
    expect(activityText({ at: 1, kind: "projectAdded", detail: "site" })).toBe("Project site was added while a computer was connected");
    expect(activityText({ at: 1, kind: "projectRemoved" })).toBe("A project was removed while a computer was connected");
    expect(one("other")).toBe("Air: an event from a newer TerminalX");
  });

  it("says when there is no activity yet", async () => {
    render(<MachinesSettings />);
    expect(await within(await screen.findByTestId("machine-activity")).findByText("Nothing yet.")).toBeTruthy();
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


it("retains the complete introduction when Machines is rendered standalone", async () => {
  render(<MachinesSettings />);
  await card("Mac mini");
  const { SETTINGS_SECTIONS } = await import("../settings/settingsRegistry");
  expect(screen.getByText(SETTINGS_SECTIONS.machines.subtitle, { exact: false })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Your machines" })).toBeTruthy();
});
