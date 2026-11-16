import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRpcError, type MachineClone, type MachineFolder, type MachineFolderListing, type MachineProject, type WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { MachineProjectNode, MachineSessionRow } from "@/lib/machineCatalog";
import { pairedMachine } from "./machineFixtures.test-utils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

const { AddMachineProjectDialog } = await import("./AddMachineProjectDialog");
const { MachinePageProjects } = await import("./MachinePageProjects");

const DEV = pairedMachine({ machineId: "PB4eLHf3wXc1qD9z", name: "dev-server", os: { family: "linux", version: "24.04" }, hasWindow: false });
const HOME = "/home/paresh";
const CODE = "/home/paresh/code";

const folder = (name: string, patch: Partial<MachineFolder> = {}, parent = CODE): MachineFolder => ({ name, path: `${parent}/${name}`, git: null, projectId: null, ...patch });
const LISTINGS: Record<string, MachineFolderListing> = {
  [HOME]: { home: HOME, path: HOME, parent: null, truncated: false, entries: [folder("code", {}, HOME)] },
  [CODE]: {
    home: HOME,
    path: CODE,
    parent: HOME,
    truncated: false,
    entries: [
      folder("terminalx", { git: { branch: "main", github: true } }),
      folder("terminalx-server", { git: { branch: "main", github: true }, projectId: "c2VydmVyMDAwMDAw" }),
      folder("tx-review-lab", { git: { branch: "main", github: true }, projectId: "cmV2aWV3bGFiMDAw" }),
      folder("relay-bench", { git: { branch: "main", github: true } }),
      folder("scratch"),
      folder("notes"),
    ],
  },
  [`${CODE}/scratch`]: { home: HOME, path: `${CODE}/scratch`, parent: CODE, truncated: false, entries: [folder("tmp", {}, `${CODE}/scratch`)] },
};

const project = (name: string, path = `${CODE}/${name}`): MachineProject => ({ projectId: `id-${name}`.padEnd(16, "0"), name, path, kind: "git", defaultBranch: "main", archived: false });

const clone = (patch: Partial<MachineClone> = {}): MachineClone => ({
  cloneId: "clone-1",
  repository: "procyon/private-repo",
  path: `${CODE}/private-repo`,
  state: "cloning",
  stage: null,
  percent: null,
  project: null,
  error: null,
  ...patch,
});

/** A machine's client answering `machine/6`, starting the browse at `/home/paresh/code` as the screen shows. */
function fakeClient() {
  return {
    browseMachineFolders: vi.fn(async (path?: string) => {
      const listing = LISTINGS[path ?? CODE];
      if (!listing) throw new WorkspaceRpcError("not_found", "No such folder", "machine.browse");
      return listing;
    }),
    addMachineProject: vi.fn(async (path: string) => project(path.split("/").pop()!, path)),
    removeMachineProject: vi.fn(async (_projectId: string) => undefined),
    cloneMachineProject: vi.fn(async (_repository: string, _parent: string) => clone()),
    cloneStatus: vi.fn(async (_cloneId: string) => clone()),
    cancelClone: vi.fn(async (_cloneId: string) => clone({ state: "canceled" })),
  };
}
type FakeClient = ReturnType<typeof fakeClient>;

function openDialog(client: FakeClient, handlers: { onClose?: () => void; onAdded?: (project: MachineProject) => void } = {}) {
  const onClose = handlers.onClose ?? vi.fn();
  const onAdded = handlers.onAdded ?? vi.fn();
  render(<AddMachineProjectDialog machine={DEV} client={client as unknown as WorkspaceRpcClient} onClose={onClose} onAdded={onAdded} />);
  return { onClose, onAdded };
}

const rows = () => screen.getAllByTestId("machine-folder");
const row = (name: string) => rows().find((el) => el.getAttribute("data-path")?.endsWith(`/${name}`))!;
const choice = () => screen.getByTestId("add-machine-project-choice").textContent;

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Add a project on a machine: Folder on <machine> (21.11)", () => {
  it("names the machine, says the server, and lists its folders with their labels", async () => {
    const client = fakeClient();
    openDialog(client);
    const dialog = screen.getByTestId("add-machine-project");
    expect(within(dialog).getByText("Add a project on dev-server")).toBeTruthy();
    expect(within(dialog).getByText("Pick a folder that is already on the server, or clone a repository there")).toBeTruthy();
    expect(within(dialog).getByRole("tab", { name: "Folder on dev-server" }).getAttribute("aria-selected")).toBe("true");
    expect(within(dialog).getByRole("tab", { name: "Clone from GitHub" })).toBeTruthy();
    await screen.findAllByTestId("machine-folder");
    expect(client.browseMachineFolders).toHaveBeenCalledWith(undefined);
    expect(screen.getByTestId("machine-folder-path").textContent).toContain(CODE);
    expect(rows().map((el) => [el.querySelector(".font-mono")?.textContent, within(el).getByTestId("machine-folder-label").textContent])).toEqual([
      ["terminalx", "Git · main"],
      ["terminalx-server", "Already a project"],
      ["tx-review-lab", "Already a project"],
      ["relay-bench", "Git · main"],
      ["scratch", "Not a Git repository"],
      ["notes", "Not a Git repository"],
    ]);
    expect(screen.getByText("Only folders are listed, and only while you browse. New sessions make their worktrees next to the project on the server.")).toBeTruthy();
  });

  it("does not let a folder that already is a project be chosen", async () => {
    openDialog(fakeClient());
    await screen.findAllByTestId("machine-folder");
    expect(row("terminalx-server").getAttribute("aria-disabled")).toBe("true");
    expect(row("terminalx-server").className).toContain("text-faint");
    fireEvent.click(row("terminalx-server"));
    expect(row("terminalx-server").getAttribute("aria-selected")).toBe("false");
    expect(choice()).toBe("Choose a folder to add.");
    expect((screen.getByRole("button", { name: "Add project" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("goes into a folder on a double click or Enter, and back up", async () => {
    const client = fakeClient();
    openDialog(client);
    await screen.findAllByTestId("machine-folder");
    fireEvent.doubleClick(row("scratch"));
    await waitFor(() => expect(client.browseMachineFolders).toHaveBeenLastCalledWith(`${CODE}/scratch`));
    await waitFor(() => expect(rows().map((el) => el.getAttribute("data-path"))).toEqual([`${CODE}/scratch/tmp`]));
    expect(screen.getByTestId("machine-folder-path").textContent).toContain(`${CODE}/scratch`);

    fireEvent.click(screen.getByRole("button", { name: "Up to the folder above" }));
    await waitFor(() => expect(client.browseMachineFolders).toHaveBeenLastCalledWith(CODE));
    await waitFor(() => expect(rows()).toHaveLength(6));

    fireEvent.keyDown(row("scratch"), { key: "Enter" });
    await waitFor(() => expect(client.browseMachineFolders).toHaveBeenLastCalledWith(`${CODE}/scratch`));

    fireEvent.click(screen.getByRole("button", { name: "Up to the folder above" }));
    await waitFor(() => expect(rows()).toHaveLength(6));
    // At home there is nothing above.
    fireEvent.click(screen.getByRole("button", { name: "Up to the folder above" }));
    await waitFor(() => expect(client.browseMachineFolders).toHaveBeenLastCalledWith(HOME));
    await waitFor(() => expect((screen.getByRole("button", { name: "Up to the folder above" }) as HTMLButtonElement).disabled).toBe(true));
  });

  it("adds the chosen folder with addMachineProject and closes", async () => {
    const client = fakeClient();
    const { onAdded, onClose } = openDialog(client);
    await screen.findAllByTestId("machine-folder");
    fireEvent.click(row("relay-bench"));
    expect(row("relay-bench").getAttribute("aria-selected")).toBe("true");
    expect(choice()).toBe(`${CODE}/relay-benchGit repository · main · origin on GitHub`);
    fireEvent.click(row("scratch"));
    expect(choice()).toBe(`${CODE}/scratchFolder`);
    fireEvent.click(row("relay-bench"));
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    await waitFor(() => expect(client.addMachineProject).toHaveBeenCalledWith(`${CODE}/relay-bench`));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ name: "relay-bench", path: `${CODE}/relay-bench` })));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a refusal in the dialog and keeps the choice", async () => {
    const client = fakeClient();
    client.addMachineProject.mockRejectedValueOnce(new WorkspaceRpcError("invalid_project", "This folder is a local mirror of a cloud workspace", "machine.addProject"));
    const { onClose } = openDialog(client);
    await screen.findAllByTestId("machine-folder");
    fireEvent.click(row("terminalx"));
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    expect((await screen.findByRole("alert")).textContent).toContain("This folder is a local mirror of a cloud workspace");
    expect(choice()).toContain(`${CODE}/terminalx`);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says why a folder could not be listed", async () => {
    const client = fakeClient();
    client.browseMachineFolders.mockRejectedValueOnce(new WorkspaceRpcError("path_forbidden", "Only folders in the home folder can be listed", "machine.browse"));
    openDialog(client);
    expect((await screen.findByRole("alert")).textContent).toBe("Could not list this folder: Only folders in the home folder can be listed");
  });
});

describe("Add a project on a machine: Clone from GitHub", () => {
  async function startClone(client: FakeClient) {
    openDialog(client);
    fireEvent.click(screen.getByRole("tab", { name: "Clone from GitHub" }));
    await screen.findAllByTestId("machine-folder");
    expect(choice()).toBe("Type a repository to clone.");
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "procyon/private-repo" } });
    expect(choice()).toContain(`${CODE}/private-repo`);
    // Already-a-project folders can hold a clone: nothing is dimmed here.
    expect(row("terminalx-server").getAttribute("aria-disabled")).toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Clone" })));
    expect(client.cloneMachineProject).toHaveBeenCalledWith("procyon/private-repo", CODE);
  }

  it("asks for its status every second, shows git's progress, and shows a failure's message with the inputs kept", async () => {
    const client = fakeClient();
    client.cloneStatus
      .mockResolvedValueOnce(clone({ stage: "Receiving objects", percent: 42 }))
      .mockResolvedValueOnce(clone({ state: "failed", error: { code: "access-denied", message: "dev-server could not read procyon/private-repo: its Git sign-in has no access to it." } }));
    await startClone(client);
    expect(screen.getByTestId("machine-clone-progress").textContent).toContain("Starting the clone…");
    expect(client.cloneStatus).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(client.cloneStatus).toHaveBeenCalledTimes(1);
    expect(client.cloneStatus).toHaveBeenCalledWith("clone-1");
    expect(screen.getByTestId("machine-clone-progress").textContent).toContain("Receiving objects · 42%");
    expect((screen.getByLabelText("Repository") as HTMLInputElement).disabled).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(client.cloneStatus).toHaveBeenCalledTimes(2);
    const alert = screen.getByTestId("machine-clone-error");
    expect(alert.textContent).toBe("dev-server could not read procyon/private-repo: its Git sign-in has no access to it.");
    expect(alert.className).toContain("text-destructive");
    expect(screen.queryByTestId("machine-clone-progress")).toBeNull();
    const input = screen.getByLabelText("Repository") as HTMLInputElement;
    expect(input.value).toBe("procyon/private-repo");
    expect(input.disabled).toBe(false);

    // It stopped asking.
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(client.cloneStatus).toHaveBeenCalledTimes(2);
  });

  it("adds the project once the clone is done", async () => {
    const client = fakeClient();
    const added = project("private-repo");
    client.cloneStatus.mockResolvedValueOnce(clone({ state: "done", percent: 100, project: added }));
    const onAdded = vi.fn();
    const onClose = vi.fn();
    openDialog(client, { onAdded, onClose });
    fireEvent.click(screen.getByRole("tab", { name: "Clone from GitHub" }));
    await screen.findAllByTestId("machine-folder");
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "https://github.com/procyon/private-repo.git" } });
    expect(choice()).toContain(`${CODE}/private-repo`);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Clone" })));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(onAdded).toHaveBeenCalledWith(added);
    expect(onClose).toHaveBeenCalled();
  });

  it("Cancel during a clone stops it on the machine", async () => {
    const client = fakeClient();
    client.cloneStatus.mockResolvedValue(clone({ stage: "Receiving objects", percent: 10 }));
    await startClone(client);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    expect(client.cancelClone).toHaveBeenCalledWith("clone-1");
    expect(screen.getByTestId("machine-clone-error").textContent).toBe("The clone was canceled. Nothing was left on the machine.");
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(client.cloneStatus).toHaveBeenCalledTimes(1);
  });
});

describe("Projects on the machine's page (21.10)", () => {
  const session = (projectId: string, id: string) => ({ projectId, sessionId: id, archived: false }) as unknown as MachineSessionRow;
  const node = (p: MachineProject, sessions: MachineSessionRow[]): MachineProjectNode => ({ key: `machine:${DEV.machineId}:${p.projectId}` as MachineProjectNode["key"], machineId: DEV.machineId, project: p, sessions });
  const LAB = project("tx-review-lab");
  const SERVER = project("terminalx-server");
  const NODES = [node(LAB, [session(LAB.projectId, "s1"), session(LAB.projectId, "s2")]), node(SERVER, [])];

  function mount(client: FakeClient, manage = true) {
    render(<MachinePageProjects machine={DEV} client={client as unknown as WorkspaceRpcClient} connected manage={manage} projects={NODES} ready />);
  }
  const projectRow = (name: string) => screen.getAllByTestId("machine-page-project").find((el) => el.textContent?.includes(name))!;

  it("lists each project with its folder and its sessions", () => {
    mount(fakeClient());
    const lab = projectRow("tx-review-lab");
    expect(within(lab).getByTestId("machine-project-path").textContent).toBe(`${CODE}/tx-review-lab`);
    expect(within(lab).getByTestId("machine-project-path").className).toContain("font-mono");
    expect(within(lab).getByTestId("machine-project-sessions").textContent).toBe("2 sessions");
    expect(within(projectRow("terminalx-server")).getByTestId("machine-project-sessions").textContent).toBe("No sessions");
    expect(screen.getByRole("button", { name: "Add a project" })).toBeTruthy();
  });

  it("offers neither Add nor a menu without machine/6", () => {
    mount(fakeClient(), false);
    expect(screen.getAllByTestId("machine-page-project")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Add a project" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^More for / })).toBeNull();
  });

  it("opens the Add a project dialog", async () => {
    const client = fakeClient();
    mount(client);
    fireEvent.click(screen.getByRole("button", { name: "Add a project" }));
    expect(await screen.findByTestId("add-machine-project")).toBeTruthy();
    await waitFor(() => expect(client.browseMachineFolders).toHaveBeenCalled());
  });

  it("asks before removing a project with sessions, and says nothing is deleted", async () => {
    const client = fakeClient();
    mount(client);
    fireEvent.click(screen.getByRole("button", { name: "More for tx-review-lab on dev-server" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Remove project/ }));
    const dialog = await screen.findByTestId("remove-machine-project");
    expect(client.removeMachineProject).not.toHaveBeenCalled();
    expect(within(dialog).getByText("Remove tx-review-lab from dev-server?")).toBeTruthy();
    expect(dialog.textContent).toContain("It has 2 sessions.");
    expect(dialog.textContent).toContain("its worktrees and its sessions stay on dev-server. Nothing is deleted");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove project" }));
    await waitFor(() => expect(client.removeMachineProject).toHaveBeenCalledWith(LAB.projectId));
    await waitFor(() => expect(screen.queryByTestId("remove-machine-project")).toBeNull());
  });

  it("removes a project with no sessions at once", async () => {
    const client = fakeClient();
    mount(client);
    fireEvent.click(screen.getByRole("button", { name: "More for terminalx-server on dev-server" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Remove project/ }));
    await waitFor(() => expect(client.removeMachineProject).toHaveBeenCalledWith(SERVER.projectId));
    expect(screen.queryByTestId("remove-machine-project")).toBeNull();
  });

  it("shows a refused removal under the list", async () => {
    const client = fakeClient();
    client.removeMachineProject.mockRejectedValueOnce(new WorkspaceRpcError("not_found", "No such project", "machine.removeProject"));
    mount(client);
    fireEvent.click(screen.getByRole("button", { name: "More for terminalx-server on dev-server" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Remove project/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not remove terminalx-server: No such project");
  });
});
