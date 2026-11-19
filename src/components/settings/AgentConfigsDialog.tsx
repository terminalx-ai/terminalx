import { Fragment, useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogScrollArea, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/tooltip";
import { ArrowLeftRight, Check, Info, Puzzle, Server, SquareTerminal } from "@/icons";
import { agentConfigs, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import type {
  AgentConfigChange, AgentConfigComparison, AgentConfigCounts, AgentConfigDirection, AgentConfigItem, AgentConfigKind, AgentConfigPreview, AgentConfigWritten,
} from "@/types/agentConfigs";
import { RegisteredSetting } from "./settingsRegistry";

/** Settings › General › Copy agent configs (design 09.03): opens the dialog. */
export function CopyAgentConfigsRow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <RegisteredSetting setting="general.copyAgentConfigs"
        control={<Button variant="outline" size="sm" onClick={() => setOpen(true)}><ArrowLeftRight aria-hidden />Compare…</Button>}
      />
      {open && <AgentConfigsDialog onClose={() => setOpen(false)} />}
    </>
  );
}

const TABS: { kind: AgentConfigKind; label: string }[] = [
  { kind: "mcp", label: "MCP servers" },
  { kind: "command", label: "Slash commands" },
  { kind: "skill", label: "Skills" },
];

const NOUN: Record<AgentConfigKind, [string, string]> = {
  mcp: ["server", "servers"],
  command: ["command", "commands"],
  skill: ["skill", "skills"],
};

const key = (item: { kind: AgentConfigKind; name: string }) => `${item.kind}:${item.name}`;

const blockedFor = (item: AgentConfigItem, direction: AgentConfigDirection) =>
  direction === "toCodex" ? item.toCodexBlocked : item.toClaudeBlocked;

/** The way an item is copied unless the reader flips it: toward the side that lacks it, else Claude Code's onto Codex. */
export function defaultDirection(item: AgentConfigItem): AgentConfigDirection | null {
  if (item.status === "same") return null;
  const preferred: AgentConfigDirection = item.status === "onlyCodex" ? "toClaude" : "toCodex";
  if (!blockedFor(item, preferred)) return preferred;
  if (item.status === "different" && !item.toClaudeBlocked) return "toClaude";
  return null;
}

/**
 * What is ticked on open: items one side lacks, each copied toward it. A
 * "Different" item replaces the other side's version, so the reader ticks it.
 */
export function initialSelection(items: AgentConfigItem[]): Map<string, AgentConfigDirection> {
  const out = new Map<string, AgentConfigDirection>();
  for (const item of items) {
    if (item.status === "different") continue;
    const direction = defaultDirection(item);
    if (direction) out.set(key(item), direction);
  }
  return out;
}

function actionLabel(item: AgentConfigItem, direction: AgentConfigDirection) {
  if (item.status === "different") return direction === "toCodex" ? "Use Claude’s →" : "← Use Codex’s";
  return direction === "toCodex" ? "Copy to Codex →" : "← Copy to Claude";
}

const STATUS: Record<AgentConfigItem["status"], { label: string; className: string }> = {
  onlyClaude: { label: "Only in Claude Code", className: "bg-info/12 text-info" },
  onlyCodex: { label: "Only in Codex", className: "bg-merged/12 text-merged" },
  different: { label: "Different", className: "bg-warning/12 text-warning" },
  same: { label: "Same", className: "bg-veil-strong text-muted-foreground" },
};

function Mark({ className, children }: { className: string; children: ReactNode }) {
  return <span className={cn("inline-flex h-[18px] shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 text-[10.5px] font-medium", className)}>{children}</span>;
}

function countText(counts: AgentConfigCounts) {
  return TABS.filter(({ kind }) => counts[kind] > 0).map(({ kind }) => `${counts[kind]} ${NOUN[kind][counts[kind] === 1 ? 0 : 1]}`).join(", ");
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A preview line with config syntax picked out: table headers, and string values (not JSON keys). */
function highlight(line: string, syntax: "toml" | "json" | "text"): ReactNode {
  if (syntax === "text") return line;
  if (syntax === "toml" && /^\s*\[[^\]]+\]\s*$/.test(line)) return <span className="text-merged">{line}</span>;
  const parts = line.split(/("(?:[^"\\]|\\.)*")/);
  return parts.map((part, index) => {
    const isString = index % 2 === 1;
    const isJsonKey = syntax === "json" && isString && /^\s*:/.test(parts[index + 1] ?? "");
    return isString && !isJsonKey ? <span key={index} className="text-add">{part}</span> : <Fragment key={index}>{part}</Fragment>;
  });
}

type Line = { text: string; header?: boolean; syntax: "toml" | "json" | "text" };

function previewLines(preview: AgentConfigPreview): Line[] {
  const lines: Line[] = [];
  preview.files.forEach((file, index) => {
    if (index > 0) lines.push({ text: "", syntax: "text" });
    const where = file.backup
      ? `backed up to ${file.backup.startsWith(file.path.replace(/\/$/, "")) ? basename(file.backup) : file.backup}`
      : "new";
    lines.push({ text: `# ${file.path}  (${where})`, header: true, syntax: "text" });
    lines.push({ text: "", syntax: "text" });
    const syntax = file.path.endsWith(".toml") ? "toml" : file.path.endsWith(".json") ? "json" : "text";
    for (const text of file.text.replace(/\n$/, "").split("\n")) lines.push({ text, syntax });
  });
  return lines;
}

/** Copy between Claude Code and Codex (design 09.05). */
export function AgentConfigsDialog({ onClose }: { onClose: () => void }) {
  const [comparison, setComparison] = useState<AgentConfigComparison | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<AgentConfigKind>("mcp");
  const [selection, setSelection] = useState<Map<string, AgentConfigDirection>>(new Map());
  const [preview, setPreview] = useState<AgentConfigPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [written, setWritten] = useState<AgentConfigWritten[] | null>(null);

  const load = useCallback(() => {
    let live = true;
    void Promise.resolve().then(() => agentConfigs.compare()).then((next) => {
      if (!live) return;
      setComparison(next);
      setSelection(initialSelection(next.items));
      setLoadError(null);
    }, (error) => { if (live) setLoadError(errorMessage(error)); });
    return () => { live = false; };
  }, []);
  useEffect(load, [load]);

  const items = useMemo(() => comparison?.items ?? [], [comparison]);
  const changes = useMemo<AgentConfigChange[]>(() => items.flatMap((item) => {
    const direction = selection.get(key(item));
    return direction ? [{ kind: item.kind, name: item.name, direction }] : [];
  }), [items, selection]);

  useEffect(() => {
    if (!changes.length) {
      setPreview(null);
      setPreviewError(null);
      setPreviewing(false);
      return;
    }
    let live = true;
    setPreviewing(true);
    void Promise.resolve().then(() => agentConfigs.preview(changes)).then((next) => {
      if (!live) return;
      setPreview(next);
      setPreviewError(null);
    }, (error) => {
      if (!live) return;
      setPreview(null);
      setPreviewError(errorMessage(error));
    }).finally(() => { if (live) setPreviewing(false); });
    return () => { live = false; };
  }, [changes]);

  const toggle = (item: AgentConfigItem) => setSelection((current) => {
    const next = new Map(current);
    if (next.has(key(item))) next.delete(key(item));
    else {
      const direction = defaultDirection(item);
      if (direction) next.set(key(item), direction);
    }
    return next;
  });
  const flip = (item: AgentConfigItem) => setSelection((current) => {
    const now = current.get(key(item)) ?? defaultDirection(item);
    const other: AgentConfigDirection = now === "toCodex" ? "toClaude" : "toCodex";
    if (blockedFor(item, other)) return current;
    return new Map(current).set(key(item), other);
  });

  const ready = !!preview && !previewing && !previewError && changes.length > 0;
  const apply = async () => {
    if (!ready || applying || !preview) return;
    setApplying(true);
    setApplyError(null);
    try {
      setWritten(await agentConfigs.apply(changes, preview.token));
      load();
    } catch (error) {
      setApplyError(errorMessage(error));
    } finally { setApplying(false); }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      void apply();
    }
  };

  const shown = items.filter((item) => item.kind === tab);
  const lines = preview ? previewLines(preview) : [];
  const claudeFile = comparison?.claudeFile ?? "~/.claude.json";
  const codexFile = comparison?.codexFile ?? "~/.codex/config.toml";
  const count = changes.length;

  const row = (item: AgentConfigItem) => {
    const direction = selection.get(key(item)) ?? null;
    const possible = defaultDirection(item);
    const shownDirection = direction ?? possible;
    const blocked = item.status !== "same" && !possible ? (item.toCodexBlocked ?? item.toClaudeBlocked) : null;
    const summary = shownDirection === "toClaude" ? item.codexSummary : item.claudeSummary ?? item.codexSummary;
    const both = item.status === "different" ? `Claude Code: ${item.claudeSummary ?? ""}\nCodex: ${item.codexSummary ?? ""}` : undefined;
    const Icon = item.kind === "mcp" ? Server : item.kind === "command" ? SquareTerminal : Puzzle;
    const flippable = item.status === "different" && !item.toCodexBlocked && !item.toClaudeBlocked;
    return (
      <li key={key(item)} className="flex h-11 items-center gap-3 rounded-md px-3 hover:bg-selected" data-agent-config={key(item)}>
        <button
          type="button"
          role="checkbox"
          aria-checked={!!direction}
          aria-label={`${actionLabel(item, shownDirection ?? "toCodex")}: ${item.name}`}
          disabled={!possible || applying}
          onClick={() => toggle(item)}
          className={cn(
            "grid size-4 shrink-0 place-items-center rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50 [&_svg]:size-3",
            direction ? "bg-accent text-accent-foreground" : "border border-border",
          )}
        >
          {direction && <Check />}
        </button>
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1" title={both}>
          <div className="truncate font-mono text-[12.5px]">{item.kind === "command" ? `/${item.name}` : item.name}</div>
          {blocked
            ? <div className="truncate text-[11.5px] text-warning" title={blocked}>{blocked}</div>
            : <div className="truncate text-[11.5px] text-faint">{summary}</div>}
        </div>
        <Mark className={STATUS[item.status].className}>{STATUS[item.status].label}</Mark>
        <span className="w-[118px] shrink-0 whitespace-nowrap text-right text-xs text-muted-foreground">
          {shownDirection && (flippable
            ? <button type="button" className="rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60" disabled={applying}
                title={`Click for ${shownDirection === "toCodex" ? "Codex’s" : "Claude’s"} version instead`} onClick={() => flip(item)}>{actionLabel(item, shownDirection)}</button>
            : actionLabel(item, shownDirection))}
          {blocked && <span className="text-faint">Can’t copy</span>}
        </span>
      </li>
    );
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !applying) onClose(); }}>
      <DialogContent width="max-w-[640px]" layout="pinned" className="mt-[70px] mb-auto max-h-[calc(100dvh-5.5rem)] p-0" aria-describedby="agent-configs-subtitle" onKeyDown={onKeyDown}>
        <div className="shrink-0 px-5 pb-3 pt-4 pr-12">
          <DialogTitle className="text-[15px] font-semibold">Copy between Claude Code and Codex</DialogTitle>
          <DialogDescription id="agent-configs-subtitle" className="mt-0.5 text-[12.5px] text-muted-foreground">
            TerminalX reads {claudeFile} and {codexFile}. Nothing is deleted, and each file is backed up before it changes.
          </DialogDescription>
        </div>
        <div className="shrink-0 px-5">
          <div role="tablist" aria-label="What to compare" className="flex border-b border-hairline">
            {TABS.map(({ kind, label }) => {
              const selected = tab === kind;
              const total = items.filter((item) => item.kind === kind).length;
              return (
                <button key={kind} type="button" role="tab" aria-selected={selected} onClick={() => setTab(kind)}
                  className={cn("mr-4 flex h-9 items-center gap-1.5 whitespace-nowrap border-b-2 px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                    selected ? "border-accent font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
                  {label}{comparison ? ` · ${total}` : ""}
                </button>
              );
            })}
          </div>
        </div>
        <DialogScrollArea role="tabpanel" aria-label={TABS.find((t) => t.kind === tab)?.label} className="min-h-24 px-3 pt-2">
          {loadError ? (
            <p role="alert" className="break-words px-3 py-2.5 text-xs text-destructive">Could not read the agents’ settings: {loadError}</p>
          ) : !comparison ? (
            <p role="status" className="px-3 py-2.5 text-xs text-muted-foreground">Reading {claudeFile} and {codexFile}…</p>
          ) : (
            <>
              {comparison.problems.map((problem) => (
                <p key={problem} role="alert" className="break-words px-3 py-1.5 text-xs text-warning">Could not read {problem}</p>
              ))}
              <ul>
                {shown.length ? shown.map(row) : (
                  <li className="px-3 py-2.5 text-xs text-muted-foreground">
                    {tab === "mcp" ? "Neither agent has an MCP server in its own settings." : tab === "command" ? "Neither agent has a slash command of your own." : "Neither agent has a skill of your own."}
                  </li>
                )}
              </ul>
            </>
          )}
        </DialogScrollArea>
        <div className="shrink-0 px-5 pb-4 pt-3">
          <div className="overflow-hidden rounded-lg border border-border bg-raised" data-agent-config-preview>
            <div className="flex h-8 items-center gap-2 border-b border-hairline px-3 text-[11.5px] text-muted-foreground">
              Preview · what will be written
              <span className="ml-auto flex items-center gap-2">
                {preview && countText(preview.added) && <Mark className="bg-add/12 text-add">+{countText(preview.added)}</Mark>}
                {preview && countText(preview.replaced) && <Mark className="bg-warning/12 text-warning">{countText(preview.replaced)} replaced</Mark>}
              </span>
            </div>
            <div className="max-h-52 overflow-auto py-2 font-mono text-xs leading-[19px] scrollbar-thin">
              {previewError ? (
                <p role="alert" className="break-words px-3 font-sans text-destructive">Can’t write this: {previewError}</p>
              ) : !count ? (
                <p className="px-3 font-sans text-muted-foreground">Tick what to copy. Nothing is written until you apply.</p>
              ) : !preview ? (
                <p role="status" className="px-3 font-sans text-muted-foreground">Preparing the preview…</p>
              ) : lines.map((line, index) => (
                <div key={index} className="flex">
                  <span className="w-9 shrink-0 select-none pr-3 text-right text-faint">{index + 1}</span>
                  <span className={cn("whitespace-pre", line.header && "italic text-faint")}>{line.header ? line.text : highlight(line.text, line.syntax)}</span>
                </div>
              ))}
            </div>
            {preview && preview.notes.length > 0 && !previewError && (
              <ul className="border-t border-hairline px-3 py-2 text-[11.5px] text-muted-foreground" aria-label="What does not carry over">
                {preview.notes.map((note, index) => (
                  <li key={index}><span className="font-mono">{note.kind === "command" ? `/${note.name}` : note.name}</span>: {note.text}</li>
                ))}
              </ul>
            )}
          </div>
          {/* The backend says what was written, if anything, before it stopped. */}
          {applyError && <p role="alert" className="mt-2 break-words text-xs text-destructive">{applyError}</p>}
          {written && !applyError && (
            <p role="status" className="mt-2 break-words text-xs text-muted-foreground">
              Wrote {written.length} {written.length === 1 ? "file" : "files"}.
              {written.some((w) => w.backup) && <> Backups: <span className="font-mono">{written.flatMap((w) => (w.backup ? [w.backup] : [])).join(", ")}</span></>}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-hairline px-5 py-3">
          <div className="flex items-start gap-2 text-xs text-faint">
            <Info aria-hidden className="mt-[3px] size-3.5 shrink-0" />
            <div>Agents pick up the change in new tabs.</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" disabled={applying} onClick={onClose}>Cancel</Button>
            <Button disabled={!ready || applying} onClick={() => void apply()} aria-keyshortcuts="Meta+Enter Control+Enter">
              {applying ? "Applying…" : `Apply ${count} ${count === 1 ? "change" : "changes"}`}
              <Kbd className="ml-0.5 bg-transparent text-xs text-current opacity-70">⌘↵</Kbd>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
