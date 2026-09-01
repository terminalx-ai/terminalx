import { useState } from "react";
import { ChevronRight, FileCode2, FilePen, FolderSearch, Globe, Loader2, Puzzle, Terminal, Users, ListChecks, CircleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { callTarget, groupTargets, type ToolCall } from "@/lib/transcript";
import { fileName, shortPath } from "@/lib/paths";
import { DiffBlock, UnifiedBlock } from "./DiffBlock";

function iconFor(toolType: string) {
  switch (toolType) {
    case "shell":
      return Terminal;
    case "file_read":
      return FileCode2;
    case "file_edit":
    case "file_write":
      return FilePen;
    case "search":
      return FolderSearch;
    case "web":
      return Globe;
    case "mcp":
      return Puzzle;
    case "subagent_spawn":
      return Users;
    case "plan":
      return ListChecks;
    default:
      return Puzzle;
  }
}

/** The verb the row leads with, in running and done forms. */
export function toolVerb(name: string, done: boolean): string {
  const table: Record<string, [string, string]> = {
    Read: ["Reading", "Read"],
    Write: ["Writing", "Wrote"],
    Edit: ["Editing", "Edited"],
    MultiEdit: ["Editing", "Edited"],
    Bash: ["Running", "Ran"],
    Glob: ["Finding", "Found"],
    Grep: ["Searching", "Searched"],
    LS: ["Listing", "Listed"],
    WebFetch: ["Fetching", "Fetched"],
    WebSearch: ["Searching", "Searched"],
    Task: ["Delegating", "Delegated"],
    Agent: ["Delegating", "Delegated"],
    TodoWrite: ["Planning", "Planned"],
    ExitPlanMode: ["Proposing plan", "Proposed plan"],
    AskUserQuestion: ["Asking", "Asked"],
    NotebookEdit: ["Editing", "Edited"],
    shell: ["Running", "Ran"],
    apply_patch: ["Editing", "Edited"],
    web_search: ["Searching", "Searched"],
  };
  const t = table[name];
  if (t) return done ? t[1] : t[0];
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return parts.slice(1).join(" · ");
  }
  return name;
}

function targetOf(call: ToolCall, cwd?: string): string {
  const t = callTarget(call);
  if (!t) return "";
  if (call.name === "Bash" || call.name === "shell") return t.split("\n")[0];
  if (call.toolType === "file_read" || call.toolType === "file_edit" || call.toolType === "file_write") return shortPath(t, cwd);
  return t;
}

export function ToolCallRow({ call, cwd, defaultOpen }: { call: ToolCall; cwd?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const done = !!call.result || !!call.abandoned;
  const pending = !done;
  const failed = call.result?.isError;
  const Icon = iconFor(call.toolType);
  const hasBody = !!call.result?.text || !!call.edits?.length || ((call.name === "Bash" || call.name === "shell") && !!callTarget(call));
  const target = targetOf(call, cwd);
  const isWholeRead = call.name === "Read" && !(call.input as { offset?: number })?.offset && !failed;

  return (
    <div className="group/tool">
      <button
        type="button"
        disabled={!hasBody || isWholeRead}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          hasBody && !isWholeRead && "hover:bg-veil-raised",
        )}
      >
        {pending ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : failed ? (
          <CircleAlert className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className={cn("shrink-0", pending ? "text-shimmer" : failed ? "text-destructive" : "text-muted-foreground")}>
          {call.abandoned && !call.result ? "Interrupted" : toolVerb(call.name, done)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground/90" title={target}>
          {target}
        </span>
        {call.edits?.length ? <EditCounts edits={call.edits} /> : null}
        {hasBody && !isWholeRead && (
          <ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} />
        )}
      </button>
      {open && hasBody && (
        <div className="mb-1 ml-6 mr-1">
          {call.edits?.length ? (
            <div className="space-y-2">
              {call.edits.map((e, i) =>
                e.unified && e.oldText == null && e.newText == null ? (
                  <UnifiedBlock key={i} path={e.path} unified={e.unified} kind={e.kind} cwd={cwd} />
                ) : (
                  <DiffBlock key={i} path={e.path} oldText={e.oldText ?? ""} newText={e.newText ?? ""} kind={e.kind} cwd={cwd} />
                ),
              )}
            </div>
          ) : null}
          {(call.name === "Bash" || call.name === "shell") && (
            <pre className="mt-1 max-h-72 overflow-auto scrollbar-thin rounded-md bg-well px-2.5 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap select-text">
              <span className="text-faint">$ </span>
              {callTarget(call)}
              {call.result?.text ? `\n${call.result.text}` : ""}
            </pre>
          )}
          {call.name !== "Bash" && call.name !== "shell" && call.result?.text && (
            <pre
              className={cn(
                "mt-1 max-h-72 overflow-auto scrollbar-thin rounded-md bg-well px-2.5 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap select-text",
                failed && "text-destructive",
              )}
            >
              {call.result.text.slice(0, 20000)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function EditCounts({ edits }: { edits: { oldText?: string; newText?: string }[] }) {
  let add = 0;
  let del = 0;
  for (const e of edits) {
    add += e.newText ? e.newText.split("\n").length : 0;
    del += e.oldText ? e.oldText.split("\n").length : 0;
  }
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums">
      <span className="text-add">+{add}</span> <span className="text-destructive">−{del}</span>
    </span>
  );
}

export function ToolGroupRow({ name, calls, cwd }: { name: string; calls: ToolCall[]; cwd?: string }) {
  const [open, setOpen] = useState(false);
  const done = calls.every((c) => c.result || c.abandoned);
  const targets = groupTargets(calls);
  const noun = name === "Bash" ? "command" : "file";
  const label =
    targets.length === 1
      ? `${toolVerb(name, done)} ${shortPath(targets[0], cwd)}`
      : `${toolVerb(name, done)} ${targets.length || calls.length} ${noun}${(targets.length || calls.length) === 1 ? "" : "s"}`;
  const Icon = iconFor(calls[0].toolType);
  const anyFailed = calls.some((c) => c.result?.isError);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-veil-raised outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {!done ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : anyFailed ? (
          <CircleAlert className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className={cn("min-w-0 flex-1 truncate", !done ? "text-shimmer" : "text-muted-foreground")}>{label}</span>
        {targets.length > 1 && (
          <span className="hidden max-w-[40%] truncate font-mono text-[11px] text-faint sm:inline">
            {targets.map((t) => fileName(t)).slice(0, 4).join(", ")}
          </span>
        )}
        <ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="ml-3 border-l border-hairline pl-1">
          {calls.map((c) => (
            <ToolCallRow key={c.callId} call={c} cwd={cwd} />
          ))}
        </div>
      )}
    </div>
  );
}
