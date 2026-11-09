import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShortcut } from "@/lib/hotkeys";
import type { Project } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), openDialog: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: mocks.openDialog }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(), openUrl: vi.fn() }));
vi.mock("@/components/layout/AppShell", () => ({ TITLEBAR_INSET: 78 }));

const { CommandPalette } = await import("./CommandPalette");
const store = await import("@/lib/sessions");
const { openProjectStart, useProjectStartDialog } = await import("@/lib/projectStart");

const existing: Project = { path: "/alpha", name: "Alpha" };
const Probe = () => <output data-testid="start-dialog">{useProjectStartDialog() ?? "none"}</output>;

beforeEach(async () => {
  mocks.openDialog.mockReset();
  mocks.invoke.mockReset().mockImplementation(async (command: string, args?: Record<string, string>) => {
    if (command === "list_projects") return { projects: [existing], lastSelected: existing.path };
    if (command === "list_sessions" || command === "list_workspaces" || command === "list_harnesses") return [];
    if (command === "add_project") return { path: args!.path, name: "widgets", kind: "git" } satisfies Project;
    return null;
  });
  // jsdom has neither; the palette scrolls its selection into view.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  await act(async () => {
    await store.refreshEverything();
    store.selectSession(null);
  });
});

afterEach(() => {
  cleanup();
  act(() => openProjectStart(null));
});

async function search(text: string) {
  const onOpenChange = vi.fn();
  render(
    <>
      <CommandPalette open onOpenChange={onOpenChange} onOpenSettings={vi.fn()} onCreated={vi.fn()} />
      <Probe />
    </>,
  );
  fireEvent.change(screen.getByLabelText("Command palette search"), { target: { value: text } });
  await waitFor(() => expect(entry("local")).toBeTruthy());
  return onOpenChange;
}

const entry = (id: "local" | "github" | "quick") => document.getElementById(`command:add-project:${id}`)!;

describe("adding a project from the command palette", () => {
  it("offers the start screen's three ways once a project already exists", async () => {
    await search("add a project");
    expect((["local", "github", "quick"] as const).map((id) => entry(id).textContent)).toEqual([
      expect.stringContaining("Add a project: Open local project"),
      expect.stringContaining("Add a project: Open GitHub project"),
      expect.stringContaining("Add a project: Quick start"),
    ]);
    expect(entry("github").getAttribute("role")).toBe("option");
  });

  it("opens the folder picker and attaches the chosen folder", async () => {
    mocks.openDialog.mockResolvedValue("/code/widgets");
    const onOpenChange = await search("add a project open local");

    fireEvent.click(entry("local"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("add_project", { path: "/code/widgets" }));
    await waitFor(() => expect(store.getSessionStore().newSessionPreset).toEqual({ projectPath: "/code/widgets", cwd: null }));
  });

  it.each([
    ["Open GitHub project", "github" as const],
    ["Quick start", "quick" as const],
  ])("opens the %s dialog", async (_label, dialog) => {
    await search("add a project");

    fireEvent.click(entry(dialog));

    await waitFor(() => expect(screen.getByTestId("start-dialog").textContent).toBe(dialog));
  });
});

describe("Home in the command palette (PRO-183)", () => {
  it("offers Home without a key binding and opens it with Enter", async () => {
    const onOpenChange = vi.fn();
    function Palette() {
      useShortcut("app.home", store.openHome);
      return <CommandPalette open onOpenChange={onOpenChange} onOpenSettings={vi.fn()} onCreated={vi.fn()} />;
    }
    store.openIssues();
    render(<Palette />);
    fireEvent.change(screen.getByLabelText("Command palette search"), { target: { value: "home" } });
    await screen.findByRole("option", { name: /Home/ });

    fireEvent.keyDown(screen.getByLabelText("Command palette search"), { key: "Enter" });

    await waitFor(() => expect(store.getSessionStore().view).toBe("home"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});


describe("setting a session’s manual status from the command palette", () => {
  it("offers a status chooser for the selected session and persists its choice", async () => {
    act(() => {
      store.upsertSession({ id: "s1", title: "Review login", projectPath: "/alpha", cwd: "/alpha", created: "2026-01-01", modified: "2026-01-01", archived: false, pinned: false, worktreeRemoved: false, tabs: [], manualStatus: "in_progress" });
      store.selectSession("s1");
    });
    const changed = vi.fn();
    render(<CommandPalette open onOpenChange={changed} onOpenSettings={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Command palette search"), { target: { value: "Set status" } });
    fireEvent.click(await screen.findByRole("option", { name: /Set status…/ }));
    const review = await screen.findByRole("option", { name: "In review" });
    expect(screen.getAllByRole("option")).toHaveLength(5);
    expect(screen.getByRole("option", { name: /In progress/ }).textContent).toContain("Current status");
    fireEvent.click(review);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("set_session_status", { sessionId: "s1", status: "in_review" }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(false));
  });
});
