import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Check, Copy, Loader2, Pencil, Plus, Search, TriangleAlert } from "@/icons";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { IssueMarkdownEditor } from "@/components/issues/IssueMarkdownEditor";
import { errorMessage, type Issue } from "@/lib/api";
import { hasEscapeOverlay, useHotkey } from "@/lib/hotkeys";
import { issueOps, isIssueOpError, type IssueDetails, type IssueOptions, type IssueProvider, type LabelOption } from "@/lib/issueOps";
import { cn } from "@/lib/cn";

/**
 * Editing an issue's title, labels, priority and description from its detail
 * pane (PRO-97). Every change is one explicit write through `issueOps`, and
 * the pane then shows the issue as the provider answered it. Labels, priority
 * and title change on screen at once and go back, with the reason, when the
 * write fails.
 */

/** The issue read whole, once it has been: a list row has no capabilities and cannot be edited. */
export function editableIssue(issue: Issue | null | undefined): IssueDetails | null {
  return issue && (issue as IssueDetails).capabilities ? (issue as IssueDetails) : null;
}

type Write = (projectPath: string, provider: IssueProvider, id: string) => Promise<IssueDetails>;

export interface IssueEdits {
  issue: IssueDetails | null;
  projectPath: string | null;
  /** Runs one write; `optimistic` is shown until the provider answers. False when it failed. */
  write: (op: Write, optimistic?: Partial<IssueDetails>) => Promise<boolean>;
  /** Shows an issue read or written outside `write`, as the newest answer for it. */
  accept: (issue: IssueDetails) => void;
  error: string | null;
  options: IssueOptions | null;
  optionsError: string | null;
  loadOptions: () => void;
  onChanged: (issue: IssueDetails) => void;
}

const keyOf = (projectPath: string | null, issue: Pick<Issue, "provider" | "id"> | null) => (issue && projectPath ? `${projectPath}:${issue.provider}:${issue.id}` : null);

export function useIssueEdits(projectPath: string | null, issue: IssueDetails | null, onChanged: (issue: IssueDetails) => void): IssueEdits {
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<IssueOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const key = keyOf(projectPath, issue);
  const current = useRef({ key, issue });
  current.current = { key, issue };
  const optionsFor = useRef<string | null>(null);
  useEffect(() => {
    setError(null);
    setOptions(null);
    setOptionsError(null);
    optionsFor.current = null;
  }, [key]);

  const loadOptions = useCallback(() => {
    const { key: asked, issue: of } = current.current;
    if (!asked || !of || !projectPath || optionsFor.current === asked) return;
    optionsFor.current = asked;
    setOptionsError(null);
    issueOps
      .options(projectPath, of.provider, { id: of.id })
      .then((value) => current.current.key === asked && setOptions(value))
      .catch((e) => {
        if (current.current.key !== asked) return;
        optionsFor.current = null;
        setOptionsError(errorMessage(e));
      });
  }, [projectPath]);

  // Per issue: how many writes have started, and how many are still out.
  // Only the newest write's answer is shown, so an older one arriving late
  // cannot undo a newer change; a failure reads the issue again once nothing
  // else is out, rather than putting back what was on screen before it.
  const writes = useRef(new Map<string, { started: number; pending: number }>());
  const countsOf = (of: string) => {
    let counts = writes.current.get(of);
    if (!counts) writes.current.set(of, (counts = { started: 0, pending: 0 }));
    return counts;
  };

  const accept = useCallback(
    (answer: IssueDetails) => {
      const of = keyOf(projectPath, answer);
      if (of) countsOf(of).started++;
      onChanged(answer);
    },
    [projectPath, onChanged],
  );

  const write = useCallback(
    async (op: Write, optimistic?: Partial<IssueDetails>) => {
      const { key: asked, issue: before } = current.current;
      if (!asked || !before || !projectPath) return false;
      const counts = countsOf(asked);
      const mine = ++counts.started;
      counts.pending++;
      setError(null);
      if (optimistic) onChanged({ ...before, ...optimistic });
      try {
        const answer = await op(projectPath, before.provider, before.id);
        counts.pending--;
        if (counts.started === mine) onChanged(answer);
        return true;
      } catch (e) {
        counts.pending--;
        if (current.current.key === asked) setError(errorMessage(e));
        const seen = counts.started;
        issueOps
          .details(projectPath, before.provider, before.id)
          .then((now) => counts.started === seen && counts.pending === 0 && onChanged(now))
          .catch(() => {});
        return false;
      }
    },
    [projectPath, onChanged],
  );

  return { issue, projectPath, write, accept, error, options, optionsError, loadOptions, onChanged };
}

/**
 * Escape while `inside` holds the focus cancels the edit there and goes no
 * further: it is taken in the window's capture phase, ahead of every other
 * Escape binding (a tab's interrupt, a reminder). So is an Escape with the
 * focus on nothing at all, as after Write turns to Preview. A menu or dialog
 * open over it keeps its own Escape.
 */
function useEscapeCancels(inside: RefObject<HTMLElement | null>, enabled: boolean, cancel: () => void, busy = false) {
  const handler = useCallback(() => {
    if (hasEscapeOverlay()) return false;
    const focus = document.activeElement;
    if (!inside.current?.contains(focus) && focus && focus !== document.body) return false;
    // A save on its way cannot be called back; the key is still the editor's.
    if (!busy) cancel();
    return true;
  }, [inside, cancel, busy]);
  useHotkey("escape", handler, { enabled, global: true, priority: 20 });
}

/** False once the component is gone: an answer that arrives later has nothing here to change. */
function useLive() {
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return live;
}

// ------------------------------------------------------------------ title

/** Render it keyed by the issue, so nothing of one issue's edit outlives a switch to another. */
export function IssueTitle({ edits, title }: { edits: IssueEdits; title: string }) {
  const issue = edits.issue;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const live = useLive();
  const close = useCallback(() => {
    refocus.current = true;
    setDraft(null);
  }, []);
  useEscapeCancels(box, draft != null, close, saving);
  useEffect(() => {
    if (draft == null && refocus.current) trigger.current?.focus();
    refocus.current = false;
  }, [draft]);

  const save = async () => {
    if (saving) return;
    const next = draft?.trim() ?? "";
    if (!next || next === title) return close();
    setSaving(true);
    const ok = await edits.write((path, provider, id) => issueOps.setTitle(path, provider, id, next), { title: next });
    if (!live.current) return;
    setSaving(false);
    if (ok) close();
  };

  if (draft == null) {
    return (
      <h2 className="min-w-0 flex-1 break-words text-[15px] font-semibold leading-snug">
        {issue ? (
          <button
            ref={trigger}
            type="button"
            aria-label="Edit title"
            title="Click to edit the title"
            onClick={() => setDraft(title)}
            className="-mx-1 w-[calc(100%+0.5rem)] cursor-text rounded px-1 text-left hover:bg-veil-raised"
          >
            {title}
          </button>
        ) : (
          title
        )}
      </h2>
    );
  }
  return (
    <div ref={box} className="flex min-w-0 flex-1 items-center gap-1.5">
      <input
        autoFocus
        aria-label="Title"
        onFocus={(e) => e.currentTarget.select()}
        value={draft}
        readOnly={saving}
        aria-busy={saving}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          }
        }}
        className="min-w-0 flex-1 rounded-md bg-well px-2 py-1 text-[15px] font-semibold leading-snug outline-none focus-visible:ring-2 focus-visible:ring-ring/30 read-only:opacity-60"
      />
      {saving && <Loader2 className="size-3.5 shrink-0 animate-spin text-faint" />}
    </div>
  );
}

// ------------------------------------------------------------------ labels

function Dot({ color }: { color?: string | null }) {
  return <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: color ? `#${color}` : "var(--ink-faint)" }} />;
}

/** What `setLabels` takes for a label the issue carries: its id, or its name on an older row. */
const labelId = (label: { id?: string | null; name: string }) => label.id || label.name;

/** What the reader did in the picker: the labels put on and taken off. */
export interface LabelChange {
  add: string[];
  remove: string[];
}

/**
 * The labels after `change`, on top of what the issue has now. A label put
 * on lets go of the others in its Linear group, whoever added them.
 */
export function labelsAfter(now: string[], change: LabelChange, options: LabelOption[]): string[] {
  const groupOf = (id: string) => options.find((option) => option.id === id)?.group ?? null;
  const takenGroups = new Set(change.add.map(groupOf).filter((group): group is string => !!group));
  const kept = now.filter((id) => {
    const group = groupOf(id);
    return !change.remove.includes(id) && !change.add.includes(id) && !(group && takenGroups.has(group));
  });
  return [...kept, ...change.add];
}

/**
 * The repository's or team's labels, searched, in their Linear groups. The
 * choice is sent once, when the picker closes, like the website's own. A
 * Linear group holds one label at most, so picking one lets go of the other.
 */
function LabelPicker({ edits, onClose }: { edits: IssueEdits; onClose: (change: LabelChange, of: IssueDetails) => void }) {
  const issue = edits.issue!;
  const [query, setQuery] = useState("");
  const [started] = useState<string[]>(() => issue.labels.map(labelId));
  const [chosen, setChosen] = useState<string[]>(started);
  const [active, setActive] = useState(0);
  const searchBox = useRef<HTMLInputElement>(null);
  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;
  useEffect(() => edits.loadOptions(), [edits.loadOptions]);
  // The parent asks for the choice when the picker closes.
  useEffect(
    () => () => onClose({ add: chosenRef.current.filter((id) => !started.includes(id)), remove: started.filter((id) => !chosenRef.current.includes(id)) }, issue),
    [onClose, issue.provider, issue.id],
  );

  const all = edits.options?.labels ?? [];
  const groups = useMemo(() => new Map(all.filter((label) => label.isGroup).map((label) => [label.name, label])), [all]);
  const rows = useMemo(() => {
    const words = query.trim().toLowerCase();
    const matches = (label: LabelOption) => !words || `${label.group ?? ""} ${label.name}`.toLowerCase().includes(words);
    const loose = all.filter((label) => !label.isGroup && !label.group && matches(label));
    const grouped = [...groups.keys()].map((group) => ({ group, labels: all.filter((label) => !label.isGroup && label.group === group && matches(label)) }));
    return { loose, grouped: grouped.filter((each) => each.labels.length > 0) };
  }, [all, groups, query]);
  const flat = useMemo(() => [...rows.loose, ...rows.grouped.flatMap((each) => each.labels)], [rows]);
  useEffect(() => setActive(0), [query]);

  const toggle = (label: LabelOption) =>
    setChosen((now) => {
      if (now.includes(label.id)) return now.filter((id) => id !== label.id);
      const siblings = label.group ? new Set(all.filter((other) => other.group === label.group).map((other) => other.id)) : new Set<string>();
      return [...now.filter((id) => !siblings.has(id)), label.id];
    });

  const option = (label: LabelOption) => {
    const index = flat.indexOf(label);
    const on = chosen.includes(label.id);
    return (
      <div
        key={label.id}
        role="option"
        aria-selected={on}
        data-index={index}
        onMouseEnter={() => setActive(index)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => toggle(label)}
        className={cn("flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px]", index === active && "bg-veil-strong")}
      >
        <Dot color={label.color} />
        <span className="min-w-0 flex-1 truncate">{label.name}</span>
        {on && <Check className="size-3.5 shrink-0 text-muted-foreground" />}
      </div>
    );
  };

  return (
    <div className="flex max-h-[min(24rem,var(--radix-popover-content-available-height))] flex-col">
      <div className="flex items-center gap-1.5 border-b border-hairline px-2 pb-1.5">
        <Search className="size-3.5 shrink-0 text-faint" />
        <input
          ref={searchBox}
          autoFocus
          aria-label="Search labels"
          placeholder="Search labels"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (flat.length) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : flat.length - 1)) % flat.length);
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing && flat[active]) {
              e.preventDefault();
              toggle(flat[active]);
            }
          }}
          className="min-w-0 flex-1 bg-transparent py-1 text-xs outline-none placeholder:text-faint"
        />
      </div>
      <div role="listbox" aria-label="Labels" aria-multiselectable className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-1">
        {!edits.options && !edits.optionsError && (
          <div className="flex items-center gap-1.5 px-2 py-2 text-xs text-faint">
            <Loader2 className="size-3.5 animate-spin" /> Loading labels…
          </div>
        )}
        {edits.optionsError && <div className="px-2 py-2 text-xs text-destructive">{edits.optionsError}</div>}
        {edits.options && flat.length === 0 && <div className="px-2 py-2 text-xs text-muted-foreground">{all.length ? "No labels match." : "There are no labels here yet."}</div>}
        {rows.loose.map(option)}
        {rows.grouped.map(({ group, labels }) => (
          <div key={group} role="group" aria-label={group}>
            <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
              <Dot color={groups.get(group)?.color} />
              {group}
            </div>
            {labels.map(option)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The issue's labels as chips, and the picker that changes them. */
export function IssueLabels({ edits, labels }: { edits: IssueEdits; labels: Issue["labels"] }) {
  const issue = edits.issue;
  const [open, setOpen] = useState(false);
  const closed = useCallback(
    (change: LabelChange, of: IssueDetails) => {
      const now = edits.issue;
      // A picker left open while another issue was opened says nothing about that one.
      if (!now || now.provider !== of.provider || now.id !== of.id) return;
      if (!change.add.length && !change.remove.length) return;
      const known = edits.options?.labels ?? [];
      const shown = labelsAfter(now.labels.map(labelId), change, known).map((id) => {
        const label = known.find((option) => option.id === id) ?? now.labels.find((each) => labelId(each) === id);
        return { id, name: label?.name ?? id, color: label?.color ?? "" };
      });
      // The provider takes the whole set: the change goes on top of the labels
      // read just now, so one someone else added meanwhile stays.
      void edits.write(async (path, provider, id) => {
        const fresh = await issueOps.details(path, provider, id);
        return issueOps.setLabels(path, provider, id, labelsAfter(fresh.labels.map(labelId), change, known));
      }, { labels: shown });
    },
    [edits],
  );
  const closedRef = useRef(closed);
  closedRef.current = closed;
  const onClose = useCallback((change: LabelChange, of: IssueDetails) => closedRef.current(change, of), []);
  useEffect(() => setOpen(false), [issue?.provider, issue?.id]);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1" data-testid="issue-labels">
      {labels.map((label) => (
        <span key={labelId(label)} className="flex max-w-full items-center gap-1 rounded-full bg-veil-raised px-2 py-0.5 text-[11px] text-muted-foreground">
          <Dot color={label.color} />
          <span className="truncate">{label.name}</span>
        </span>
      ))}
      {issue && (
        <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
          <PopoverPrimitive.Trigger asChild>
            <Button variant="ghost" size="xs" aria-label="Edit labels" className="gap-1 text-faint">
              {labels.length ? <Pencil /> : <Plus />}
              {labels.length ? null : "Label"}
            </Button>
          </PopoverPrimitive.Trigger>
          <PopoverPrimitive.Portal>
            <PopoverPrimitive.Content
              align="start"
              sideOffset={4}
              collisionPadding={8}
              className="z-(--z-menu) w-64 max-w-[calc(100vw-1rem)] rounded-lg bg-popover glass pt-1.5 text-popover-foreground shadow-surface hairline outline-none data-[state=open]:animate-fade-in"
            >
              <LabelPicker edits={edits} onClose={onClose} />
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ priority

const PRIORITY_NAMES = ["No priority", "Urgent", "High", "Medium", "Low"];

/** Linear's own marks: dashes for none, a filled square for urgent, three bars filled by how high. */
export function PriorityIcon({ value, className }: { value: number; className?: string }) {
  if (value === 1) {
    return (
      <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5 shrink-0", className)}>
        <rect x="1" y="1" width="14" height="14" rx="3" fill="#f2994a" />
        <rect x="7" y="4" width="2" height="5.5" rx="1" fill="white" />
        <rect x="7" y="10.5" width="2" height="2" rx="1" fill="white" />
      </svg>
    );
  }
  if (value < 1 || value > 4) {
    return (
      <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5 shrink-0 text-faint", className)}>
        {[2, 6.5, 11].map((x) => <rect key={x} x={x} y="7.25" width="3" height="1.5" rx="0.75" fill="currentColor" />)}
      </svg>
    );
  }
  const filled = 5 - value;
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", className)}>
      {[{ x: 1.5, y: 9, h: 5 }, { x: 6.5, y: 5.5, h: 8.5 }, { x: 11.5, y: 2, h: 12 }].map((bar, i) => (
        <rect key={bar.x} x={bar.x} y={bar.y} width="3" height={bar.h} rx="1" fill="currentColor" opacity={i < filled ? 1 : 0.3} />
      ))}
    </svg>
  );
}

/** Linear's priority; nothing at all for a provider without one. */
export function IssuePriority({ edits }: { edits: IssueEdits }) {
  const issue = edits.issue;
  if (!issue?.capabilities.priority) return null;
  const value = issue.priority ?? 0;
  const choices = edits.options?.priorities.length ? edits.options.priorities : PRIORITY_NAMES.map((label, index) => ({ value: index, label }));
  const name = choices.find((choice) => choice.value === value)?.label ?? PRIORITY_NAMES[value] ?? PRIORITY_NAMES[0];
  return (
    <DropdownMenu onOpenChange={(open) => open && edits.loadOptions()}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" aria-label={`Priority: ${name}`} className="gap-1 text-muted-foreground">
          <PriorityIcon value={value} />
          {name}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={String(value)}
          onValueChange={(next) => {
            const priority = Number(next);
            if (priority === value) return;
            void edits.write((path, provider, id) => issueOps.setPriority(path, provider, id, priority), { priority });
          }}
        >
          {choices.map((choice) => (
            <DropdownMenuRadioItem key={choice.value} value={String(choice.value)}>
              <PriorityIcon value={choice.value} />
              {choice.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ------------------------------------------------------------------ description

interface Editing {
  draft: string;
  /** The issue as it was when editing started: Save overwrites only that. */
  base: { updatedAt: string; description: string };
}

/**
 * The description, and an Edit that turns it into the Markdown editor. Save
 * sends the description and `updatedAt` the editor started from; the
 * provider refuses it with `conflict` when the description has changed
 * since. The issue is then read again: when its description is after all
 * the one the editor started from, the save goes through on the new
 * `updatedAt`, and otherwise nothing is written until the reader chooses.
 *
 * Render it keyed by the issue, so nothing of one issue's edit outlives a
 * switch to another.
 */
export function IssueDescription({ edits, children }: { edits: IssueEdits; children: React.ReactNode }) {
  const issue = edits.issue;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theirs, setTheirs] = useState<IssueDetails | null>(null);
  const [showTheirs, setShowTheirs] = useState(false);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const live = useLive();
  const cancel = useCallback(() => {
    refocus.current = true;
    setEditing(null);
    setTheirs(null);
    setError(null);
  }, []);
  useEscapeCancels(box, editing != null, cancel, saving);
  useEffect(() => {
    if (!editing && refocus.current) trigger.current?.focus();
    refocus.current = false;
  }, [editing]);

  const save = async (expected: Editing["base"]) => {
    if (saving || !issue || !edits.projectPath || !editing) return;
    const { projectPath } = edits;
    const send = (from: Editing["base"]) =>
      issueOps.setDescription(projectPath, issue.provider, issue.id, { description: editing.draft, expectedUpdatedAt: from.updatedAt, expectedDescription: from.description });
    setSaving(true);
    setError(null);
    try {
      let answer: IssueDetails;
      try {
        answer = await send(expected);
      } catch (e) {
        if (!isIssueOpError(e) || e.kind !== "conflict") throw e;
        const now = await issueOps.details(projectPath, issue.provider, issue.id);
        if (!live.current) return;
        edits.accept(now);
        if (now.description !== (theirs ?? editing.base).description) {
          setTheirs(now);
          setShowTheirs(false);
          return;
        }
        answer = await send({ updatedAt: now.updatedAt, description: now.description });
      }
      if (!live.current) return;
      edits.accept(answer);
      cancel();
    } catch (e) {
      if (live.current) setError(isIssueOpError(e) && e.kind === "conflict" ? CHANGED : errorMessage(e));
    } finally {
      if (live.current) setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div>
        {issue && (
          <div className="mb-2 flex justify-end">
            <Button
              ref={trigger}
              variant="ghost"
              size="xs"
              className="gap-1"
              onClick={() => setEditing({ draft: issue.description, base: { updatedAt: issue.updatedAt, description: issue.description } })}
            >
              <Pencil /> Edit
            </Button>
          </div>
        )}
        {children}
      </div>
    );
  }

  const copyTheirs = () => {
    if (!theirs) return;
    void navigator.clipboard?.writeText(theirs.description).then(() => setCopied(true), () => {});
  };
  return (
    <div
      ref={box}
      className="flex flex-col gap-2"
      data-testid="description-editor"
      // A click on a button leaves the focus in the editor, and Escape with it.
      onMouseDown={(e) => (e.target as Element).closest("button") && e.preventDefault()}
    >
      <IssueMarkdownEditor autoFocus value={editing.draft} readOnly={saving} onChange={(draft) => setEditing({ ...editing, draft })} />
      {theirs && (
        <div role="alert" className="flex flex-col gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs">
          <div className="flex items-start gap-1.5 text-warning">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            <span>{CHANGED}. Nothing was saved. Your text is still here.</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="secondary" size="xs" onClick={() => setShowTheirs((v) => !v)}>
              {showTheirs ? "Hide their text" : "Show their text"}
            </Button>
            <Button variant="secondary" size="xs" className="gap-1" onClick={copyTheirs} onBlur={() => setCopied(false)}>
              {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy theirs"}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setEditing({ draft: theirs.description, base: { updatedAt: theirs.updatedAt, description: theirs.description } });
                setTheirs(null);
              }}
            >
              Start again from theirs
            </Button>
          </div>
          {showTheirs && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-well px-2 py-1.5 font-mono text-[11px] text-foreground" data-testid="their-description">
              {theirs.description || "(empty)"}
            </pre>
          )}
        </div>
      )}
      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <span className="mr-auto text-[11px] text-faint">Esc to cancel</span>
        {/* Never disabled: a disabled button drops the focus, and Escape with it. */}
        <Button variant="ghost" size="sm" aria-disabled={saving} onClick={() => !saving && cancel()}>
          Cancel
        </Button>
        {theirs ? (
          <Button variant="destructive" size="sm" aria-disabled={saving} onClick={() => void save({ updatedAt: theirs.updatedAt, description: theirs.description })}>
            {saving && <Loader2 className="animate-spin" />}
            Replace theirs with mine
          </Button>
        ) : (
          <Button variant="accent" size="sm" aria-disabled={saving} onClick={() => void save(editing.base)}>
            {saving && <Loader2 className="animate-spin" />}
            Save
          </Button>
        )}
      </div>
    </div>
  );
}

const CHANGED = "This issue changed since you started editing";
