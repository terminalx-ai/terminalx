import { useEffect, useState } from "react";
import { Check, CircleAlert, Loader2 } from "@/icons";
import { copiedStepText } from "@/components/ui/WorktreeCopyNotices";
import type { FirstMessagePreview } from "@/lib/agentEvents";
import { formatSetupDuration, revealSetup, setupActive, type WorkspaceSetup } from "@/lib/workspaceSetup";
import type { SessionEntry } from "@/types/session";
import { SendingMessage } from "./TurnBlock";

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="shrink-0 text-[11px] tabular-nums text-faint">{formatSetupDuration(Math.max(0, now - since))}</span>;
}

function Step({ label, state }: { label: string; state: "done" | "running" | "failed" }) {
  const Icon = state === "done" ? Check : state === "running" ? Loader2 : CircleAlert;
  return (
    <li className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <Icon className={state === "running" ? "size-3 shrink-0 animate-spin" : "size-3 shrink-0"} aria-hidden />
      <span className="truncate" title={label}>{label}</span>
    </li>
  );
}

/** The reader's Create prompt stays visible until the tab log has a real prompt. */
export function FirstMessage({ message, session, agent, setup }: {
  message: FirstMessagePreview;
  session: SessionEntry;
  agent: string;
  setup?: WorkspaceSetup;
}) {
  const failed = message.error !== null;
  const base = session.worktreeBase;
  const branch = session.branch || session.worktreeName;
  const from = base?.from || session.baseRef;
  const copy = base?.fileCopy;
  const copied = copy ? copiedStepText(copy) : null;
  const setupRunning = setup && setupActive(setup);
  const setupDone = setup?.status === "succeeded";

  return (
    <div data-testid="first-message">
      <SendingMessage message={message} cwd={session.cwd} failed={failed} />
      <div className="mb-3 rounded-lg px-3 py-2.5 hairline">
        <div className="flex items-center gap-2 text-[13px] text-foreground">
          <span className="min-w-0 flex-1" role="status">{failed ? "The session started, but the first message was not sent" : "Starting the session"}</span>
          {!failed && <Elapsed since={message.startedAt} />}
          {setup?.hasPane && (
            <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => revealSetup(session.id)}>
              Setup tab
            </button>
          )}
        </div>
        <ul className="mt-1.5 space-y-1">
          {base && branch && <Step label={`Created worktree ${branch}${from ? ` from ${from}` : ""}`} state="done" />}
          {(copied || copy?.error) && <Step label={copied ?? "Could not copy workspace files"} state={copy?.error ? "failed" : "done"} />}
          {setup && <Step label={`${setupDone ? "Ran the setup script" : setupRunning ? "Running the setup script" : "The setup script did not finish"} · ${setup.command}`} state={setupDone ? "done" : setupRunning ? "running" : "failed"} />}
          <Step label={failed ? `${agent} did not take the message` : `Starting ${agent}`} state={failed ? "failed" : "running"} />
        </ul>
      </div>
      {failed ? (
        <p role="alert" className="mb-4 px-1 text-xs text-warning">Couldn't send the first message: {message.error}</p>
      ) : (
        <p className="mb-4 px-1 text-xs text-faint">Your first message is held and sent as soon as {agent} is ready.</p>
      )}
    </div>
  );
}
