import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessInfo, SessionEntry } from "@/types/session";
import type { AgentReadiness } from "@/lib/agentReadiness";
import type { AgentLoginStatus, AgentLoginTab, ShellKeyOffer } from "@/lib/agentLogins";

const { invoke, listen, refreshHarnesses, startTabAgent, openUrl, store } = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(), refreshHarnesses: vi.fn(async () => {}), startTabAgent: vi.fn(async () => true), openUrl: vi.fn(),
  store: { sessions: [] as SessionEntry[] },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@/lib/sessions", () => ({ refreshHarnesses, getSessionStore: () => store }));
vi.mock("@/lib/tabViews", () => ({ startTabAgent }));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: ({ id }: { id: string }) => <div data-testid="terminal-view" data-pane={id} /> }));
import { AgentsPanel } from "./AgentsPanel";
import { AgentLoginToasts } from "./AgentLoginToasts";
import { resetAgentSetupFlows } from "@/lib/agentSetupFlow";
import { forgetAgentLoginNotices } from "@/lib/agentLogins";

const caps = { images: true, steer: false, permissionModes: true, effort: true, slashCommands: true, atMentions: true, fork: true, resume: true };
const claude: HarnessInfo = { id: "claude", name: "Claude Code", binary: "claude", available: true, installable: true, path: "/Users/ada/.local/bin/claude",
  installHint: "curl -fsSL https://claude.ai/install.sh | bash", installUrl: "https://docs.claude.com/claude-code", caps };
const codex: HarnessInfo = { id: "codex", name: "Codex", binary: "codex", available: true, installable: true, path: "/opt/homebrew/bin/codex",
  installHint: "curl -fsSL https://chatgpt.com/codex/install.sh | sh && codex login", installUrl: "https://developers.openai.com/codex/cli", caps };
const opencode: HarnessInfo = { id: "opencode", name: "OpenCode", binary: "opencode", available: false, installHint: "npm i -g opencode-ai", installUrl: "https://opencode.ai", caps };

const KEY = "sk-ant-api03-Zq9vLwPq3bXbmTkF0aB7cD2eF4gH6iJ8kL0mN2oP4qR6sT8uV0wX2yZ4-4f2a";
const MASKED = `sk-ant-api03-${"•".repeat(24)}4f2a`;

const ready = (id: string, more: Partial<AgentReadiness> = {}): AgentReadiness => ({
  state: "ready", checkedAt: "2026-11-11T10:00:00Z", version: id === "claude" ? "2.3.41" : "0.166.0",
  loginMethod: id === "claude" ? "Claude account" : "ChatGPT account", plan: id === "claude" ? "max" : "pro",
  account: "ada@example.com", organization: id === "claude" ? "Procyon Labs" : null, ...more,
});
const signedOut = (id: string): AgentReadiness => ({ state: "signed_out", checkedAt: "2026-11-11T10:00:00Z", version: id === "claude" ? "2.3.41" : "0.166.0" });

/** The backend, as the commands see it. */
let readiness: Record<string, AgentReadiness>;
let logins: Record<string, AgentLoginStatus>;
let offers: Record<string, ShellKeyOffer | null>;
let running: Record<string, AgentLoginTab[]>;
let verification: { ok: boolean; reason?: string };
let saved: { harness: string; key: string }[];

function backend(command: string, args: Record<string, unknown> = {}) {
  const harness = args.harness as string;
  const now = new Date().toISOString();
  switch (command) {
    case "check_agent_readiness": return readiness[harness] ?? { state: "missing", checkedAt: now, version: null };
    case "agent_login_status": return logins[harness];
    case "agent_login_shell_offer": return offers[harness] ?? null;
    case "agent_login_save_key":
      saved.push({ harness, key: args.key as string });
      logins[harness] = { ...logins[harness], mode: "api_key", saved: { masked: harness === "claude" ? MASKED : `sk-proj-${"•".repeat(24)}9Qx1`, savedAt: now }, verified: undefined };
      running[harness] = running[harness].map((tab) => ({ ...tab, current: false }));
      return logins[harness];
    case "agent_login_verify": {
      const verified = { ...verification, checkedAt: now };
      logins[harness] = { ...logins[harness], verified };
      return verified;
    }
    case "agent_login_remove_key":
      logins[harness] = { ...logins[harness], mode: "subscription", saved: undefined, verified: undefined };
      running[harness] = running[harness].map((tab) => ({ ...tab, current: false }));
      return logins[harness];
    case "agent_login_set_mode":
      logins[harness] = { ...logins[harness], mode: args.mode as AgentLoginStatus["mode"] };
      return logins[harness];
    case "agent_login_import_shell":
      logins[harness] = { ...logins[harness], mode: "api_key", saved: { masked: `sk-proj-${"•".repeat(24)}9Qx1`, savedAt: now, fromShell: { file: offers[harness]?.file } } };
      offers[harness] = null;
      running[harness] = running[harness].map((tab) => ({ ...tab, current: false }));
      return logins[harness];
    case "agent_login_dismiss_shell":
      offers[harness] = null;
      return null;
    case "agent_login_set_base_url":
      logins[harness] = { ...logins[harness], baseUrl: (args.baseUrl as string | null)?.replace(/\/$/, "") ?? undefined };
      return logins[harness];
    case "agent_login_tabs": return running[harness];
    case "stop_tab": return null;
    default: throw new Error(`unexpected command ${command}`);
  }
}

const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);

function show(harnesses: HarnessInfo[] = [claude, codex]) {
  return render(<>
    <AgentsPanel harnesses={harnesses} checkRun={0} busy={false} onRecheck={() => {}} />
    <AgentLoginToasts />
  </>);
}

const statusLine = () => screen.getAllByRole("status").find((node) => node.closest("[role=tabpanel]") && !node.closest("section"))!;
const row = (label: string) => within(screen.getByRole("tabpanel")).getByText(label, { selector: "dt" }).nextElementSibling!.textContent;
const toast = (title: string) => screen.getByRole("status", { name: title });

beforeEach(() => {
  vi.clearAllMocks();
  resetAgentSetupFlows();
  forgetAgentLoginNotices();
  readiness = { claude: ready("claude"), codex: ready("codex") };
  logins = {
    claude: { harness: "claude", variable: "ANTHROPIC_API_KEY", mode: "default" },
    codex: { harness: "codex", variable: "OPENAI_API_KEY", mode: "default", config: "~/.codex/config.toml" },
  };
  offers = {};
  running = {
    claude: [{ sessionId: "s1", tabId: "t1", current: true }, { sessionId: "s2", tabId: "t2", current: true }],
    codex: [{ sessionId: "s3", tabId: "t3", current: true }],
  };
  verification = { ok: true };
  saved = [];
  store.sessions = [
    { id: "s1", tabs: [{ id: "t1", harness: "claude" }] },
    { id: "s2", tabs: [{ id: "t2", harness: "claude" }] },
    { id: "s3", tabs: [{ id: "t3", harness: "codex" }] },
  ] as unknown as SessionEntry[];
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => backend(command, args));
  listen.mockResolvedValue(() => {});
});
afterEach(() => { cleanup(); invoke.mockReset(); vi.useRealTimers(); });

describe("Agents · API key (PRO-306)", () => {
  it("shows which login each agent uses", async () => {
    show();
    await waitFor(() => expect(statusLine().textContent).toBe("Signed in"));
    expect(screen.getByRole("tab", { name: "Claude Code: Signed in", selected: true })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Claude subscription/, checked: true })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /API key\s*ANTHROPIC_API_KEY/, checked: false })).toBeTruthy();
    expect(row("Version")).toBe("2.3.41");
    expect(row("Login")).toBe("Claude Max · ada@example.com");
    expect(row("Organization")).toBe("Procyon Labs");
    expect(row("Executable")).toBe("~/.local/bin/claude");

    fireEvent.click(screen.getByRole("tab", { name: /Codex/ }));
    expect(await screen.findByRole("radio", { name: /ChatGPT\s*ada@example.com · Pro/, checked: true })).toBeTruthy();
    await waitFor(() => expect(row("Config")).toBe("~/.codex/config.toml"));
    expect(row("Executable")).toBe("/opt/homebrew/bin/codex");
  });

  it("saves a key to the Keychain, shows it masked, and restarts exactly the agent's running tabs", async () => {
    show();
    fireEvent.click(await screen.findByRole("radio", { name: /API key/ }));
    expect(screen.getByText("Kept in the Keychain. TerminalX passes it to Claude Code when a tab starts, in place of ANTHROPIC_API_KEY.")).toBeTruthy();
    const field = screen.getByLabelText("Anthropic API key") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(toast("API key saved to the Keychain")).toBeTruthy());
    expect(saved).toEqual([{ harness: "claude", key: KEY }]);
    expect(toast("API key saved to the Keychain").textContent).toContain("New Claude Code tabs use it. 2 running tabs keep their current login until you restart them.");
    expect(screen.getByLabelText("Saved Anthropic API key").textContent).toBe(MASKED);
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    // The key itself is nowhere on the page once saved.
    expect(document.body.textContent).not.toContain(KEY.slice(13, -4));
    expect(screen.queryByLabelText("Anthropic API key")).toBeNull();

    await waitFor(() => expect(statusLine().textContent).toBe("Using an API key · verified just now"));
    expect(calls("agent_login_verify")).toEqual([{ harness: "claude" }]);
    expect(row("Login")).toBe("API key · ANTHROPIC_API_KEY · Keychain");
    expect(screen.queryByText("Organization", { selector: "dt" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Claude Code: Using an API key" })).toBeTruthy();

    // A Codex tab, a tab already on the new key: neither is restarted.
    running.claude.push({ sessionId: "s1", tabId: "t9", current: true });
    fireEvent.click(within(toast("API key saved to the Keychain")).getByRole("button", { name: "Restart 2 tabs" }));
    await waitFor(() => expect(screen.queryByRole("status", { name: "API key saved to the Keychain" })).toBeNull());
    expect(calls("stop_tab")).toEqual([{ sessionId: "s1", tabId: "t1" }, { sessionId: "s2", tabId: "t2" }]);
    expect(startTabAgent.mock.calls.map((call) => (call as unknown as [SessionEntry, { id: string }])[1].id)).toEqual(["t1", "t2"]);
  });

  it("says nothing about restarts when no tab of the agent is running", async () => {
    running.claude = [];
    show();
    fireEvent.click(await screen.findByRole("radio", { name: /API key/ }));
    fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: KEY } });
    fireEvent.keyDown(screen.getByLabelText("Anthropic API key"), { key: "Enter" });
    await waitFor(() => expect(toast("API key saved to the Keychain").textContent).toContain("New Claude Code tabs use it."));
    expect(toast("API key saved to the Keychain").textContent).not.toContain("running");
    expect(within(toast("API key saved to the Keychain")).queryByRole("button", { name: /Restart/ })).toBeNull();
  });

  it("removes the key from the Keychain and goes back to the subscription login", async () => {
    logins.claude = { ...logins.claude, mode: "api_key", saved: { masked: MASKED, savedAt: "2026-11-11T09:00:00Z" }, verified: { ok: true, checkedAt: new Date().toISOString() } };
    show();
    await waitFor(() => expect(statusLine().textContent).toBe("Using an API key · verified just now"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const title = "API key removed · Claude Code uses your Claude login again";
    await waitFor(() => expect(toast(title)).toBeTruthy());
    expect(calls("agent_login_remove_key")).toEqual([{ harness: "claude" }]);
    expect(toast(title).textContent).toContain("Deleted from the Keychain. New tabs sign in with Claude Max (ada@example.com).");
    expect(within(toast(title)).getByRole("button", { name: "Restart 2 tabs" })).toBeTruthy();
    expect(statusLine().textContent).toBe("Signed in");
    expect(screen.getByRole("radio", { name: /Claude subscription/, checked: true })).toBeTruthy();
    expect(row("Login")).toBe("Claude Max · ada@example.com");
    expect(screen.queryByLabelText("Saved Anthropic API key")).toBeNull();
  });

  it("goes back to sign-in required when there is no subscription login to return to", async () => {
    readiness.claude = signedOut("claude");
    logins.claude = { ...logins.claude, mode: "api_key", saved: { masked: MASKED, savedAt: "2026-11-11T09:00:00Z" } };
    running.claude = [];
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    const title = "API key removed · Claude Code needs a sign-in";
    await waitFor(() => expect(toast(title)).toBeTruthy());
    expect(toast(title).textContent).toContain("Deleted from the Keychain. Sign in to Claude Code below to start new tabs.");
    await waitFor(() => expect(statusLine().textContent).toBe("Sign in required"));
    expect(row("Login")).toBe("None · sign in required");
    expect(screen.getByRole("button", { name: "Sign in to Claude Code" })).toBeTruthy();
  });

  it("reports a key the provider refuses as not verified, with the reason", async () => {
    verification = { ok: false, reason: "api.anthropic.com refused this key (HTTP 401). Check it was copied whole, or make a new one" };
    show();
    fireEvent.click(await screen.findByRole("radio", { name: /API key/ }));
    fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(statusLine().textContent).toBe("Using an API key · not verified: api.anthropic.com refused this key (HTTP 401). Check it was copied whole, or make a new one"));
    expect(screen.getByRole("tab", { name: "Claude Code: Using an API key" }).querySelector(".text-add")).toBeNull();
    // Refresh asks the provider again.
    verification = { ok: true };
    fireEvent.click(within(statusLine().parentElement!).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(statusLine().textContent).toBe("Using an API key · verified just now"));
    expect(calls("agent_login_verify")).toHaveLength(2);
  });

  it("offers the login shell's key once, imports it on request and names the file it came from", async () => {
    offers.codex = { variable: "OPENAI_API_KEY", file: "~/.zshrc" };
    show([codex]);
    const offer = await screen.findByText(/in your login shell/);
    expect(offer.textContent).toBe("Found OPENAI_API_KEY in your login shell (~/.zshrc). Copy it to the Keychain so new tabs use it without that file?");
    expect(calls("agent_login_import_shell")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Import to the Keychain" }));

    const title = "Imported OPENAI_API_KEY from your shell environment";
    await waitFor(() => expect(toast(title)).toBeTruthy());
    expect(toast(title).textContent).toContain("Codex uses it in new tabs. Switch back to ChatGPT any time. 1 running tab keeps its current login until you restart it.");
    expect(screen.getByRole("radio", { name: /API key/, checked: true })).toBeTruthy();
    expect(screen.getByText("From your shell")).toBeTruthy();
    expect(screen.getByText(/A copy is now in the Keychain/).textContent).toBe("Found in your login shell (~/.zshrc). A copy is now in the Keychain, so it works without that file.");
    expect(screen.queryByRole("button", { name: "Import to the Keychain" })).toBeNull();
    await waitFor(() => expect(screen.getByLabelText("Verified")).toBeTruthy());
  });

  it("does not ask again once the offer is declined", async () => {
    offers.claude = { variable: "ANTHROPIC_API_KEY" };
    show();
    expect((await screen.findByText(/in your login shell/)).textContent).toBe("Found ANTHROPIC_API_KEY in your login shell. Copy it to the Keychain so new tabs use it without that file?");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByText(/in your login shell/)).toBeNull());
    expect(calls("agent_login_dismiss_shell")).toEqual([{ harness: "claude" }]);
    expect(calls("agent_login_import_shell")).toHaveLength(0);
  });

  it("points Codex's key at a custom OpenAI-compatible provider", async () => {
    logins.codex = { ...logins.codex, mode: "api_key", saved: { masked: `sk-proj-${"•".repeat(24)}9Qx1`, savedAt: "2026-11-11T09:00:00Z" } };
    show([codex]);
    const custom = await screen.findByRole("button", { name: /Custom provider\s*Any OpenAI-compatible endpoint, set with OPENAI_BASE_URL/ });
    fireEvent.click(custom);
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://llm.example.com/v1/" } });
    fireEvent.click(within(custom.parentElement!).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Custom provider\s*https:\/\/llm.example.com\/v1/ })).toBeTruthy());
    expect(calls("agent_login_set_base_url")).toEqual([{ harness: "codex", baseUrl: "https://llm.example.com/v1/" }]);
    expect(calls("agent_login_verify")).toEqual([{ harness: "codex" }]);
    fireEvent.click(screen.getByRole("button", { name: "Use OpenAI" }));
    await waitFor(() => expect(calls("agent_login_set_base_url")).toHaveLength(2));
    expect(calls("agent_login_set_base_url")[1]).toEqual({ harness: "codex", baseUrl: null });
  });

  it("switches between a saved key and the subscription without forgetting the key", async () => {
    logins.claude = { ...logins.claude, mode: "api_key", saved: { masked: MASKED, savedAt: "2026-11-11T09:00:00Z" } };
    show();
    fireEvent.click(await screen.findByRole("radio", { name: /Claude subscription/ }));
    await waitFor(() => expect(statusLine().textContent).toBe("Signed in"));
    expect(calls("agent_login_set_mode")).toEqual([{ harness: "claude", mode: "subscription" }]);
    expect(calls("agent_login_remove_key")).toHaveLength(0);
    fireEvent.click(screen.getByRole("radio", { name: /API key/ }));
    await waitFor(() => expect(screen.getByLabelText("Saved Anthropic API key").textContent).toBe(MASKED));
    expect(calls("agent_login_set_mode")[1]).toEqual({ harness: "claude", mode: "api_key" });
  });

  it("never sends a key that was only typed, and says why a save failed", async () => {
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "agent_login_save_key") throw "Could not save the key to the Keychain. Nothing changed.";
      return backend(command, args);
    });
    show();
    fireEvent.click(await screen.findByRole("radio", { name: /API key/ }));
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "Show the key" }));
    expect((screen.getByLabelText("Anthropic API key") as HTMLInputElement).type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not save the key to the Keychain. Nothing changed.");
    expect(screen.queryByRole("status", { name: "API key saved to the Keychain" })).toBeNull();
    expect(calls("agent_login_tabs")).toHaveLength(0);
  });
});

describe("Agents · tabs keep their badge and body together (PRO-170)", () => {
  const answer = (state: AgentReadiness["state"]): AgentReadiness => ({ state, checkedAt: "2026-11-05T16:00:00Z", version: state === "missing" ? null : "0.166.0" });

  it("follows one probe through missing → installed → ready", async () => {
    readiness.codex = answer("missing");
    show([{ ...codex, available: false, path: undefined }]);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Codex: Not installed" })).toBeTruthy());
    expect(statusLine().textContent).toBe("Not installed");
    expect(screen.getByRole("button", { name: "Install Codex and sign in" })).toBeTruthy();

    readiness.codex = answer("signed_out");
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Codex: Sign in required" })).toBeTruthy());
    expect(statusLine().textContent).toBe("Sign in required");
    expect(screen.queryByRole("button", { name: "Install Codex and sign in" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in to Codex" })).toBeTruthy();

    readiness.codex = answer("ready");
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Codex: Signed in" })).toBeTruthy());
    expect(statusLine().textContent).toBe("Signed in");
    expect(screen.queryByRole("button", { name: "Sign in to Codex" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Codex setup" })).toBeNull();
  });

  it("checks again on Refresh, re-reading the installed agents", async () => {
    show([claude]);
    await waitFor(() => expect(statusLine().textContent).toBe("Signed in"));
    readiness.claude = answer("missing");
    fireEvent.click(within(statusLine().parentElement!).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(statusLine().textContent).toBe("Not installed"));
    expect(refreshHarnesses).toHaveBeenCalledOnce();
    expect(screen.getByRole("tab", { name: "Claude Code: Not installed" })).toBeTruthy();
  });

  it("shows agents without a key choice with their status and setup only", async () => {
    show([claude, opencode]);
    fireEvent.click(await screen.findByRole("tab", { name: /OpenCode/ }));
    await waitFor(() => expect(statusLine().textContent).toBe("Not installed"));
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("region", { name: "OpenCode setup" })).toBeTruthy();
    expect(calls("agent_login_status").every((args) => (args as { harness: string }).harness !== "opencode")).toBe(true);
  });
});
