import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { invoke, openDialog } = vi.hoisted(() => ({ invoke: vi.fn(), openDialog: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));
vi.mock("@/lib/sessions", () => ({ addProject: vi.fn(), startSessionIn: vi.fn() }));
vi.mock("@/lib/prefs", () => ({ setPrefs: vi.fn() }));

const { ProjectTemplatesSettings } = await import("./ProjectTemplatesSettings");

const BUILT_IN = [
  { id: "empty", name: "Empty", description: "A README, a .gitignore and nothing else", builtIn: true },
  { id: "vite-react", name: "Vite + React", description: "TypeScript, Tailwind and Vitest", builtIn: true },
  { id: "agent-starter", name: "Agent starter", description: "CLAUDE.md, AGENTS.md, setup and test scripts", builtIn: true },
];
let own: Record<string, unknown>[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  own = [];
  invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
    if (command === "project_templates") return [...BUILT_IN, ...own];
    if (command === "project_template_add") {
      if (args.path === "/") throw { code: "invalid-template", message: "/ holds too much to be a template. Choose the folder of one project." };
      const added = { id: `user:${own.length + 1}`, name: args.path.split("/").pop(), description: args.path, path: args.path, builtIn: false };
      own.push(added);
      return added;
    }
    if (command === "project_template_remove") {
      own = own.filter((template) => template.id !== args.id);
      return undefined;
    }
    throw new Error(`unexpected command ${command}`);
  });
});

afterEach(cleanup);

it("lists the built-in templates and adds a folder as the reader's own", async () => {
  render(<ProjectTemplatesSettings />);
  const builtIn = await screen.findByRole("list", { name: "Built-in templates" });
  expect(within(builtIn).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
    "EmptyA README, a .gitignore and nothing else",
    "Vite + ReactTypeScript, Tailwind and Vitest",
    "Agent starterCLAUDE.md, AGENTS.md, setup and test scripts",
  ]);
  expect(screen.getByText("None yet. Add a folder to start new projects with its files.")).toBeTruthy();

  openDialog.mockResolvedValue("/home/me/templates/house-style");
  fireEvent.click(screen.getByRole("button", { name: "Add a template from a folder…" }));

  const mine = await screen.findByRole("list", { name: "Your templates" });
  expect(invoke).toHaveBeenCalledWith("project_template_add", { path: "/home/me/templates/house-style" });
  expect(within(mine).getByText("house-style")).toBeTruthy();
  expect(within(mine).getByText("/home/me/templates/house-style")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("house-style is now a template in Create a project.");
});

it("removes a template without touching its folder, and says why a folder was refused", async () => {
  own = [
    { id: "user:1", name: "house-style", description: "/t/house-style", path: "/t/house-style", builtIn: false },
    { id: "user:2", name: "old", description: "/t/old", path: "/t/old", builtIn: false, problem: "/t/old is no longer there." },
  ];
  render(<ProjectTemplatesSettings />);
  const mine = await screen.findByRole("list", { name: "Your templates" });
  expect(within(mine).getByText("/t/old is no longer there.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Remove old" }));
  await waitFor(() => expect(within(screen.getByRole("list", { name: "Your templates" })).queryByText("old")).toBeNull());
  expect(invoke).toHaveBeenCalledWith("project_template_remove", { id: "user:2" });
  expect(screen.getByRole("status").textContent).toBe("old was removed from the templates. Its folder was not changed.");

  openDialog.mockResolvedValue("/");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Add a template from a folder…" }));
  });
  expect((await screen.findByRole("alert")).textContent).toContain("holds too much to be a template");
});

it("adds nothing when the folder picker is closed", async () => {
  render(<ProjectTemplatesSettings />);
  await screen.findByRole("list", { name: "Built-in templates" });
  openDialog.mockResolvedValue(null);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Add a template from a folder…" }));
  });
  expect(invoke).not.toHaveBeenCalledWith("project_template_add", expect.anything());
});
