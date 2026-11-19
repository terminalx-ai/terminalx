import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenCodeCatalogProvider, OpenCodeConnected, OpenCodeOverview } from "@/lib/api";
import type { HarnessInfo } from "@/types/session";

const { invoke, openUrl, refreshModels, showError } = vi.hoisted(() => ({ invoke: vi.fn(), openUrl: vi.fn(), refreshModels: vi.fn(async () => {}), showError: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/models", () => ({ refreshModels }));
vi.mock("@/lib/errorToasts", () => ({ showError }));
vi.mock("@/components/session/AgentSetup", () => ({ AgentSetup: () => <div data-testid="agent-setup" /> }));
import { OpenCodeAgent } from "./OpenCodeAgent";

const caps = { images: true, steer: false, permissionModes: true, effort: false, slashCommands: false, atMentions: false, fork: false, resume: true };
const harness: HarnessInfo = { id: "opencode", name: "OpenCode", binary: "opencode", available: true, path: "/opt/homebrew/bin/opencode", installHint: "", installUrl: "https://opencode.ai", caps };

const provider = (id: string, name: string, more: Partial<OpenCodeCatalogProvider> = {}): OpenCodeCatalogProvider =>
  ({ id, name, env: [`${id.toUpperCase()}_API_KEY`], api: null, doc: null, modelCount: 10, local: false, baseUrl: null, ...more });
const CATALOG = [
  provider("anthropic", "Anthropic", { modelCount: 17 }), provider("openai", "OpenAI"), provider("openrouter", "OpenRouter", { modelCount: 375, api: "https://openrouter.ai/api/v1" }),
  provider("ollama", "Ollama", { env: [], api: "http://localhost:11434/v1", modelCount: 0, local: true }), provider("groq", "Groq"), provider("google", "Google"),
  provider("mistral", "Mistral"), provider("deepseek", "DeepSeek"), provider("xai", "xAI"), provider("togetherai", "Together AI"), provider("fireworks-ai", "Fireworks AI"), provider("zai", "Z.AI"),
];

/** OpenCode's files as `harness::opencode::manage` reads and writes them. */
let connected: OpenCodeConnected[];
let refuse: string | null;
let catalog: OpenCodeCatalogProvider[];
let authProblem: string | null;
const overview = (): OpenCodeOverview => ({
  configPath: "~/.config/opencode/opencode.json", configExists: true, configProblem: null, authPath: "~/.local/share/opencode/auth.json", logDir: "~/.local/share/opencode/log",
  connected,
  models: connected.flatMap((p) => p.models.map((model) => ({ id: `${p.id}/${model}`, provider: p.id, providerName: p.name, model, name: model === "openai/gpt-5" ? "GPT-5" : model }))),
  catalog, catalogProblem: null, authProblem,
});

beforeEach(() => {
  connected = [];
  refuse = null;
  catalog = CATALOG;
  authProblem = null;
  invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "opencode_overview": return overview();
      case "agent_latest_version": return "1.19.6";
      case "agent_executable": return { harness: "opencode", chosen: null, path: harness.path, system: harness.path, version: "1.19.5", problem: null };
      case "agent_config_file": return { path: "/Users/ada/.config/opencode/opencode.json", displayPath: "~/.config/opencode/opencode.json", exists: true };
      case "opencode_connect": {
        if (refuse) throw refuse;
        const entry = CATALOG.find((p) => p.id === args.provider)!;
        connected = [...connected.filter((p) => p.id !== entry.id), { id: entry.id, name: entry.name, auth: "api", maskedKey: "sk-or-••••••••8c1e", baseUrl: null, models: [], unlisted: false, catalogModels: entry.modelCount }];
        return { overview: overview(), check: entry.id === "openrouter" ? { result: "accepted" } : { result: "notChecked", reason: "Groq couldn’t be reached to check the key: offline" } };
      }
      case "opencode_add_model":
        connected = connected.map((p) => p.id === args.provider ? { ...p, models: [...p.models, args.model as string] } : p);
        return overview();
      case "opencode_remove_model":
        connected = connected.map((p) => p.id === args.provider ? { ...p, models: p.models.filter((m) => m !== args.model) } : p);
        return overview();
      case "opencode_disconnect":
        connected = connected.filter((p) => p.id !== args.provider);
        return overview();
      case "opencode_open_logs": return null;
      case "reveal_agent_path": return null;
      case "opencode_catalog_models": return [{ id: "openai/gpt-5", name: "GPT-5" }, { id: "deepseek/deepseek-v4", name: "DeepSeek V4" }];
      default: throw new Error(`unexpected command ${command}`);
    }
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const show = () => render(<OpenCodeAgent harness={harness} readiness={{ state: "unknown", checkedAt: "2026-11-19T10:00:00Z", version: "1.19.5" }} checking={false} recheck={() => {}} />);
const dialog = () => within(screen.getByTestId("configure-providers"));

describe("Agents › OpenCode (PRO-157, designs 10.14–10.16)", () => {
  it("shows the version with its update, the executable, config, and no providers yet", async () => {
    show();
    expect(screen.getByRole("status").textContent).toBe("Installed · 1.19.5");
    expect((await screen.findByTestId("opencode-update")).textContent).toBe("Update available · 1.19.6");
    expect(await screen.findByText("No providers yet")).toBeTruthy();
    expect(screen.getByText("OpenCode can’t start a chat until it has a model provider.")).toBeTruthy();
    expect(screen.getByText("Models in the picker")).toBeTruthy();
    expect(screen.getByText("Only models you add from a provider appear in the composer.")).toBeTruthy();
    expect(screen.getByTestId("opencode-no-models")).toBeTruthy();
    expect(screen.getAllByText("~/.config/opencode/opencode.json").length).toBeGreaterThan(0);
    expect(screen.getByRole("textbox", { name: "OpenCode executable" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "View logs" }));
    await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "opencode_open_logs")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Docs" }));
    expect(openUrl).toHaveBeenCalledWith("https://opencode.ai/docs");
  });

  it("connects a first provider, then adds a model the picker offers", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
    expect(dialog().getByText("Add your first provider")).toBeTruthy();
    expect(dialog().getByText("Or search all 12 providers on the left.")).toBeTruthy();
    expect(dialog().getByRole("button", { name: "View all providers (12)" })).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Add OpenRouter" }));

    const form = within(dialog().getByTestId("connect-provider"));
    expect(form.getByText("Not connected")).toBeTruthy();
    expect(form.getByText("Paste it here; it’s checked with OpenRouter before saving.")).toBeTruthy();
    expect((form.getByRole("button", { name: /Connect OpenRouter/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(form.getByLabelText("OpenRouter API key"), { target: { value: "sk-or-v1-secret" } });
    fireEvent.click(form.getByRole("button", { name: /Connect OpenRouter/ }));
    await waitFor(() => expect(dialog().getByTestId("connected-provider")).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith("opencode_connect", { provider: "openrouter", key: "sk-or-v1-secret", baseUrl: null });

    const detail = within(dialog().getByTestId("connected-provider"));
    expect(detail.getByText("sk-or-••••••••8c1e")).toBeTruthy();
    expect(detail.getByText("Add your first OpenRouter model")).toBeTruthy();
    expect(detail.getByText("0 in the picker")).toBeTruthy();
    fireEvent.change(detail.getByRole("textbox", { name: "Model ID" }), { target: { value: "deepseek/deepseek-v4" } });
    fireEvent.click(detail.getByRole("button", { name: "Add model" }));
    await waitFor(() => expect(detail.getByText("1 in the picker")).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith("opencode_add_model", { provider: "openrouter", model: "deepseek/deepseek-v4" });
    expect(refreshModels).toHaveBeenCalled();

    // Several at once from the catalogue.
    fireEvent.click(detail.getByRole("button", { name: "Or browse the catalogue and pick several at once." }));
    fireEvent.click(await detail.findByRole("checkbox", { name: "GPT-5 (openai/gpt-5)" }));
    await waitFor(() => expect(detail.getByText("2 in the picker")).toBeTruthy());

    fireEvent.click(dialog().getByRole("button", { name: "Done" }));
    const picker = await screen.findByRole("list", { name: "Models in the picker" });
    expect(within(picker).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("openrouter/deepseek/deepseek-v4"), expect.stringContaining("openrouter/openai/gpt-5"),
    ]);
    expect(within(screen.getByTestId("opencode-providers")).getByText("2 models")).toBeTruthy();
    fireEvent.click(within(picker).getByRole("button", { name: "Remove GPT-5" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Models in the picker" })).getAllByRole("listitem")).toHaveLength(1));
  });

  it("shows a refused key and saves nothing", async () => {
    refuse = "Groq didn’t accept this key. Check that it was copied whole and is still active.";
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Configure providers" }));
    fireEvent.click(dialog().getByRole("button", { name: "Groq" }));
    const form = within(dialog().getByTestId("connect-provider"));
    fireEvent.change(form.getByLabelText("Groq API key"), { target: { value: "gsk_bad" } });
    fireEvent.click(form.getByRole("button", { name: /Connect Groq/ }));
    expect((await form.findByRole("alert")).textContent).toBe(refuse);
    expect(connected).toEqual([]);
    expect(dialog().getByText("None yet")).toBeTruthy();
  });

  it("says when a key was saved without a check, and disconnects", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Configure providers" }));
    fireEvent.change(dialog().getByRole("textbox", { name: "Search providers" }), { target: { value: "gro" } });
    expect(dialog().getByText("Matching providers")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Groq" }));
    fireEvent.change(dialog().getByLabelText("Groq API key"), { target: { value: "gsk_key" } });
    fireEvent.keyDown(dialog().getByLabelText("Groq API key"), { key: "Enter", metaKey: true });
    expect((await dialog().findByRole("note")).textContent).toBe("Saved without a check: Groq couldn’t be reached to check the key: offline");
    fireEvent.click(dialog().getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(connected).toEqual([]));
    expect(dialog().getByText("Add your first provider")).toBeTruthy();
  });

  it("lists every provider once asked, Ollama marked local", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Configure providers" }));
    expect(dialog().queryByRole("button", { name: "Z.AI" })).toBeNull();
    expect(within(dialog().getByRole("button", { name: /^Ollama/ })).getByText("local")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "View all providers (12)" }));
    expect(dialog().getByText("All providers · 12")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Z.AI" }));
    expect(dialog().getByText("Models from Z.AI. Connect it, then add the models you want in the picker.")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: /^Ollama/ }));
    const form = within(dialog().getByTestId("connect-provider"));
    expect(form.queryByLabelText("Ollama API key")).toBeNull();
    expect((form.getByLabelText("Base URL") as HTMLInputElement).value).toBe("http://localhost:11434/v1");
  });

  it("reconnects through the gateway the config still has, leaving it as it is", async () => {
    const gateway = "https://gateway.example.internal/openrouter/v1";
    catalog = CATALOG.map((p) => p.id === "openrouter" ? { ...p, baseUrl: gateway } : p);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Configure providers" }));
    fireEvent.click(dialog().getByRole("button", { name: "Add OpenRouter" }));
    const form = within(dialog().getByTestId("connect-provider"));
    expect((form.getByLabelText("Base URL") as HTMLInputElement).value).toBe(gateway);
    fireEvent.change(form.getByLabelText("OpenRouter API key"), { target: { value: "gw-key" } });
    fireEvent.click(form.getByRole("button", { name: /Connect OpenRouter/ }));
    // null: Rust checks the key at, and keeps, the address already saved.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("opencode_connect", { provider: "openrouter", key: "gw-key", baseUrl: null }));
  });

  it("clears a saved gateway only when the field is emptied", async () => {
    catalog = CATALOG.map((p) => p.id === "openrouter" ? { ...p, baseUrl: "https://gateway.example.internal/v1" } : p);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Configure providers" }));
    fireEvent.click(dialog().getByRole("button", { name: "Add OpenRouter" }));
    const form = within(dialog().getByTestId("connect-provider"));
    fireEvent.change(form.getByLabelText("Base URL"), { target: { value: "" } });
    fireEvent.change(form.getByLabelText("OpenRouter API key"), { target: { value: "direct-key" } });
    fireEvent.click(form.getByRole("button", { name: /Connect OpenRouter/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("opencode_connect", { provider: "openrouter", key: "direct-key", baseUrl: "" }));
  });

  it("says why OpenCode's key file is left alone when it can't be read", async () => {
    authProblem = "~/.local/share/opencode/auth.json isn’t valid JSON, so TerminalX won’t change it: saving would drop OpenCode’s other sign-ins. Run `opencode auth list` or fix the file, then try again.";
    show();
    expect((await screen.findByTestId("opencode-auth-problem")).textContent).toBe(authProblem);
  });
});
