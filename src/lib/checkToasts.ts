import { openExternalWebUrl } from "@/lib/externalUrl";
import { showError } from "@/lib/errorToasts";

/**
 * The two check actions that can fail out of sight, said as toasts with
 * GitHub's own reason and a way on (PRO-394, design 05.17): a re-run GitHub
 * refused, and Fix errors that could not collect the logs.
 */

/**
 * GitHub's reason, from what `gh` (or the runtime) reported: without the
 * command it ran, a leading "error:"/"gh:" and GitHub's trailing "(HTTP 403)",
 * as one sentence that ends in a full stop.
 */
export function githubReason(message: string): string {
  const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
  // The command line `gh` echoes, and a bare usage hint, say nothing of why.
  const said = lines.filter((line) => !/^(gh|git) [\w-]+( |$).*: *$/.test(line) && !/^(usage|run 'gh|try 'gh)/i.test(line));
  let reason = (said.find((line) => /\b(cannot|can't|could not|couldn't|not |no |only|already|failed|denied|forbidden|timed out|must)\b/i.test(line)) ?? said[said.length - 1] ?? message).trim();
  // "gh run rerun 1 --repo o/r: run 1 cannot be rerun" → "run 1 cannot be rerun"
  reason = reason.replace(/^gh [^:]*: */, "").replace(/^(error|fatal|gh|failed to run [^:]*): */i, "").replace(/ *\(HTTP \d{3}\) *$/, "").trim();
  if (!reason) return "GitHub didn't say why.";
  reason = reason.charAt(0).toUpperCase() + reason.slice(1);
  return /[.!?]$/.test(reason) ? reason : `${reason}.`;
}

/** A re-run GitHub refused: its reason, and the run to look at there. */
export function showRerunFailed({ prNumber, error, runUrl }: { prNumber: number; error: string; runUrl?: string | null }): string {
  return showError(githubReason(error), null, {
    title: `Couldn't re-run checks on #${prNumber}`,
    key: `checks-rerun:${prNumber}`,
    tone: "error",
    copy: false,
    actions: runUrl ? [{ label: "Open run on GitHub", icon: "external", keepOpen: true, run: () => openExternalWebUrl(runUrl) }] : undefined,
  });
}

/**
 * Fix errors that never reached the agent: why, said plainly with "Nothing
 * was sent to the agent", Try again, and the failing check's log on GitHub.
 */
export function showFixFailed({ error, retry, logUrl, key }: { error: string; retry?: () => unknown; logUrl?: string | null; key: string }): string {
  const reason = githubReason(error);
  return showError(`${reason} Nothing was sent to the agent.`, null, {
    title: "Couldn't start Fix errors",
    key: `fix-errors:${key}`,
    tone: "error",
    copy: false,
    actions: [
      ...(retry ? [{ label: "Try again", icon: "retry" as const, primary: true, run: retry }] : []),
      ...(logUrl ? [{ label: "Open log on GitHub", icon: "external" as const, keepOpen: true, run: () => openExternalWebUrl(logUrl) }] : []),
    ],
  });
}
