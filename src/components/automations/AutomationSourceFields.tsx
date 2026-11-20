import { useEffect, useRef, useState } from "react";
import { Switch } from "@/components/ui/controls";
import { automationsApi, errorMessage, issues as issuesApi, type IssueTeam } from "@/lib/api";
import { issueOps, type IssueUser, type WorkflowState } from "@/lib/issueOps";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AutomationEventTrigger, LinearIssueReport, LinearIssueSource, PullRequestEvent, PullRequestSource, SourceMatch } from "@/types/automations";

const INPUT = "h-8 w-full rounded-md bg-well px-2.5 text-[13px] outline-none ring-offset-background focus:ring-2 focus:ring-ring/30";
const LABEL = "flex flex-col gap-1.5 text-xs font-medium";
const WARNING_NOTE = "col-span-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground";

const PR_EVENTS: { value: PullRequestEvent; label: string }[] = [
  { value: "opened", label: "Opened" },
  { value: "pushed", label: "New commits pushed" },
  { value: "reviewRequested", label: "Review requested from me" },
  { value: "checkFailed", label: "A check failed" },
];

const LINEAR_STATES: { value: string; label: string }[] = [
  { value: "open", label: "Open (not done or canceled)" },
  { value: "triage", label: "Triage" },
  { value: "backlog", label: "Backlog" },
  { value: "unstarted", label: "Todo" },
  { value: "started", label: "In progress" },
  { value: "all", label: "Any state" },
];

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * A comma-separated list typed as text. The text is kept as typed, so a comma
 * or a space being typed stays; the list it means is what is saved.
 */
function ListInput({ value, onChange, placeholder }: { value: string[]; onChange: (next: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState(() => value.join(", "));
  useEffect(() => {
    // Only a change from elsewhere replaces the text.
    if (splitList(text).join("\n") !== value.join("\n")) setText(value.join(", "));
  }, [value.join("\n")]);
  return <input value={text} onChange={(event) => { setText(event.target.value); onChange(splitList(event.target.value)); }} className={INPUT} placeholder={placeholder} />;
}

export function defaultLinearTrigger(): AutomationEventTrigger {
  return {
    source: { kind: "linearIssue", teamId: "", teamName: null, state: "open", labels: [], assignee: null, text: null, report: { comment: true, moveToStateId: null, moveToStateName: null, commentOnFailure: true } },
    pollIntervalMinutes: 5,
    maxRunsPerTick: 3,
  };
}

export function defaultPullRequestTrigger(repo = ""): AutomationEventTrigger {
  return {
    source: { kind: "githubPullRequest", repo, events: ["opened", "pushed"], base: null, author: null, labels: [], draft: null, fromForks: false },
    pollIntervalMinutes: 5,
    maxRunsPerTick: 3,
  };
}

/** Whether this version knows the trigger's kind; a newer TerminalX may have written another. */
export function eventTriggerKnown(trigger: AutomationEventTrigger): boolean {
  return (trigger.source.kind as string) === "linearIssue" || (trigger.source.kind as string) === "githubPullRequest";
}

export const NEEDS_NEWER = "This trigger needs a newer TerminalX: it is kept as it is and not checked.";

/** Whether the trigger has what saving it needs. */
export function eventTriggerReady(trigger: AutomationEventTrigger): boolean {
  const source = trigger.source;
  if (!eventTriggerKnown(trigger)) return true;
  return source.kind === "linearIssue" ? !!source.teamId.trim() : !!source.repo.trim() && source.events.length > 0;
}

/** How the list and the detail header say what an event trigger waits for. */
export function eventTriggerSentence(trigger: AutomationEventTrigger): string {
  const source = trigger.source;
  const every = `checked every ${trigger.pollIntervalMinutes} min`;
  if (!eventTriggerKnown(trigger)) return `A ${String(source.kind)} trigger this version does not know`;
  if (source.kind === "linearIssue") {
    const labels = source.labels.length ? ` labelled ${source.labels.join(" or ")}` : "";
    return `Linear: new ${source.teamName ?? "team"} issues${labels}, ${every}`;
  }
  const events = PR_EVENTS.filter((event) => source.events.includes(event.value)).map((event) => event.label.toLowerCase()).join(", ");
  return `GitHub pull requests in ${source.repo}: ${events}, ${every}`;
}

/** A change to a source: the fields, or, for a value filled in after a request, what to change given the source as it is then. */
type SourceChange<S> = Partial<S> | ((current: S) => Partial<S>);

/** The fields of a Linear issue or pull request trigger, with what it would match now. */
export function AutomationSourceFields({ projectPath, trigger, onChange }: { projectPath: string; trigger: AutomationEventTrigger; onChange: (next: AutomationEventTrigger) => void }) {
  const [preview, setPreview] = useState<SourceMatch[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const source = trigger.source;
  const sourceKey = JSON.stringify({ ...source, report: undefined });
  // A field filled in after a request (the team, the repository) merges into the trigger as it is then, not as it was when asked.
  const latest = useRef(trigger);
  latest.current = trigger;
  const merge = <S extends AutomationEventTrigger["source"]>(next: SourceChange<S>) => {
    const current = latest.current.source as S;
    onChange({ ...latest.current, source: { ...current, ...(typeof next === "function" ? next(current) : next) } });
  };

  useEffect(() => {
    if (!projectPath || !eventTriggerKnown(trigger) || !eventTriggerReady(trigger)) {
      setPreview([]);
      setPreviewError(null);
      return;
    }
    let live = true;
    const timer = window.setTimeout(async () => {
      setPreviewing(true);
      setPreviewError(null);
      try {
        const matches = await automationsApi.sourcePreview(projectPath, source);
        if (live) setPreview(matches);
      } catch (cause) {
        if (live) {
          setPreview([]);
          setPreviewError(errorMessage(cause));
        }
      } finally {
        if (live) setPreviewing(false);
      }
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [projectPath, sourceKey]);

  const noun = source.kind === "linearIssue" ? "issue" : "pull request";
  if (!eventTriggerKnown(trigger)) return <div role="note" className={WARNING_NOTE}>{NEEDS_NEWER}</div>;
  return (
    <>
      {source.kind === "linearIssue"
        ? <LinearFields projectPath={projectPath} source={source} onChange={merge} />
        : <PullRequestFields projectPath={projectPath} source={source} onChange={merge} />}
      <label className={LABEL}>
        Check every (minutes)
        <input type="number" min={1} value={trigger.pollIntervalMinutes} onChange={(event) => onChange({ ...trigger, pollIntervalMinutes: Math.max(1, Number(event.target.value)) })} className={INPUT} />
      </label>
      <label className={LABEL}>
        New runs per tick
        <input type="number" min={1} max={50} value={trigger.maxRunsPerTick} onChange={(event) => onChange({ ...trigger, maxRunsPerTick: Math.max(1, Number(event.target.value)) })} className={INPUT} />
      </label>
      <div className={WARNING_NOTE}>
        {source.kind === "linearIssue" ? "Issue titles and descriptions" : "Pull request titles"} can be untrusted. They are given as context, not followed as instructions, and each run uses the Permissions mode chosen above.
        <div className="mt-1">What matches when the trigger starts is the baseline; anything that comes to match later starts one run.</div>
      </div>
      <div className="col-span-2 rounded-lg bg-well p-2" aria-label="Matching now">
        <div className="flex items-center justify-between gap-2 px-1 pb-1.5 text-[11px] text-muted-foreground">
          <span>{previewing ? "Checking matches…" : `${preview.length} matching ${noun}${preview.length === 1 ? "" : "s"} now`}</span>
          {previewError && <span className="min-w-0 truncate text-destructive">{previewError}</span>}
        </div>
        {preview.length > 0 && (
          <div className="max-h-40 overflow-y-auto scrollbar-thin">
            {preview.map((match) => (
              <button key={match.id} type="button" onClick={() => void openUrl(match.url)} className="flex w-full min-w-0 items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-selected/30">
                <span className="shrink-0 font-mono text-muted-foreground">{match.identifier}</span>
                <span className="min-w-0 flex-1 truncate">{match.title}</span>
                <span className="shrink-0 truncate text-[11px] text-faint">{match.detail}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function LinearFields({ projectPath, source, onChange }: { projectPath: string; source: LinearIssueSource; onChange: (next: SourceChange<LinearIssueSource>) => void }) {
  const [teams, setTeams] = useState<IssueTeam[]>([]);
  const [teamsError, setTeamsError] = useState<string | null>(null);
  const [states, setStates] = useState<WorkflowState[]>([]);
  const [members, setMembers] = useState<IssueUser[]>([]);

  useEffect(() => {
    let live = true;
    issuesApi.linearTeams()
      .then((values) => {
        if (!live) return;
        setTeams(values);
        if (values[0]) onChange((current) => (current.teamId ? {} : { teamId: values[0].id, teamName: values[0].name }));
      })
      .catch((cause) => live && setTeamsError(errorMessage(cause)));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!source.teamId) return;
    let live = true;
    issueOps.options(projectPath, "linear", { teamId: source.teamId })
      .then((options) => {
        if (!live) return;
        setStates([...options.states].sort((a, b) => a.position - b.position));
        setMembers(options.members);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectPath, source.teamId]);

  const patchReport = (next: Partial<LinearIssueReport>) => onChange({ report: { ...source.report, ...next } });
  return (
    <>
      <label className={LABEL}>
        Team
        <select value={source.teamId} onChange={(event) => onChange({ teamId: event.target.value, teamName: teams.find((team) => team.id === event.target.value)?.name ?? null, report: { ...source.report, moveToStateId: null, moveToStateName: null } })} className={INPUT}>
          {!source.teamId && <option value="">Choose a team</option>}
          {source.teamId && !teams.some((team) => team.id === source.teamId) && <option value={source.teamId}>{source.teamName ?? source.teamId}</option>}
          {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
        </select>
        {teamsError && <span className="text-[11px] font-normal text-destructive">{teamsError}</span>}
      </label>
      <label className={LABEL}>
        State
        <select value={source.state ?? "open"} onChange={(event) => onChange({ state: event.target.value })} className={INPUT}>
          {LINEAR_STATES.map((state) => <option key={state.value} value={state.value}>{state.label}</option>)}
        </select>
      </label>
      <label className={LABEL}>
        Labels (any of)
        <ListInput value={source.labels} onChange={(labels) => onChange({ labels })} placeholder="bot" />
      </label>
      <label className={LABEL}>
        Assignee
        <select value={source.assignee ?? ""} onChange={(event) => onChange({ assignee: event.target.value || null })} className={INPUT}>
          <option value="">Anyone</option>
          <option value="me">Me</option>
          <option value="unassigned">Unassigned</option>
          {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select>
      </label>
      <label className={`${LABEL} col-span-2`}>
        Text in the title
        <input value={source.text ?? ""} onChange={(event) => onChange({ text: event.target.value || null })} className={INPUT} placeholder="Optional" />
      </label>
      <div className="col-span-2 border-t border-hairline pt-3 text-xs font-medium">Report back</div>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={source.report.comment} onChange={(event) => patchReport({ comment: event.target.checked })} /> Comment with the final response</label>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={source.report.commentOnFailure} onChange={(event) => patchReport({ commentOnFailure: event.target.checked })} /> Comment when a run fails</label>
      <label className={`${LABEL} col-span-2`}>
        Move the issue to
        <select value={source.report.moveToStateId ?? ""} onChange={(event) => patchReport({ moveToStateId: event.target.value || null, moveToStateName: states.find((state) => state.id === event.target.value)?.name ?? null })} className={INPUT}>
          <option value="">Leave it where it is</option>
          {source.report.moveToStateId && !states.some((state) => state.id === source.report.moveToStateId) && <option value={source.report.moveToStateId}>{source.report.moveToStateName ?? "Saved state"}</option>}
          {states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}
        </select>
      </label>
    </>
  );
}

function PullRequestFields({ projectPath, source, onChange }: { projectPath: string; source: PullRequestSource; onChange: (next: SourceChange<PullRequestSource>) => void }) {
  useEffect(() => {
    if (source.repo || !projectPath) return;
    let live = true;
    issuesApi.githubRepo(projectPath)
      .then((repo) => {
        if (live && repo) onChange((current) => (current.repo ? {} : { repo }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectPath, source.repo]);

  const toggle = (event: PullRequestEvent, on: boolean) => onChange({ events: on ? [...source.events.filter((value) => value !== event), event] : source.events.filter((value) => value !== event) });
  return (
    <>
      <label className={LABEL}>
        Repository
        <input value={source.repo} onChange={(event) => onChange({ repo: event.target.value })} className={`${INPUT} font-mono`} placeholder="owner/repo" />
      </label>
      <label className={LABEL}>
        Base branch
        <input value={source.base ?? ""} onChange={(event) => onChange({ base: event.target.value || null })} className={`${INPUT} font-mono`} placeholder="Any" />
      </label>
      <fieldset className="col-span-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs" aria-label="Pull request events">
        <legend className="mb-1.5 font-medium">Wake on</legend>
        {PR_EVENTS.map((event) => (
          <label key={event.value} className="flex items-center gap-2"><input type="checkbox" checked={source.events.includes(event.value)} onChange={(change) => toggle(event.value, change.target.checked)} /> {event.label}</label>
        ))}
      </fieldset>
      <label className={LABEL}>
        Author
        <input value={source.author ?? ""} onChange={(event) => onChange({ author: event.target.value || null })} className={`${INPUT} font-mono`} placeholder="Anyone" />
      </label>
      <label className={LABEL}>
        Labels (all of)
        <ListInput value={source.labels} onChange={(labels) => onChange({ labels })} placeholder="Optional" />
      </label>
      <label className={LABEL}>
        Drafts
        <select value={source.draft == null ? "" : String(source.draft)} onChange={(event) => onChange({ draft: event.target.value === "" ? null : event.target.value === "true" })} className={INPUT}>
          <option value="">Drafts and ready ones</option>
          <option value="false">Only ready for review</option>
          <option value="true">Only drafts</option>
        </select>
      </label>
      <div />
      <label className="col-span-2 flex items-center justify-between gap-3 rounded-lg bg-well px-3 py-2.5 text-xs">
        <span>
          <span className="block font-medium">Also wake on pull requests from forks</span>
          <span className="text-faint">Anyone can open one, and the run works on their code in the Permissions mode chosen above. Off by default: only branches of this repository wake a run. Those are pushed by people with write access, or by bots such as Dependabot and Renovate; filter by author to leave bots out.</span>
        </span>
        <Switch aria-label="Also wake on pull requests from forks" checked={!!source.fromForks} onCheckedChange={(fromForks) => onChange({ fromForks })} />
      </label>
      {source.fromForks && (
        <div role="note" className={WARNING_NOTE}>
          <span className="font-medium text-foreground">Runs can work on outsiders' code.</span> A pull request from a fork can contain anything; an unattended run that builds or tests it runs that code on this Mac.
        </div>
      )}
    </>
  );
}
