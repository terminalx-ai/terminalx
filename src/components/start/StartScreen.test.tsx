import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessInfo, Project } from "@/types/session";

const { dragDropListener, invoke, openDialog, openUrl, store, account, sessions, signIn } = vi.hoisted(() => ({
  dragDropListener: vi.fn(),
  invoke: vi.fn(),
  openDialog: vi.fn(),
  openUrl: vi.fn(),
  signIn: vi.fn(),
  store: { harnesses: [] as unknown[] },
  account: { ready: true, busy: false, status: { state: "signed-out" as string } },
  sessions: { addProject: vi.fn(), startSessionIn: vi.fn(), refreshHarnesses: vi.fn() },
}));

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: dragDropListener }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@/lib/api", () => ({ errorMessage: (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)), files: { droppedText: vi.fn(async () => null) } }));
vi.mock("@/lib/account", () => ({ signIn, useAccount: () => account }));
vi.mock("@/lib/prefs", () => ({ setPrefs: vi.fn(), usePrefs: () => ({ projectsDir: null }) }));
vi.mock("@/lib/sessions", () => ({ ...sessions, useSessionStore: () => store }));

const { StartScreen } = await import("./StartScreen");
const { ProjectStartDialogHost } = await import("./ProjectStartDialogs");
const { openProjectStart } = await import("@/lib/projectStart");

const claude = { id: "claude", name: "Claude Code", available: true, installHint: "npm i -g claude", installUrl: "https://example.com/claude" } as HarnessInfo;
const codex = { id: "codex", name: "Codex", available: false, installHint: "npm i -g codex", installUrl: "https://example.com/codex" } as HarnessInfo;

const cards = () => screen.getAllByRole("button").filter((button) => button.hasAttribute("data-start-card"));

async function emitDrop(payload: { type: string; paths?: string[] }) {
  await waitFor(() => expect(dragDropListener).toHaveBeenCalled());
  await act(async () => {
    await dragDropListener.mock.calls.at(-1)![0]({ payload: { position: { x: 5, y: 5 }, ...payload } });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dragDropListener.mockResolvedValue(vi.fn());
  store.harnesses = [claude];
  account.status = { state: "signed-out" };
  sessions.addProject.mockImplementation(async (path: string) => ({ path, name: path.split("/").pop() }) as Project);
  invoke.mockImplementation(async (command: string) => {
    if (command === "github_repositories") return { status: "ready", repositories: [], truncated: false };
    if (command === "project_start_defaults") return { projectsDir: "/home/me/Projects", suggestedName: "my-project" };
    throw new Error(`unexpected command ${command}`);
  });
});

afterEach(() => {
  cleanup();
  act(() => openProjectStart(null));
});

describe("the start screen", () => {
  it("shows the wordmark and the three ways to a project", () => {
    render(<StartScreen onOpenSettings={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "TerminalX" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Get started" })).toBeTruthy();
    expect(cards().map((card) => card.getAttribute("data-start-card"))).toEqual(["local", "github", "quick"]);
    // Each is a real button with a name of its own, and its hint as a description.
    expect(screen.getByRole("button", { name: "Open local project" }).getAttribute("aria-describedby")).toBe("start-card-hint-local");
    expect(screen.getByRole("button", { name: "Open GitHub project" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Quick start" })).toBeTruthy();
    expect(screen.queryByTestId("start-no-agent")).toBeNull();
  });

  it("opens a chosen folder as a project and lands on its new-session view", async () => {
    openDialog.mockResolvedValue("/code/widgets");
    render(<StartScreen onOpenSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Open local project" }));

    await waitFor(() => expect(sessions.startSessionIn).toHaveBeenCalledWith("/code/widgets", null));
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(sessions.addProject).toHaveBeenCalledWith("/code/widgets");
  });

  it("attaches nothing when the folder picker is dismissed", async () => {
    openDialog.mockResolvedValue(null);
    render(<StartScreen onOpenSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Open local project" }));

    await waitFor(() => expect(openDialog).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByRole("button", { name: "Open local project" }) as HTMLButtonElement).disabled).toBe(false));
    expect(sessions.addProject).not.toHaveBeenCalled();
    expect(sessions.startSessionIn).not.toHaveBeenCalled();
  });

  it("says why a folder could not be opened", async () => {
    openDialog.mockResolvedValue("/code/mirror");
    sessions.addProject.mockRejectedValue(new Error("That folder is a cloud mirror."));
    render(<StartScreen onOpenSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Open local project" }));

    expect((await screen.findByRole("alert")).textContent).toBe("That folder is a cloud mirror.");
    expect(sessions.startSessionIn).not.toHaveBeenCalled();
  });

  it("opens the GitHub and Quick start dialogs from their cards", async () => {
    render(
      <>
        <StartScreen onOpenSettings={vi.fn()} />
        <ProjectStartDialogHost />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open GitHub project" }));
    expect(await screen.findByTestId("start-github-dialog")).toBeTruthy();

    act(() => openProjectStart(null));
    fireEvent.click(screen.getByRole("button", { name: "Quick start" }));
    expect(await screen.findByTestId("start-quick-dialog")).toBeTruthy();
  });

  it("moves between the cards with the arrow keys, Home and End", () => {
    render(<StartScreen onOpenSettings={vi.fn()} />);
    const [local, github, quick] = cards();

    local.focus();
    fireEvent.keyDown(local, { key: "ArrowRight" });
    expect(document.activeElement).toBe(github);
    fireEvent.keyDown(github, { key: "ArrowDown" });
    expect(document.activeElement).toBe(quick);
    fireEvent.keyDown(quick, { key: "ArrowRight" });
    expect(document.activeElement).toBe(local);
    fireEvent.keyDown(local, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(quick);
    fireEvent.keyDown(quick, { key: "ArrowUp" });
    expect(document.activeElement).toBe(github);
    fireEvent.keyDown(github, { key: "End" });
    expect(document.activeElement).toBe(quick);
    fireEvent.keyDown(quick, { key: "Home" });
    expect(document.activeElement).toBe(local);
  });

  it("opens a folder dropped anywhere on it", async () => {
    render(<StartScreen onOpenSettings={vi.fn()} />);

    await emitDrop({ type: "drop", paths: ["/code/dropped", "/code/second"] });

    await waitFor(() => expect(sessions.startSessionIn).toHaveBeenCalledWith("/code/dropped", null));
    expect(sessions.addProject).toHaveBeenCalledTimes(1);
  });

  it("refuses a dropped file without attaching anything", async () => {
    sessions.addProject.mockRejectedValue("Not a directory: /code/notes.txt");
    render(<StartScreen onOpenSettings={vi.fn()} />);

    await emitDrop({ type: "drop", paths: ["/code/notes.txt"] });

    expect((await screen.findByRole("alert")).textContent).toBe("Drop a folder to open it as a project.");
    expect(sessions.startSessionIn).not.toHaveBeenCalled();
  });

  it("says so when no agent is installed, with the install action and a re-check", () => {
    store.harnesses = [{ ...claude, available: false }, codex];
    const onOpenSettings = vi.fn();
    render(<StartScreen onOpenSettings={onOpenSettings} />);

    const notice = screen.getByTestId("start-no-agent");
    expect(notice.textContent).toContain("No agent is installed");
    fireEvent.click(screen.getByRole("button", { name: /Get Codex/ }));
    expect(openUrl).toHaveBeenCalledWith("https://example.com/codex");
    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));
    expect(sessions.refreshHarnesses).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Agent settings" }));
    expect(onOpenSettings).toHaveBeenCalledWith("agents");
  });

  it("claims nothing about agents before the probe has answered", () => {
    store.harnesses = [];
    render(<StartScreen onOpenSettings={vi.fn()} />);
    expect(screen.queryByTestId("start-no-agent")).toBeNull();
  });

  it("offers sign-in only while signed out, beside Settings and the docs", () => {
    const onOpenSettings = vi.fn();
    const { unmount } = render(<StartScreen onOpenSettings={onOpenSettings} />);

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(signIn).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledWith();
    fireEvent.click(screen.getByRole("button", { name: /Read the docs/ }));
    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining("github.com"));

    unmount();
    account.status = { state: "signed-in" };
    render(<StartScreen onOpenSettings={onOpenSettings} />);
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });
});
