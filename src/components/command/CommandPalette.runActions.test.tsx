import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, SessionEntry } from "@/types/session";

// PRO-363: ⌘K lists "Run <name>" for each visible action of the open session's
// project, and "Open <name>" for each of its preview URLs.
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(), openUrl: vi.fn() }));
vi.mock("@/components/layout/AppShell", () => ({ TITLEBAR_INSET: 78 }));

const { CommandPalette } = await import("./CommandPalette");
const store = await import("@/lib/sessions");

const action = (id: string, name: string, hidden = false) => ({ id, name, icon: "play", command: `pnpm ${id}`, runAfterSetup: false, concurrent: false, hidden });
const project: Project = {
  path: "/alpha",
  name: "Alpha",
  actions: [action("dev", "Dev server"), action("secret", "Secret job", true), action("test", "Unit tests")],
  previewUrls: [{ id: "web", name: "Web app", url: "http://localhost:$PORT" }, { id: "api", name: "API docs", url: "http://localhost:$PORT_1/docs" }],
};
const session = { id: "s1", projectPath: "/alpha", cwd: "/alpha", title: "Work", branch: "main", tabs: [], created: "2026-11-13T00:00:00Z", modified: "2026-11-13T00:00:00Z" } as unknown as SessionEntry;

beforeEach(async () => {
  mocks.invoke.mockReset().mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "list_projects") return { projects: [project], lastSelected: project.path };
    if (command === "list_sessions") return [session];
    if (command === "list_workspaces" || command === "list_harnesses") return [];
    if (command === "action_run") return { run: { sessionId: "s1", actionId: args!.actionId, name: "", paneId: `s1:action-1-${String(args!.actionId)}`, state: "running", exitCode: null, started: "", ended: null }, started: true };
    if (command === "workspace_ports") return [4010, 4011, 4012];
    if (command === "browser_open_tab") return { browserPageId: "page-1", url: args!.url, title: "" };
    if (command === "browser_pages") return [];
    return null;
  });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  await act(async () => {
    await store.refreshEverything();
    store.selectSession("s1");
  });
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

function palette(text: string) {
  render(<CommandPalette open onOpenChange={vi.fn()} onOpenSettings={vi.fn()} onCreated={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Command palette search"), { target: { value: text } });
}
const entry = (id: string) => document.getElementById(id);

describe("project actions in the command palette", () => {
  it("lists Run for each visible action and leaves hidden ones out", async () => {
    palette("run");
    await waitFor(() => expect(entry("command:run-action:dev")?.textContent).toContain("Run Dev server"));
    expect(entry("command:run-action:test")?.textContent).toContain("Run Unit tests");
    expect(entry("command:run-action:secret")).toBeNull();
    cleanup();
    palette("secret job");
    await waitFor(() => expect(screen.getByLabelText("Command palette search")).toBeTruthy());
    expect(document.body.textContent).not.toContain("Run Secret job");
  });

  it("lists Open for each preview URL", async () => {
    palette("open");
    await waitFor(() => expect(entry("command:open-preview:web")?.textContent).toContain("Open Web app"));
    expect(entry("command:open-preview:api")?.textContent).toContain("Open API docs");
  });

  it("runs the chosen action in the open session", async () => {
    palette("run unit tests");
    await waitFor(() => expect(entry("command:run-action:test")).toBeTruthy());
    fireEvent.click(entry("command:run-action:test")!);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("action_run", { sessionId: "s1", actionId: "test", restart: false }));
  });

  it("opens the chosen preview URL with the session's ports: $PORT_1 is the second", async () => {
    palette("open api docs");
    await waitFor(() => expect(entry("command:open-preview:api")).toBeTruthy());
    fireEvent.click(entry("command:open-preview:api")!);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("browser_open_tab", { workspace: "/alpha", url: "http://localhost:4011/docs", profile: null }));
  });

  it("offers none of them without an open session", async () => {
    act(() => store.selectSession(null));
    palette("run");
    await waitFor(() => expect(screen.getByLabelText("Command palette search")).toBeTruthy());
    expect(entry("command:run-action:dev")).toBeNull();
    expect(entry("command:open-preview:web")).toBeNull();
  });
});
