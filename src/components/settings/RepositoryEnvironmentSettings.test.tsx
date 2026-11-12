import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { invoke, open } = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/api", () => ({ invoke, errorMessage: (e: unknown) => String(e) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ projects: [{ name: "terminalx", path: "/code/terminalx", kind: "git" }] }) }));
import { RepositoryEnvironmentSettings } from "./RepositoryEnvironmentSettings";
import { dismissError, getErrorToasts } from "@/lib/errorToasts";

const rows = [
  { name: "ANTHROPIC_API_KEY", scope: "user", overridden: false },
  { name: "DATABASE_URL", scope: "user", overridden: true, secret: false, value: "postgres://localhost/dev" },
  { name: "NODE_OPTIONS", scope: "user", overridden: false, secret: false, value: "--max-old-space-size=8192" },
  { name: "DATABASE_URL", scope: "repository", overridden: false, secret: false, value: "postgres://localhost/terminalx_dev" },
  { name: "STRIPE_SECRET_KEY", scope: "repository", overridden: false },
  { name: "VITE_RELAY_URL", scope: "repositoryShared", overridden: false, secret: false },
];
beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case "environment_list": return args.projectPath === "/code/terminalx" ? rows : [];
      case "environment_reveal": return "sk_live_hidden";
      case "environment_save": return true;
      case "environment_read_file": return "FROM_FILE=loaded";
      default: throw new Error(`Unexpected command ${command}`);
    }
  });
});
afterEach(() => { cleanup(); for (const toast of getErrorToasts()) dismissError(toast.id); });

const cellsOf = (name: string) => screen.getAllByRole("row").filter((row) => within(row).queryAllByRole("cell")[0]?.textContent?.startsWith(name)).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));

describe("repository environment page", () => {
  it("shows this repository's variables over Personal ones, saying where each comes from", async () => {
    render(<RepositoryEnvironmentSettings projectPath="/code/terminalx" />);
    await screen.findByRole("button", { name: "Reveal STRIPE_SECRET_KEY" });
    expect(screen.getByRole("region", { name: "Environment of terminalx" }).textContent).toContain("These override your personal ones.");
    expect(screen.getByRole("columnheader", { name: "Applies to" })).toBeTruthy();
    expect(cellsOf("DATABASE_URL").map((cells) => cells[2])).toEqual(["from Personal", "overrides Personal"]);
    expect(cellsOf("STRIPE_SECRET_KEY")[0][2]).toBe("This project");
    expect(cellsOf("NODE_OPTIONS")[0].slice(1, 3)).toEqual(["--max-old-space-size=8192", "from Personal"]);
    expect(cellsOf("VITE_RELAY_URL")[0].slice(1, 3)).toEqual(["Set in file", ".terminalx/settings.json"]);
    // Only this repository's own rows are editable; file rows have no actions.
    expect(screen.queryByRole("button", { name: "Edit NODE_OPTIONS" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit STRIPE_SECRET_KEY" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy VITE_RELAY_URL" })).toBeNull();
    expect(screen.queryByText("sk_live_hidden")).toBeNull();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["environment_list"]);
  });

  it("lists documented variables with where each is set", async () => {
    render(<RepositoryEnvironmentSettings projectPath="/code/terminalx" />);
    const list = within(await screen.findByRole("list", { name: "Documented variables" }));
    const status = (name: string) => list.getAllByRole("listitem").find((item) => item.textContent?.startsWith(name))!.textContent!;
    expect(status("ANTHROPIC_API_KEY")).toMatch(/instead of your Claude login.*Set in Personal$/);
    expect(status("OPENAI_API_KEY")).toMatch(/Not set$/);
    expect(status("VITE_RELAY_URL")).toMatch(/settings file\.Set in \.terminalx\/settings\.json$/);
    expect(screen.getByText(/^Documented variables \(13\)$/)).toBeTruthy();
  });

  it("saves to this repository, keeps Load from .env a one-time import, and shows an empty state", async () => {
    render(<RepositoryEnvironmentSettings projectPath="/code/terminalx" />);
    await screen.findByRole("button", { name: "Reveal STRIPE_SECRET_KEY" });
    open.mockResolvedValue("/code/terminalx/.env");
    fireEvent.click(screen.getByRole("button", { name: "Load from .env file" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("Applies to this project. An empty value sets the variable to an empty string.")).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Import 1 valid variables" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("environment_save", { projectPath: "/code/terminalx", inputs: [{ name: "FROM_FILE", value: "loaded", secret: false }], previous: null }));
    expect(invoke.mock.calls.filter(([command]) => command === "environment_read_file")).toHaveLength(1);
    cleanup();
    render(<RepositoryEnvironmentSettings projectPath="/code/other" />);
    expect((await screen.findByText(/No variables set/)).textContent).toContain("agents and terminals in other");
  });

  it("raises an error toast when the list cannot be read", async () => {
    invoke.mockRejectedValue("Choose a local Git repository.");
    render(<RepositoryEnvironmentSettings projectPath="/code/terminalx" />);
    expect((await screen.findByRole("alert")).textContent).toBe("Choose a local Git repository.");
    expect(getErrorToasts().map((toast) => [toast.action, toast.cause])).toEqual([["Couldn't load environment variables", "Choose a local Git repository."]]);
  });
});
