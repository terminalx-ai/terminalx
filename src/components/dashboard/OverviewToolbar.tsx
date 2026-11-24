import { type ReactNode, type RefObject } from "react";
import { Archive, ArrowDownWideNarrow, ArrowUpNarrowWide, CalendarClock, ChevronDown, ListFilter, Plus, Search, SlidersHorizontal, UserRound, X } from "@/icons";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/menu";
import { initials } from "@/lib/cloudPeople";
import { cn } from "@/lib/cn";
import { keycaps, useKeymap, joinKeycaps } from "@/lib/shortcuts";
import { TABLE_COLUMNS, REQUIRED_COLUMN, type DashboardPreferences, type DashboardSort, type Inclusion, type TableColumn, type TableColumnId } from "@terminalx/portable/dashboard";

/** Initials in a round face. */
export function PersonFace({ name, size = 22, className }: { name: string; size?: number; className?: string }) {
  return (
    <span aria-hidden className={cn("relative inline-grid shrink-0 place-items-center rounded-full bg-veil-strong font-semibold leading-none text-foreground", className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}>
      {name === "You" ? <UserRound className="size-[60%]" /> : initials(name)}
    </span>
  );
}

const chip = "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-hairline px-2 text-[12.5px] text-muted-foreground outline-none hover:bg-veil-raised hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-selected data-[state=open]:text-foreground [&_svg]:size-[13px] [&_svg]:shrink-0";

function Chip({ icon, children, active, ...props }: { icon: ReactNode; children?: ReactNode; active?: boolean } & React.ComponentProps<"button">) {
  return (
    <button type="button" {...props} className={cn(chip, active && "bg-selected text-foreground", !children && "px-1.5", props.className)}>
      {icon}
      {children}
      {children && <ChevronDown aria-hidden className="size-3! text-faint" />}
    </button>
  );
}

export function SearchField({ inputRef, query, onQuery }: { inputRef: RefObject<HTMLInputElement | null>; query: string; onQuery: (query: string) => void }) {
  return (
    <div className="flex h-8 w-[280px] min-w-[160px] shrink items-center gap-2 rounded-md border border-hairline bg-veil-card px-2.5 focus-within:border-ring">
      <Search aria-hidden className="size-3.5 shrink-0 text-faint" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { if (query) onQuery(""); else e.currentTarget.blur(); }
          e.stopPropagation();
        }}
        placeholder="Search sessions, branches, PRs"
        aria-label="Search sessions"
        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
      />
      {query ? (
        <button type="button" aria-label="Clear search" className="text-faint hover:text-foreground" onClick={() => onQuery("")}>
          <X className="size-3.5" />
        </button>
      ) : <kbd aria-hidden className="shrink-0 rounded border border-hairline px-1.5 font-sans text-[11px] leading-4 text-faint">/</kbd>}
    </div>
  );
}

const INCLUSION_TEXT = {
  automations: { icon: <CalendarClock aria-hidden />, hide: "Hiding automations", show: "With automations", only: "Only automations", noun: "automations" },
  archived: { icon: <Archive aria-hidden />, hide: "Hiding archived", show: "With archived", only: "Only archived", noun: "archived" },
} as const;

/** "Hiding automations" / "Hiding archived": leave a kind of session out, show it too, or show it alone. */
export function InclusionChip({ kind, value, onChange }: { kind: keyof typeof INCLUSION_TEXT; value: Inclusion; onChange: (value: Inclusion) => void }) {
  const text = INCLUSION_TEXT[kind];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Chip icon={text.icon} active={value !== "hide"}>{text[value]}</Chip></DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as Inclusion)}>
          <DropdownMenuRadioItem value="hide">Hide {text.noun}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="show">Show {text.noun}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="only">Only {text.noun}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const menuName = (id: TableColumnId) => TABLE_COLUMNS.find((column) => column.id === id)!.menu;

/** The order: which column, and which way. */
/** `columns`: the ones the table offers (Where only once a machine is paired). */
export function SortChip({ sort, onChange, columns = TABLE_COLUMNS }: { sort: DashboardSort; onChange: (sort: DashboardSort) => void; columns?: readonly TableColumn[] }) {
  const Icon = sort.direction === "desc" ? ArrowDownWideNarrow : ArrowUpNarrowWide;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Chip icon={<Icon aria-hidden />} aria-label={`Sort: ${menuName(sort.column)}`}>{menuName(sort.column)}</Chip></DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={sort.column} onValueChange={(column) => onChange({ ...sort, column: column as TableColumnId })}>
          {columns.map(({ id, menu }) => <DropdownMenuRadioItem key={id} value={id}>{menu}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={sort.direction} onValueChange={(direction) => onChange({ ...sort, direction: direction as DashboardSort["direction"] })}>
          <DropdownMenuRadioItem value="desc">Descending</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="asc">Ascending</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Display (02.15): Table or Board, the table's columns, and row density. */
export function DisplayMenu({ preferences, onChange, columns = TABLE_COLUMNS }: { preferences: DashboardPreferences; onChange: (preferences: DashboardPreferences) => void; columns?: readonly TableColumn[] }) {
  const table = preferences.view === "table";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Chip icon={<SlidersHorizontal aria-hidden />}>Display</Chip></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-(--radix-dropdown-menu-content-available-height) w-[220px] overflow-y-auto scrollbar-thin">
        <div className="px-1.5 pb-2 pt-1.5">
          <div role="group" aria-label="Dashboard view" className="flex w-full items-center rounded-md border border-hairline p-0.5">
            {(["table", "board"] as const).map((view) => (
              <button key={view} type="button" aria-pressed={preferences.view === view}
                onClick={() => onChange({ ...preferences, view })}
                className={cn("flex h-6 flex-1 items-center justify-center rounded-[5px] text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  preferences.view === view ? "bg-selected text-foreground" : "text-muted-foreground hover:text-foreground")}>
                {view === "table" ? "Table" : "Board"}
              </button>
            ))}
          </div>
        </div>
        {table && <>
          <DropdownMenuLabel className="pt-2">Columns</DropdownMenuLabel>
          {columns.filter(({ id }) => id !== REQUIRED_COLUMN).map(({ id, menu }) => (
            <DropdownMenuCheckboxItem key={id} indicator="box" className="h-8 text-[12.5px]"
              checked={!preferences.hiddenColumns.includes(id)}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={() => onChange({ ...preferences, hiddenColumns: preferences.hiddenColumns.includes(id) ? preferences.hiddenColumns.filter((hidden) => hidden !== id) : [...preferences.hiddenColumns, id] })}>
              {menu}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem indicator="box" className="h-8 text-[12.5px]" checked={preferences.compact}
            onSelect={(e) => e.preventDefault()} onCheckedChange={(compact) => onChange({ ...preferences, compact: compact === true })}>
            Compact rows
          </DropdownMenuCheckboxItem>
        </>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The project, agent and status filters the toolbar's chips do not cover. */
export function FilterChip({ count, children }: { count: number; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Chip icon={<ListFilter aria-hidden />} active={count > 0} aria-label={count ? `Filter, ${count} on` : "Filter"} title="Filter by project, agent or status">
          {count > 0 ? <span className="rounded-full bg-accent/20 px-1.5 text-[10px] text-foreground tabular-nums">{count}</span> : undefined}
        </Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-(--radix-dropdown-menu-content-available-height) w-56 overflow-y-auto scrollbar-thin">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function NewSessionButton({ onClick }: { onClick: () => void }) {
  const binding = useKeymap()["app.newSession"]?.[0];
  return (
    <button type="button" onClick={onClick}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-foreground px-3 text-[12.5px] font-medium text-background outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50">
      <Plus aria-hidden className="size-3.5" />
      New session
      {binding && <kbd aria-hidden className="ml-1 rounded border border-background/20 px-1 font-sans text-[11px] leading-4 text-background/70">{joinKeycaps(keycaps(binding))}</kbd>}
    </button>
  );
}
