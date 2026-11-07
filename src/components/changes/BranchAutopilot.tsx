import { useState } from "react";
import { ChevronRight } from "@/icons";
import { PipelineStatus } from "@/components/issues/IssuePipelinePanel";
import { SessionPipelineControls } from "@/components/session/SessionPipelineControls";
import { pipelineForSession, useIssuePipelines } from "@/lib/issuePipeline";
import { useSessionStore } from "@/lib/sessions";
import { cn } from "@/lib/cn";

/**
 * Autopilot: the branch's remaining steps (open a pull request, review it,
 * resolve conflicts, merge when green) done for the reader. It lives in the
 * Branch tab, under the next step, because it is that same path run for you;
 * see docs/AUTOPILOT-PLACEMENT.md for why it is a section here and not a
 * header dialog or a tab of its own.
 *
 * Off, it is one line that opens its switches in place. On, that line is the
 * pipeline's live status, opened by default so where it stands is seen.
 * `offer` is false where a pipeline cannot be started from here (a cloud
 * workspace, a chat with no repository); a running one is still shown.
 */
export function BranchAutopilot({ sessionId, offer }: { sessionId?: string; offer: boolean }) {
  const store = useSessionStore();
  const session = store.sessions.find((candidate) => candidate.id === sessionId);
  const role = pipelineForSession(useIssuePipelines(), sessionId ?? "");
  const [open, setOpen] = useState<boolean | null>(null);
  if (!session || (!role && !offer)) return null;
  const expanded = open ?? !!role;
  const project = store.projects.find((candidate) => candidate.path === session.projectPath);
  return (
    <section aria-label="Autopilot" className="flex flex-col gap-2" data-testid="branch-autopilot">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
        className="flex h-7 min-w-0 items-center gap-2 rounded-md px-3 text-left text-xs outline-none hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <span className="shrink-0 text-foreground">Autopilot</span>
        {role ? (
          <PipelineStatus pipeline={role.pipeline} className="min-w-0" labelClassName="truncate" lead={role.role === "reviewer" ? <span className="font-normal text-muted-foreground">Reviewer · </span> : null} />
        ) : (
          <span className="min-w-0 truncate text-faint">Off</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5 text-faint">
          {!role && !expanded && "Set up"}
          <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} aria-hidden />
        </span>
      </button>
      {expanded && (
        <div className="flex flex-col gap-2 px-3" data-testid="branch-autopilot-body">
          <SessionPipelineControls session={session} project={project} tabId={session.activeTab ?? undefined} pipeline={role?.pipeline} />
        </div>
      )}
    </section>
  );
}
