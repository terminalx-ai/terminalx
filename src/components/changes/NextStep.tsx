import type { ReactNode } from "react";
import type { BranchOverview, PullRequest } from "@/lib/api";
import { cn } from "@/lib/cn";

export type StepTone = "bad" | "warn" | "good" | "muted";

export type LocalStepKind = "pull" | "reconcile" | "detached" | "conflicts" | "commit" | "empty" | "local" | "push";

/**
 * The step, and in plain words why it is the step: written for someone who
 * has not used git before, so each says what doing it gets them.
 */
export type LocalStep = { kind: LocalStepKind; text: string; why: string; tone: StepTone };

/**
 * Wording for the native local-step resolver shared with the session header.
 * Null when the branch needs nothing before its pull request (or opening one).
 *
 * A project without usable GitHub pull requests can land work on its local
 * base (`local`), even when its remote is hosted elsewhere.
 *
 * `pr` is undefined while it is being read: no step is claimed from it then.
 */
export function localStep(o: BranchOverview, pr: PullRequest | null | undefined, baseName: string, localOnly = !o.hasRemote): LocalStep | null {
  if (o.nextStep === "pull") {
    return { kind: "pull", text: `Pull ${commits(o.unpulled)}`, why: `Someone else pushed to this branch. Pull so you are working on the latest.`, tone: "warn" };
  }
  if (o.nextStep === "reconcile") return { kind: "reconcile", text: "Reconcile with upstream", why: "Both this branch and its remote have new commits. Keep both sides before pushing.", tone: "warn" };
  if (o.nextStep === "detached") return { kind: "detached", text: "Not on a branch", why: "Work done here belongs to no branch and is easy to lose. Make a branch to keep it.", tone: "muted" };
  if (o.nextStep === "conflicts") {
    const n = o.merge.conflicted.length;
    return { kind: "conflicts", text: n ? `Conflicts with ${baseName} in ${files(n)}` : "Finish the Git operation", why: n ? `${baseName} changed the same lines you did. Resolve them before this can be merged.` : "Finish the merge, rebase or other operation before continuing.", tone: "bad" };
  }
  if (o.nextStep === "commit") {
    return {
      kind: "commit",
      text: "Commit your changes",
      why: `${o.changed ? `${files(o.changed)} changed. ` : ""}A commit saves them on this branch as a checkpoint you can come back to.`,
      tone: "warn",
    };
  }
  // Nothing of its own: unless a pull request already speaks for it (a merged one, say).
  if (o.nextStep === "empty") return pr === null || localOnly ? { kind: "empty", text: "No changes yet", why: "", tone: "muted" } : null;
  if (o.nextStep === "local") {
    return {
      kind: "local",
      text: `${commits(o.ahead)} ready for ${baseName}`,
      why: `GitHub pull requests are unavailable for this project. Merge into the local ${baseName} branch here.`,
      tone: "good",
    };
  }
  if (o.nextStep === "push" && !o.upstream) return { kind: "push", text: `Push ${commits(o.ahead)}`, why: "Your commits are only on this computer. Push them so others can see them and you can open a pull request.", tone: "muted" };
  if (o.nextStep === "push") return { kind: "push", text: `Push ${commits(o.unpushed)}`, why: "Your newest commits are only on this computer. Push them so the remote, and any pull request, has them.", tone: "muted" };
  return null;
}

const commits = (n: number) => `${n} ${n === 1 ? "commit" : "commits"}`;
const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

/** The one next step, in the same look wherever it is said. */
export function NextLine({ tone, text, why, children, actions, testId = "next-step" }: { tone: StepTone; text: ReactNode; why?: ReactNode; children?: ReactNode; actions?: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-well px-3 py-2.5" data-testid={testId} data-tone={tone}>
      <div className="flex min-h-6 items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            tone === "bad" && "bg-destructive",
            tone === "warn" && "bg-warning",
            tone === "good" && "bg-success",
            tone === "muted" && "bg-muted-foreground/60",
          )}
        />
        <span className={cn("min-w-0 flex-1 truncate text-xs", tone === "muted" ? "text-muted-foreground" : "text-foreground")}>{text}</span>
        {actions && <div className="-my-0.5 flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {why && <p className="pl-3.5 text-[11px] leading-relaxed text-faint" data-testid="next-step-why">{why}</p>}
      {children}
    </div>
  );
}
