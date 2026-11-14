import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { agent } from "@/lib/api";
import { getSessionStore } from "@/lib/sessions";
import { startTabAgent } from "@/lib/tabViews";

/**
 * An agent's sign-in as Settings → Agents sets it (PRO-306): its own
 * subscription login, or an API key kept in the Keychain. The key goes to
 * the app once, when it is saved, and never comes back: what is shown is
 * its masked form.
 */
export type AgentLoginMode = "default" | "subscription" | "api_key";

export interface AgentKeyVerified {
  ok: boolean;
  /** Why it is not verified, in words. */
  reason?: string;
  checkedAt: string;
}

export interface AgentLoginStatus {
  harness: string;
  /** What the key is, and what the provider's own tools read it from. */
  variable: string;
  mode: AgentLoginMode;
  saved?: { masked: string; savedAt: string; fromShell?: { file?: string } };
  /** Codex's custom provider: where the key is sent instead of OpenAI. */
  baseUrl?: string;
  verified?: AgentKeyVerified;
  /** The saved key could not be read back from the Keychain. */
  problem?: string;  /** The agent's own settings file, `~`-relative (Codex's `config.toml`). */
  config?: string;
}

export interface ShellKeyOffer {
  variable: string;
  /** The startup file that sets it, `~`-relative, when one plainly does. */
  file?: string;
}

export interface AgentLoginTab {
  sessionId: string;
  tabId: string;
  /** It started with the login new tabs get now. */
  current: boolean;
}

/** The agents this version lets people give an API key. */
export const API_KEY_AGENTS = ["claude", "codex"] as const;

export function takesApiKey(harness: string): boolean {
  return (API_KEY_AGENTS as readonly string[]).includes(harness);
}

/** Where to make a key, per agent. */
export const KEY_PAGES: Record<string, string> = {
  claude: "https://console.anthropic.com/settings/keys",
  codex: "https://platform.openai.com/api-keys",
};

export const agentLogins = {
  status: (harness: string) => invoke<AgentLoginStatus>("agent_login_status", { harness }),
  saveKey: (harness: string, key: string) => invoke<AgentLoginStatus>("agent_login_save_key", { harness, key }),
  removeKey: (harness: string) => invoke<AgentLoginStatus>("agent_login_remove_key", { harness }),
  setMode: (harness: string, mode: AgentLoginMode) => invoke<AgentLoginStatus>("agent_login_set_mode", { harness, mode }),
  setBaseUrl: (harness: string, baseUrl: string | null) => invoke<AgentLoginStatus>("agent_login_set_base_url", { harness, baseUrl }),
  verify: (harness: string) => invoke<AgentKeyVerified>("agent_login_verify", { harness }),
  shellOffer: (harness: string) => invoke<ShellKeyOffer | null>("agent_login_shell_offer", { harness }),
  importShell: (harness: string) => invoke<AgentLoginStatus>("agent_login_import_shell", { harness }),
  dismissShell: (harness: string) => invoke<void>("agent_login_dismiss_shell", { harness }),
  tabs: (harness: string) => invoke<AgentLoginTab[]>("agent_login_tabs", { harness }),
};

/** The running tabs of `harness` that keep a login older than new tabs get. */
export async function tabsKeepingOlderLogin(harness: string): Promise<AgentLoginTab[]> {
  try {
    return (await agentLogins.tabs(harness)).filter((tab) => !tab.current);
  } catch {
    // No runtime attached: nothing is running to restart.
    return [];
  }
}

/**
 * Restart exactly these tabs' agents, as the tab menu's Restart does: the
 * conversation resumes under the login new tabs get. A tab gone since is
 * skipped. Resolves to how many were restarted.
 */
export async function restartAgentTabs(tabs: readonly AgentLoginTab[]): Promise<number> {
  const store = getSessionStore();
  let restarted = 0;
  await Promise.all(tabs.map(async ({ sessionId, tabId }) => {
    const session = store.sessions.find((candidate) => candidate.id === sessionId);
    const tab = session?.tabs.find((candidate) => candidate.id === tabId);
    if (!session || !tab) return;
    await agent.stop(sessionId, tabId);
    await startTabAgent(session, tab);
    restarted++;
  }));
  return restarted;
}

/** One agent's login settings, and what changes them. */
export function useAgentLogin(harness: string) {
  const [status, setStatus] = useState<AgentLoginStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++run.current;
    try {
      const next = await agentLogins.status(harness);
      if (mine === run.current) { setStatus(next); setError(null); }
      return next;
    } catch (e) {
      if (mine === run.current) setError(String(e));
      return null;
    }
  }, [harness]);
  useEffect(() => {
    void refresh();
    return () => { run.current++; };
  }, [refresh]);
  /** Take an answer from a change, as the latest. */
  const take = useCallback((next: AgentLoginStatus) => {
    run.current++;
    setStatus(next);
    setError(null);
  }, []);
  return { status, error, refresh, take };
}

// ---------------------------------------------------------------- toasts

export interface AgentLoginNotice {
  id: number;
  harness: string;
  kind: "saved" | "removed" | "imported";
  title: string;
  body: string;
  /** The running tabs of the agent that keep their older login. */
  stale: AgentLoginTab[];
}

let notices: AgentLoginNotice[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of [...listeners]) listener(); };

export function showAgentLoginNotice(notice: Omit<AgentLoginNotice, "id">) {
  // One notice per agent: the latest change is the one that is true.
  notices = [...notices.filter((other) => other.harness !== notice.harness), { ...notice, id: nextId++ }];
  emit();
}

export function dismissAgentLoginNotice(id: number) {
  notices = notices.filter((notice) => notice.id !== id);
  emit();
}

export function useAgentLoginNotices(): AgentLoginNotice[] {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => notices, () => notices);
}

/** For tests. */
export function forgetAgentLoginNotices() {
  notices = [];
  emit();
}

/** "2 running tabs keep their current login until you restart them." */
export function keepLine(count: number): string {
  if (count === 0) return "";
  return count === 1
    ? "1 running tab keeps its current login until you restart it."
    : `${count} running tabs keep their current login until you restart them.`;
}
