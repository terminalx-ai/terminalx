import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { invoke, open } = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/api", () => ({ invoke, errorMessage: (e: unknown) => String(e) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ projects: [{ name: "App", path: "/repo", kind: "git" }, { name: "Remote", path: "cloud:org:repo", kind: "git" }] }) }));
import { EnvironmentSettings } from "./EnvironmentSettings";
let values: Record<string, Record<string, string>>;
beforeEach(() => {
  values = { user: { API_KEY: "private-value" }, "/repo": { REPO_KEY: "repo-secret" } };
  vi.clearAllMocks();
  invoke.mockImplementation(async (command: string, args: Record<string, any>) => {
    const scope = args.projectPath || "user";
    switch (command) {
      case "environment_list": return [
        ...(scope !== "user" ? Object.keys(values.user).map((name) => ({ name, scope: "user", overridden: name in values[scope] })) : []),
        ...Object.keys(values[scope]).map((name) => ({ name, scope: scope === "user" ? "user" : "repository", overridden: false })),
      ];
      case "environment_reveal": return values[scope][args.name];
      case "environment_copy": return;
      case "environment_save":
        if (args.previous) delete values[scope][args.previous];
        for (const { name, value } of args.inputs) values[scope][name] = value;
        return true;
      case "environment_delete": delete values[scope][args.name]; return true;
      case "environment_read_file": return "FROM_FILE=loaded";
      default: throw new Error(`Unexpected command ${command}`);
    }
  });
});
afterEach(cleanup);

async function ready() { render(<EnvironmentSettings />); await screen.findByRole("button", { name: "Reveal API_KEY" }); }

describe("environment settings", () => {
  it("lists names without fetching secrets, reveals on demand, copies and deletes", async () => {
    await ready();
    expect(screen.queryByText("private-value")).toBeNull();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["environment_list"]);
    fireEvent.click(screen.getByRole("button", { name: "Reveal API_KEY" }));
    await screen.findByText("private-value");
    fireEvent.click(screen.getByRole("button", { name: "Hide API_KEY" }));
    expect(screen.queryByText("private-value")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy API_KEY" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("environment_copy", { projectPath: null, name: "API_KEY" }));
    expect(invoke.mock.calls.filter(([command]) => command === "environment_reveal")).toHaveLength(1);
    await waitFor(() => expect((screen.getByRole("button", { name: "Delete API_KEY" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Delete API_KEY" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reveal API_KEY" })).toBeNull());
    expect(screen.getByRole("status").textContent).toContain("Restart to apply");
  });
  it("validates the Add sheet and saves a masked value; Edit can rename", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "API_KEY" } });
    expect(dialog.getByRole("alert").textContent).toContain("already exists");
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "TERMINALX_NEXT_TOKEN" } });
    expect(dialog.getByRole("alert").textContent).toContain("reserved");
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "NEW_KEY" } });
    fireEvent.change(dialog.getByLabelText("Value"), { target: { value: "new-secret" } });
    expect(dialog.getByLabelText("Value").getAttribute("type")).toBe("password");
    fireEvent.click(dialog.getByRole("button", { name: "Save variable" }));
    await screen.findByRole("button", { name: "Edit NEW_KEY" });
    expect(screen.queryByText("new-secret")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit NEW_KEY" }));
    const edit = within(await screen.findByRole("dialog"));
    expect((edit.getByLabelText("Value") as HTMLInputElement).value).toBe("new-secret");
    fireEvent.change(edit.getByLabelText("Name"), { target: { value: "RENAMED_KEY" } });
    fireEvent.click(edit.getByRole("button", { name: "Save variable" }));
    await screen.findByRole("button", { name: "Edit RENAMED_KEY" });
    expect(values.user.NEW_KEY).toBeUndefined();
    expect(values.user.RENAMED_KEY).toBe("new-secret");
  });
  it("imports ten valid rows and reports bad line numbers", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Paste variables" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Variables"), { target: { value: Array.from({ length: 10 }, (_, i) => `KEY_${i}=secret${i}`).join("\n") + "\nbad=sensitive\nKEY_0=again" } });
    expect(dialog.getByRole("alert").textContent).toContain("Line 11:");
    expect(dialog.getByRole("alert").textContent).toContain("Line 12:");
    expect(dialog.getByRole("alert").textContent).not.toContain("sensitive");
    fireEvent.click(dialog.getByRole("button", { name: "Import 10 valid variables" }));
    await screen.findByRole("button", { name: "Reveal KEY_9" });
    expect(screen.getAllByRole("row")).toHaveLength(12);
  });
  it("selects repository scope, lists inheritance and loads a file for review", async () => {
    await ready();
    expect(screen.queryByRole("option", { name: /Remote/ })).toBeNull();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "/repo" } });
    await screen.findByRole("button", { name: "Reveal REPO_KEY" });
    expect(screen.queryByRole("button", { name: "Edit API_KEY" })).toBeNull();
    open.mockResolvedValue("/repo/.env");
    fireEvent.click(screen.getByRole("button", { name: "Load from .env file" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(invoke).toHaveBeenCalledWith("environment_read_file", { projectPath: "/repo", path: "/repo/.env" });
    expect(values["/repo"].FROM_FILE).toBeUndefined();
    fireEvent.click(dialog.getByRole("button", { name: "Import 1 valid variables" }));
    await screen.findByRole("button", { name: "Reveal FROM_FILE" });
    expect(values["/repo"].FROM_FILE).toBe("loaded");
    expect(values.user.FROM_FILE).toBeUndefined();
  });
  it("keeps the sheet open and reports failed writes", async () => {
    await ready();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command, args) => command === "environment_save" ? Promise.reject("Keychain unavailable") : original(command, args));
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "KEY" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save variable" }));
    await waitFor(() => expect(dialog.getByRole("alert").textContent).toBe("Keychain unavailable"));
    expect(values.user.KEY).toBeUndefined();
  });
  it("waits for the runtime revision before reporting a save as ready", async () => {
    await ready();
    const original = invoke.getMockImplementation()!;
    let finish!: (ready: boolean) => void;
    invoke.mockImplementation(async (command, args) => {
      const result = await original(command, args);
      return command === "environment_save" ? new Promise<boolean>((resolve) => { finish = resolve; }) : result;
    });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "KEY" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save variable" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect((dialog.getByRole("button", { name: "Save variable" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
    finish(true);
    await screen.findByRole("button", { name: "Reveal KEY" });
    expect(screen.getByRole("status").textContent).toContain("Restart to apply");
  });
  it("distinguishes a successful save from an unavailable runtime cache", async () => {
    await ready();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, args) => {
      const result = await original(command, args);
      return command === "environment_delete" ? false : result;
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete API_KEY" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reveal API_KEY" })).toBeNull());
    expect(screen.getByRole("status").textContent).toContain("Saved, but environment overrides are not ready");
  });
});
