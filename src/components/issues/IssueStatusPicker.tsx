import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2 } from "@/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { WithTooltip } from "@/components/ui/tooltip";
import { errorMessage, type Issue } from "@/lib/api";
import { issueOps, type CloseReason, type IssueDetails, type IssueOptions, type StateChange, type WorkflowState } from "@/lib/issueOps";
import { bindingText, useKeymap } from "@/lib/shortcuts";
import { cn } from "@/lib/cn";
import type { IssuePipeline } from "@/types/issuePipeline";

/** Linear's own order of state types, the one its pickers use. */
const TYPE_ORDER = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];
const TYPE_LABEL: Record<string, string> = {
  triage: "Triage",
  backlog: "Backlog",
  unstarted: "Unstarted",
  started: "Started",
  completed: "Completed",
  canceled: "Canceled",
};

/**
 * A team's workflow states by type, in Linear's order; a type it has no name
 * for goes last. Duplicate is left out, as Linear's own picker does: an issue
 * is only moved there by marking it a duplicate of another, and Linear
 * refuses the plain move.
 */
export function groupWorkflowStates(states: WorkflowState[]): { type: string; label: string; states: WorkflowState[] }[] {
  const rank = (type: string) => (TYPE_ORDER.includes(type) ? TYPE_ORDER.indexOf(type) : TYPE_ORDER.length);
  const types = [...new Set(states.map((state) => state.type))]
    .filter((type) => type !== "duplicate").sort((a, b) => rank(a) - rank(b));
  return types.map((type) => ({
    type,
    label: TYPE_LABEL[type] ?? type.charAt(0).toUpperCase() + type.slice(1),
    states: states.filter((state) => state.type === type).sort((a, b) => a.position - b.position),
  }));
}

/**
 * True while the issue's pipeline is still to move it to review: it does
 * that once, when its pull request opens, and only on Linear. A state picked
 * by hand before then may be moved again, though never backwards.
 */
export function pipelineMayMoveIssue(pipeline: IssuePipeline | null | undefined): boolean {
  if (!pipeline || pipeline.issue.provider !== "linear" || pipeline.stopped) return false;
  if (pipeline.state === "merged" || pipeline.state === "stopped") return false;
  return !pipeline.events.some((event) => event.kind === "tracker");
}

const closedAs = (reason: CloseReason) => (reason === "not_planned" ? "Closed as not planned" : "Closed as completed");

/** What the list's `stateType` is for a Linear state type. */
const listType = (type: string): Issue["stateType"] => (type === "started" || type === "completed" || type === "canceled" ? type : "open");

/** How an issue is shown while a change to it is on its way. */
function guessed(issue: Issue, change: StateChange, state?: WorkflowState): Issue {
  if (change.kind === "workflow_state" && state) {
    return { ...issue, state: state.name, stateType: listType(state.type), workflowStateType: state.type, stateId: state.id, stateColor: state.color } as Issue;
  }
  if (change.kind === "close") {
    return { ...issue, state: "Closed", stateType: change.reason === "not_planned" ? "canceled" : "completed", closeReason: change.reason } as Issue;
  }
  return { ...issue, state: "Open", stateType: "open", closeReason: null } as Issue;
}

function Dot({ issue, color }: { issue: Issue; color?: string | null }) {
  if (color) return <span className="size-2 shrink-0 rounded-full" style={{ background: `#${color}` }} />;
  return <span className={cn("size-2 shrink-0 rounded-full", issue.stateType === "open" ? "bg-add" : issue.stateType === "completed" ? "bg-merged" : "bg-faint")} />;
}

/**
 * The issue's state in the detail header, and the way to change it: the
 * team's workflow states on Linear, close (with a reason) or reopen on
 * GitHub. A change shows at once; what the provider answers replaces it, and
 * a refusal puts back what the provider says with the reason under it.
 * An issue read without its capabilities shows the state as plain text.
 */
export function IssueStatusPicker({
  projectPath,
  issue,
  pipeline,
  open: controlledOpen,
  onOpenChange,
  busy = false,
  onWriting,
  onChange,
}: {
  projectPath: string;
  issue: Issue;
  /** The issue's pipeline, when one was started from it. */
  pipeline?: IssuePipeline | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** A change to this issue is on its way. Kept by the view, so it outlives this picker. */
  busy?: boolean;
  /** Told when a change starts and when it has been answered (or refused and read again). */
  onWriting?: (on: boolean) => void;
  /** The issue as it now shows: the guess while a change is on its way, then the provider's answer. */
  onChange: (issue: Issue) => void;
}) {
  const details = issue as Partial<IssueDetails> & Issue;
  const capabilities = details.capabilities;
  const keys = useKeymap()["issues.status"][0];
  const [localOpen, setLocalOpen] = useState(false);
  const [options, setOptions] = useState<IssueOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Nothing opens while a change is on its way: what it would offer depends on the answer.
  const open = (controlledOpen ?? localOpen) && !busy;
  // The picker is keyed by its issue, so it is gone once another one is open. A change still on
  // its way then lands only on its own issue's row (`onChange` names the issue), never on this
  // picker's message.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const wantsStates = !!capabilities?.workflowStates;

  // The team's states are read when the picker first opens, by a click or by the shortcut.
  useEffect(() => {
    if (!open || !wantsStates || options) return;
    let live = true;
    setOptionsError(null);
    issueOps
      .options(projectPath, issue.provider, { id: issue.id })
      .then((value) => live && setOptions(value))
      .catch((e) => live && setOptionsError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [open, wantsStates, options, projectPath, issue.provider, issue.id]);

  if (!capabilities || !(capabilities.workflowStates || capabilities.closeReasons)) {
    return issue.state ? <span>{issue.state}</span> : null;
  }

  const setOpen = (value: boolean) => {
    if (value && busy) return;
    setLocalOpen(value);
    onOpenChange?.(value);
  };

  const choose = async (change: StateChange, state?: WorkflowState) => {
    const before = issue;
    setMessage(null);
    onWriting?.(true);
    onChange(guessed(issue, change, state));
    try {
      onChange(await issueOps.setState(projectPath, issue.provider, issue.id, change));
    } catch (e) {
      if (mounted.current) setMessage(errorMessage(e));
      // Refused: show what the provider says now, or, when it cannot be read, what was there.
      try {
        onChange(await issueOps.details(projectPath, issue.provider, issue.id));
      } catch {
        onChange(before);
      }
    } finally {
      onWriting?.(false);
    }
  };

  const currentId = details.stateId ?? options?.states.find((state) => state.name === issue.state)?.id ?? "";
  const closeReason = details.closeReason ?? null;
  const label = capabilities.closeReasons && issue.stateType !== "open" && closeReason ? closedAs(closeReason) : issue.state;
  const mayMove = capabilities.workflowStates && pipelineMayMoveIssue(pipeline);

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <WithTooltip label={keys ? `Change status (${bindingText(keys)})` : "Change status"}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Status: ${label}`}
              disabled={busy}
              className="flex h-5 min-w-0 max-w-full items-center gap-1.5 rounded px-1 -mx-1 text-foreground transition-colors hover:bg-veil-raised disabled:opacity-70"
            >
              {busy ? <Loader2 className="size-3 shrink-0 animate-spin text-faint" /> : <Dot issue={issue} color={details.stateColor} />}
              <span className="truncate">{label}</span>
              <ChevronDown className="size-3 shrink-0 text-faint" />
            </button>
          </DropdownMenuTrigger>
        </WithTooltip>
        <DropdownMenuContent align="start" className="max-h-(--radix-dropdown-menu-content-available-height) max-w-[18rem] overflow-y-auto scrollbar-thin">
          {mayMove && (
            <>
              <p className="px-2 py-1 text-[11px] leading-snug text-faint">The issue pipeline may move this issue to review when its pull request opens.</p>
              <DropdownMenuSeparator />
            </>
          )}
          {capabilities.workflowStates ? (
            optionsError ? (
              <p className="px-2 py-1 text-xs text-destructive">{optionsError}</p>
            ) : !options ? (
              <p className="flex items-center gap-1.5 px-2 py-1 text-xs text-faint"><Loader2 className="size-3 animate-spin" /> Loading states…</p>
            ) : (
              <DropdownMenuRadioGroup
                value={currentId}
                onValueChange={(id) => {
                  const state = options.states.find((each) => each.id === id);
                  if (state && id !== currentId) void choose({ kind: "workflow_state", stateId: id }, state);
                }}
              >
                {groupWorkflowStates(options.states).map((group) => (
                  <div key={group.type} role="group" aria-label={group.label}>
                    <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                    {group.states.map((state) => (
                      <DropdownMenuRadioItem key={state.id} value={state.id}>
                        <span className="size-2 shrink-0 rounded-full" style={{ background: state.color ? `#${state.color}` : "var(--ink-faint)" }} />
                        <span className="truncate">{state.name}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </div>
                ))}
              </DropdownMenuRadioGroup>
            )
          ) : issue.stateType === "open" ? (
            <>
              <DropdownMenuItem onSelect={() => void choose({ kind: "close", reason: "completed" })}>
                <span className="size-2 shrink-0 rounded-full bg-merged" /> Close as completed
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void choose({ kind: "close", reason: "not_planned" })}>
                <span className="size-2 shrink-0 rounded-full bg-faint" /> Close as not planned
              </DropdownMenuItem>
            </>
          ) : (
            <>
              <DropdownMenuLabel className="normal-case tracking-normal">{label}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => void choose({ kind: "reopen" })}>
                <span className="size-2 shrink-0 rounded-full bg-add" /> Reopen
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {message && (
        <span role="alert" className="basis-full text-destructive">
          {message}
        </span>
      )}
    </>
  );
}
