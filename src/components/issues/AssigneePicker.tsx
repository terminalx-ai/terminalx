import { useEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { ChevronDown, Loader2, UserPlus, X } from "@/icons";
import { AvatarStack, PeoplePicker, PeoplePickerAction } from "@/components/issues/People";
import { errorMessage, type Issue } from "@/lib/api";
import { issueOps, type IssueCapabilities, type IssueDetails, type IssueOptions, type IssueUser } from "@/lib/issueOps";

/**
 * "Assigned to …" in the issue's header, and the picker it opens.
 *
 * Linear takes one assignee or none: a pick replaces whoever has it and
 * closes the picker. GitHub takes up to `maxAssignees`: rows are checkboxes
 * and every tick is its own write. The people offered are the provider's
 * (the team's members, the repository's assignable users); nobody else can
 * be typed in. A write sends a whole set, so a tick is kept as what it
 * changes and applied to the assignees read again just before the write:
 * someone added on the website meanwhile stays. Each write answers with the
 * issue re-read, which replaces what is shown; a refused one says why and
 * shows the issue as the provider has it.
 */

/** What a pick changes: Linear's one assignee replaced, or GitHub's set ticked on and off. */
export type AssigneeChange = { replace: IssueUser[] } | { add: IssueUser[]; remove: string[] };

/** The set `change` makes of `base`; `null` when it would pass `max`. */
export function applyAssigneeChange(base: IssueUser[], change: AssigneeChange, max: number): IssueUser[] | null {
  if ("replace" in change) return change.replace;
  const removed = new Set(change.remove);
  const kept = base.filter((person) => !removed.has(person.id));
  const next = [...kept, ...change.add.filter((person) => !kept.some((each) => each.id === person.id))];
  return next.length > max && next.length > kept.length ? null : next;
}
export function AssigneePicker({
  projectPath,
  issue,
  viewer,
  onChange,
}: {
  projectPath: string;
  /** The issue as last read: the list's row until its details come. */
  issue: Issue & { capabilities?: IssueCapabilities };
  /** The reader, for "Assign to me"; offered only once known. */
  viewer?: IssueUser | null;
  onChange: (issue: IssueDetails) => void;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<IssueOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  // What a write in flight will make the assignees, shown until it answers.
  const [pending, setPending] = useState<IssueUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${projectPath}\n${issue.provider}\n${issue.id}`;
  // Which issue the picker is on now. A write answers after an await; its
  // answer is still passed up (the view files it by issue), but it touches
  // this picker's state only while the picker is on the same issue.
  const on = useRef<string | null>(key);

  useEffect(() => {
    on.current = key;
    setPending(null);
    setError(null);
    setOptions(null);
    setOptionsError(null);
    return () => {
      on.current = null;
    };
  }, [key]);

  useEffect(() => {
    if (!open || options) return;
    let live = true;
    issueOps
      .options(projectPath, issue.provider, { id: issue.id })
      .then((value) => live && setOptions(value))
      .catch((e) => live && setOptionsError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [open, options, projectPath, issue.provider, issue.id]);

  // A row a pipeline remembers, or an older one, may have only the first assignee, by name.
  const assignees = pending ?? issue.assignees ?? (issue.assignee ? [{ id: issue.assignee.name, name: issue.assignee.name, avatarUrl: issue.assignee.avatarUrl }] : []);
  const capabilities = issue.capabilities ?? options?.capabilities ?? null;
  const multiple = !!capabilities?.multiAssignee;
  const max = capabilities?.maxAssignees ?? 1;
  const saving = pending !== null;
  const members = options?.members ?? [];
  const names = assignees.map((person) => person.name).join(", ");
  // GitHub refuses someone without access to the repository, so the reader is offered only when the provider offers them.
  const me = viewer && members.some((person) => person.id === viewer.id) ? members.find((person) => person.id === viewer.id)! : null;
  const isMine = !!me && assignees.some((person) => person.id === me.id);

  const write = async (change: AssigneeChange) => {
    const mine = key;
    const here = () => on.current === mine;
    const { provider, id } = issue;
    setPending(applyAssigneeChange(assignees, change, Infinity));
    setError(null);
    try {
      const fresh = await issueOps.details(projectPath, provider, id);
      const next = applyAssigneeChange(fresh.assignees, change, max);
      if (!next) {
        onChange(fresh);
        if (here()) setError(`An issue can have up to ${max} assignees.`);
        return;
      }
      onChange(await issueOps.setAssignees(projectPath, provider, id, next.map((person) => person.id)));
    } catch (e) {
      if (here()) setError(errorMessage(e));
      // What the provider holds now, which a refusal may not be the same as what was shown.
      await issueOps.details(projectPath, provider, id).then(onChange, () => {});
    } finally {
      if (here()) setPending(null);
    }
  };

  const pick = (person: IssueUser) => {
    const chosen = assignees.some((each) => each.id === person.id);
    if (!multiple) {
      setOpen(false);
      if (!chosen) void write({ replace: [person] });
      return;
    }
    if (chosen) void write({ add: [], remove: [person.id] });
    else if (assignees.length < max) void write({ add: [person], remove: [] });
  };

  return (
    <span className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5">
      <Popover.Root
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (value) setError(null);
        }}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={assignees.length ? `Assignees: ${names}` : "Assign"}
            className="-mx-1 flex h-5 min-w-0 max-w-full items-center gap-1 rounded px-1 hover:bg-veil-raised hover:text-foreground data-[state=open]:bg-veil-raised data-[state=open]:text-foreground"
          >
            <AvatarStack people={assignees} avatarClassName="size-4" />
            <span className="min-w-0 truncate">{assignees.length ? names : "Unassigned"}</span>
            {saving ? <Loader2 className="size-3 shrink-0 animate-spin" /> : <ChevronDown className="size-3 shrink-0 text-faint" />}
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
                <Loader2 className="size-3.5 animate-spin" /> Loading people…
              </div>
            ) : (
              <PeoplePicker
                label="Assignees"
                people={members}
                chosen={assignees}
                multiple={multiple}
                disabled={saving}
                isDisabled={(_, chosen) => multiple && !chosen && assignees.length >= max}
                onPick={pick}
                placeholder={multiple ? "Search assignable people" : "Search team members"}
                actions={
                  (me && !isMine) || assignees.length > 0 ? (
                    <>
                      {me && !isMine && (
                        <PeoplePickerAction
                          icon={<UserPlus />}
                          disabled={saving || (multiple && assignees.length >= max)}
                          onClick={() => pick(me)}
                        >
                          Assign to me
                        </PeoplePickerAction>
                      )}
                      {assignees.length > 0 && (
                        <PeoplePickerAction
                          icon={<X />}
                          disabled={saving}
                          onClick={() => {
                            if (!multiple) setOpen(false);
                            // Those shown, not someone added elsewhere since.
                            void write(multiple ? { add: [], remove: assignees.map((person) => person.id) } : { replace: [] });
                          }}
                        >
                          {multiple ? "Clear" : "Unassign"}
                        </PeoplePickerAction>
                      )}
                    </>
                  ) : null
                }
                footer={
                  <>
                    {multiple && assignees.length >= max && <div className="border-t border-hairline px-3 py-1.5 text-[11px] text-faint">An issue can have up to {max} assignees.</div>}
                    {error && <div role="alert" className="border-t border-hairline px-3 py-1.5 text-[11px] text-destructive">{error}</div>}
                  </>
                }
              />
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {error && !open && (
        <span role="alert" className="basis-full text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
