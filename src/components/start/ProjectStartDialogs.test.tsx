import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/types/session";

type ProgressHandler = (event: { payload: { id: string; stage: string; percent: number | null } }) => void;

const { invoke, listen, unlisten, openDialog, prefs, setPrefs, sessions } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  openDialog: vi.fn(),
  prefs: { projectsDir: null as string | null },
  setPrefs: vi.fn(),
  sessions: { addProject: vi.fn(), startSessionIn: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));
vi.mock("@/lib/prefs", () => ({ setPrefs, usePrefs: () => prefs }));
vi.mock("@/lib/sessions", () => sessions);

const { ProjectStartDialogHost } = await import("./ProjectStartDialogs");
const { isMac } = await import("@/lib/shortcuts");
/** The platform's Cmd+Enter (Ctrl+Enter off macOS). */
const modEnter = { key: "Enter", ...(isMac ? { metaKey: true } : { ctrlKey: true }) };
const { openProjectStart } = await import("@/lib/projectStart");

const repositories = [
  { nameWithOwner: "acme/widgets", description: "Widget factory", isPrivate: true, pushedAt: null },
  { nameWithOwner: "acme/gadgets", description: null, isPrivate: false, pushedAt: null },
];

/** The clone the backend is running, for a test to finish, fail or report on. */
let clone: { id: string; source: string; parent: string; resolve: (value: unknown) => void; reject: (cause: unknown) => void } | null = null;
let gh: unknown = { status: "ready", repositories, truncated: false };
let created: (args: { parent: string; name: string; template: string }) => Promise<string>;
const BUILT_IN_TEMPLATES = [
  { id: "empty", name: "Empty", description: "A README, a .gitignore and nothing else", builtIn: true },
  { id: "vite-react", name: "Vite + React", description: "TypeScript, Tailwind and Vitest", builtIn: true },
  { id: "agent-starter", name: "Agent starter", description: "CLAUDE.md, AGENTS.md, setup and test scripts", builtIn: true },
];
let templates: unknown[] = BUILT_IN_TEMPLATES;
const canceled: string[] = [];

function progress(stage: string, percent: number | null, id = clone!.id) {
  const handler = listen.mock.calls.at(-1)![1] as ProgressHandler;
  act(() => handler({ payload: { id, stage, percent } }));
}

function open(kind: "github" | "quick") {
  render(<ProjectStartDialogHost />);
  act(() => openProjectStart(kind));
}

beforeEach(() => {
  vi.clearAllMocks();
  clone = null;
  canceled.length = 0;
  gh = { status: "ready", repositories, truncated: false };
  prefs.projectsDir = null;
  created = async ({ parent, name }) => `${parent}/${name}`;
  templates = BUILT_IN_TEMPLATES;
  listen.mockResolvedValue(unlisten);
  sessions.addProject.mockImplementation(async (path: string) => ({ path, name: path.split("/").pop() }) as Project);
  invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
    if (command === "github_repositories") return gh;
    if (command === "project_start_defaults") return { projectsDir: args.parent ?? "/home/me/Projects", suggestedName: args.parent === "/elsewhere" ? "my-project-2" : "my-project" };
    if (command === "project_clone") {
      return new Promise((resolve, reject) => {
        clone = { id: args.id, source: args.source, parent: args.parent, resolve, reject };
      });
    }
    if (command === "project_clone_cancel") {
      canceled.push(args.id);
      return undefined;
    }
    if (command === "project_create") return created(args as { parent: string; name: string; template: string });
    if (command === "project_templates") return templates;
    throw new Error(`unexpected command ${command}`);
  });
});

afterEach(() => {
  cleanup();
  act(() => openProjectStart(null));
});

const cloneButton = () => screen.getByRole("button", { name: "Clone" }) as HTMLButtonElement;

async function startClone(repository = "acme/widgets") {
  open("github");
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(repository) }));
  await waitFor(() => expect(cloneButton().disabled).toBe(false));
  fireEvent.click(cloneButton());
  await waitFor(() => expect(clone).not.toBeNull());
}

describe("Open GitHub project", () => {
  it("lists the reader's repositories from the backend and narrows them as they type", async () => {
    open("github");

    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["acme/widgets", "acme/gadgets"]);
    expect(screen.getByLabelText("Private")).toBeTruthy();
    expect(cloneButton().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Search your repositories"), { target: { value: "factory" } });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["acme/widgets"]);

    fireEvent.change(screen.getByLabelText("Search your repositories"), { target: { value: "nothing-like-it" } });
    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(screen.getByText(/No repository matches/)).toBeTruthy();
  });

  it("clones the picked repository into the suggested folder and opens it", async () => {
    await startClone();

    expect(clone).toMatchObject({ source: "acme/widgets", parent: "/home/me/Projects" });
    expect(screen.getByTestId("start-destination").textContent).toBe("/home/me/Projects/widgets");
    await act(async () => clone!.resolve({ path: "/home/me/Projects/widgets", existing: false }));

    await waitFor(() => expect(sessions.startSessionIn).toHaveBeenCalledWith("/home/me/Projects/widgets", null));
    expect(sessions.addProject).toHaveBeenCalledWith("/home/me/Projects/widgets");
    // The folder is remembered for the next project.
    expect(setPrefs).toHaveBeenCalledWith({ projectsDir: "/home/me/Projects" });
    expect(screen.queryByTestId("start-github-dialog")).toBeNull();
    expect(unlisten).toHaveBeenCalled();
  });

  it("shows the clone's progress, and only its own", async () => {
    await startClone();

    const bar = screen.getByRole("progressbar", { name: "Clone progress" });
    expect(bar.getAttribute("aria-valuetext")).toBe("Connecting");

    progress("Receiving objects", 45);
    expect(bar.getAttribute("aria-valuenow")).toBe("45");
    expect(screen.getByTestId("start-clone-progress").textContent).toContain("Receiving objects");

    progress("Resolving deltas", 99, "some-other-clone");
    expect(bar.getAttribute("aria-valuenow")).toBe("45");
  });

  it("cancels a running clone and attaches nothing", async () => {
    await startClone();

    fireEvent.click(screen.getByRole("button", { name: "Cancel clone" }));
    expect(canceled).toEqual([clone!.id]);
    await act(async () => clone!.reject({ code: "canceled", message: "The clone was canceled." }));

    expect(await screen.findByText(/Clone canceled/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(sessions.addProject).not.toHaveBeenCalled();
    expect(cloneButton().disabled).toBe(false);
  });

  it("stops the clone when the dialog is closed over it", async () => {
    await startClone();
    const id = clone!.id;

    act(() => openProjectStart(null));

    expect(canceled).toEqual([id]);
    expect(sessions.addProject).not.toHaveBeenCalled();
  });

  it("attaches nothing when a clone finishes after its dialog was closed", async () => {
    await startClone();
    const running = clone!;

    act(() => openProjectStart(null));
    await act(async () => running.resolve({ path: "/home/me/Projects/widgets", existing: false }));

    expect(sessions.addProject).not.toHaveBeenCalled();
    expect(sessions.startSessionIn).not.toHaveBeenCalled();
  });

  it("keeps the choice as it was while offering an existing clone", async () => {
    await startClone();
    await act(async () => clone!.resolve({ path: "/home/me/Projects/widgets", existing: true }));
    await screen.findByTestId("start-already-cloned");

    expect((screen.getByLabelText("Or paste a repository URL or owner/name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Choose folder…" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByLabelText("Or paste a repository URL or owner/name") as HTMLInputElement).disabled).toBe(false);
  });

  it.each([
    ["access-denied", "Git could not access acme/widgets. Check that it exists and that you have access to it.\nremote: Repository not found."],
    ["network", "Could not reach the server for acme/widgets. Check your connection and try again."],
    ["destination-exists", "/home/me/Projects/widgets already exists and is not empty. Choose another folder."],
    ["timed-out", "The transfer stalled and was stopped."],
  ])("reports a %s failure with its own message and a way to retry", async (code, message) => {
    await startClone();
    const first = clone!.id;
    await act(async () => clone!.reject({ code, message }));

    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-failure")).toBe(code);
    expect(alert.textContent).toContain(message.split("\n")[0]);
    expect(sessions.addProject).not.toHaveBeenCalled();
    expect(sessions.startSessionIn).not.toHaveBeenCalled();

    clone = null;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(clone).not.toBeNull());
    expect(clone!.id).not.toBe(first);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers to open a repository that is already cloned there", async () => {
    await startClone();
    await act(async () => clone!.resolve({ path: "/home/me/Projects/widgets", existing: true }));

    expect((await screen.findByTestId("start-already-cloned")).textContent).toContain("/home/me/Projects/widgets");
    expect(sessions.addProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open it" }));
    await waitFor(() => expect(sessions.startSessionIn).toHaveBeenCalledWith("/home/me/Projects/widgets", null));
  });

  it("clones a pasted URL or owner/name, which wins over a picked repository", async () => {
    open("github");
    fireEvent.click(await screen.findByRole("option", { name: /acme\/gadgets/ }));
    const field = screen.getByLabelText("Or paste a repository URL or owner/name");

    fireEvent.change(field, { target: { value: " git@gitlab.com:group/tool.git " } });
    expect(screen.getByTestId("start-destination").textContent).toBe("/home/me/Projects/tool");
    expect(screen.getByRole("option", { name: /acme\/gadgets/ }).getAttribute("aria-selected")).toBe("false");
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(clone).not.toBeNull());
    expect(clone!.source).toBe("git@gitlab.com:group/tool.git");
  });

  it("takes an address pasted into the search box when nothing listed matches it", async () => {
    open("github");
    const search = await screen.findByLabelText("Search your repositories");

    // A word that matches nothing is only a search.
    fireEvent.change(search, { target: { value: "nothing-like-it" } });
    expect(cloneButton().disabled).toBe(true);

    fireEvent.change(search, { target: { value: "https://github.com/else/tool.git" } });
    expect(screen.getByText(/Not in your list/)).toBeTruthy();
    expect(screen.getByTestId("start-destination").textContent).toBe("/home/me/Projects/tool");
    fireEvent.keyDown(search, { key: "Enter" });

    await waitFor(() => expect(clone?.source).toBe("https://github.com/else/tool.git"));
  });

  it.each([
    ["missing", /not installed/],
    ["signed-out", /not signed in/],
  ])("explains a %s gh and still clones from a URL", async (status, title) => {
    gh = { status };
    open("github");

    const note = await screen.findByTestId("start-gh-unavailable");
    expect(note.getAttribute("data-gh")).toBe(status);
    expect(note.textContent).toMatch(title);
    expect(note.textContent).toContain("Git credentials already on this computer");
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.change(screen.getByLabelText("Or paste a repository URL or owner/name"), { target: { value: "acme/widgets" } });
    await waitFor(() => expect(cloneButton().disabled).toBe(false));
    fireEvent.click(cloneButton());
    await waitFor(() => expect(clone?.source).toBe("acme/widgets"));
  });

  it("lists the repositories once gh has been signed in and checked again", async () => {
    gh = { status: "signed-out" };
    open("github");
    await screen.findByTestId("start-gh-unavailable");

    gh = { status: "ready", repositories, truncated: true };
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByRole("option", { name: /acme\/widgets/ })).toBeTruthy();
    expect(screen.getByText(/most recently pushed/)).toBeTruthy();
  });

  it("clones where the reader chooses, starting from the folder used last", async () => {
    prefs.projectsDir = "/work";
    openDialog.mockResolvedValue("/elsewhere");
    open("github");
    fireEvent.click(await screen.findByRole("option", { name: /acme\/widgets/ }));
    expect(screen.getByTestId("start-destination").textContent).toBe("/work/widgets");

    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect(screen.getByTestId("start-destination").textContent).toBe("/elsewhere/widgets"));
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true, defaultPath: "/work" }));

    fireEvent.click(cloneButton());
    await waitFor(() => expect(clone?.parent).toBe("/elsewhere"));
  });
});

describe("Create a project (Quick start)", () => {
  const nameField = () => screen.getByLabelText("Project name") as HTMLInputElement;
  const createButton = () => screen.getByRole("button", { name: /^Create/ }) as HTMLButtonElement;
  const templateCard = (name: string) => screen.getByRole("radio", { name: new RegExp(`^${name.replace(/[+]/g, "\\+")}`) }) as HTMLButtonElement;
  const sessionBox = () => screen.getByRole("checkbox", { name: "Open a new session in it when it's ready" }) as HTMLInputElement;
  const ready = async () => {
    await waitFor(() => expect(nameField().value).toBe("my-project"));
    await screen.findByRole("radiogroup", { name: "Template" });
  };

  it("shows the fields, the three built-in templates, the git note and the session checkbox", async () => {
    open("quick");
    await ready();
    expect(screen.getByRole("heading", { name: "Create a project" })).toBeTruthy();
    expect(screen.getByText("A new folder with its own git repository, ready for a first session.")).toBeTruthy();
    expect(screen.getByTestId("start-destination").textContent).toBe("/home/me/Projects/my-project");
    expect(screen.getByTestId("start-parent").textContent).toBe("/home/me/Projects");
    expect(screen.getByRole("button", { name: "Change…" })).toBeTruthy();

    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("data-template"))).toEqual(["empty", "vite-react", "agent-starter"]);
    // Empty is chosen until the reader picks another.
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(templateCard("Empty").textContent).toContain("A README, a .gitignore and nothing else");
    expect(templateCard("Vite + React").textContent).toContain("TypeScript, Tailwind and Vitest");
    expect(templateCard("Agent starter").textContent).toContain("CLAUDE.md, AGENTS.md, setup and test scripts");
    expect(templateCard("Agent starter").textContent).toContain("NEW");

    expect(screen.getByRole("note").textContent).toBe("Creates a git repository on main with a first commit. No GitHub remote yet: TerminalX offers to create a private one the first time you push.");
    expect(sessionBox().checked).toBe(true);
    expect(screen.getByRole("button", { name: "Add your own templates in Settings › Projects" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Cancel/ }).textContent).toContain("esc");
  });

  it("creates the project from the chosen template and opens a new session in it", async () => {
    open("quick");
    await ready();

    fireEvent.click(templateCard("Vite + React"));
    expect(templateCard("Vite + React").getAttribute("aria-checked")).toBe("true");
    expect(templateCard("Empty").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(createButton());

    // A real project is attached, and the session view opens in it: never a project-less session.
    await waitFor(() => expect(sessions.startSessionIn).toHaveBeenCalledWith("/home/me/Projects/my-project", null));
    expect(invoke).toHaveBeenCalledWith("project_create", { parent: "/home/me/Projects", name: "my-project", template: "vite-react" });
    expect(sessions.addProject).toHaveBeenCalledWith("/home/me/Projects/my-project");
    expect(setPrefs).toHaveBeenCalledWith({ projectsDir: "/home/me/Projects" });
    expect(screen.queryByTestId("start-quick-dialog")).toBeNull();
  });

  it("with the checkbox off, adds the project without opening a new-session view", async () => {
    open("quick");
    await ready();

    fireEvent.click(sessionBox());
    expect(sessionBox().checked).toBe(false);
    fireEvent.click(createButton());

    await waitFor(() => expect(sessions.addProject).toHaveBeenCalledWith("/home/me/Projects/my-project"));
    expect(invoke).toHaveBeenCalledWith("project_create", { parent: "/home/me/Projects", name: "my-project", template: "empty" });
    await waitFor(() => expect(screen.queryByTestId("start-quick-dialog")).toBeNull());
    expect(sessions.startSessionIn).not.toHaveBeenCalled();
  });

  it("creates with Cmd+Enter from anywhere in the dialog", async () => {
    open("quick");
    await ready();
    fireEvent.click(templateCard("Agent starter"));
    fireEvent.keyDown(templateCard("Agent starter"), modEnter);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("project_create", { parent: "/home/me/Projects", name: "my-project", template: "agent-starter" }));
  });

  it("offers a template added in Settings, and a template whose folder is gone cannot be picked", async () => {
    templates = [
      ...BUILT_IN_TEMPLATES,
      { id: "user:1", name: "house-style", description: "/home/me/templates/house-style", builtIn: false, path: "/home/me/templates/house-style" },
      { id: "user:2", name: "old", description: "/home/me/old", builtIn: false, path: "/home/me/old", problem: "/home/me/old is no longer there." },
    ];
    open("quick");
    await ready();

    expect(templateCard("old").disabled).toBe(true);
    expect(templateCard("old").textContent).toContain("is no longer there");
    fireEvent.click(templateCard("house-style"));
    fireEvent.click(createButton());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("project_create", { parent: "/home/me/Projects", name: "my-project", template: "user:1" }));
  });

  it("opens Settings › Projects from the link and closes the dialog", async () => {
    const { onTemplateSettingsRequest } = await import("@/lib/projectStart");
    const opened = vi.fn();
    const stop = onTemplateSettingsRequest(opened);
    open("quick");
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Add your own templates in Settings › Projects" }));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("start-quick-dialog")).toBeNull();
    stop();
  });

  it("uses the name and the folder the reader chose", async () => {
    openDialog.mockResolvedValue("/elsewhere");
    open("quick");
    await ready();

    // Until a name is typed, the suggestion follows the folder.
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    await waitFor(() => expect(nameField().value).toBe("my-project-2"));
    expect(screen.getByTestId("start-parent").textContent).toBe("/elsewhere");

    fireEvent.change(nameField(), { target: { value: "first-idea" } });
    expect(screen.getByTestId("start-destination").textContent).toBe("/elsewhere/first-idea");
    fireEvent.keyDown(nameField(), { key: "Enter" });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("project_create", { parent: "/elsewhere", name: "first-idea", template: "empty" }));
  });

  it("reports a folder that is already taken and attaches nothing", async () => {
    created = async () => {
      throw { code: "destination-exists", message: "/home/me/Projects/my-project already exists. Choose another name." };
    };
    open("quick");
    await ready();

    fireEvent.click(createButton());

    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-failure")).toBe("destination-exists");
    expect(alert.textContent).toContain("already exists");
    expect(sessions.addProject).not.toHaveBeenCalled();
    expect(screen.getByTestId("start-quick-dialog")).toBeTruthy();

    // A second try with another name goes through.
    created = async ({ parent, name }) => `${parent}/${name}`;
    fireEvent.change(nameField(), { target: { value: "second-idea" } });
    fireEvent.click(createButton());
    await waitFor(() => expect(sessions.startSessionIn).toHaveBeenCalledWith("/home/me/Projects/second-idea", null));
  });

  it("reports a bad name", async () => {
    created = async () => {
      throw { code: "invalid-name", message: "Enter a folder name for the project, without slashes." };
    };
    open("quick");
    await ready();
    fireEvent.change(nameField(), { target: { value: "a/b" } });
    fireEvent.click(createButton());
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-failure")).toBe("invalid-name");
    expect(alert.textContent).toBe("Enter a folder name for the project, without slashes.");
  });

  it("does not create a project without a name", async () => {
    open("quick");
    await ready();

    fireEvent.change(nameField(), { target: { value: "   " } });

    expect(createButton().disabled).toBe(true);
    fireEvent.keyDown(nameField(), { key: "Enter" });
    fireEvent.keyDown(nameField(), modEnter);
    expect(invoke).not.toHaveBeenCalledWith("project_create", expect.anything());
  });

  it("cancels with Esc and creates nothing", async () => {
    open("quick");
    await ready();
    fireEvent.keyDown(nameField(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("start-quick-dialog")).toBeNull());
    expect(invoke).not.toHaveBeenCalledWith("project_create", expect.anything());
  });
});
