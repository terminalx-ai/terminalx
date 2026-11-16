import { useEffect, useState } from "react";
import { Check, CircleAlert, Loader2 } from "@/icons";
import { cn } from "@/lib/cn";
import { useSessionStore } from "@/lib/sessions";
import { revealSetup, useWorkspaceSetup } from "@/lib/workspaceSetup";
import type { HeldFirstMessage } from "@/lib/firstMessage";
import { SendingMessage } from "./TurnBlock";

type StepState = "done" | "running" | "failed";
interface Step { key: string; label: string; state: StepState }

const seconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

/** Ticks while the session starts, for the elapsed time beside "Starting the session". */
function useNow(running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/**
 * A new session's first message, drawn the moment the session opens (PRO-397):
 * the prompt as written with its attachments, the start progress under it, and
 * that the message waits for the agent. A send that failed keeps the message,
 * with why, in place of the progress.
 */
export function FirstMessage({ message, cwd }: { message: HeldFirstMessage; cwd?: string }) {
  const { sessions, harnesses } = useSessionStore();
  const session = sessions.find((item) => item.id === message.sessionId);
  const harness = session?.tabs.find((tab) => tab.id === message.tabId)?.harness;
  const agent = (harness && harnesses.find((item) => item.id === harness)?.name) || "the agent";
  const setup = useWorkspaceSetup(message.sessionId);
  const failed = message.error !== null;
  const now = useNow(!failed);

  const steps: Step[] = [];
  const branch = session?.branch || session?.worktreeName;
  if (branch) {
    const from = session?.worktreeBase?.from || session?.baseRef;
    steps.push({ key: "worktree", label: `Created worktree ${branch}${from ? ` from ${from}` : ""}`, state: "done" });
  }
  const copy = session?.worktreeBase?.fileCopy;
  if (copy && copy.copiedCount > 0) {
    const first = copy.firstCopied;
    const others = copy.copiedCount - (first ? 1 : 0);
    const label = first
      ? others > 0 ? `Copied ${first} and ${others} other ${others === 1 ? "file" : "files"}` : `Copied ${first}`
      : `Copied ${copy.copiedCount} ${copy.copiedCount === 1 ? "file" : "files"}`;
    steps.push({ key: "copy", label, state: copy.error ? "failed" : "done" });
  }
  if (setup) {
    const state: StepState = setup.status === "succeeded" ? "done" : setup.status === "failed" || setup.status === "stopped" ? "failed" : "running";
    const verb = state === "done" ? "Ran the setup script" : state === "failed" ? "The setup script did not finish" : "Running the setup script";
    steps.push({ key: "setup", label: `${verb} · ${setup.command}`, state });
  }
  steps.push({ key: "agent", label: failed ? `${agent} did not take the message` : `Starting ${agent}`, state: failed ? "failed" : "running" });

  return (
    <div data-testid="first-message" data-first-message-state={failed ? "failed" : "pending"}>
      <SendingMessage message={message} cwd={cwd} />
      <div className="mb-3 rounded-lg px-3 py-2.5 hairline" role="status" aria-live="polite" data-testid="start-progress">
        <div className="flex items-center gap-2 text-[13px] text-foreground">
          {failed ? <CircleAlert className="size-3.5 shrink-0 text-warning" aria-hidden /> : <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
          <span className="min-w-0 flex-1 truncate">{failed ? "The session started, but the first message was not sent" : "Starting the session"}</span>
          {!failed && <span className="shrink-0 text-[11px] tabular-nums text-faint">{seconds(now - message.startedAt)}</span>}
          {setup?.hasPane && (
            <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => revealSetup(message.sessionId)}>
              Setup tab
            </button>
          )}
        </div>
        <ul className="mt-1.5 space-y-1 pl-5.5">
          {steps.map((step) => (
            <li key={step.key} data-step={step.key} data-state={step.state} className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              {step.state === "done" ? (
                <Check className="size-3 shrink-0" aria-hidden />
              ) : step.state === "failed" ? (
                <CircleAlert className="size-3 shrink-0 text-warning" aria-hidden />
              ) : (
                <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
              )}
              <span className={cn("min-w-0 truncate", step.state === "running" && "text-foreground")}>{step.label}</span>
            </li>
          ))}
        </ul>
      </div>
      {failed ? (
        <p role="alert" className="mb-4 px-1 text-xs text-warning" data-testid="first-message-error">
          Couldn't send the first message: {message.error}
        </p>
      ) : (
        <p className="mb-4 px-1 text-xs text-muted-foreground" data-testid="first-message-held">
          Your first message is held and sent as soon as {agent} is ready.
        </p>
      )}
    </div>
  );
}
