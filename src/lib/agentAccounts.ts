import { invoke } from "@tauri-apps/api/core";
import type { AgentReadiness } from "@/lib/agentReadiness";
import type { UsageWindow } from "@/lib/api";

/**
 * Agent accounts (#980, docs/AGENT-ACCOUNTS.md): several Claude Code and
 * Codex logins, chosen per session. Every agent always has This Mac's login
 * (`local`); a saved API key is an account of kind `apiKey`; added
 * subscriptions each sign in with the agent's own login into a directory of
 * their own. Nothing here ever carries a token: ids, labels, kinds,
 * addresses and plans only, and a Codex device code while its dialog is open.
 *
 * The Rust side is `src-tauri/src/agent_accounts/`.
 */

/** This Mac's own login, for every agent. */
export const LOCAL_ACCOUNT = "local";
/** The PRO-306 saved key, while one is saved. */
export const SAVED_KEY_ACCOUNT = "api-key";

export type AgentAccountAgent = "claude" | "codex";
export type AgentAccountKind = "subscription" | "apiKey";

export interface AgentAccount {
  id: string;
  agent: AgentAccountAgent;
  kind: AgentAccountKind;
  /** The person's own label, or "email · plan". */
  label: string;
  email: string | null;
  plan: string | null;
  organization: string | null;
  /** This Mac's login: it cannot be removed or relabelled. */
  local: boolean;
  /** The agent's default account. */
  isDefault: boolean;
  /** Its directory was deleted outside the app: offer "Sign in again". */
  missing: boolean;
  addedAt: string | null;
}

/** An agent's accounts, its default and its project defaults (local only). */
export interface AgentAccounts {
  agent: AgentAccountAgent;
  accounts: AgentAccount[];
  defaultAccount: string;
  /** Project id → account id. */
  projectDefaults: Record<string, string>;
}

/** A sign-in that has begun: the browser (Claude Code) or a device code (Codex). */
export interface AgentAccountLoginStarted {
  attemptId: string;
  agent: AgentAccountAgent;
  accountId: string;
  /** Signing a listed account in again. */
  again: boolean;
  flow: "browser" | "deviceCode";
  /** The page to finish at, when the CLI gave one. */
  verificationUrl?: string;
  /** What to type at the page (Codex). Shown in the dialog only. */
  userCode?: string;
  expiresInSeconds: number;
}

/** How a sign-in ended, or that it has not yet. */
export type AgentAccountLoginFinished =
  | { status: "waiting" }
  | { status: "added"; account: AgentAccount }
  | { status: "signedInAgain"; account: AgentAccount }
  /** That account is already listed: the new sign-in was signed out and not kept. */
  | { status: "duplicate"; accountId: string; label: string }
  | { status: "expired" }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

export interface AgentAccountRunningTab {
  sessionId: string;
  tabId: string;
  current: boolean;
  account?: string;
}

/** What removing an account did: with tabs running on it and no confirmation, nothing. */
export interface AgentAccountRemoval {
  removed: boolean;
  runningTabs: AgentAccountRunningTab[];
  accounts: AgentAccounts;
}

/**
 * One account's usage windows (the usage piece fills it). `unavailable` with
 * no `error`: the account has none to show, as an `apiKey` account.
 */
export interface AgentAccountUsage {
  accountId: string;
  label: string;
  windows: UsageWindow[];
  error: string | null;
  unavailable: boolean;
}

export const agentAccounts = {
  list: (harness: string) => invoke<AgentAccounts>("agent_accounts_list", { harness }),
  addStart: (harness: string) => invoke<AgentAccountLoginStarted>("agent_accounts_add_start", { harness }),
  addFinish: (attemptId: string) => invoke<AgentAccountLoginFinished>("agent_accounts_add_finish", { attemptId }),
  addCancel: (attemptId: string) => invoke<void>("agent_accounts_add_cancel", { attemptId }),
  openPage: (attemptId: string) => invoke<void>("agent_accounts_open_page", { attemptId }),
  addKey: (harness: string, key: string, label: string | null = null) => invoke<AgentAccounts>("agent_accounts_add_key", { harness, key, label }),
  relabel: (harness: string, accountId: string, label: string) => invoke<AgentAccounts>("agent_accounts_relabel", { harness, accountId, label }),
  signInAgain: (harness: string, accountId: string) => invoke<AgentAccountLoginStarted>("agent_accounts_sign_in_again", { harness, accountId }),
  remove: (harness: string, accountId: string, confirmed = false) => invoke<AgentAccountRemoval>("agent_accounts_remove", { harness, accountId, confirmed }),
  /** The agent's default, or with `projectId` that project's; `null` with a project follows the agent's. */
  setDefault: (harness: string, accountId: string | null, projectId: string | null = null) =>
    invoke<AgentAccounts>("agent_accounts_set_default", { harness, accountId, projectId }),
  readiness: (harness: string, accountId: string) => invoke<AgentReadiness>("agent_accounts_readiness", { harness, accountId }),
};

/** The agents this version keeps several accounts for. */
export const ACCOUNT_AGENTS: readonly AgentAccountAgent[] = ["claude", "codex"];

export function takesAccounts(harness: string): harness is AgentAccountAgent {
  return (ACCOUNT_AGENTS as readonly string[]).includes(harness);
}

/** Pickers and the tab's account mark appear only when the agent has more than one account. */
export function showsAccounts(view: AgentAccounts | null | undefined): boolean {
  return (view?.accounts.length ?? 0) > 1;
}

function listed(view: AgentAccounts, id: string | null | undefined): id is string {
  return !!id && view.accounts.some((account) => account.id === id);
}

/**
 * The account a launch runs on, as the runtime resolves it: the one asked
 * for, else the project's default, else the agent's, each only while listed.
 */
export function resolveAccount(view: AgentAccounts, choice: { accountId?: string | null; projectId?: string | null } = {}): AgentAccount {
  const project = choice.projectId ? view.projectDefaults[choice.projectId] : undefined;
  const id = [choice.accountId, project, view.defaultAccount].find((candidate) => listed(view, candidate)) ?? LOCAL_ACCOUNT;
  return view.accounts.find((account) => account.id === id) ?? view.accounts[0];
}

/** The label of account `id`, or nothing when it is not listed (removed meanwhile). */
export function accountLabel(view: AgentAccounts | null | undefined, id: string | null | undefined): string | null {
  return view?.accounts.find((account) => account.id === id)?.label ?? null;
}

/**
 * Ask until sign-in `attemptId` has ended. Stops (and cancels the sign-in)
 * when `signal` aborts; resolves with what the sign-in became.
 */
export async function waitForSignIn(attemptId: string, options: { intervalMs?: number; signal?: AbortSignal } = {}): Promise<AgentAccountLoginFinished> {
  const intervalMs = options.intervalMs ?? 1000;
  for (;;) {
    if (options.signal?.aborted) {
      await agentAccounts.addCancel(attemptId);
      return { status: "cancelled" };
    }
    const finished = await agentAccounts.addFinish(attemptId);
    if (finished.status !== "waiting") return finished;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      options.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
