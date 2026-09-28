import type { AgentEvent, RecoveryKind } from "@/types/events";

export const RECOVERY_MESSAGES: Record<RecoveryKind, string> = {
  capacity: "The provider is at capacity. Retry or choose another available model.",
  tool: "A tool or command failed. Review its outcome before continuing.",
  timeout: "No progress was confirmed before the timeout. The process outcome is unknown.",
  disconnected: "The connection was lost. The process outcome is unknown.",
  permission_expired: "The permission request expired. Check the terminal for a new request or stop the session.",
  failed: "The agent encountered an error. Review the conversation before continuing.",
};

/** Never echo arbitrary IPC/provider errors in recovery controls. */
export function classifyRecovery(message: string): RecoveryKind {
  if (/capacity|overloaded|rate.?limit|too many requests|429|529/i.test(message)) return "capacity";
  if (/timeout|timed out|no progress/i.test(message)) return "timeout";
  if (/network|disconnect|connection|broken pipe|closed|eof/i.test(message)) return "disconnected";
  return "failed";
}

export function recoveryFromEvents(events: AgentEvent[]): RecoveryKind | null {
  let kind: RecoveryKind | null = null;
  for (const event of events) {
    if (event.subagent) continue;
    const p = event.payload;
    if (p.type === "recovery") kind = p.kind;
    else if (p.type === "user_message" && !p.queued) kind = null;
  }
  return kind;
}

// A new conversation turn, never a replay of tool input or the original prompt.
export const RECOVERY_PROMPT = "Review the previous interrupted or failed turn and check the current outcome first. Do not repeat completed tool calls. If a command may still be running or its side effects are unknown, verify its state before taking further action. Continue only the unfinished work; ask me if you cannot safely determine what remains.";
