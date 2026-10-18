import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { Check, ChevronDown, CircleDot, ListFilter, Loader2, Search, Tag, UserRound, Users, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { PeoplePicker, PeoplePickerAction } from "@/components/issues/People";
import { errorMessage, type IssueTeam } from "@/lib/api";
import { issueOps, type IssueUser } from "@/lib/issueOps";
import { SORT_CHOICES, STATE_CHOICES, type IssueListFilter, type IssueListProvider } from "@/lib/issueListFilter";
import { cn } from "@/lib/cn";

/**
 * The Issues list's filters: state, assignee, labels, sort, and Linear's
 * team. Each is one menu; a change goes to `onChange` whole, and the view
 * keeps it per project and tracker. The people and labels offered are the
 * tracker's own (the repository's, or the team's; every team's together
 * when none is chosen), read when one of those menus is first opened.
 */
export function IssueListFilters({
  projectPath,
  provider,
  filter,
  onChange,
  teams,
  viewer,
}: {
  projectPath: string | null;
  provider: IssueListProvider;
  filter: IssueListFilter;
  onChange: (filter: IssueListFilter) => void;
  /** Linear's teams; empty for GitHub. */
  teams: IssueTeam[];
  viewer?: IssueUser | null;
}) {
  const choices = useFilterChoices(projectPath, provider, filter.teamId, teams);
  const set = (patch: Partial<IssueListFilter>) => onChange({ ...filter, ...patch });
  const state = STATE_CHOICES[provider].find((choice) => choice.value === filter.state) ?? STATE_CHOICES[provider][0];
  const sort = SORT_CHOICES[provider].find((choice) => choice.value === filter.sort) ?? SORT_CHOICES[provider][0];

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={`State: ${state.label}`} className={cn("gap-1 text-xs", filter.state !== "open" && "bg-veil-strong text-foreground")}>
            <CircleDot className="size-3.5" />
            {state.label}
            <ChevronDown className="text-faint" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup value={state.value} onValueChange={(value) => set({ state: value })}>
            {STATE_CHOICES[provider].map((choice) => (
              <DropdownMenuRadioItem key={choice.value} value={choice.value}>
                {choice.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <AssigneeFilterMenu filter={filter} onChange={(assignee) => set({ assignee })} choices={choices} viewer={viewer} />
      <LabelFilterMenu provider={provider} labels={filter.labels} onChange={(labels) => set({ labels })} choices={choices} />
      {provider === "linear" && teams.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1 text-xs">
              {teams.find((t) => t.id === filter.teamId)?.name ?? "All teams"}
              <ChevronDown className="text-faint" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => set({ teamId: null })}>All teams</DropdownMenuItem>
            {teams.map((t) => (
              <DropdownMenuItem key={t.id} onSelect={() => set({ teamId: t.id })}>
                <span className="font-mono text-[11px] text-faint">{t.key}</span>
                <span>{t.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={`Sort: ${sort.label}`} className="gap-1 text-xs">
            <ListFilter className="size-3.5" />
            {sort.label}
            <ChevronDown className="text-faint" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup value={sort.value} onValueChange={(value) => set({ sort: value as IssueListFilter["sort"] })}>
            {SORT_CHOICES[provider].map((choice) => (
              <DropdownMenuRadioItem key={choice.value} value={choice.value}>
                {choice.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

interface FilterChoices {
  people: IssueUser[];
  labels: { name: string; color: string }[];
  loading: boolean;
  error: string | null;
  /** Reads them, once per repository or team set. */
  load: () => void;
}

/** The people and labels the filter menus offer, read on first use. */
function useFilterChoices(projectPath: string | null, provider: IssueListProvider, teamId: string | null, teams: IssueTeam[]): FilterChoices {
  // Every team's, when none is chosen: Linear's options are per team.
  const scopes = useMemo(() => (provider === "github" ? [null] : teamId ? [teamId] : teams.slice(0, 10).map((team) => team.id)), [provider, teamId, teams]);
  const key = projectPath ? `${projectPath}\n${provider}\n${scopes.join(",")}` : null;
  const [state, setState] = useState<{ key: string | null; people: IssueUser[]; labels: FilterChoices["labels"]; loading: boolean; error: string | null }>({ key: null, people: [], labels: [], loading: false, error: null });
  const asked = useRef<string | null>(null);
  const current = useRef(key);
  current.current = key;

  const load = () => {
    if (!key || !projectPath || asked.current === key || (provider === "linear" && scopes.length === 0)) return;
    asked.current = key;
    setState({ key, people: [], labels: [], loading: true, error: null });
    Promise.all(scopes.map((teamId) => issueOps.options(projectPath, provider, { teamId })))
      .then((all) => {
        if (current.current !== key) return;
        const people = new Map<string, IssueUser>();
        const labels = new Map<string, FilterChoices["labels"][number]>();
        for (const options of all) {
          options.members.forEach((person) => people.has(person.id) || people.set(person.id, person));
          options.labels.filter((label) => !label.isGroup).forEach((label) => labels.has(label.name) || labels.set(label.name, { name: label.name, color: label.color }));
        }
        setState({ key, people: [...people.values()], labels: [...labels.values()], loading: false, error: null });
      })
      .catch((e) => {
        if (current.current !== key) return;
        asked.current = null;
        setState({ key, people: [], labels: [], loading: false, error: errorMessage(e) });
      });
  };

  const mine = state.key === key;
  return { people: mine ? state.people : [], labels: mine ? state.labels : [], loading: mine && state.loading, error: mine ? state.error : null, load };
}

function ChoicesStatus({ choices, what }: { choices: FilterChoices; what: string }) {
  if (choices.error) return <div role="alert" className="px-3 py-2 text-xs text-destructive">{choices.error}</div>;
  if (choices.loading) return <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-faint"><Loader2 className="size-3.5 animate-spin" /> Loading {what}…</div>;
  return null;
}

const popoverClass = "z-(--z-menu) w-64 max-w-[calc(100vw-16px)] overflow-hidden rounded-lg bg-popover glass text-popover-foreground shadow-surface hairline animate-fade-in";

function AssigneeFilterMenu({
  filter,
  onChange,
  choices,
  viewer,
}: {
  filter: IssueListFilter;
  onChange: (assignee: IssueListFilter["assignee"]) => void;
  choices: FilterChoices;
  viewer?: IssueUser | null;
}) {
  const [open, setOpen] = useState(false);
  const assignee = filter.assignee;
  const label = !assignee ? "Anyone" : assignee.kind === "me" ? "Assigned to me" : assignee.kind === "unassigned" ? "Unassigned" : assignee.name ?? assignee.id;
  const choose = (value: IssueListFilter["assignee"]) => {
    setOpen(false);
    onChange(value);
  };
  const personId = assignee?.kind === "person" ? assignee.id : null;
  const personName = assignee?.kind === "person" ? assignee.name : undefined;
  // Kept the same between renders: the picker takes its order afresh when these change.
  const chosen = useMemo(() => (personId ? [choices.people.find((person) => person.id === personId) ?? { id: personId, name: personName ?? personId }] : []), [choices.people, personId, personName]);
  // The reader is "Assigned to me", so is not offered again among the people.
  const people = useMemo(() => (viewer ? choices.people.filter((person) => person.id !== viewer.id) : choices.people), [choices.people, viewer]);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) choices.load();
      }}
    >
      <Popover.Trigger asChild>
        <Button variant="ghost" size="sm" aria-label={`Assignee: ${label}`} className={cn("max-w-48 gap-1 text-xs", assignee && "bg-veil-strong text-foreground")}>
          <UserRound className="size-3.5" />
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="text-faint" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content aria-label="Filter by assignee" sideOffset={4} align="start" collisionPadding={8} className={popoverClass}>
          {choices.error || (choices.loading && !choices.people.length) ? (
            <>
              <div className="flex flex-col border-b border-hairline p-1">
                <AssigneeActions assignee={assignee} choose={choose} />
              </div>
              <ChoicesStatus choices={choices} what="people" />
            </>
          ) : (
            <PeoplePicker
              label="People"
              people={people}
              chosen={chosen}
              onPick={(person) => choose({ kind: "person", id: person.id, name: person.name })}
              placeholder="Search people"
              actions={<AssigneeActions assignee={assignee} choose={choose} />}
            />
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AssigneeActions({ assignee, choose }: { assignee: IssueListFilter["assignee"]; choose: (value: IssueListFilter["assignee"]) => void }) {
  const mark = (on: boolean) => <Check className={cn("ml-auto", !on && "invisible")} />;
  return (
    <>
      <PeoplePickerAction icon={<Users />} onClick={() => choose(null)}>
        <span className="flex items-center gap-2">Anyone {mark(!assignee)}</span>
      </PeoplePickerAction>
      <PeoplePickerAction icon={<UserRound />} onClick={() => choose({ kind: "me" })}>
        <span className="flex items-center gap-2">Assigned to me {mark(assignee?.kind === "me")}</span>
      </PeoplePickerAction>
      <PeoplePickerAction icon={<X />} onClick={() => choose({ kind: "unassigned" })}>
        <span className="flex items-center gap-2">Unassigned {mark(assignee?.kind === "unassigned")}</span>
      </PeoplePickerAction>
    </>
  );
}

function LabelFilterMenu({
  provider,
  labels,
  onChange,
  choices,
}: {
  provider: IssueListProvider;
  labels: string[];
  onChange: (labels: string[]) => void;
  choices: FilterChoices;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  // A chosen label the tracker no longer offers can still be taken off.
  const all = useMemo(() => [...choices.labels, ...labels.filter((name) => !choices.labels.some((label) => label.name === name)).map((name) => ({ name, color: "" }))], [choices.labels, labels]);
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    return all.filter((label) => !words || label.name.toLowerCase().includes(words));
  }, [all, query]);
  useEffect(() => setActive(0), [query]);
  const toggle = (name: string) => onChange(labels.includes(name) ? labels.filter((each) => each !== name) : [...labels, name]);
  const label = labels.length === 0 ? "Labels" : labels.length === 1 ? labels[0] : `${labels.length} labels`;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) choices.load();
      }}
    >
      <Popover.Trigger asChild>
        <Button variant="ghost" size="sm" aria-label={labels.length ? `Labels: ${labels.join(", ")}` : "Labels: any"} className={cn("max-w-48 gap-1 text-xs", labels.length > 0 && "bg-veil-strong text-foreground")}>
          <Tag className="size-3.5" />
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="text-faint" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content aria-label="Filter by labels" sideOffset={4} align="start" collisionPadding={8} className={popoverClass}>
          <div className="flex h-8 items-center gap-1.5 border-b border-hairline px-2">
            <Search className="size-3.5 shrink-0 text-faint" />
            <input
              autoFocus
              aria-label="Search labels"
              placeholder="Search labels"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  if (shown.length) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
                } else if (e.key === "Enter" && !e.nativeEvent.isComposing && shown[active]) {
                  e.preventDefault();
                  toggle(shown[active].name);
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-faint"
            />
          </div>
          <ChoicesStatus choices={choices} what="labels" />
          <div role="listbox" aria-label="Labels" aria-multiselectable className="max-h-64 overflow-y-auto p-1 scrollbar-thin">
            {!choices.loading && shown.length === 0 && <div className="px-2 py-1.5 text-xs text-faint">{all.length ? "No labels match." : "There are no labels here."}</div>}
            {shown.map((each, index) => {
              const on = labels.includes(each.name);
              return (
                <div
                  key={each.name}
                  role="option"
                  aria-selected={on}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggle(each.name)}
                  className={cn("flex cursor-default items-center gap-2 rounded-md px-2 py-1 text-[13px]", index === active && "bg-veil-strong")}
                >
                  <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: each.color ? `#${each.color}` : "var(--ink-faint)" }} />
                  <span className="min-w-0 flex-1 truncate">{each.name}</span>
                  {on && <Check className="size-3.5 shrink-0 text-muted-foreground" />}
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-2 border-t border-hairline px-3 py-1.5 text-[11px] text-faint">
            <span className="min-w-0 flex-1">{provider === "github" ? "Issues with all of these" : "Issues with any of these"}</span>
            {labels.length > 0 && (
              <button type="button" onClick={() => onChange([])} className="shrink-0 hover:text-foreground">
                Clear
              </button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
