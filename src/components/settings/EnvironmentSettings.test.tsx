import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { invoke, open } = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/api", () => ({ invoke, errorMessage: (e: unknown) => String(e) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ projects: [{ name: "App", path: "/repo", kind: "git" }, { name: "Remote", path: "cloud:org:repo", kind: "git" }] }) }));
import { EnvironmentSettings } from "./EnvironmentSettings";
let values: Record<string, Record<string, string>>;
let plain: Set<string>;
beforeEach(() => {
  values = { user: { API_KEY: "private-value" }, "/repo": { REPO_KEY: "repo-secret" } };
  plain = new Set();
  vi.clearAllMocks();
  invoke.mockImplementation(async (command: string, args: Record<string, any>) => {
    const scope = args.projectPath || "user";
    switch (command) {
      case "environment_list": {
        const row = (s: string, name: string, overridden: boolean) => plain.has(`${s}:${name}`) ? { name, scope: s === "user" ? "user" : "repository", overridden, secret: false, value: values[s][name] } : { name, scope: s === "user" ? "user" : "repository", overridden };
        return [
          ...(scope !== "user" ? Object.keys(values.user).map((name) => row("user", name, name in values[scope])) : []),
          ...Object.keys(values[scope]).map((name) => row(scope, name, false)),
        ];
      }
      case "environment_reveal": return values[scope][args.name];
      case "environment_copy": return;
      case "environment_save":
        if (args.previous) delete values[scope][args.previous];
        for (const { name, value, secret } of args.inputs) { values[scope][name] = value; if (secret === false) plain.add(`${scope}:${name}`); else plain.delete(`${scope}:${name}`); }
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
  it("an edit keeps a variable where it is stored unless the Keychain switch is changed", async () => {
    // EDITOR does not look like a secret, but it was saved in the Keychain.
    values.user.EDITOR = "vim";
    await ready();
    const lastSave = () => invoke.mock.calls.filter(([command]) => command === "environment_save").at(-1)![1].inputs;
    fireEvent.click(screen.getByRole("button", { name: "Edit EDITOR" }));
    let edit = within(await screen.findByRole("dialog"));
    expect(edit.getByText(/kept in the Keychain/)).toBeTruthy();
    fireEvent.change(edit.getByLabelText("Value"), { target: { value: "nano" } });
    fireEvent.click(edit.getByRole("button", { name: "Save variable" }));
    await waitFor(() => expect(lastSave()).toEqual([{ name: "EDITOR", value: "nano", secret: true }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Turning the switch off on the sheet does move it out of the Keychain.
    fireEvent.click(screen.getByRole("button", { name: "Edit EDITOR" }));
    edit = within(await screen.findByRole("dialog"));
    fireEvent.click(edit.getByLabelText("Keep values that look like secrets in the Keychain"));
    expect(edit.getByText(/stored in TerminalX's settings/)).toBeTruthy();
    fireEvent.click(edit.getByRole("button", { name: "Save variable" }));
    await waitFor(() => expect(lastSave()).toEqual([{ name: "EDITOR", value: "nano", secret: false }]));
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
  it("opens a repository's variables below the Personal ones and loads a file for review", async () => {
    await ready();
    expect(screen.queryByRole("option", { name: /Remote/ })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Scope" }), { target: { value: "/repo" } });
    const repository = within(await screen.findByRole("region", { name: "Environment of App" }));
    await repository.findByRole("button", { name: "Reveal REPO_KEY" });
    expect(repository.queryByRole("button", { name: "Edit API_KEY" })).toBeNull();
    open.mockResolvedValue("/repo/.env");
    fireEvent.click(repository.getByRole("button", { name: "Load from .env file" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(invoke).toHaveBeenCalledWith("environment_read_file", { projectPath: "/repo", path: "/repo/.env" });
    expect(values["/repo"].FROM_FILE).toBeUndefined();
    fireEvent.click(dialog.getByRole("button", { name: "Import 1 valid variables" }));
    await repository.findByText("loaded");
    expect(values["/repo"].FROM_FILE).toBe("loaded");
    expect(values.user.FROM_FILE).toBeUndefined();
  });
  it("keeps secret-looking values in the Keychain by default and stores others plainly", async () => {
    await ready();
    expect(screen.getByRole("columnheader", { name: "Applies to" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "All projects" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Paste variables" }));
    let dialog = within(screen.getByRole("dialog"));
    const keychain = dialog.getByRole("switch", { name: "Keep values that look like secrets in the Keychain" });
    expect(keychain.getAttribute("aria-checked")).toBe("true");
    fireEvent.change(dialog.getByLabelText("Variables"), { target: { value: "SENTRY_AUTH_TOKEN=sntrys_eyJpYXQiOjE3\nVITE_RELAY_URL=wss://relay.dev.example\n2FA_SEED=JBSWY3DPEHPK3PXP" } });
    const detected = within(dialog.getByRole("list", { name: "Detected variables" }));
    expect(detected.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["SENTRY_AUTH_TOKENsecret", "VITE_RELAY_URL"]);
    expect(dialog.getByRole("alert").textContent).toContain("Line 3:");
    fireEvent.click(dialog.getByRole("button", { name: "Import 2 valid variables" }));
    await screen.findByText("wss://relay.dev.example");
    const sent = invoke.mock.calls.find(([command]) => command === "environment_save")![1];
    expect(sent.inputs).toEqual([{ name: "SENTRY_AUTH_TOKEN", value: "sntrys_eyJpYXQiOjE3", secret: true }, { name: "VITE_RELAY_URL", value: "wss://relay.dev.example", secret: false }]);
    expect(screen.queryByRole("button", { name: "Reveal VITE_RELAY_URL" })).toBeNull();
    expect(screen.queryByText("sntrys_eyJpYXQiOjE3")).toBeNull();
    // Off: this save stores even a secret-looking value plainly.
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("switch", { name: "Keep values that look like secrets in the Keychain" }));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "OTHER_TOKEN" } });
    fireEvent.change(dialog.getByLabelText("Value"), { target: { value: "visible" } });
    expect(dialog.getByText(/stored in TerminalX's settings/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Save variable" }));
    await screen.findByText("visible");
    expect(invoke.mock.calls.filter(([command]) => command === "environment_save").at(-1)![1].inputs).toEqual([{ name: "OTHER_TOKEN", value: "visible", secret: false }]);
    // The next sheet starts with the switch on again.
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    expect(within(screen.getByRole("dialog")).getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });
  it("lists what TerminalX sets itself, including the workspace port block", async () => {
    await ready();
    const own = screen.getByText(/Variables TerminalX sets itself/).closest("details")!;
    expect(own.textContent).toContain("TERMINALX_PORT");
    expect(own.textContent).toContain("TERMINALX_PORTS");
    expect(own.textContent).not.toContain("do not allocate an environment variable");
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
