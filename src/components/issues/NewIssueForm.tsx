import { useCallback, useEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { ChevronDown, FileText, Loader2, Plus, UserPlus, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { WithTooltip } from "@/components/ui/tooltip";
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
import { MarkdownEditor } from "@/components/issues/MarkdownEditor";
import { AvatarStack, PeoplePicker, PeoplePickerAction } from "@/components/issues/People";
import { LabelChooser, LabelDot, PRIORITY_NAMES, PriorityIcon, useEscapeCancels } from "@/components/issues/IssueFields";
import { groupWorkflowStates } from "@/components/issues/IssueStatusPicker";
import { errorMessage, issues, type IssueTeam } from "@/lib/api";
import { clearIssueDraft, draftHasContent, emptyIssueDraft, getIssueDraft, issueDraftRevision, setIssueDraft, type IssueDraft } from "@/lib/newIssueDrafts";
import { isIssueOpError, issueOps, type IssueCreate, type IssueDetails, type IssueOptions, type IssueProvider, type IssueTemplate, type IssueUser } from "@/lib/issueOps";
import { issueViewer } from "@/lib/issueViewer";
import { bindingText } from "@/lib/shortcuts";

/**
 * A new issue, written without leaving TerminalX: in the project's GitHub
 * repository or in a Linear team. Title and description, and optionally
 * assignees, labels and (on Linear) the state and priority, from the same
 * people and labels the detail pane's pickers offer. A GitHub repository's
 * Markdown templates fill the description.
 *
 * What is typed is the project's and provider's draft (`newIssueDrafts`): it
 * outlives the form, and is cleared only once the issue is created. A failed
 * create keeps it all and says why.
 *
 * Render it keyed by project and provider.
 */

const draftKey = (projectPath: string, provider: IssueProvider) => `${provider}:${projectPath}`;

/**
 * The creates on their way, by project and provider. A form closed and
 * opened again while its issue is being created shows it still busy, and
 * how it ended, rather than offer to create it twice.
 */
const creating = new Map<string, Promise<IssueDetails>>();

/** How a create ended badly; kept here when the form was closed meanwhile, and said when it opens again. */
interface Failure {
  message: string;
  /** The answer was lost, not refused: the issue may exist all the same. */
  uncertain: boolean;
}
const failed = new Map<string, Failure>();

/** A create whose answer never came, and no issue it could have made turned up. */
class Unanswered {
  constructor(readonly cause: unknown) {}
}

// A dropped connection, a timeout or a reply that couldn't be read can all come after the provider made the issue.
const unanswered = (e: unknown) => !isIssueOpError(e) || e.kind === "network" || e.kind === "other";

function failureOf(e: unknown): Failure {
  if (e instanceof Unanswered) {
    return {
      message: `${errorMessage(e.cause)} The issue may have been created all the same, but it isn't in the list: look there before you create it again. Nothing was lost: what you wrote is still here.`,
      uncertain: true,
    };
  }
  return { message: `${errorMessage(e)} Nothing was lost: what you wrote is still here.`, uncertain: false };
}

// How long before the create was sent an issue found afterwards may say it was made: the clocks may differ.
const CLOCK_SLACK_MS = 2 * 60_000;

/**
 * The issue a create whose answer was lost made, if it did: one with the
 * same title, by the reader, made since the create was sent. The list is
 * read without a search, newest first: GitHub's search index lags behind.
 */
export async function findJustCreated(projectPath: string, provider: IssueProvider, input: IssueCreate, viewer: IssueUser | null | undefined, since: number): Promise<IssueDetails | null> {
  const me = viewer ?? (await issueViewer(projectPath, provider).catch(() => null));
  if (!me) return null;
  // Newest first, whatever its state: the create may have put it straight into a closed one.
  const rows = await issues.list(projectPath, provider, { state: "all", sort: "created", teamId: provider === "linear" ? input.teamId : null });
  for (const row of rows.filter((each) => each.title.trim() === input.title).slice(0, 3)) {
    const issue = await issueOps.details(projectPath, provider, row.id).catch(() => null);
    if (issue && issue.author?.id === me.id && Date.parse(issue.createdAt) >= since - CLOCK_SLACK_MS) return issue;
  }
  return null;
}

async function createOrFind(projectPath: string, provider: IssueProvider, input: IssueCreate, viewer: IssueUser | null | undefined): Promise<IssueDetails> {
  const since = Date.now();
  try {
    return await issueOps.create(projectPath, provider, input);
  } catch (e) {
    if (!unanswered(e)) throw e;
    const found = await findJustCreated(projectPath, provider, input, viewer, since).catch(() => null);
    if (found) return found;
    throw new Unanswered(e);
  }
}

/** What the provider is asked to create: the draft, with only the labels and people it still offers. */
export function createInput(draft: IssueDraft, provider: IssueProvider, options: IssueOptions | null): IssueCreate {
  const labels = options ? draft.labels.filter((id) => options.labels.some((label) => label.id === id && !label.isGroup)) : draft.labels;
  const assignees = (options ? draft.assignees.filter((person) => options.members.some((member) => member.id === person.id)) : draft.assignees).map((person) => person.id);
  return {
    teamId: provider === "linear" ? draft.teamId : null,
    title: draft.title.trim(),
    description: draft.description,
    assignees,
    labels,
    stateId: provider === "linear" ? draft.stateId : null,
    priority: provider === "linear" ? draft.priority : null,
  };
}

/** The draft once `template` is chosen: its body, and its title and labels where the draft has none. */
export function applyTemplate(draft: IssueDraft, template: IssueTemplate | null, options: IssueOptions | null): IssueDraft {
  if (!template) return { ...draft, template: null, description: "" };
  const labels = [...draft.labels];
  for (const name of template.labels) {
    // GitHub names labels by name; the repository's own spelling is the one it takes.
    const known = options?.labels.find((label) => label.name.toLowerCase() === name.toLowerCase());
    const id = known?.id ?? (options ? null : name);
    if (id && !labels.includes(id)) labels.push(id);
  }
  const assignees = [...draft.assignees];
  for (const login of template.assignees) {
    const member = options?.members.find((person) => person.id.toLowerCase() === login.toLowerCase());
    const person = member ?? (options ? null : { id: login, name: login, login });
    if (person && !assignees.some((each) => each.id === person.id)) assignees.push(person);
  }
  return {
    ...draft,
    template: template.file,
    description: template.body,
    title: draft.title.trim() ? draft.title : (template.title ?? draft.title),
    labels,
    assignees,
  };
}

export function NewIssueForm({
  projectPath,
  provider,
  onProviderChange,
  repo,
  teams,
  defaultTeamId,
  viewer,
  unavailable,
  onCreated,
  onClose,
}: {
  projectPath: string;
  provider: IssueProvider;
  onProviderChange: (provider: IssueProvider) => void;
  /** `owner/repo`, for GitHub. */
  repo: string | null;
  /** Linear's teams; empty while they are read. */
  teams: IssueTeam[];
  /** The team the list is narrowed to, which a new draft starts in. */
  defaultTeamId: string | null;
  viewer?: IssueUser | null;
  /** Why no issue can be created here (no `gh`, no Linear key), shown instead of the form. */
  unavailable?: string | null;
  /** The issue as the provider created it. Called even when the form has been closed since. */
  onCreated: (projectPath: string, issue: IssueDetails) => void;
  /** Closed without creating: the draft is kept. */
  onClose: () => void;
}) {
  const key = draftKey(projectPath, provider);
  const [draft, setDraftState] = useState<IssueDraft>(() => getIssueDraft(projectPath, provider) ?? emptyIssueDraft(provider === "linear" ? defaultTeamId : null));
  const [busy, setBusy] = useState(() => creating.has(key));
  const [error, setError] = useState<string | null>(null);
  // The last create may have made the issue though no answer came: creating again says so.
  const [uncertain, setUncertain] = useState(false);
  const [options, setOptions] = useState<IssueOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<IssueTemplate[]>([]);
  // A template chosen over a description that was typed, until the reader says whether to replace it.
  const [replacing, setReplacing] = useState<IssueTemplate | null>(null);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const titleBox = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const update = useCallback(
    (change: (draft: IssueDraft) => IssueDraft) => {
      setDraftState((now) => {
        const next = change(now);
        setIssueDraft(projectPath, provider, next);
        return next;
      });
      setError(null);
    },
    [projectPath, provider],
  );

  // A Linear draft with no team yet takes the one the list is narrowed to, or the only one there is.
  useEffect(() => {
    if (provider !== "linear" || draft.teamId) return;
    const team = defaultTeamId ?? (teams.length === 1 ? teams[0].id : null);
    if (!team) return;
    setDraftState((now) => {
      if (now.teamId) return now;
      const next = { ...now, teamId: team };
      // A draft with something in it keeps its team; an empty one takes the list's again next time.
      if (draftHasContent(next)) setIssueDraft(projectPath, provider, next);
      return next;
    });
  }, [projectPath, provider, draft.teamId, defaultTeamId, teams]);

  const scope = provider === "linear" ? draft.teamId : "repo";
  useEffect(() => {
    setOptions(null);
    setOptionsError(null);
    if (!scope || unavailable) return;
    let on = true;
    issueOps
      .options(projectPath, provider, provider === "linear" ? { teamId: scope } : {})
      .then((value) => on && setOptions(value))
      .catch((e) => on && setOptionsError(errorMessage(e)));
    return () => {
      on = false;
    };
  }, [projectPath, provider, scope, unavailable]);

  useEffect(() => {
    if (provider !== "github" || unavailable) return setTemplates([]);
    let on = true;
    issueOps
      .templates(projectPath)
      .then((value) => on && setTemplates(value))
      .catch(() => on && setTemplates([]));
    return () => {
      on = false;
    };
  }, [projectPath, provider, unavailable]);

  // A create on its way when the form opened: shown busy until it ends, and its failure said here.
  const watch = useCallback(
    (pending: Promise<IssueDetails>) => {
      setBusy(true);
      pending.then(
        () => {
          if (!live.current) return;
          setBusy(false);
          setUncertain(false);
          setDraftState(getIssueDraft(projectPath, provider) ?? emptyIssueDraft(provider === "linear" ? defaultTeamId : null));
        },
        (e) => {
          if (!live.current) return;
          setBusy(false);
          const failure = failed.get(key) ?? failureOf(e);
          failed.delete(key);
          setError(failure.message);
          setUncertain(failure.uncertain);
          titleBox.current?.focus({ preventScroll: true });
        },
      );
    },
    [key, projectPath, provider, defaultTeamId],
  );
  useEffect(() => {
    const pending = creating.get(key);
    if (pending) return watch(pending);
    // One that failed after the form was closed: said now.
    const failure = failed.get(key);
    if (!failure) return;
    failed.delete(key);
    setError(failure.message);
    setUncertain(failure.uncertain);
  }, [key, watch]);

  const multiple = !!options?.capabilities.multiAssignee;
  const maxAssignees = options?.capabilities.maxAssignees ?? 1;
  const known = (id: string) => options?.labels.find((label) => label.id === id);
  // Before the options come, what the draft holds is shown as it was picked.
  const shownLabels = options ? draft.labels.filter((id) => known(id)) : draft.labels;
  const me = viewer && options?.members.find((person) => person.id === viewer.id);
  const state = options?.states.find((each) => each.id === draft.stateId) ?? null;
  const team = teams.find((each) => each.id === draft.teamId) ?? null;
  const template = templates.find((each) => each.file === draft.template) ?? null;
  const missing = !draft.title.trim() ? "Give the issue a title." : provider === "linear" && !draft.teamId ? "Choose a team." : null;

  const submit = () => {
    if (busy) return;
    if (missing) {
      setError(missing);
      if (!draft.title.trim()) titleBox.current?.focus();
      return;
    }
    // Only the draft that was sent: one typed since, in a form opened again, stays.
    const revision = issueDraftRevision(projectPath, provider);
    const pending = createOrFind(projectPath, provider, createInput(draft, provider, options), viewer).then((issue) => {
      if (issueDraftRevision(projectPath, provider) === revision) clearIssueDraft(projectPath, provider);
      return issue;
    });
    creating.set(key, pending);
    const done = () => creating.get(key) === pending && creating.delete(key);
    pending.then(done, (e) => {
      failed.set(key, failureOf(e));
      done();
    });
    pending.then((issue) => onCreated(projectPath, issue), () => {});
    setError(null);
    watch(pending);
  };

  const close = useCallback(() => onClose(), [onClose]);
  // Not while the create is out: its failure is said here.
  useEscapeCancels(box, true, close, busy);

  const chooseTemplate = (next: IssueTemplate | null) => {
    setReplacing(null);
    const typed = draft.description.trim() && draft.description !== (template?.body ?? "");
    if (typed && next) return setReplacing(next);
    update((now) => applyTemplate(now, next, options));
  };

  const pickPerson = (person: IssueUser) => {
    update((now) => {
      const chosen = now.assignees.some((each) => each.id === person.id);
      if (!multiple) return { ...now, assignees: chosen ? [] : [person] };
      if (chosen) return { ...now, assignees: now.assignees.filter((each) => each.id !== person.id) };
      return now.assignees.length < maxAssignees ? { ...now, assignees: [...now.assignees, person] } : now;
    });
    if (!multiple) setPeopleOpen(false);
  };

  const header = (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-5 pb-3 pt-4">
      <h2 className="mr-auto text-[15px] font-semibold leading-snug">New issue</h2>
      <Segmented<IssueProvider>
        aria-label="Create on"
        value={provider}
        onChange={(value) => !busy && onProviderChange(value)}
        options={[
          { value: "github", label: "GitHub" },
          { value: "linear", label: "Linear" },
        ]}
      />
      <WithTooltip label="Close (the draft is kept)">
        <Button variant="ghost" size="icon-xs" aria-label="Close" onClick={close}>
          <X />
        </Button>
      </WithTooltip>
    </div>
  );

  if (unavailable) {
    return (
      <div ref={box} className="flex min-h-0 flex-1 flex-col" data-testid="new-issue">
        {header}
        <div className="px-5 py-4 text-sm text-muted-foreground">{unavailable}</div>
      </div>
    );
  }

  const chip = "flex h-6 min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-veil-raised hover:text-foreground data-[state=open]:bg-veil-raised data-[state=open]:text-foreground";

  return (
    <div ref={box} className="flex min-h-0 flex-1 flex-col" data-testid="new-issue">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px] text-muted-foreground">
            {provider === "github" ? (
              <span className="min-w-0 truncate">
                In <span className="font-mono text-foreground">{repo ?? "this project's repository"}</span>
              </span>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" size="xs" className="min-w-0 gap-1" aria-label={team ? `Team: ${team.name}` : "Choose a team"}>
                    {team ? (
                      <>
                        <span className="font-mono text-faint">{team.key}</span>
                        <span className="truncate">{team.name}</span>
                      </>
                    ) : teams.length ? (
                      "Choose a team"
                    ) : (
                      <>
                        <Loader2 className="animate-spin" /> Loading teams…
                      </>
                    )}
                    <ChevronDown className="text-faint" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto scrollbar-thin">
                  <DropdownMenuLabel>Team</DropdownMenuLabel>
                  {teams.map((each) => (
                    <DropdownMenuItem
                      key={each.id}
                      onSelect={() =>
                        each.id !== draft.teamId &&
                        // Another team has its own states, labels and people.
                        update((now) => ({ ...now, teamId: each.id, stateId: null, labels: [], assignees: [] }))
                      }
                    >
                      <span className="font-mono text-[11px] text-faint">{each.key}</span>
                      <span className="truncate">{each.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {templates.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="xs" className="min-w-0 gap-1" aria-label={`Template: ${template?.name ?? "None"}`}>
                    <FileText />
                    <span className="truncate">{template?.name ?? "Template"}</span>
                    <ChevronDown className="text-faint" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-w-[20rem]">
                  <DropdownMenuLabel>Templates</DropdownMenuLabel>
                  {templates.map((each) => (
                    <DropdownMenuItem key={each.file} onSelect={() => chooseTemplate(each)} className="flex-col items-start gap-0">
                      <span>{each.name}</span>
                      {each.about && <span className="text-[11px] text-faint">{each.about}</span>}
                    </DropdownMenuItem>
                  ))}
                  {template && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => update((now) => ({ ...now, template: null }))}>No template</DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          {replacing && (
            <div role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md bg-warning/10 px-3 py-2 text-xs">
              <span className="min-w-0 flex-1 basis-48 text-warning">Replace your description with the “{replacing.name}” template?</span>
              <div className="flex shrink-0 gap-1.5">
                <Button variant="ghost" size="xs" onClick={() => setReplacing(null)}>
                  Keep mine
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => {
                    const chosen = replacing;
                    setReplacing(null);
                    update((now) => applyTemplate(now, chosen, options));
                  }}
                >
                  Replace
                </Button>
              </div>
            </div>
          )}

          <input
            ref={titleBox}
            autoFocus
            aria-label="Title"
            placeholder="Title"
            value={draft.title}
            readOnly={busy}
            aria-busy={busy || undefined}
            onChange={(e) => update((now) => ({ ...now, title: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (e.metaKey || e.ctrlKey) submit();
              }
            }}
            className="w-full min-w-0 rounded-md bg-well px-2.5 py-1.5 text-[15px] font-semibold leading-snug outline-none placeholder:font-normal placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/30 read-only:opacity-60"
          />

          <MarkdownEditor
            label="Description"
            placeholder="Add a description…"
            rows={8}
            value={draft.description}
            readOnly={busy}
            onChange={(description) => update((now) => ({ ...now, description }))}
            onSubmit={submit}
          />

          <div className="flex min-w-0 flex-wrap items-center gap-1" data-testid="new-issue-fields">
            <Popover.Root open={peopleOpen} onOpenChange={setPeopleOpen}>
              <Popover.Trigger asChild>
                <button type="button" className={chip} aria-label={draft.assignees.length ? `Assignees: ${draft.assignees.map((person) => person.name).join(", ")}` : "Assign"}>
                  {draft.assignees.length ? <AvatarStack people={draft.assignees} avatarClassName="size-4" /> : <UserPlus className="size-3.5 shrink-0" />}
                  <span className="min-w-0 truncate">{draft.assignees.length ? draft.assignees.map((person) => person.name).join(", ") : "Assignee"}</span>
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  aria-label="Assignees"
                  sideOffset={4}
                  align="start"
                  collisionPadding={8}
                  className="z-(--z-menu) w-64 max-w-[calc(100vw-16px)] overflow-hidden rounded-lg bg-popover glass text-popover-foreground shadow-surface hairline animate-fade-in"
                >
                  {optionsError ? (
                    <div role="alert" className="px-3 py-2 text-xs text-destructive">{optionsError}</div>
                  ) : !options ? (
                    <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-faint">
                      {scope ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" /> Loading people…
                        </>
                      ) : (
                        "Choose a team first."
                      )}
                    </div>
                  ) : (
                    <PeoplePicker
                      label="Assignees"
                      people={options.members}
                      chosen={draft.assignees}
                      multiple={multiple}
                      isDisabled={(_, chosen) => multiple && !chosen && draft.assignees.length >= maxAssignees}
                      onPick={pickPerson}
                      placeholder={multiple ? "Search assignable people" : "Search team members"}
                      actions={
                        (me && !draft.assignees.some((person) => person.id === me.id)) || draft.assignees.length > 0 ? (
                          <>
                            {me && !draft.assignees.some((person) => person.id === me.id) && (
                              <PeoplePickerAction icon={<UserPlus />} disabled={multiple && draft.assignees.length >= maxAssignees} onClick={() => pickPerson(me)}>
                                Assign to me
                              </PeoplePickerAction>
                            )}
                            {draft.assignees.length > 0 && (
                              <PeoplePickerAction
                                icon={<X />}
                                onClick={() => {
                                  update((now) => ({ ...now, assignees: [] }));
                                  if (!multiple) setPeopleOpen(false);
                                }}
                              >
                                {multiple ? "Clear" : "Unassign"}
                              </PeoplePickerAction>
                            )}
                          </>
                        ) : null
                      }
                    />
                  )}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            <Popover.Root open={labelsOpen} onOpenChange={setLabelsOpen}>
              <Popover.Trigger asChild>
                <button type="button" className={chip} aria-label={shownLabels.length ? `Labels: ${shownLabels.map((id) => known(id)?.name ?? id).join(", ")}` : "Add labels"}>
                  {shownLabels.length ? (
                    shownLabels.map((id) => (
                      <span key={id} className="flex min-w-0 items-center gap-1 rounded-full bg-veil-raised px-1.5 py-px">
                        <LabelDot color={known(id)?.color} />
                        <span className="truncate">{known(id)?.name ?? id}</span>
                      </span>
                    ))
                  ) : (
                    <>
                      <Plus className="size-3.5 shrink-0" /> Label
                    </>
                  )}
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  align="start"
                  sideOffset={4}
                  collisionPadding={8}
                  className="z-(--z-menu) w-64 max-w-[calc(100vw-1rem)] rounded-lg bg-popover glass pt-1.5 text-popover-foreground shadow-surface hairline outline-none data-[state=open]:animate-fade-in"
                >
                  {scope ? (
                    <LabelChooser labels={options?.labels ?? null} error={optionsError} chosen={draft.labels} onChange={(labels) => update((now) => ({ ...now, labels }))} />
                  ) : (
                    <div className="px-3 pb-2 text-xs text-faint">Choose a team first.</div>
                  )}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            {provider === "linear" && (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className={chip} aria-label={`Status: ${state?.name ?? "Team default"}`} disabled={!scope}>
                      <span className="size-2 shrink-0 rounded-full" style={{ background: state?.color ? `#${state.color}` : "var(--ink-faint)" }} />
                      <span className="truncate">{state?.name ?? "Status"}</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-h-(--radix-dropdown-menu-content-available-height) max-w-[18rem] overflow-y-auto scrollbar-thin">
                    {!options ? (
                      <p className="flex items-center gap-1.5 px-2 py-1 text-xs text-faint">
                        {optionsError ?? (
                          <>
                            <Loader2 className="size-3 animate-spin" /> Loading states…
                          </>
                        )}
                      </p>
                    ) : (
                      <DropdownMenuRadioGroup value={draft.stateId ?? ""} onValueChange={(id) => update((now) => ({ ...now, stateId: id || null }))}>
                        <DropdownMenuRadioItem value="">The team's default</DropdownMenuRadioItem>
                        {groupWorkflowStates(options.states).map((group) => (
                          <div key={group.type} role="group" aria-label={group.label}>
                            <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                            {group.states.map((each) => (
                              <DropdownMenuRadioItem key={each.id} value={each.id}>
                                <span className="size-2 shrink-0 rounded-full" style={{ background: each.color ? `#${each.color}` : "var(--ink-faint)" }} />
                                <span className="truncate">{each.name}</span>
                              </DropdownMenuRadioItem>
                            ))}
                          </div>
                        ))}
                      </DropdownMenuRadioGroup>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className={chip} aria-label={`Priority: ${PRIORITY_NAMES[draft.priority ?? 0]}`}>
                      <PriorityIcon value={draft.priority ?? 0} />
                      <span className="truncate">{draft.priority ? PRIORITY_NAMES[draft.priority] : "Priority"}</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuRadioGroup value={String(draft.priority ?? 0)} onValueChange={(value) => update((now) => ({ ...now, priority: Number(value) || null }))}>
                      {(options?.priorities.length ? options.priorities : PRIORITY_NAMES.map((label, value) => ({ value, label }))).map((choice) => (
                        <DropdownMenuRadioItem key={choice.value} value={String(choice.value)}>
                          <PriorityIcon value={choice.value} />
                          {choice.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>

          {error && (
            <div role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5">
            <span className="mr-auto min-w-0 text-[11px] text-faint">{bindingText("mod+enter")} to create · Esc to close, keeping the draft</span>
            {draftHasContent(draft) && (
              <Button
                variant="ghost"
                size="sm"
                aria-disabled={busy}
                onClick={() => {
                  if (busy) return;
                  setReplacing(null);
                  update(() => emptyIssueDraft(draft.teamId));
                }}
              >
                Discard draft
              </Button>
            )}
            {/* Never disabled: a disabled button drops the focus, and the keys with it. */}
            <Button variant="accent" size="sm" aria-disabled={busy || !!missing} onClick={submit} title={missing ?? undefined}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? "Creating…" : uncertain ? "Create again" : "Create issue"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
