import { ChevronRight, FileCode2, FilePen, FolderSearch, Globe, Loader2, Puzzle, Terminal, Users, ListChecks, CircleAlert, ShieldCheck, ShieldX } from "@/icons";
import { cn } from "@/lib/cn";
import { callTarget, groupTargets, type ToolCall } from "@/lib/transcript";
import { fileName, shortPath } from "@/lib/paths";
import { DiffBlock, UnifiedBlock } from "./DiffBlock";
import { LinkedText } from "./LinkedText";
import type { ChatLinkContext } from "@/lib/chatLinks";
import { useDisclosure, useSearchRevealed, useSearchSection } from "./disclosures";
import { editLineCounts } from "@/lib/turnChanges";

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

/**
 * A step's icon colour, by what it did, so a turn reads at a glance: reading blue, writing amber, running a command
 * green, searching or the web violet, anything else (tools, helpers, plans) the thinking colour. Only the icon is
 * coloured: the label and its chip stay neutral, so colour stays a cue and never noise.
 */
function toneFor(toolType: string): string {
  switch (toolType) {
    case "file_read":
      return "text-info";
    case "file_edit":
    case "file_write":
      return "text-accent";
    case "shell":
      return "text-add";
    case "search":
    case "web":
      return "text-merged";
    default:
      return "text-thinking";
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

export function ToolCallRow({ call, cwd, defaultOpen, linkContext }: { call: ToolCall; cwd?: string; defaultOpen?: boolean; linkContext?: ChatLinkContext }) {
  const [open, setOpen] = useDisclosure(`call:${call.callId}`, defaultOpen ?? false);
  const outputSection = useSearchSection(`output:${call.callId}`);
  const commandSection = useSearchSection(`command:${call.callId}`);
  const searching = useSearchRevealed(`call:${call.callId}`);
  const done = !!call.result || !!call.abandoned;
  const pending = !done;
  const failed = call.result?.isError;
  const Icon = iconFor(call.toolType);
  const hasBody = !!call.result?.text || !!call.edits?.length || ((call.name === "Bash" || call.name === "shell") && !!callTarget(call));
  const target = targetOf(call, cwd);
  const isWholeRead = call.name === "Read" && !(call.input as { offset?: number })?.offset && !failed;
  // The agent's own safety check held this call for a person (#775): which one, and whether it was let past.
  const safetyCheck = call.result?.safetyCheck;
  const SafetyIcon = failed ? ShieldX : ShieldCheck;

  return (
    <div className="group/tool">
      <div
        onClick={() => { if (hasBody && !isWholeRead) setOpen((o) => !o); }}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-[13.5px]",
          hasBody && !isWholeRead && "hover:bg-veil-raised",
        )}
      >
        <button type="button" disabled={!hasBody || isWholeRead} onClick={(event) => { event.stopPropagation(); setOpen((o) => !o); }} aria-label={`${open ? "Collapse" : "Expand"} ${toolVerb(call.name, done)} ${target}`} className="flex shrink-0 items-center gap-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        {pending ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : failed ? (
          <CircleAlert className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <Icon className={cn("size-4 shrink-0", toneFor(call.toolType))} />
        )}
        <span className={cn("shrink-0", pending ? "text-shimmer" : failed ? "text-destructive" : "text-foreground/90")}>
          {call.abandoned && !call.result ? "Interrupted" : toolVerb(call.name, done)}
        </span>
        </button>
        {/* Three kinds of text, each its own look: the step (plain), what it acted on (code, in a quiet chip beside
            it, not pushed to the far edge), and the reply's prose around it. */}
        <span className="flex min-w-0 flex-1">
          {target && (
            <span className="min-w-0 max-w-[36rem] truncate rounded-md bg-veil-raised px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground" title={target}>
              <LinkedText text={target} context={linkContext} />
            </span>
          )}
        </span>
        {safetyCheck && (
          <span className="flex min-w-0 max-w-[45%] items-center gap-1 text-[11px] text-warning" title={safetyCheck} data-testid="tool-safety-check">
            <SafetyIcon className="size-3 shrink-0" />
            <span className="truncate">{safetyCheck}</span>
          </span>
        )}
        {call.edits?.length ? <EditCounts edits={call.edits} /> : null}
        {hasBody && !isWholeRead && (
          <button type="button" onClick={(event) => { event.stopPropagation(); setOpen((o) => !o); }} aria-label={open ? "Collapse tool output" : "Expand tool output"} className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/40"><ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} /></button>
        )}
      </div>
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
              <span {...commandSection} data-chat-search-tool><LinkedText text={callTarget(call) ?? ""} context={linkContext} /></span>
              {call.result?.text ? <><br /><span {...outputSection} data-chat-search-tool><LinkedText text={call.result.text} context={linkContext} /></span></> : null}
            </pre>
          )}
          {call.name !== "Bash" && call.name !== "shell" && call.result?.text && (
            <pre
              className={cn(
                "mt-1 max-h-72 overflow-auto scrollbar-thin rounded-md bg-well px-2.5 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap select-text",
                failed && "text-destructive",
              )}
            >
              <span {...outputSection} data-chat-search-tool><LinkedText text={searching ? call.result.text : call.result.text.slice(0, 20000)} context={linkContext} /></span>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function EditCounts({ edits }: { edits: NonNullable<ToolCall["edits"]> }) {
  let add = 0;
  let del = 0;
  for (const e of edits) {
    const { added, removed } = editLineCounts(e);
    add += added;
    del += removed;
  }
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums">
      <span className="text-add">+{add}</span> <span className="text-destructive">−{del}</span>
    </span>
  );
}

export function ToolGroupRow({ name, calls, cwd, linkContext }: { name: string; calls: ToolCall[]; cwd?: string; linkContext?: ChatLinkContext }) {
  const [open, setOpen] = useDisclosure(`group:${calls[0].callId}`);
  const done = calls.every((c) => c.result || c.abandoned);
  const targets = groupTargets(calls);
  const noun = name === "Bash" ? "command" : "file";
  const label =
    targets.length === 1
      ? `${toolVerb(name, done)} ${shortPath(targets[0], cwd)}`
      : `${toolVerb(name, done)} ${targets.length || calls.length} ${noun}${(targets.length || calls.length) === 1 ? "" : "s"}`;
  const Icon = iconFor(calls[0].toolType);
  // Red only while the group ended on a failure: one the agent got past is marked on its own row inside, not on the whole group.
  const endedFailed = !!calls[calls.length - 1]?.result?.isError;
  const names = targets.map((t) => fileName(t)).filter(Boolean);
  return (
    <div>
      <div
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-[13.5px] hover:bg-veil-raised"
      >
        <button type="button" onClick={(event) => { event.stopPropagation(); setOpen((o) => !o); }} aria-label={`${open ? "Collapse" : "Expand"} ${label}`} className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        {!done ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : endedFailed ? (
          <CircleAlert className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <Icon className={cn("size-4 shrink-0", toneFor(calls[0].toolType))} />
        )}
        </button>
        <span className={cn("shrink-0 truncate", !done ? "text-shimmer" : "text-foreground/90")}><LinkedText text={label} context={linkContext} /></span>
        <span className="flex min-w-0 flex-1">
          {targets.length > 1 && names.length > 0 && (
            <span className="min-w-0 max-w-[36rem] truncate rounded-md bg-veil-raised px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground">
              {names.slice(0, 4).join(", ")}
            </span>
          )}
        </span>
        <button type="button" onClick={(event) => { event.stopPropagation(); setOpen((o) => !o); }} aria-label={open ? "Collapse tool group" : "Expand tool group"} className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/40"><ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} /></button>
      </div>
      {open && (
        <div className="ml-3 border-l border-hairline pl-1">
          {calls.map((c) => (
            <ToolCallRow key={c.callId} call={c} cwd={cwd} linkContext={linkContext} />
          ))}
        </div>
      )}
    </div>
  );
}
