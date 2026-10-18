import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Search, UserRound } from "@/icons";
import { WithTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { IssueUser } from "@/lib/issueOps";

/**
 * People on an issue: avatars, a stack of them, and a searchable list to
 * pick from. Shared by the assignee picker, @-mentions in comments and the
 * new-issue form, so nothing here knows what a pick is for.
 */

/** What a person is drawn from; the list's `IssueAssignee` has no id or login. */
export type Person = Pick<IssueUser, "name"> & Partial<IssueUser>;

const personKey = (person: Person) => person.id ?? person.login ?? person.name;

/** The name, and the login beside it when the two differ. */
export function personLabel(person: Person) {
  return person.login && person.login !== person.name ? `${person.name} (@${person.login})` : person.name;
}

export function Avatar({ person, className }: { person: Person; className?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [person.avatarUrl]);
  const initial = Array.from((person.name || person.login || "").trim())[0]?.toLocaleUpperCase();
  const box = cn("size-5 shrink-0 rounded-full", className);
  if (person.avatarUrl && !broken) {
    return <img src={person.avatarUrl} alt="" aria-hidden draggable={false} referrerPolicy="no-referrer" onError={() => setBroken(true)} className={cn(box, "bg-veil-strong object-cover")} />;
  }
  return (
    <span aria-hidden className={cn(box, "flex items-center justify-center bg-accent/15 text-[9px] font-semibold text-accent")}>
      {initial ?? <UserRound className="size-3" />}
    </span>
  );
}

/** Overlapping avatars, the first few of them; every name is on hover and in the accessible name. */
export function AvatarStack({ people, max = 3, className, avatarClassName }: { people: Person[]; max?: number; className?: string; avatarClassName?: string }) {
  if (people.length === 0) return null;
  const names = people.map((person) => person.name).join(", ");
  const extra = people.length - max;
  return (
    <WithTooltip label={names}>
      <span role="img" aria-label={names} className={cn("flex shrink-0 items-center", className)}>
        {people.slice(0, max).map((person, index) => (
          <Avatar key={personKey(person)} person={person} className={cn("ring-2 ring-background", index > 0 && "-ml-1.5", avatarClassName)} />
        ))}
        {extra > 0 && <span className="-ml-1 rounded-full bg-veil-strong px-1 text-[9px] leading-4 text-muted-foreground ring-2 ring-background">+{extra}</span>}
      </span>
    </WithTooltip>
  );
}

/** Whether every word of `query` is in the person's name or login. */
export function matchesPerson(person: Person, query: string) {
  const words = query.trim().toLowerCase().replace(/^@/, "").split(/\s+/).filter(Boolean);
  const text = `${person.name} ${person.login ?? ""}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/**
 * The people the list offers for `query`: the chosen ones first, in the
 * order they were chosen, then everyone else in the provider's order. A
 * chosen person the provider no longer offers (one who lost access) is
 * still listed, so they can be taken off.
 */
export function peopleFor(people: IssueUser[], chosen: IssueUser[], query: string): IssueUser[] {
  const chosenIds = new Set(chosen.map((person) => person.id));
  const rest = people.filter((person) => !chosenIds.has(person.id));
  return [...chosen, ...rest].filter((person) => matchesPerson(person, query));
}

/**
 * A search box over a list of people. `chosen` people are ticked and come
 * first; `onPick` gets the person a row was clicked (or Enter was pressed)
 * on, and the caller decides what that means. `actions` sit above the list,
 * as rows of their own ("Assign to me", "Unassign").
 */
export function PeoplePicker({
  people,
  chosen = [],
  onPick,
  multiple = false,
  disabled = false,
  isDisabled,
  actions,
  placeholder = "Search people",
  emptyText = "No one matches.",
  label = "People",
  footer,
}: {
  people: IssueUser[];
  chosen?: IssueUser[];
  onPick: (person: IssueUser) => void;
  /** Rows are checkboxes rather than a single choice. */
  multiple?: boolean;
  disabled?: boolean;
  /** A row that can't be picked right now, like an 11th GitHub assignee. */
  isDisabled?: (person: IssueUser, isChosen: boolean) => boolean;
  actions?: ReactNode;
  placeholder?: string;
  emptyText?: string;
  label?: string;
  footer?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const chosenIds = useMemo(() => new Set(chosen.map((person) => person.id)), [chosen]);
  // The order is taken when the list opens and as the search changes, not on
  // every pick, so a row doesn't jump out from under the pointer when ticked.
  const [order, setOrder] = useState<IssueUser[]>(() => peopleFor(people, chosen, ""));
  useEffect(() => setOrder(peopleFor(people, chosen, query)), [people, query]);
  const shown = useMemo(() => {
    const known = new Set(order.map((person) => person.id));
    return [...order, ...chosen.filter((person) => !known.has(person.id) && matchesPerson(person, query))];
  }, [order, chosen, query]);
  useEffect(() => setActive(0), [query]);
  const pickable = (person: IssueUser) => !disabled && !isDisabled?.(person, chosenIds.has(person.id));

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex h-8 items-center gap-1.5 border-b border-hairline px-2">
        <Search className="size-3.5 shrink-0 text-faint" />
        <input
          autoFocus
          value={query}
          aria-label={placeholder}
          placeholder={placeholder}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (shown.length) setActive((index) => (index + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
            } else if (event.key === "Enter") {
              event.preventDefault();
              const person = shown[active];
              if (person && pickable(person)) onPick(person);
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-faint"
        />
      </div>
      {actions && <div className="flex flex-col border-b border-hairline p-1">{actions}</div>}
      <div ref={listRef} role="listbox" aria-label={label} aria-multiselectable={multiple || undefined} className="max-h-64 overflow-y-auto p-1 scrollbar-thin">
        {shown.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-faint">{emptyText}</div>
        ) : (
          shown.map((person, index) => {
            const isChosen = chosenIds.has(person.id);
            const can = pickable(person);
            return (
              <div
                key={person.id}
                role="option"
                data-index={index}
                aria-selected={isChosen}
                aria-disabled={!can || undefined}
                aria-label={personLabel(person)}
                onMouseEnter={() => setActive(index)}
                onClick={() => can && onPick(person)}
                className={cn(
                  "flex min-w-0 cursor-default select-none items-center gap-2 rounded-md px-2 py-1 text-[13px]",
                  index === active && "bg-veil-strong",
                  !can && "opacity-50",
                )}
              >
                {multiple && (
                  <span className={cn("flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border", isChosen ? "border-accent bg-accent text-accent-foreground" : "border-hairline-strong")}>
                    {isChosen && <Check className="size-3" />}
                  </span>
                )}
                <Avatar person={person} />
                <span className="min-w-0 flex-1 truncate">
                  {person.name}
                  {person.login && person.login !== person.name && <span className="ml-1.5 text-[11px] text-faint">{person.login}</span>}
                </span>
                {!multiple && isChosen && <Check className="size-3.5 shrink-0 text-muted-foreground" />}
              </div>
            );
          })
        )}
      </div>
      {footer}
    </div>
  );
}

/** A row above the people list, styled like one of them. */
export function PeoplePickerAction({ icon, children, onClick, disabled }: { icon?: ReactNode; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-veil-strong disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  );
}
