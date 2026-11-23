import { ArrowUpFromLine, ChevronRight, FileCode2, FilePen, FolderSearch, GitCommitHorizontal, Globe, Loader2, Puzzle, Terminal, Users, ListChecks, CircleAlert, ShieldCheck, ShieldX } from "@/icons";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/time";
import { callTarget, groupTargets, type ToolCall } from "@/lib/transcript";
import { fileName, shortPath } from "@/lib/paths";
import { DiffBlock, UnifiedBlock } from "./DiffBlock";
import { LinkedText } from "./LinkedText";
import type { ChatLinkContext } from "@/lib/chatLinks";
import { useDisclosure, useSearchRevealed, useSearchSection } from "./disclosures";
import { editLineCounts } from "@/lib/turnChanges";
import { ReviewCommentCard, reviewComment } from "./ReviewCommentCard";

export function iconFor(toolType: string) {
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
 * What a step acted on, beside its label: plain muted code, no chip, so the verb leads and the target reads as its
 * object. Shared with a group's file names.
 */
export const STEP_TARGET = "min-w-0 truncate font-mono text-[12px] text-muted-foreground";
/** The facts after a target ("301 lines", "6 matches in 3 files"): quieter still. */
const STEP_FACT = "shrink-0 text-[12px] text-faint";
/** A row's open/closed mark: right after what the row says, never pinned to the column's far edge. */
function RowChevron({ open }: { open: boolean }) {
  return <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} />;
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

function isShell(call: ToolCall): boolean {
  return call.name === "Bash" || call.name === "shell";
}

function targetOf(call: ToolCall, cwd?: string): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  // A search names what it looked for first, then where: "tool_use_id" in src-tauri/src.
  if (call.toolType === "search" && typeof input.pattern === "string" && input.pattern) return `"${input.pattern}"`;
  const t = callTarget(call);
  if (!t) return "";
  if (isShell(call)) return t.split("\n")[0];
  if (call.toolType === "file_read" || call.toolType === "file_edit" || call.toolType === "file_write") return shortPath(t, cwd);
  return t;
}

/** A git step a command is, named as what it does ("Committed", "Pushing"), or null for any other command. */
export function gitStep(command: string): { running: string; done: string; kind: "commit" | "push" } | null {
  const c = command.trim();
  if (/^git\s+(?:-\S+\s+)*commit\b/.test(c)) return { running: "Committing", done: "Committed", kind: "commit" };
  if (/^git\s+(?:-\S+\s+)*push\b/.test(c)) return { running: "Pushing", done: "Pushed", kind: "push" };
  return null;
}

/** A finished commit's short hash and message, from git's own "[branch abc1234] message" line. */
export function commitLine(output: string): string | null {
  const m = output.match(/^\[[^\]\n]*?\b([0-9a-f]{7,40})\] (.+)$/m);
  return m ? `${m[1]} ${m[2].trim()}` : null;
}

/** A tool's run time, short: "1.4s" under ten seconds, then whole seconds and minutes. */
export function stepDuration(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  return formatDuration(ms);
}

function callDuration(call: ToolCall): number | null {
  const start = Date.parse(call.startedTs ?? "");
  const end = Date.parse(call.endedTs ?? "");
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

/** How a finished command ended: its exit code, from the harness or from "Exit code 1" in a failed result. */
export function exitCodeOf(call: ToolCall): number | null {
  const result = call.result;
  if (!result) return null;
  if (typeof result.exitCode === "number") return result.exitCode;
  if (result.isError) {
    const m = result.text.match(/^Exit code (\d+)/m);
    return m ? Number(m[1]) : null;
  }
  return 0;
}

/** Numbered lines in a read's output ("   12→text", or a tab after the number), else its plain lines. */
export function readLineCount(text: string): number {
  const lines = text.replace(/\n$/, "").split("\n");
  const numbered = lines.filter((line) => /^\s*\d+(?:→|\t)/.test(line)).length;
  return numbered || lines.filter((line) => line.trim()).length;
}

/**
 * What a search found, from its output: "6 matches in 3 files" for matching lines ("path:12:text"), "3 files" for a
 * list of files. Null when the output says nothing countable.
 */
export function searchCounts(text: string): string | null {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length || /^no (?:files|matches)/i.test(lines[0])) return "no matches";
  const found = lines[0].match(/^Found (\d+) files?/i);
  if (found) return plural(Number(found[1]), "file");
  const hits = lines.map((line) => line.match(/^(.+?):(\d+)[:-]/)).filter((m): m is RegExpMatchArray => !!m);
  if (hits.length) return `${plural(hits.length, "match", "matches")} in ${plural(new Set(hits.map((m) => m[1])).size, "file")}`;
  return null;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function ToolCallRow({ call, cwd, defaultOpen, linkContext }: { call: ToolCall; cwd?: string; defaultOpen?: boolean; linkContext?: ChatLinkContext }) {
  const [open, setOpen] = useDisclosure(`call:${call.callId}`, defaultOpen ?? false);
  const outputSection = useSearchSection(`output:${call.callId}`);
  const commandSection = useSearchSection(`command:${call.callId}`);
  const searching = useSearchRevealed(`call:${call.callId}`);
  const done = !!call.result || !!call.abandoned;
  const pending = !done;
  const failed = call.result?.isError;
  const shell = isShell(call);
  const command = shell ? callTarget(call) ?? "" : "";
  const git = shell ? gitStep(command) : null;
  const Icon = git?.kind === "commit" ? GitCommitHorizontal : git?.kind === "push" ? ArrowUpFromLine : iconFor(call.toolType);
  const hasBody = !!call.result?.text || !!call.edits?.length || (shell && !!command);
  // A finished commit names itself: "Committed ede0b4d Make slugify…", not the command that made it.
  const committed = git?.kind === "commit" && done && !failed && call.result ? commitLine(call.result.text) : null;
  const target = committed ?? targetOf(call, cwd);
  const isWholeRead = call.name === "Read" && !(call.input as { offset?: number })?.offset && !failed;
  const expandable = hasBody && !isWholeRead;
  const input = (call.input ?? {}) as Record<string, unknown>;
  const searchedIn = call.toolType === "search" && typeof input.pattern === "string" && input.pattern && typeof input.path === "string" && input.path ? shortPath(input.path, cwd) : null;
  const searchFound = call.toolType === "search" && call.result && !failed ? searchCounts(call.result.text) : null;
  const readLines = call.toolType === "file_read" && call.result?.text && !failed ? readLineCount(call.result.text) : null;
  // A commit that names itself has said how it went; any other command says its exit status and run time.
  const exit = shell && done && !call.abandoned && !committed ? exitCodeOf(call) : null;
  const ran = shell ? callDuration(call) : null;
  const verb = call.abandoned && !call.result ? "Interrupted" : git ? (done ? git.done : git.running) : toolVerb(call.name, done);
  // The agent's own safety check held this call for a person (#775): which one, and whether it was let past.
  const safetyCheck = call.result?.safetyCheck;
  const SafetyIcon = failed ? ShieldX : ShieldCheck;

  const comment = reviewComment(call);
  if (comment) return <ReviewCommentCard call={call} comment={comment} linkContext={linkContext} />;

  return (
    <div className="group/tool">
      <div
        onClick={() => { if (expandable) setOpen((o) => !o); }}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-[13.5px]",
          expandable && "cursor-pointer hover:bg-veil-raised",
        )}
        data-testid="tool-row"
      >
        <button type="button" disabled={!expandable} onClick={(event) => { event.stopPropagation(); setOpen((o) => !o); }} aria-expanded={expandable ? open : undefined} aria-label={`${open ? "Collapse" : "Expand"} ${verb} ${target}`} className="flex shrink-0 items-center gap-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        {pending ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-warning" data-testid="tool-running" />
        ) : failed ? (
          <CircleAlert className="size-4 shrink-0 text-destructive" />
        ) : (
          <Icon className={cn("size-4 shrink-0", toneFor(call.toolType))} />
        )}
        <span className={cn("shrink-0", pending ? "text-warning" : failed ? "text-destructive" : "text-foreground/90")}>
          {verb}
        </span>
        </button>
        {/* Three kinds of text, each its own look: the step (plain), what it acted on (muted code right after it),
            and the facts about how it went (quieter still). */}
        {target && (
          <span className={STEP_TARGET} title={target}>
            <LinkedText text={target} context={linkContext} />
          </span>
        )}
        {searchedIn && <span className={cn(STEP_TARGET, "shrink")} title={searchedIn}><span className="font-sans text-faint">in </span><LinkedText text={searchedIn} context={linkContext} /></span>}
        {searchFound && <span className={STEP_FACT}>· {searchFound}</span>}
        {readLines ? <span className={STEP_FACT}>· {readLines} {readLines === 1 ? "line" : "lines"}</span> : null}
        {safetyCheck && (
          <span className="flex min-w-0 max-w-[45%] items-center gap-1 text-[12px] text-warning" title={safetyCheck} data-testid="tool-safety-check">
            <SafetyIcon className="size-3 shrink-0" />
            <span className="truncate">{safetyCheck}</span>
          </span>
        )}
        {call.edits?.length ? <EditCounts edits={call.edits} /> : null}
        {exit != null && (
          <span className={cn("shrink-0 font-mono text-[12px] tabular-nums", exit === 0 ? "text-add" : "text-destructive")} data-testid="tool-exit">
            exit {exit}{ran != null ? ` · ${stepDuration(ran)}` : ""}
          </span>
        )}
        {expandable && <RowChevron open={open} />}
      </div>
      {open && hasBody && (
        <div className="mb-1 ml-6 mr-1">
          {call.edits?.length ? (
            <div className="space-y-2">
              {call.edits.map((e, i) =>
                e.unified && e.oldText == null && e.newText == null ? (
                  <UnifiedBlock key={i} path={e.path} unified={e.unified} kind={e.kind} cwd={cwd} />
                ) : (
                  <DiffBlock key={i} path={e.path} oldText={e.oldText ?? ""} newText={e.newText ?? ""} kind={e.kind} cwd={cwd} resultText={call.result?.text} />
                ),
              )}
            </div>
          ) : null}
          {shell && (
            <pre className="mt-1 max-h-72 overflow-auto scrollbar-thin rounded-md bg-well px-2.5 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap select-text">
              <span className="text-faint">$ </span>
              <span {...commandSection} data-chat-search-tool><LinkedText text={command} context={linkContext} /></span>
              {call.result?.text ? <><br /><span {...outputSection} data-chat-search-tool><LinkedText text={call.result.text} context={linkContext} /></span></> : null}
            </pre>
          )}
          {/* An edit's diff is its result: the tool's "ok" is only shown when the edit failed. */}
          {!shell && call.result?.text && (!call.edits?.length || failed) && (
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

/** Lines added and removed, each side only when it is not zero: "+3 −1", "+36". */
export function EditCounts({ edits }: { edits: NonNullable<ToolCall["edits"]> }) {
  let add = 0;
  let del = 0;
  for (const e of edits) {
    const { added, removed } = editLineCounts(e);
    add += added;
    del += removed;
  }
  if (!add && !del) return null;
  return (
    <span className="shrink-0 font-mono text-[12px] tabular-nums" data-testid="edit-counts">
      {add > 0 && <span className="text-add">+{add}</span>}
      {add > 0 && del > 0 && " "}
      {del > 0 && <span className="text-destructive">−{del}</span>}
    </span>
  );
}

export function ToolGroupRow({ name, calls, cwd, linkContext }: { name: string; calls: ToolCall[]; cwd?: string; linkContext?: ChatLinkContext }) {
  const [open, setOpen] = useDisclosure(`group:${calls[0].callId}`);
  const done = calls.every((c) => c.result || c.abandoned);
  const targets = groupTargets(calls);
  const noun = name === "Bash" ? "command" : "file";
  const verb = toolVerb(name, done);
  const single = targets.length === 1 ? shortPath(targets[0], cwd) : null;
  const count = targets.length || calls.length;
  const label = single ? `${verb} ${single}` : `${verb} ${count} ${noun}${count === 1 ? "" : "s"}`;
  const Icon = iconFor(calls[0].toolType);
  // Red only while the group ended on a failure: one the agent got past is marked on its own row inside, not on the whole group.
  const endedFailed = !!calls[calls.length - 1]?.result?.isError;
  const names = targets.map((t) => fileName(t)).filter(Boolean);
  return (
    <div>
      <div
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-[13.5px] hover:bg-veil-raised"
      >
        <button type="button" onClick={(event) => { event.stopPropagation(); setOpen((o) => !o); }} aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${label}`} className="flex shrink-0 items-center gap-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        {!done ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-warning" />
        ) : endedFailed ? (
          <CircleAlert className="size-4 shrink-0 text-destructive" />
        ) : (
          <Icon className={cn("size-4 shrink-0", toneFor(calls[0].toolType))} />
        )}
        <span className={cn("shrink-0", !done ? "text-warning" : "text-foreground/90")}>{single ? verb : `${verb} ${count} ${noun}${count === 1 ? "" : "s"}`}</span>
        </button>
        {single && <span className={STEP_TARGET} title={single}><LinkedText text={single} context={linkContext} /></span>}
        {targets.length > 1 && names.length > 0 && (
          <span className={STEP_TARGET}>
            {names.slice(0, 4).join(", ")}
          </span>
        )}
        <RowChevron open={open} />
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
