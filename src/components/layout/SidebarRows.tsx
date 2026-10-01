import type { HTMLAttributes, ReactNode, Ref } from "react";
import { Archive, ArrowUp, ChevronDown, Globe, Lock, Pin, Terminal, X } from "lucide-react";
import { AgentMark, agentName } from "@/components/AgentMark";
import { actionRow, yieldsToRowActions } from "@/components/layout/RowActions";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/time";
import { TAB_STATUS_LABEL, type TabStatus } from "@/types/session";

/**
 * Row building blocks for the sidebar navigation tree.
 *
 * These pieces draw rows and nothing else: they take plain values (labels,
 * counts, statuses, flags) and callbacks, never a session, workspace or tab
 * record, and never call a store or a backend. The local tree in
 * `SidebarTree.tsx` wires them to local sessions, and other tree sections can
 * render their own records from the same pieces so every row looks and
 * behaves alike.
 *
 * The tree has two row levels above tabs: a "group" row (a workspace) and an
 * "item" row (a session). Tabs draw as {@link TabRow}s under an item.
 */

/** Chevron that expands or collapses one tree node. `data-tree-toggle` is read by tree keyboard navigation. */
export function TreeToggle({ expanded, label, onToggle, className }: { expanded: boolean; label: string; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      data-tree-toggle
      aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
      onClick={onToggle}
      className={cn("shrink-0 rounded-sm p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/40", className)}
    >
      <ChevronDown className={cn("size-3 shrink-0 text-faint transition-transform", !expanded && "-rotate-90")} />
    </button>
  );
}

/** One expandable tree node: its row, anything drawn under the row, and its {@link TreeGroup}. */
export function TreeNode({ label, expanded, children }: { label: string; expanded: boolean; children: ReactNode }) {
  return (
    <div role="treeitem" aria-label={label} aria-expanded={expanded} className="min-w-0">
      {children}
    </div>
  );
}

const TREE_ROW = {
  group: {
    base: "relative flex min-h-7 items-center gap-1 rounded-md pr-1 text-[11px] text-muted-foreground",
    selected: "bg-selected/60",
    idle: "hover:bg-selected/40",
  },
  item: {
    base: "relative flex min-h-7 cursor-default items-center gap-1 rounded-md pr-1 outline-none",
    selected: "bg-selected",
    idle: "hover:bg-selected/50",
  },
} as const;

/**
 * The visible row of a {@link TreeNode}. A "group" row is a workspace and an
 * "item" row is a session; `selected` marks the active workspace or the
 * selected session. Trailing content can yield to a {@link RowActions} toolbar.
 */
export function TreeRow({ level, selected, title, children }: { level: keyof typeof TREE_ROW; selected: boolean; title?: string; children: ReactNode }) {
  const style = TREE_ROW[level];
  return (
    <div data-tree-row className={cn(actionRow, style.base, selected ? style.selected : style.idle)} title={title}>
      {children}
    </div>
  );
}

/** The children of a {@link TreeNode}. Collapsed groups stay mounted but hidden. */
export function TreeGroup({ expanded, className, children }: { expanded: boolean; className: string; children: ReactNode }) {
  return (
    <div hidden={!expanded} className={cn(className, !expanded && "hidden")} role="group">
      {children}
    </div>
  );
}

/** Coloured bar on a row's leading edge: warning when it needs the user, green when done, pulsing while working. */
export function StatusStripe({ status, size }: { status: TabStatus; size: "row" | "tab" }) {
  return (
    <span
      aria-hidden
      className={cn(
        size === "row" ? "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full" : "absolute left-0 top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full",
        status === "waiting" && "bg-warning",
        status === "completed" && "bg-add",
        status === "in_progress" && "bg-info animate-pulse-soft",
      )}
    />
  );
}

/** Small tag after a row's label, such as a workspace kind; `mono` draws a truncated branch name. */
export function RowChip({ mono, children }: { mono?: boolean; children: ReactNode }) {
  return (
    <span className={mono ? "max-w-20 shrink-0 truncate rounded-sm bg-veil-raised px-1 font-mono text-[9px] text-faint" : "shrink-0 rounded-sm bg-veil-raised px-1 text-[9px] text-faint"}>
      {children}
    </span>
  );
}

/** Added and deleted lines plus unpushed commits. Draws nothing when all are zero. */
export function DiffStats({ additions, deletions, unpushed }: { additions: number; deletions: number; unpushed: number }) {
  if (!additions && !deletions && !unpushed) return null;
  return (
    <span className={cn("flex shrink-0 items-center gap-1 tabular-nums", yieldsToRowActions)}>
      {additions > 0 ? <span className="text-add">+{additions}</span> : null}
      {deletions > 0 ? <span className="text-destructive">−{deletions}</span> : null}
      {unpushed > 0 ? (
        <span className="flex items-center text-warning" title={`${unpushed} unpushed commit${unpushed === 1 ? "" : "s"}`}>
          <ArrowUp className="size-3" />
          {unpushed}
        </span>
      ) : null}
    </span>
  );
}

/** Relative age of a row's last activity, which gives way to the row's toolbar. */
export function RowTime({ at }: { at: string }) {
  return (
    <span className={cn("shrink-0 text-[10px] tabular-nums text-faint", yieldsToRowActions)}>
      {relativeTime(at)}
    </span>
  );
}

/** A group row's label as a plain button, for rows whose name cannot be edited. */
export function GroupTitle({ label, onActivate }: { label: string; onActivate: () => void }) {
  return (
    <button type="button" onClick={onActivate} className="min-w-0 flex-1 truncate rounded-sm text-left font-mono text-foreground/90 outline-none focus-visible:ring-2 focus-visible:ring-ring/40">{label}</button>
  );
}

/** An item row's label: opens the item, with pinned and archived marks and an optional branch chip. */
export function ItemTitle({ title, pinned, archived, badge, onActivate }: { title: string; pinned?: boolean; archived?: boolean; badge?: string | null; onActivate: () => void }) {
  return (
    <button
      type="button"
      onClick={onActivate}
      className="flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      title={title}
    >
      {pinned ? <Pin className="size-3 shrink-0 text-faint" /> : null}
      {archived ? <Archive className="size-3 shrink-0 text-faint" aria-label="Archived session" /> : null}
      <span className="min-w-0 flex-1 truncate text-[12px]">{title}</span>
      {badge ? <RowChip mono>{badge}</RowChip> : null}
    </button>
  );
}

const TAB_ROW = {
  agent: {
    row: "group/tab relative flex h-6 min-w-0 cursor-default items-center gap-1.5 rounded-md px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
    idle: "text-muted-foreground hover:bg-selected/40 hover:text-foreground",
    close: "rounded-sm p-0.5 text-faint opacity-0 hover:bg-veil-strong hover:text-foreground group-hover/tab:opacity-100 focus-visible:opacity-100",
  },
  peer: {
    row: "group/tab relative flex h-6 min-w-0 items-center gap-1.5 rounded-md px-2 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
    idle: "text-muted-foreground hover:bg-selected/40",
    close: "rounded-sm p-0.5 text-faint opacity-0 hover:bg-veil-strong group-hover/tab:opacity-100 focus-visible:opacity-100",
  },
} as const;

/** Props a menu trigger (`asChild`) or a caller may add to a tab row's element. */
type TabRowPassThrough = Omit<HTMLAttributes<HTMLDivElement>, "id" | "title" | "className" | "children" | "onClick" | "onKeyDown" | "onAuxClick"> & {
  ref?: Ref<HTMLDivElement>;
};

export interface TabRowProps extends TabRowPassThrough {
  /** "agent" draws a conversation tab; "peer" draws a shell or browser tab. */
  tone: keyof typeof TAB_ROW;
  /** DOM id of the row, which the tab panel's `aria-labelledby` points at. */
  nodeId: string;
  /** DOM id of the panel the tab shows. */
  panelId: string;
  label: string;
  title: string;
  selected: boolean;
  closeLabel: string;
  onOpen: () => void;
  /** Absent when this reader may not close the tab (a cloud tab for anyone but a workspace manager): no close button is drawn. */
  onClose?: () => void;
  children: ReactNode;
}

/**
 * One tab under an item row. Opens on click, Enter or Space, and closes on a
 * middle click or its hover close button. Remaining props (a context menu
 * trigger's handlers and ref, `aria-description`) land on the row element.
 */
export function TabRow({ tone, nodeId, panelId, label, title, selected, closeLabel, onOpen, onClose, children, ...rest }: TabRowProps) {
  const style = TAB_ROW[tone];
  return (
    <div
      {...rest}
      role="treeitem"
      id={nodeId}
      aria-controls={panelId}
      aria-label={label}
      aria-selected={selected}
      tabIndex={0}
      title={title}
      onClick={onOpen}
      onAuxClick={(event) => event.button === 1 && onClose?.()}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className={cn(style.row, selected ? "bg-(--surface-thumb) text-foreground shadow-button" : style.idle)}
    >
      {children}
      {onClose && (
        <button
          type="button"
          aria-label={closeLabel}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className={style.close}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

type TabRowBase = Omit<TabRowProps, "tone" | "label" | "title" | "closeLabel" | "children">;

/** A conversation tab: its agent, status, and whether mobile is driving it or it shows the terminal view. */
export function AgentTabRow({ harness, label, status, mobileDriven, terminalView, ...row }: TabRowBase & {
  harness: string;
  label: string;
  status: TabStatus;
  mobileDriven: boolean;
  terminalView: boolean;
}) {
  return (
    <TabRow
      {...row}
      tone="agent"
      label={label}
      aria-description={agentName(harness)}
      title={`${label} · ${TAB_STATUS_LABEL[status]}`}
      closeLabel={`Close ${label}`}
    >
      <StatusStripe status={status} size="tab" />
      <span role="img" aria-label={TAB_STATUS_LABEL[status]} className="sr-only" />
      <AgentMark id={harness} className="size-3.5 shrink-0" decorative />
      <span className="min-w-0 flex-1 truncate text-[11px]">{label}</span>
      {mobileDriven ? <Lock className="size-3 shrink-0 text-warning" aria-label="Mobile is driving this terminal" /> : null}
      {terminalView ? <Terminal className="size-3 shrink-0 text-faint" aria-label="In terminal view" /> : null}
    </TabRow>
  );
}

/** A shell terminal tab; an exited shell stays listed, struck through. */
export function ShellTabRow({ title, exited, ...row }: TabRowBase & { title: string; exited: boolean }) {
  return (
    <TabRow {...row} tone="peer" label={`${title}${exited ? ", exited" : ""}`} title={title} closeLabel={`Close ${title} terminal tab`}>
      <Terminal className="size-3.5 shrink-0" />
      <span className={cn("min-w-0 flex-1 truncate", exited && "text-faint line-through")}>{title}</span>
    </TabRow>
  );
}

/** A browser page tab; `agentTarget` marks the page agents act on. */
export function BrowserTabRow({ label, url, agentTarget, ...row }: TabRowBase & { label: string; url: string; agentTarget: boolean }) {
  return (
    <TabRow {...row} tone="peer" label={`${label} browser page`} title={url || label} closeLabel={`Close ${label} browser page`}>
      <Globe className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {agentTarget ? <span className="size-1.5 shrink-0 rounded-full bg-info" aria-label="Active page for agents" /> : null}
    </TabRow>
  );
}
