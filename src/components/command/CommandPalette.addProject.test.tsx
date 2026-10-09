import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
