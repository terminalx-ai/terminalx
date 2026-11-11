import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type { HarnessInfo } from "@/types/session";
import { onAppResume } from "./appResume";

export interface AgentReadiness {
  state: "missing" | "signed_out" | "ready" | "unknown";
  checkedAt: string | null;
  version: string | null;
  loginMethod?: string | null;
  plan?: string | null;
}

export const READINESS_LABELS: Record<AgentReadiness["state"], string> = {
  missing: "Not installed",
  signed_out: "Installed · sign in required",
  ready: "Ready · local login found",
  unknown: "Login not checked",
};

/** The last answer for each agent from any check in this window, and when it came. */
const known = new Map<string, { value: AgentReadiness; at: number }>();
/** Everything that follows every answer, for any agent. */
const hearing = new Set<(harness: string, value: AgentReadiness) => void>();
function remember(harness: string, value: AgentReadiness) {
  known.set(harness, { value, at: Date.now() });
  for (const hear of [...hearing]) hear(harness, value);
}

/** How long an answer is good enough for a view that only needs a rough idea (the welcome screen). */
export const RECENT_ANSWER_MS = 5 * 60_000;

export async function checkAgentReadiness(harness: string): Promise<AgentReadiness> {
  let value: AgentReadiness = { state: "unknown", checkedAt: null, version: null };
  try {
    const answer = await invoke<AgentReadiness>("check_agent_readiness", { harness });
    if (answer && answer.state in READINESS_LABELS) value = answer;
  } catch {
    // Failure to probe is not evidence of invalid credentials. Never display
    // raw errors from a provider, and never block an existing login on a guess.
  }
  remember(harness, value);
  return value;
}

export function readinessBlock(harness: string, value: AgentReadiness): string | null {
  if (value.state === "missing") return `${harness} is not installed. Install it above, then start again. Your draft is kept.`;
  if (value.state === "signed_out") return `Sign in to ${harness} above, then start again. Your draft is kept and no session has been created.`;
  return null;
}

/** Everything showing an agent's readiness, told of a check made elsewhere. */
const announced = new Set<(harness: string, value: AgentReadiness) => void>();

/**
 * A fresh answer for `harness`, from a check someone else made (the setup
 * flow, after an install or a sign-in): every view of it takes it at once,
 * and a check of its own still under way no longer replaces it.
 */
export function announceReadiness(harness: string, value: AgentReadiness) {
  remember(harness, value);
  for (const take of [...announced]) take(harness, value);
}

/** Hear every announced answer, for any agent, until the returned function is called. */
export function onReadiness(listener: (harness: string, value: AgentReadiness) => void): () => void {
  announced.add(listener);
  return () => { announced.delete(listener); };
}

/**
 * Whether every installed agent is signed out. An answer from the last few
 * minutes is taken as it is; the others are asked for one at a time, and the
 * first agent that is not signed out settles it, so a reader who is set up
 * costs one check at most, and none when anything else checked lately.
 * Every later answer counts too. Not all in yet, or any answer but signed
 * out (ready, or a login that cannot be told), is `false`.
 */
export function useAllSignedOut(harnesses: readonly string[]): boolean {
  const key = harnesses.join(",");
  const [states, setStates] = useState<Record<string, AgentReadiness["state"]>>({});
  useEffect(() => {
    if (!key) return;
    const ids = key.split(",");
    let live = true;
    const take = (id: string, value: AgentReadiness) => {
      if (live && ids.includes(id)) setStates((before) => ({ ...before, [id]: value.state }));
    };
    // Every answer, from any check in this window as well as announced ones.
    hearing.add(take);
    void (async () => {
      for (const id of ids) {
        const recent = known.get(id);
        const value = recent && Date.now() - recent.at < RECENT_ANSWER_MS ? recent.value : await checkAgentReadiness(id);
        if (!live) return;
        take(id, value);
        if (value.state !== "signed_out") return;
      }
    })();
    return () => { live = false; hearing.delete(take); };
  }, [key]);
  return harnesses.length > 0 && harnesses.every((id) => states[id] === "signed_out");
}

/** For tests: forget every answer. */
export function forgetReadiness() {
  known.clear();
}

/** Keep every local setup surface current; only Settings requests periodic checks. */
function useReadinessRefresh(enabled: boolean, refresh: () => Promise<unknown>, poll = false) {
  useEffect(() => {
    if (!enabled) return;
    const recheck = () => { void refresh(); };
    const stopResume = onAppResume(recheck);
    // An embedded login (for example the Codex sign-in shell) exits its PTY
    // when finished. An exit is only a hint: always probe the actual login.
    let disposed = false;
    let stopExit: (() => void) | undefined;
    void listen("pty_exit", () => { if (!disposed) recheck(); }).then((stop) => {
      if (disposed) stop();
      else stopExit = stop;
    }).catch(() => { /* outside a webview */ });
    const timer = poll ? setInterval(() => {
      if (!document.hidden) recheck();
    }, 2 * 60_000) : undefined;
    return () => {
      disposed = true;
      stopResume();
      stopExit?.();
      clearInterval(timer);
    };
  }, [enabled, poll, refresh]);
}

export function useAgentReadiness(harness: string | null, poll = false) {
  const [answer, setAnswer] = useState<{ harness: string; value: AgentReadiness } | null>(null);
  const [checking, setChecking] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    if (!harness) return;
    const take = (id: string, value: AgentReadiness) => {
      if (id !== harness) return;
      generation.current++;
      setAnswer({ harness, value });
      setChecking(false);
    };
    announced.add(take);
    return () => { announced.delete(take); };
  }, [harness]);
  const refresh = useCallback(async () => {
    const run = ++generation.current;
    if (!harness) { setChecking(false); return null; }
    setChecking(true);
    const value = await checkAgentReadiness(harness);
    if (generation.current === run) { setAnswer({ harness, value }); setChecking(false); }
    return value;
  }, [harness]);
  useEffect(() => {
    void refresh();
    return () => { generation.current++; };
  }, [refresh]);
  useReadinessRefresh(!!harness, refresh, poll);
  return { value: answer?.harness === harness ? answer.value : null, checking, refresh };
}

export type AgentReadinessMap = Readonly<Record<string, AgentReadiness>>;

/** Check all candidates before choosing a default, without persisting a fallback as a preference. */
export function useAgentReadinessList(harnesses: readonly Pick<HarnessInfo, "id" | "available" | "path">[], enabled = true) {
  // Discovery can return a fresh array on every render. Only a changed installation needs another check.
  const key = JSON.stringify(enabled ? harnesses.map(({ id, available, path }) => [id, available, path]) : []);
  const [answer, setAnswer] = useState<{ key: string; values: AgentReadinessMap } | null>(null);
  const [checking, setChecking] = useState(false);
  const generation = useRef(0);
  // Answers announced since the latest check began (the setup flow's, after
  // an install or a sign-in): shown at once, and kept over that check's own.
  const heard = useRef<Record<string, AgentReadiness>>({});
  const refresh = useCallback(async () => {
    const run = ++generation.current;
    heard.current = {};
    const candidates: [string, boolean, string | null][] = JSON.parse(key);
    setChecking(true);
    // Installation metadata may predate a CLI installed in another terminal.
    const entries = await Promise.all(candidates.map(async ([id]) => [id, await checkAgentReadiness(id)] as const));
    const values: AgentReadinessMap = { ...Object.fromEntries(entries), ...heard.current };
    if (run === generation.current) {
      setAnswer({ key, values });
      setChecking(false);
    }
    return values;
  }, [key]);
  useEffect(() => {
    void refresh();
    return () => { generation.current++; };
  }, [refresh]);
  useEffect(() => onReadiness((id, value) => {
    const candidates: [string, boolean, string | null][] = JSON.parse(key);
    if (!candidates.some(([candidate]) => candidate === id)) return;
    heard.current = { ...heard.current, [id]: value };
    setAnswer((before) => before?.key === key ? { key, values: { ...before.values, [id]: value } } : before);
  }), [key]);
  useReadinessRefresh(enabled && harnesses.length > 0, refresh);
  return {
    values: answer?.key === key ? answer.values : null,
    checking: checking || answer?.key !== key,
    refresh,
    refreshAgent: async (id: string) => (await refresh())[id] ?? null,
  };
}
