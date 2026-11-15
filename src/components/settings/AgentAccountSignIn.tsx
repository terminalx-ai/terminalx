import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { agentAccounts, waitForSignIn, type AgentAccountLoginFinished, type AgentAccountLoginStarted } from "@/lib/agentAccounts";
import { errorMessage } from "@/lib/api";

/** How a sign-in ended. */
export type SignInEnd = Exclude<AgentAccountLoginFinished, { status: "waiting" }>;

/**
 * One agent sign-in at a time (#980): Add account, or Sign in again on one
 * account. The agent's own CLI does the signing in; this asks until it has
 * ended and cancels it when the person does, or when the page goes away.
 */
export function useAccountSignIn() {
  const [started, setStarted] = useState<AgentAccountLoginStarted | null>(null);
  const [starting, setStarting] = useState(false);
  const controller = useRef<AbortController | null>(null);
  // Leaving Settings ends the sign-in: the CLI must not keep a login port open for no one.
  useEffect(() => () => controller.current?.abort(), []);

  /** Start with `start` and wait for the end. Throws what starting or asking threw. */
  const begin = useCallback(async (start: () => Promise<AgentAccountLoginStarted>): Promise<SignInEnd> => {
    controller.current?.abort();
    const mine = new AbortController();
    controller.current = mine;
    setStarting(true);
    try {
      const attempt = await start();
      if (mine.signal.aborted) {
        await agentAccounts.addCancel(attempt.attemptId).catch(() => {});
        return { status: "cancelled" };
      }
      setStarted(attempt);
      setStarting(false);
      // It resolves only once the sign-in is no longer waiting.
      return (await waitForSignIn(attempt.attemptId, { signal: mine.signal })) as SignInEnd;
    } finally {
      if (controller.current === mine) {
        controller.current = null;
        setStarted(null);
        setStarting(false);
      }
    }
  }, []);
  const cancel = useCallback(() => controller.current?.abort(), []);
  return { started, starting, busy: starting || !!started, begin, cancel };
}

/** What to tell the person about a sign-in that ended, or nothing (cancelled). */
export function signInMessage(end: SignInEnd, agentName: string): { tone: "ok" | "problem"; text: string } | null {
  switch (end.status) {
    case "added": return { tone: "ok", text: `Added ${end.account.label}.` };
    case "signedInAgain": return { tone: "ok", text: `${end.account.label} is signed in again.` };
    case "duplicate": return { tone: "problem", text: `That account is already listed as ${end.label || "an account"}. The new sign-in was signed out and not kept.` };
    case "expired": return { tone: "problem", text: `The ${agentName} sign-in expired before it finished. Start it again.` };
    case "failed": return { tone: "problem", text: end.message };
    case "cancelled": return null;
  }
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** The sign-in under way: the browser it opened, or the code to enter (Codex). */
export function SignInProgress({ started, agentName, onCancel }: {
  started: AgentAccountLoginStarted | null;
  agentName: string;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    if (!started) return;
    setError(null);
    try { await agentAccounts.openPage(started.attemptId); } catch (e) { setError(errorMessage(e)); }
  };
  return <div role="status" aria-label={`Signing in to ${agentName}`} className="mt-2 rounded-md bg-muted/60 px-3 py-2.5 text-[12.5px]">
    <div className="flex items-center gap-2">
      <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-faint" />
      <span className="min-w-0">
        {!started ? `Starting ${agentName}'s sign-in…`
          : started.flow === "deviceCode" ? <>Enter this code at {started.verificationUrl ? hostOf(started.verificationUrl) : "the sign-in page"}, then come back.</>
          : `Finish signing in to ${agentName} in your browser.`}
      </span>
    </div>
    {started?.flow === "deviceCode" && started.userCode && <div aria-label="Sign-in code" className="mt-2 select-all font-mono text-[15px] tracking-[0.2em]">{started.userCode}</div>}
    <div className="mt-2 flex flex-wrap gap-1.5">
      {started?.verificationUrl && <Button size="sm" variant="outline" className="whitespace-nowrap" onClick={() => void open()}>
        <ExternalLink /> {started.flow === "deviceCode" ? "Open the page" : "Open the page again"}
      </Button>}
      <Button size="sm" variant="ghost" className="whitespace-nowrap" onClick={onCancel}>Cancel sign-in</Button>
    </div>
    {error && <p role="alert" className="mt-1.5 text-[12px] text-destructive">{error}</p>}
  </div>;
}
