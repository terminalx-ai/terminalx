import { useEffect, useRef, useState } from "react";
import { Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { automationsApi, errorMessage } from "@/lib/api";
import type { AutomationInput, AutomationPrecheck, PrecheckTrial } from "@/types/automations";

export const PRECHECK_DEFAULT_TIMEOUT = 60;
export const PRECHECK_MAX_TIMEOUT = 300;

const INPUT = "h-8 w-full rounded-md bg-well px-2.5 text-[13px] outline-none ring-offset-background focus:ring-2 focus:ring-ring/30";
const LABEL = "flex flex-col gap-1.5 text-xs font-medium";

const VERDICT: Record<PrecheckTrial["outcome"], string> = {
  nothingNew: "Nothing new: the run would end here, with no session and no model call.",
  proceed: "The run would go ahead, with this output under the prompt.",
  failed: "The run would fail without starting the agent.",
};

/** A saved first check is usable only when it names a command. */
export function precheckReady(precheck: AutomationPrecheck | null | undefined): boolean {
  return !precheck || !!precheck.command.trim();
}

/**
 * The editor's optional "First check" (PRO-484): a shell command run before
 * the agent, in the folder the run would use, and a Try it that runs it once.
 */
export function PrecheckSection({ input, onChange, onTry, where }: {
  input: AutomationInput;
  onChange: (precheck: AutomationPrecheck | null) => void;
  /** Runs Try it somewhere else than the automation's folder (a bot's duty, PRO-471). */
  onTry?: (precheck: AutomationPrecheck) => Promise<PrecheckTrial>;
  /** Where the check runs, said under Try it, when it is not the automation's folder. */
  where?: string;
}) {
  const precheck = input.precheck ?? null;
  const [trial, setTrial] = useState<PrecheckTrial | null>(null);
  const [trying, setTrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The timeout as typed: an empty field stays empty until it loses focus.
  const [timeoutText, setTimeoutText] = useState(String(precheck?.timeoutSeconds ?? PRECHECK_DEFAULT_TIMEOUT));
  const folderReady = input.workspace === "newWorktree" || !!input.sessionId;
  // A result belongs to the command, timeout and folder it ran with.
  const key = JSON.stringify([precheck?.command, precheck?.timeoutSeconds, input.projectPath, input.workspace, input.sessionId]);
  const latest = useRef(key);
  latest.current = key;

  useEffect(() => {
    setTrial(null);
    setError(null);
  }, [key]);

  useEffect(() => {
    if (precheck && Number(timeoutText) !== precheck.timeoutSeconds) setTimeoutText(String(precheck.timeoutSeconds));
    // Only an outside change (a reset) rewrites what is being typed.
  }, [precheck?.timeoutSeconds]);

  const setTimeoutFrom = (text: string) => {
    if (!precheck) return;
    const value = Math.round(Number(text));
    if (text.trim() && Number.isFinite(value)) onChange({ ...precheck, timeoutSeconds: Math.min(PRECHECK_MAX_TIMEOUT, Math.max(1, value)) });
  };

  const tryIt = async () => {
    if (!precheck || !precheck.command.trim()) return;
    const asked = key;
    setTrying(true);
    setError(null);
    setTrial(null);
    try {
      const result = onTry ? await onTry(precheck) : await automationsApi.tryPrecheck({ projectPath: input.projectPath, workspace: input.workspace, sessionId: input.sessionId ?? null, precheck });
      if (latest.current === asked) setTrial(result);
    } catch (cause) {
      if (latest.current === asked) setError(errorMessage(cause));
    } finally {
      setTrying(false);
    }
  };

  return (
    <div className="col-span-2 flex flex-col gap-3 border-t border-hairline pt-3" data-testid="automation-precheck">
      <label className="flex items-center justify-between gap-3 text-xs">
        <span className="min-w-0">
          <span className="block font-medium">First check</span>
          <span className="text-faint">A shell command run before the agent. Prints nothing: “nothing new”, no session. Prints something: the agent gets it with the prompt. Fails or times out: the run fails.</span>
        </span>
        <Switch
          aria-label="Run a first check"
          checked={!!precheck}
          onCheckedChange={(on) => {
            setTimeoutText(String(PRECHECK_DEFAULT_TIMEOUT));
            onChange(on ? { command: "", timeoutSeconds: PRECHECK_DEFAULT_TIMEOUT } : null);
          }}
        />
      </label>
      {precheck && (
        <>
          <label className={LABEL}>
            Command
            <textarea
              value={precheck.command}
              onChange={(event) => onChange({ ...precheck, command: event.target.value })}
              rows={2}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              className="w-full resize-y rounded-lg bg-well px-3 py-2 font-mono text-[12px] leading-relaxed outline-none focus:ring-2 focus:ring-ring/30"
              placeholder="gh pr list --search 'review-requested:@me' --json number,title --jq '.[] | .title'"
            />
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className={`${LABEL} w-40`}>
              Timeout (seconds)
              <input
                type="number"
                min={1}
                max={PRECHECK_MAX_TIMEOUT}
                value={timeoutText}
                onChange={(event) => {
                  setTimeoutText(event.target.value);
                  setTimeoutFrom(event.target.value);
                }}
                onBlur={() => setTimeoutText(String(precheck.timeoutSeconds))}
                className={INPUT}
              />
            </label>
            <Button variant="secondary" size="sm" disabled={trying || !precheck.command.trim() || (!onTry && (!input.projectPath || !folderReady))} onClick={() => void tryIt()}>
              {trying ? <><Loader2 className="size-3.5 animate-spin" /> Trying…</> : "Try it"}
            </Button>
            <span className="min-w-0 flex-1 text-[11px] text-faint">
              {where ?? (input.workspace === "session" ? "Runs in the chosen session's folder." : "Runs in the project folder, not in the run's new worktree.")}
            </span>
          </div>
          {error && <div role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
          {trial && <PrecheckTrialResult trial={trial} />}
        </>
      )}
    </div>
  );
}

function PrecheckTrialResult({ trial }: { trial: PrecheckTrial }) {
  const { result } = trial;
  const facts = [
    result.exitCode != null ? `exit ${result.exitCode}` : result.timedOut ? "timed out" : null,
    `${(result.durationMs / 1000).toFixed(1)} s`,
    result.truncated ? "output cut short" : null,
  ].filter(Boolean).join(" · ");
  return (
    <div role="status" aria-label="First check result" className="min-w-0 rounded-lg bg-well px-3 py-2.5 text-xs">
      <div className={trial.outcome === "failed" ? "font-medium text-destructive" : "font-medium text-foreground"}>{VERDICT[trial.outcome]}</div>
      {trial.reason && <div className="mt-0.5 text-destructive">{trial.reason}</div>}
      <div className="mt-0.5 text-[11px] text-faint">{facts}</div>
      {result.stdoutTail.trim() ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] text-foreground">{result.stdoutTail}</pre> : <div className="mt-2 text-[11px] text-faint">It printed nothing.</div>}
      {result.stderrTail.trim() && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">{result.stderrTail}</pre>}
    </div>
  );
}
