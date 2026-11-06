import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type { HarnessInfo } from "@/types/session";
import { onAppResume } from "./appResume";

export interface AgentReadiness {
  state: "missing" | "signed_out" | "ready" | "unknown";
  checkedAt: string | null;
  version: string | null;
}

export const READINESS_LABELS: Record<AgentReadiness["state"], string> = {
  missing: "Not installed",
  signed_out: "Installed · sign in required",
  ready: "Ready · local login found",
  unknown: "Login not checked",
};

export async function checkAgentReadiness(harness: string): Promise<AgentReadiness> {
  try {
    const value = await invoke<AgentReadiness>("check_agent_readiness", { harness });
    if (value && value.state in READINESS_LABELS) return value;
  } catch {
    // Failure to probe is not evidence of invalid credentials. Never display
    // raw errors from a provider, and never block an existing login on a guess.
  }
  return { state: "unknown", checkedAt: null, version: null };
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
  for (const take of [...announced]) take(harness, value);
}

/** Hear every announced answer, for any agent, until the returned function is called. */
export function onReadiness(listener: (harness: string, value: AgentReadiness) => void): () => void {
  announced.add(listener);
  return () => { announced.delete(listener); };
}

/**
 * Whether every installed agent is signed out, by a check of each when the
 * view mounts, when the app comes back, and on every announced answer. Not
 * all in yet, or any answer but signed out (ready, or a login that cannot
 * be told), is `false`.
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
    const check = () => { for (const id of ids) void checkAgentReadiness(id).then((value) => take(id, value)); };
    check();
    const stopResume = onAppResume(check);
    const stopHearing = onReadiness(take);
    return () => { live = false; stopResume(); stopHearing(); };
  }, [key]);
  return harnesses.length > 0 && harnesses.every((id) => states[id] === "signed_out");
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
  useEffect(() => {
    if (!harness) return;
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
  }, [harness, poll, refresh]);
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
    const entries = await Promise.all(candidates.map(async ([id, installed]) => [id, installed
      ? await checkAgentReadiness(id)
      : { state: "missing", checkedAt: null, version: null } satisfies AgentReadiness] as const));
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
  return {
    values: answer?.key === key ? answer.values : null,
    checking: checking || answer?.key !== key,
    refresh,
    refreshAgent: async (id: string) => (await refresh())[id] ?? null,
  };
}
