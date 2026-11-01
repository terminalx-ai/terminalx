import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

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
  if (value.state === "missing") return `${harness} is not installed. Follow the setup steps, then check again. Your draft is kept.`;
  if (value.state === "signed_out") return `Sign in to ${harness}, then check again. Your draft is kept and no session has been created.`;
  return null;
}

export function useAgentReadiness(harness: string | null) {
  const [answer, setAnswer] = useState<{ harness: string; value: AgentReadiness } | null>(null);
  const [checking, setChecking] = useState(false);
  const generation = useRef(0);
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
  return { value: answer?.harness === harness ? answer.value : null, checking, refresh };
}
