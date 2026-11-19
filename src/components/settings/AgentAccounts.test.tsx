import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessInfo, SessionEntry } from "@/types/session";
import type { AgentReadiness } from "@/lib/agentReadiness";
import type { AgentLoginStatus, AgentLoginTab } from "@/lib/agentLogins";
import type { AgentAccount, AgentAccountLoginFinished, AgentAccountLoginStarted } from "@/lib/agentAccounts";

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

const KEY = "sk-ant-api03-Zq9vLwPq3bXbmTkF0aB7cD2eF4gH6iJ8kL0mN2oP4qR6sT8uV0wX2yZ4-4f2a";
const WORK = "1f0c9a7e3b2d4c5a";
const SIDE = "7a6b5c4d3e2f1a0b";

const ready = (id: string, more: Partial<AgentReadiness> = {}): AgentReadiness => ({
  state: "ready", checkedAt: "2026-11-15T10:00:00Z", version: id === "claude" ? "2.3.41" : "0.166.0",
  loginMethod: id === "claude" ? "Claude account" : "ChatGPT account", plan: id === "claude" ? "max" : "pro",
  account: "ada@example.com", organization: null, ...more,
});

interface Stored { id: string; kind: "subscription" | "apiKey"; label?: string; email?: string; plan?: string; organization?: string; missing?: boolean }

/** The backend, as the core's commands answer (src-tauri/src/agent_accounts). */
let logins: Record<string, AgentLoginStatus>;
let added: Record<string, Stored[]>;
let defaults: Record<string, string | undefined>;
let accountReadiness: Record<string, AgentReadiness>;
let running: Record<string, AgentLoginTab[]>;
/** What the next sign-in becomes when the app asks for its end. */
let ending: AgentAccountLoginFinished[];
let started: AgentAccountLoginStarted | null;
let startError: string | null;

function label(stored: Stored, agent: string) {
  if (stored.label) return stored.label;
  if (stored.kind === "apiKey") return "API key";
  if (stored.email && stored.plan) return `${stored.email} · ${stored.plan}`;
  return stored.email ?? (agent === "claude" ? "Claude account" : "ChatGPT account");
}

function view(agent: string) {
  const login = logins[agent];
  const stored = defaults[agent];
  const exists = (id: string | undefined) => !!id && (id === "local" || (id === "api-key" && !!login.saved) || added[agent].some((account) => account.id === id));
  const chosen = exists(stored) ? stored! : login.mode === "api_key" && login.saved ? "api-key" : "local";
  const base = { agent, email: null, plan: null, organization: null, missing: false, addedAt: null };
  const accounts: AgentAccount[] = [{ ...base, id: "local", kind: "subscription", label: "This Mac's login", local: true, isDefault: chosen === "local" } as AgentAccount];
  if (login.saved) accounts.push({ ...base, id: "api-key", kind: "apiKey", label: "API key", local: false, isDefault: chosen === "api-key", addedAt: login.saved.savedAt } as AgentAccount);
  for (const account of added[agent]) {
    accounts.push({ ...base, id: account.id, kind: account.kind, label: label(account, agent), email: account.email ?? null, plan: account.plan ?? null,
      organization: account.organization ?? null, local: false, isDefault: chosen === account.id, missing: !!account.missing, addedAt: "2026-11-15T09:00:00Z" } as AgentAccount);
  }
  return { agent, accounts, defaultAccount: chosen, projectDefaults: {} };
}

function attempt(agent: string, accountId: string, again: boolean): AgentAccountLoginStarted {
  if (startError) throw startError;
  started = agent === "codex"
    ? { attemptId: "att-1", agent: "codex", accountId, again, flow: "deviceCode", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234", expiresInSeconds: 900 }
    : { attemptId: "att-1", agent: "claude", accountId, again, flow: "browser", verificationUrl: "https://claude.ai/oauth/authorize?code=true", expiresInSeconds: 930 };
  return started;
}

function backend(command: string, args: Record<string, unknown> = {}) {
  const harness = args.harness as string;
  const now = new Date().toISOString();
  switch (command) {
    case "check_agent_readiness": return ready(harness);
    case "agent_login_status": return logins[harness];
    case "agent_login_shell_offer": return null;
    case "agent_login_tabs": return running[harness];
    case "agent_login_set_mode":
      logins[harness] = { ...logins[harness], mode: args.mode as AgentLoginStatus["mode"] };
      defaults[harness] = undefined; // follow_mode
      return logins[harness];
    case "agent_accounts_list": return view(harness);
    case "agent_accounts_readiness": return accountReadiness[args.accountId as string] ?? { state: "unknown", checkedAt: null, version: null };
    case "agent_accounts_add_start": return attempt(harness, "9e8d7c6b5a4f3e2d", false);
    case "agent_accounts_sign_in_again": return attempt(harness, args.accountId as string, true);
    case "agent_accounts_add_finish": {
      const end = ending.shift() ?? { status: "waiting" };
      if (end.status === "added") added[started!.agent].push({ id: end.account.id, kind: "subscription", email: end.account.email ?? undefined, plan: end.account.plan ?? undefined });
      return end;
    }
    case "agent_accounts_add_cancel": return null;
    case "agent_accounts_open_page": return null;
    case "agent_accounts_add_key": {
      added[harness].push({ id: "0a1b2c3d4e5f6a7b", kind: "apiKey", label: (args.label as string | null) ?? undefined });
      return view(harness);
    }
    case "agent_accounts_relabel": {
      const account = added[harness].find((candidate) => candidate.id === args.accountId)!;
      account.label = (args.label as string).trim() || undefined;
      return view(harness);
    }
    case "agent_accounts_set_default": {
      defaults[harness] = args.accountId as string;
      const id = args.accountId as string;
      if (id === "api-key") logins[harness] = { ...logins[harness], mode: "api_key" };
      else if (logins[harness].mode === "api_key") logins[harness] = { ...logins[harness], mode: "subscription" };
      running[harness] = running[harness].map((tab) => ({ ...tab, current: tab.account === id }));
      return view(harness);
    }
    case "agent_accounts_remove": {
      const id = args.accountId as string;
      const tabs = running[harness].filter((tab) => tab.account === id);
      if (tabs.length && !args.confirmed) return { removed: false, runningTabs: tabs, accounts: view(harness) };
      added[harness] = added[harness].filter((account) => account.id !== id);
      if (defaults[harness] === id) defaults[harness] = undefined;
      return { removed: true, runningTabs: tabs, accounts: view(harness) };
    }
    // PRO-157: each tab's Executable and settings file rows.
    case "agent_executable": return { harness: args.harness, chosen: null, path: `/opt/homebrew/bin/${args.harness}`, system: `/opt/homebrew/bin/${args.harness}`, version: "1.0.0", problem: null };
    case "agent_config_file": return { path: "/Users/ada/.claude/settings.json", displayPath: "~/.claude/settings.json", exists: true };
    default: void now; throw new Error(`unexpected command ${command}`);
  }
}

const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);
const list = () => screen.getByRole("list", { name: /accounts$/ });
const account = (name: string) => within(list()).getByRole("listitem", { name });
const toast = (title: string) => screen.getByRole("status", { name: title });

function show(harnesses: HarnessInfo[] = [claude, codex]) {
  return render(<>
    <AgentsPanel harnesses={harnesses} checkRun={0} busy={false} onRecheck={() => {}} />
    <AgentLoginToasts />
  </>);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAgentSetupFlows();
  forgetAgentLoginNotices();
  logins = {
    claude: { harness: "claude", variable: "ANTHROPIC_API_KEY", mode: "default" },
    codex: { harness: "codex", variable: "OPENAI_API_KEY", mode: "default", config: "~/.codex/config.toml" },
  };
  added = { claude: [], codex: [] };
  defaults = {};
  accountReadiness = {};
  running = { claude: [], codex: [] };
  ending = [];
  started = null;
  startError = null;
  store.sessions = [
    { id: "s1", title: "Fix the login race", tabs: [{ id: "t1", harness: "claude" }] },
    { id: "s2", title: "Release notes", tabs: [{ id: "t2", harness: "claude", title: "Reviewer" }, { id: "t3", harness: "claude", title: "Author" }] },
  ] as unknown as SessionEntry[];
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => backend(command, args));
  listen.mockResolvedValue(() => {});
});
afterEach(() => { cleanup(); invoke.mockReset(); });

function twoAccounts() {
  added.claude = [
    { id: WORK, kind: "subscription", email: "ada@work.example", plan: "team", organization: "Acme" },
    { id: SIDE, kind: "subscription", email: "ada@side.example", plan: "pro" },
  ];
  accountReadiness[WORK] = ready("claude", { account: "ada@work.example", plan: "team" });
  accountReadiness[SIDE] = { state: "signed_out", checkedAt: "2026-11-15T10:00:00Z", version: "2.3.41" };
}

describe("Agents · Add account (#980)", () => {
  it("signs a second Claude Code account in with the agent's own login and lists it", async () => {
    ending = [{ status: "waiting" }, { status: "added", account: { id: "9e8d7c6b5a4f3e2d", agent: "claude", kind: "subscription", label: "ada@side.example · pro", email: "ada@side.example", plan: "pro", organization: null, local: false, isDefault: false, missing: false, addedAt: null } }];
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    const region = screen.getByRole("region", { name: "Add a Claude Code account" });
    expect(within(region).getByText(/A Claude Console sign-in without an API key cannot be a second account/)).toBeTruthy();
    expect(within(region).getByText(/not their OAuth sign-ins/)).toBeTruthy();
    fireEvent.click(within(region).getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(calls("agent_accounts_add_start")).toEqual([{ harness: "claude" }]));
    await waitFor(() => expect(toast("Added ada@side.example · pro")).toBeTruthy(), { timeout: 3000 });
    expect(calls("agent_accounts_add_finish")).toEqual([{ attemptId: "att-1" }, { attemptId: "att-1" }]);
    expect(screen.queryByRole("region", { name: "Add a Claude Code account" })).toBeNull();
    await waitFor(() => expect(account("ada@side.example · pro")).toBeTruthy());
    expect(account("This Mac's login").textContent).toContain("Default");
    expect(within(account("ada@side.example · pro")).getByRole("button", { name: "Sign in again to ada@side.example · pro" })).toBeTruthy();
    expect(within(account("This Mac's login")).queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(within(account("This Mac's login")).queryByRole("button", { name: /Rename/ })).toBeNull();
    expect(screen.getByText(/The default is what new tabs use/).textContent).toContain("not their OAuth sign-ins");
  });

  it("shows Codex's device code while it signs in, and opens the page through the app", async () => {
    ending = [{ status: "waiting" }];
    show([codex]);
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    const region = screen.getByRole("region", { name: "Add a Codex account" });
    expect(within(region).queryByText(/Claude Console/)).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: "Sign in" }));
    const progress = await screen.findByRole("status", { name: "Signing in to Codex" });
    await waitFor(() => expect(within(progress).getByLabelText("Sign-in code").textContent).toBe("ABCD-1234"));
    expect(progress.textContent).toContain("Enter this code at auth.openai.com");
    fireEvent.click(within(progress).getByRole("button", { name: "Open the page" }));
    await waitFor(() => expect(calls("agent_accounts_open_page")).toEqual([{ attemptId: "att-1" }]));
    expect(openUrl).not.toHaveBeenCalled();
    fireEvent.click(within(progress).getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(calls("agent_accounts_add_cancel")).toEqual([{ attemptId: "att-1" }]));
  });

  it("says which listed account a duplicate sign-in is, and keeps nothing", async () => {
    twoAccounts();
    ending = [{ status: "duplicate", accountId: WORK, label: "ada@work.example · team" }];
    show();
    await screen.findByRole("listitem", { name: "ada@work.example · team" });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    fireEvent.click(within(screen.getByRole("region", { name: "Add a Claude Code account" })).getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That account is already listed as ada@work.example · team. The new sign-in was signed out and not kept.");
    expect(within(list()).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("region", { name: "Add a Claude Code account" })).toBeTruthy();
  });

  it("shows the agent's own error when its sign-in fails, or does not start", async () => {
    ending = [{ status: "failed", message: "Your organization requires you to sign in with the Acme organization (forceLoginOrgUUID)." }];
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    const region = screen.getByRole("region", { name: "Add a Claude Code account" });
    fireEvent.click(within(region).getByRole("button", { name: "Sign in" }));
    expect((await within(region).findByRole("alert")).textContent).toBe("Your organization requires you to sign in with the Acme organization (forceLoginOrgUUID).");
    expect(screen.queryByRole("list", { name: /accounts$/ })).toBeNull();

    startError = "Claude Code is not installed on this Mac. Install it in Settings → Agents first.";
    fireEvent.click(within(region).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(within(region).getByRole("alert").textContent).toBe("Claude Code is not installed on this Mac. Install it in Settings → Agents first."));
    expect(calls("agent_accounts_add_start")).toHaveLength(2);
  });

  it("cancels a sign-in under way, and says nothing went wrong", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    const region = screen.getByRole("region", { name: "Add a Claude Code account" });
    fireEvent.click(within(region).getByRole("button", { name: "Sign in" }));
    const progress = await screen.findByRole("status", { name: "Signing in to Claude Code" });
    await waitFor(() => expect(progress.textContent).toContain("Finish signing in to Claude Code in your browser."));
    fireEvent.click(within(progress).getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(calls("agent_accounts_add_cancel")).toEqual([{ attemptId: "att-1" }]));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Signing in to Claude Code" })).toBeNull());
    expect(within(region).queryByRole("alert")).toBeNull();
    expect(within(region).getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("adds a second API key as an account of its own, with a label", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    const region = screen.getByRole("region", { name: "Add a Claude Code account" });
    fireEvent.click(within(region).getByRole("radio", { name: /API key/ }));
    const field = within(region).getByLabelText("Anthropic API key") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: KEY } });
    fireEvent.change(within(region).getByLabelText("Label (optional)"), { target: { value: "Work key" } });
    fireEvent.click(within(region).getByRole("button", { name: "Add key" }));
    await waitFor(() => expect(toast("Added Work key")).toBeTruthy());
    expect(calls("agent_accounts_add_key")).toEqual([{ harness: "claude", key: KEY, label: "Work key" }]);
    expect(account("Work key").textContent).toContain("API key");
    expect(document.body.textContent).not.toContain(KEY.slice(13, -4));
  });
});

describe("Agents · several accounts (#980)", () => {
  it("lists each account with its kind, address, plan and own login state", async () => {
    twoAccounts();
    show();
    await waitFor(() => expect(account("ada@work.example · team").textContent).toContain("ada@work.example · Team · Acme · Signed in"));
    expect(account("ada@work.example · team").textContent).toContain("Subscription");
    expect(account("ada@side.example · pro").textContent).toContain("ada@side.example · Pro · Sign in required");
    expect(account("This Mac's login").textContent).toContain("ada@example.com · Max · Signed in");
    expect(calls("agent_accounts_readiness")).toEqual(expect.arrayContaining([{ harness: "claude", accountId: WORK }, { harness: "claude", accountId: SIDE }]));
    expect(calls("agent_accounts_readiness").some((args) => (args as { accountId: string }).accountId === "local")).toBe(false);
  });

  it("offers Sign in again on an account whose folder was deleted outside the app", async () => {
    twoAccounts();
    added.claude[1].missing = true;
    show();
    await waitFor(() => expect(account("ada@side.example · pro").textContent).toContain("Its folder is gone · sign in again"));
    expect(within(account("ada@side.example · pro")).getByRole("button", { name: /Make .* the default/ }).hasAttribute("disabled")).toBe(true);
  });

  it("signs in again on that one account only", async () => {
    twoAccounts();
    show();
    const side = await screen.findByRole("listitem", { name: "ada@side.example · pro" });
    ending = [{ status: "waiting" }, { status: "signedInAgain", account: { ...view("claude").accounts[2] } }];
    accountReadiness[SIDE] = ready("claude", { account: "ada@side.example", plan: "pro" });
    fireEvent.click(within(side).getByRole("button", { name: "Sign in again to ada@side.example · pro" }));
    // The app asks once a second until the CLI has ended.
    expect(await within(side).findByText("ada@side.example · pro is signed in again.", {}, { timeout: 3000 })).toBeTruthy();
    expect(calls("agent_accounts_sign_in_again")).toEqual([{ harness: "claude", accountId: SIDE }]);
    expect(calls("agent_accounts_add_start")).toHaveLength(0);
    await waitFor(() => expect(account("ada@side.example · pro").textContent).toContain("Signed in"));
    // The other account was not touched, and shows no sign-in.
    expect(within(account("ada@work.example · team")).queryByRole("status", { name: "Signing in to Claude Code" })).toBeNull();
    expect(within(account("ada@work.example · team")).queryByText(/signed in again/)).toBeNull();
  });

  it("relabels an account inline, and keeps the old label on Escape", async () => {
    twoAccounts();
    show();
    const work = await screen.findByRole("listitem", { name: "ada@work.example · team" });
    fireEvent.click(within(work).getByRole("button", { name: "Rename ada@work.example · team" }));
    const field = within(work).getByLabelText("Label for ada@work.example · team");
    fireEvent.change(field, { target: { value: "Throwaway" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(calls("agent_accounts_relabel")).toHaveLength(0);

    fireEvent.click(within(work).getByRole("button", { name: "Rename ada@work.example · team" }));
    fireEvent.change(within(work).getByLabelText("Label for ada@work.example · team"), { target: { value: "Work" } });
    fireEvent.keyDown(within(work).getByLabelText("Label for ada@work.example · team"), { key: "Enter" });
    await waitFor(() => expect(account("Work")).toBeTruthy());
    expect(calls("agent_accounts_relabel")).toEqual([{ harness: "claude", accountId: WORK, label: "Work" }]);
  });

  it("says why a label was refused", async () => {
    twoAccounts();
    show();
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "agent_accounts_relabel") throw "Keep the label to 60 characters.";
      return backend(command, args);
    });
    const work = await screen.findByRole("listitem", { name: "ada@work.example · team" });
    fireEvent.click(within(work).getByRole("button", { name: "Rename ada@work.example · team" }));
    fireEvent.click(within(work).getByRole("button", { name: "Save" }));
    // Unchanged: nothing is sent.
    expect(calls("agent_accounts_relabel")).toHaveLength(0);
    fireEvent.click(within(work).getByRole("button", { name: "Rename ada@work.example · team" }));
    fireEvent.change(within(work).getByLabelText("Label for ada@work.example · team"), { target: { value: "x".repeat(61) } });
    fireEvent.click(within(work).getByRole("button", { name: "Save" }));
    expect((await within(work).findByRole("alert")).textContent).toBe("Keep the label to 60 characters.");
  });

  it("makes an account the default, offers to restart the tabs on the old one, and the key choice above follows", async () => {
    twoAccounts();
    running.claude = [{ sessionId: "s1", tabId: "t1", current: true, account: "local" }];
    show();
    const work = await screen.findByRole("listitem", { name: "ada@work.example · team" });
    expect(screen.getByRole("radio", { name: /Claude subscription/, checked: true })).toBeTruthy();
    fireEvent.click(within(work).getByRole("button", { name: "Make ada@work.example · team the default" }));
    await waitFor(() => expect(toast("New Claude Code tabs use ada@work.example · team")).toBeTruthy());
    expect(calls("agent_accounts_set_default")).toEqual([{ harness: "claude", accountId: WORK, projectId: null }]);
    expect(toast("New Claude Code tabs use ada@work.example · team").textContent).toContain("1 running tab keeps its current login until you restart it.");
    expect(account("ada@work.example · team").textContent).toContain("Default");
    expect(account("This Mac's login").textContent).not.toContain("Default");
    // An added account is the default: neither the subscription nor the key card is chosen.
    await waitFor(() => expect(screen.getByRole("radio", { name: /Claude subscription/ }).getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByRole("radio", { name: /API key/ }).getAttribute("aria-checked")).toBe("false");

    // Choosing the subscription above makes This Mac's login the default again.
    fireEvent.click(screen.getByRole("radio", { name: /Claude subscription/ }));
    await waitFor(() => expect(account("This Mac's login").textContent).toContain("Default"));
    expect(calls("agent_login_set_mode")).toEqual([{ harness: "claude", mode: "subscription" }]);
  });

  it("names the running tabs on an account before removing it, and removes only once confirmed", async () => {
    twoAccounts();
    running.claude = [
      { sessionId: "s1", tabId: "t1", current: true, account: WORK },
      { sessionId: "s2", tabId: "t3", current: true, account: WORK },
      { sessionId: "s2", tabId: "t2", current: true, account: "local" },
    ];
    show();
    const work = await screen.findByRole("listitem", { name: "ada@work.example · team" });
    fireEvent.click(within(work).getByRole("button", { name: "Remove ada@work.example · team" }));
    const confirm = await within(work).findByRole("group", { name: "Remove ada@work.example · team?" });
    expect(confirm.textContent).toContain("Claude Code signs it out first, then its folder is deleted.");
    expect(confirm.textContent).toContain("2 running tabs use it");
    expect(within(confirm).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Fix the login race", "Release notes · Author"]);
    expect(calls("agent_accounts_remove")).toHaveLength(0);

    fireEvent.click(within(confirm).getByRole("button", { name: "Keep it" }));
    expect(within(work).queryByRole("group")).toBeNull();
    expect(calls("agent_accounts_remove")).toHaveLength(0);

    fireEvent.click(within(work).getByRole("button", { name: "Remove ada@work.example · team" }));
    fireEvent.click(within(await within(work).findByRole("group")).getByRole("button", { name: "Remove account" }));
    await waitFor(() => expect(toast("Removed ada@work.example · team")).toBeTruthy());
    expect(calls("agent_accounts_remove")).toEqual([{ harness: "claude", accountId: WORK, confirmed: true }]);
    expect(within(list()).queryByRole("listitem", { name: "ada@work.example · team" })).toBeNull();
  });

  it("shows tabs that started on the account after the question, instead of removing it", async () => {
    twoAccounts();
    show();
    const side = await screen.findByRole("listitem", { name: "ada@side.example · pro" });
    fireEvent.click(within(side).getByRole("button", { name: "Remove ada@side.example · pro" }));
    const confirm = await within(side).findByRole("group");
    expect(confirm.textContent).toContain("No running tab uses it.");
    running.claude = [{ sessionId: "s1", tabId: "t1", current: true, account: SIDE }];
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove account" }));
    await waitFor(() => expect(within(side).getByRole("group").textContent).toContain("1 running tab uses it"));
    expect(calls("agent_accounts_remove")).toEqual([{ harness: "claude", accountId: SIDE, confirmed: false }]);
    expect(account("ada@side.example · pro")).toBeTruthy();
    fireEvent.click(within(within(side).getByRole("group")).getByRole("button", { name: "Remove account" }));
    await waitFor(() => expect(calls("agent_accounts_remove")[1]).toEqual({ harness: "claude", accountId: SIDE, confirmed: true }));
    await waitFor(() => expect(within(list()).queryByRole("listitem", { name: "ada@side.example · pro" })).toBeNull());
  });

  it("goes back to today's panel once the last added account is removed", async () => {
    added.codex = [{ id: SIDE, kind: "subscription", email: "ada@side.example", plan: "plus" }];
    show([codex]);
    const side = await screen.findByRole("listitem", { name: "ada@side.example · plus" });
    expect(screen.queryByText(/not their OAuth sign-ins/)).toBeNull();
    fireEvent.click(within(side).getByRole("button", { name: "Remove ada@side.example · plus" }));
    fireEvent.click(within(await within(side).findByRole("group")).getByRole("button", { name: "Remove account" }));
    await waitFor(() => expect(screen.queryByRole("list", { name: /accounts$/ })).toBeNull());
    expect(screen.getByRole("button", { name: "Add account" })).toBeTruthy();
  });
});
