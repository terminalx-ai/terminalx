import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSwitchLogEntry, AgentAccount, AgentAccounts, AutoSwitchSetting } from "@/lib/agentAccounts";

const { invoke, store } = vi.hoisted(() => ({ invoke: vi.fn(), store: { sessions: [] as unknown[] } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/sessions", () => ({ getSessionStore: () => store, refreshHarnesses: vi.fn() }));
import { AgentAutoSwitch, API_KEY_NOTE, clampThreshold, logLine, moved, TERMS_NOTE } from "./AgentAutoSwitch";

const WORK = "1f0c9a7e3b2d4c5a";
const SIDE = "7a6b5c4d3e2f1a0b";

function account(id: string, label: string, kind: AgentAccount["kind"] = "subscription"): AgentAccount {
  return { id, agent: "claude", kind, label, email: null, plan: null, organization: null, local: id === "local", isDefault: id === "local", missing: false, addedAt: null };
}

/** An agent's accounts with automatic switching as the core lists it: unnamed accounts follow, keys unchecked. */
function accounts(setting: Partial<AutoSwitchSetting> = {}, subscriptions = 2): AgentAccounts {
  const all = [account("local", "This Mac's login"), account("api-key", "API key", "apiKey"), account(WORK, "Work"), account(SIDE, "Side")].slice(0, subscriptions + 1);
  const full: AutoSwitchSetting = { enabled: false, threshold: 90, accounts: [], order: "mostRoom", notifySwitch: true, notifyNoneLeft: true, neverProjects: [], ...setting };
  const named = full.accounts.map((pick) => ({ pick, account: all.find((one) => one.id === pick.id)! })).filter(({ account }) => account);
  const listed = [...named.map(({ pick, account }) => ({ id: account.id, label: account.label, kind: account.kind, use: pick.use, signedIn: true })),
    ...all.filter((one) => !named.some(({ account }) => account.id === one.id)).map((one) => ({ id: one.id, label: one.label, kind: one.kind, use: one.kind === "subscription", signedIn: true }))];
  return {
    agent: "claude", accounts: all, defaultAccount: "local", projectDefaults: {},
    autoSwitch: { offered: all.filter((one) => one.kind === "subscription").length >= 2, setting: full, accounts: listed },
  };
}

let saved: AutoSwitchSetting[];
let log: AccountSwitchLogEntry[];

beforeEach(() => {
  saved = [];
  log = [];
  invoke.mockImplementation(async (command: string, args: { setting?: AutoSwitchSetting }) => {
    if (command === "agent_accounts_set_auto_switch") {
      saved.push(args.setting!);
      return accounts(args.setting);
    }
    if (command === "agent_accounts_switch_log") return log;
    throw new Error(`unexpected ${command}`);
  });
});

afterEach(cleanup);

function show(view: AgentAccounts) {
  const onView = vi.fn();
  const result = render(<AgentAutoSwitch harness="claude" agentName="Claude Code" view={view} onView={onView} />);
  return { ...result, onView };
}

describe("Switch accounts automatically (#981)", () => {
  it("appears only with two or more subscription accounts, off by default", () => {
    // This Mac's login and an API key: one subscription.
    show(accounts({}, 1));
    expect(screen.queryByRole("switch", { name: "Switch accounts automatically" })).toBeNull();
    cleanup();
    show(accounts());
    const toggle = screen.getByRole("switch", { name: "Switch accounts automatically" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(TERMS_NOTE)).toBeNull();
    expect(screen.queryByRole("slider", { name: "Threshold" })).toBeNull();
  });

  it("turning it on saves the setting and its list as shown", async () => {
    const { onView } = show(accounts());
    fireEvent.click(screen.getByRole("switch", { name: "Switch accounts automatically" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].enabled).toBe(true);
    expect(saved[0].accounts).toEqual([{ id: "local", use: true }, { id: "api-key", use: false }, { id: WORK, use: true }]);
    await waitFor(() => expect(onView).toHaveBeenCalled());
  });

  it("while on, says the person is responsible for the providers' terms, and marks a key as billed per request", () => {
    show(accounts({ enabled: true }));
    expect(screen.getByTestId("auto-switch-terms").textContent).toBe(TERMS_NOTE);
    const list = screen.getByRole("list", { name: "Accounts to use" });
    const key = within(list).getAllByRole("listitem").find((row) => row.textContent?.includes("API key"))!;
    expect(key.textContent).toContain(API_KEY_NOTE);
    expect((within(key).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("keeps the threshold between 50% and 100%", async () => {
    expect([clampThreshold(10), clampThreshold(49.6), clampThreshold(73.2), clampThreshold(140), clampThreshold(Number.NaN)]).toEqual([50, 50, 73, 100, 90]);
    show(accounts({ enabled: true }));
    const slider = screen.getByRole("slider", { name: "Threshold" }) as HTMLInputElement;
    expect([slider.min, slider.max, slider.value]).toEqual(["50", "100", "90"]);
    fireEvent.change(slider, { target: { value: "75" } });
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(saved.at(-1)?.threshold).toBe(75));
  });

  it("reorders and unchecks accounts in the list the person sees", async () => {
    show(accounts({ enabled: true }));
    fireEvent.click(screen.getByRole("button", { name: `Move Work up` }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].accounts.map((pick) => pick.id)).toEqual(["local", WORK, "api-key"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Use This Mac's login" }));
    await waitFor(() => expect(saved).toHaveLength(2));
    expect(saved[1].accounts.find((pick) => pick.id === "local")?.use).toBe(false);
    expect(moved(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moved(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
  });

  it("chooses the next account by most room or in the person's order", async () => {
    show(accounts({ enabled: true }));
    const order = screen.getByRole("radiogroup", { name: "When choosing the next account" });
    expect(within(order).getByRole("radio", { name: "Most room left" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(order).getByRole("radio", { name: "In my order" }));
    await waitFor(() => expect(saved.at(-1)?.order).toBe("inOrder"));
  });

  it("shows the switch log for this agent, newest first, with each reason", async () => {
    log = [
      { at: Date.UTC(2026, 10, 16, 9), agent: "claude", sessionId: "s1", tabId: "t1", title: "Fix login", from: "local", fromLabel: "Work", to: SIDE, toLabel: "Personal", outcome: "switched", reason: "Work reached 91% of its 5-hour limit" },
      { at: Date.UTC(2026, 10, 16, 8), agent: "codex", sessionId: "s2", tabId: "t2", from: "local", fromLabel: "Codex", outcome: "noneAvailable", reason: "Codex hit its usage limit" },
      { at: Date.UTC(2026, 10, 15, 8), agent: "claude", sessionId: "s3", tabId: "t3", title: "Docs", from: SIDE, fromLabel: "Personal", outcome: "noneAvailable", reason: "Personal hit its usage limit" },
    ];
    show(accounts({ enabled: true }));
    const list = await screen.findByRole("list", { name: "Switch log" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Switched · Work → Personal");
    expect(rows[0].textContent).toContain("Fix login · Work reached 91% of its 5-hour limit");
    expect(rows[1].textContent).toContain("No account had room · Personal");
    expect(logLine(log[1])).toBe("No account had room · Codex");
  });
});
