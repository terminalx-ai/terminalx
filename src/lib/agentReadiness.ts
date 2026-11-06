import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
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
