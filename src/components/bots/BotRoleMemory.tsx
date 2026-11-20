import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Building2, ExternalLink, FileText, History, Loader2, Lock, Plus, RotateCw, Undo2, UserRound, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { WithTooltip } from "@/components/ui/tooltip";
import { errorMessage, fs } from "@/lib/api";
import { updateBot } from "@/lib/bots";
import { botMemoryApi, byLabel, changeHeadline, changeSource, placeLabel, placeNote, useBotRoleMemory } from "@/lib/botMemory";
import { cn } from "@/lib/cn";
import { recentTime } from "@/lib/time";
import type { Bot } from "@/types/bots";
import type { BotChange, BotDiffLine, BotMemoryPlace, BotRoleMemory as RoleMemory, BotRoleVersion } from "@/types/botMemory";
import { BotAvatar } from "./BotAvatar";
import { reportsToLabel } from "./botLabels";

/**
 * Role and memory (PRO-470, design 23.06): who a bot is and what it has learned, every change to either kept in a log
 * outside the bot's reach, each with Undo. `bots` is the whole team, for "reports to", "leads" and who made a change.
 */
export function BotRoleMemory({ bot, bots, unreadable = 0 }: { bot: Bot; bots: Bot[]; unreadable?: number }) {
  const { view, error, loading, reload } = useBotRoleMemory(bot);
  if (!view) {
    return (
      <div className="px-6 py-6" data-testid="bot-role-memory">
        {error ? <LoadError error={error} onRetry={() => void reload()} /> : (
          <p role="status" className="flex items-center gap-2 text-[12.5px] text-faint"><Loader2 className="size-3.5 animate-spin" /> Reading {bot.name}'s role and memory…</p>
        )}
      </div>
    );
  }
  return (
    <div className="grid min-w-0 gap-x-8 gap-y-6 px-6 py-5 @5xl/editor-host:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]" data-testid="bot-role-memory" aria-busy={loading}>
      {error && <div className="@5xl/editor-host:col-span-2"><LoadError error={error} onRetry={() => void reload()} /></div>}
      <RoleSection bot={bot} bots={bots} unreadable={unreadable} view={view} />
      <div className="flex min-w-0 flex-col gap-6">
        <MemorySection bot={bot} view={view} />
        <ChangesSection bot={bot} bots={bots} view={view} />
      </div>
    </div>
  );
}

function LoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
      <span className="min-w-0 flex-1">Couldn't read the role and memory: {error}</span>
      <Button variant="outline" size="sm" onClick={onRetry}><RotateCw /> Retry</Button>
    </div>
  );
}

function SectionTitle({ id, title, note, children }: { id: string; title: string; note?: string; children?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 id={id} className="text-[14px] font-semibold text-foreground">{title}</h2>
      {note && <p className="text-[12.5px] text-faint">{note}</p>}
      {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
    </div>
  );
}

function Problem({ children, testId }: { children: ReactNode; testId?: string }) {
  return <p className="rounded-md bg-warning/10 px-3 py-2 text-[12.5px] text-warning" data-testid={testId}>{children}</p>;
}

const fieldClass = "h-8 w-full min-w-0 rounded-md border border-hairline bg-input px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50";

function kb(bytes: number) {
  return `${Math.ceil(bytes / 1024)} KB`;
}

/** A change's time: the clock today, the weekday this week, the date before. */
export function changeTime(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  if (at.toDateString() === now.toDateString()) return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (now.getTime() - at.getTime() < 6 * 24 * 3600 * 1000) return at.toLocaleDateString(undefined, { weekday: "short" });
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function versionAge(iso: string) {
  const recent = recentTime(iso);
  return recent === "now" ? "just now" : recent ? `${recent} ago` : changeTime(iso);
}

// ---------------------------------------------------------------- role

function RoleSection({ bot, bots, unreadable, view }: { bot: Bot; bots: Bot[]; unreadable: number; view: RoleMemory }) {
  const role = view.role;
  const leads = bots.filter((other) => other.reportsTo === bot.id);
  const [panel, setPanel] = useState<"none" | "history" | "template">("none");
  const latest = role.versions[0];
  return (
    <section aria-labelledby="bot-role-heading" className="min-w-0">
      <div className="mb-3">
        <h2 id="bot-role-heading" className="text-[14px] font-semibold text-foreground">Role</h2>
        <p className="mt-0.5 text-[12.5px] text-faint">
          Who {bot.name} is and what it answers for. {bot.name} reads this at the start of every conversation and cannot change it without you seeing it.
        </p>
      </div>
      <dl className="mb-4 grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-[13px]">
        <dt className="text-muted-foreground">Job title</dt>
        <dd className="min-w-0"><JobTitle bot={bot} /></dd>
        <dt className="text-muted-foreground">Reports to</dt>
        <dd className="min-w-0"><ReportsTo bot={bot} bots={bots} unreadable={unreadable} /></dd>
        <dt className="text-muted-foreground">Leads</dt>
        <dd className="flex min-w-0 items-center gap-2" data-testid="bot-leads">
          {leads.length === 0 ? <span className="text-faint">No one reports to {bot.name}</span> : (
            <>
              <span className="flex -space-x-1">{leads.map((lead) => <BotAvatar key={lead.id} roleTemplateId={lead.roleTemplateId} size="xs" />)}</span>
              <span className="truncate text-muted-foreground">{leads.map((lead) => lead.name).join(", ")}</span>
            </>
          )}
        </dd>
      </dl>
      <RoleEditor bot={bot} view={view} />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint" data-testid="bot-role-footer">
        <span className="inline-flex items-center gap-1.5">
          <History className="size-3.5" />
          {latest && latest.kind !== "template" ? `Changed ${versionAge(latest.at)} by ${byLabel(latest.by, bots)}` : "Unchanged since it was hired"}
        </span>
        <button type="button" className="text-accent hover:underline" aria-expanded={panel === "history"} onClick={() => setPanel(panel === "history" ? "none" : "history")} data-testid="bot-role-history-toggle">History</button>
        {role.templateTitle && (
          <span>
            Built from the {role.templateTitle} role ·{" "}
            <button type="button" className="text-accent hover:underline" aria-expanded={panel === "template"} onClick={() => setPanel(panel === "template" ? "none" : "template")} data-testid="bot-role-template-toggle">see what changed</button>
          </span>
        )}
      </div>
      {panel === "history" && <RoleHistory bot={bot} bots={bots} versions={role.versions} current={role.text} />}
      {panel === "template" && <TemplateDiff lines={role.templateDiff} />}
    </section>
  );
}

function JobTitle({ bot }: { bot: Bot }) {
  const [draft, setDraft] = useState(bot.roleTitle);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(bot.roleTitle), [bot.roleTitle]);
  const save = () => {
    const title = draft.trim();
    if (!title || title === bot.roleTitle) {
      setDraft(bot.roleTitle);
      return;
    }
    updateBot(bot.id, { roleTitle: title }).then(() => setError(null), (cause) => setError(errorMessage(cause)));
  };
  return (
    <>
      <input aria-label="Job title" className={fieldClass} value={draft} spellCheck={false} maxLength={80} onChange={(event) => setDraft(event.target.value)} onBlur={save} onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()} data-testid="bot-job-title" />
      {error && <p role="alert" className="mt-1 text-[12px] text-destructive">{error}</p>}
    </>
  );
}

function ReportsTo({ bot, bots, unreadable }: { bot: Bot; bots: Bot[]; unreadable: number }) {
  const [error, setError] = useState<string | null>(null);
  const others = bots.filter((other) => other.id !== bot.id);
  // A lead that is not in the list (removed, or unreadable by this version) is kept and named plainly.
  const known = bot.reportsTo === "owner" || others.some((other) => other.id === bot.reportsTo);
  return (
    <>
      <select aria-label="Reports to" className={fieldClass} value={bot.reportsTo} onChange={(event) => updateBot(bot.id, { reportsTo: event.target.value }).then(() => setError(null), (cause) => setError(errorMessage(cause)))} data-testid="bot-reports-to">
        <option value="owner">You</option>
        {others.map((other) => <option key={other.id} value={other.id}>{other.name} · {other.roleTitle}</option>)}
        {!known && <option value={bot.reportsTo}>{reportsToLabel(bot.reportsTo, bots, unreadable)}</option>}
      </select>
      {error && <p role="alert" className="mt-1 text-[12px] text-destructive">{error}</p>}
    </>
  );
}

function RoleEditor({ bot, view }: { bot: Bot; view: RoleMemory }) {
  const role = view.role;
  const [draft, setDraft] = useState(role.text);
  const [base, setBase] = useState(role.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== base;
  // The file changed (saved here, undone, or edited outside the app): follow it unless there is unsaved work.
  const outsideChange = role.text !== base;
  useEffect(() => {
    if (outsideChange && !dirty) {
      setDraft(role.text);
      setBase(role.text);
    }
  }, [role.text, outsideChange, dirty]);

  const save = () => {
    setSaving(true);
    botMemoryApi.writeRole(bot.id, draft).then(
      () => {
        setBase(draft);
        setError(null);
      },
      (cause) => setError(errorMessage(cause)),
    ).finally(() => setSaving(false));
  };
  const state = saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved";
  return (
    <div className="min-w-0" data-testid="bot-role-editor">
      <div className="mb-1.5 flex min-w-0 items-center gap-2 text-[12.5px]">
        <span className="shrink-0 font-medium text-foreground">Standing instructions</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-faint" title={role.path}>{role.path}</span>
        <Button variant="ghost" size="sm" onClick={() => fs.openPath(role.path).catch((cause) => setError(errorMessage(cause)))} data-testid="bot-role-open">
          <ExternalLink /> Open in editor
        </Button>
      </div>
      {role.problem && <Problem>ROLE.md: {role.problem}</Problem>}
      {role.overLimit && <Problem testId="bot-role-over-limit">ROLE.md is {kb(role.bytes)}. Only the first {kb(view.memory.readLimit)} is read at the start of a conversation.</Problem>}
      {!role.editable && <Problem testId="bot-role-read-only">ROLE.md is {kb(role.bytes)}, more than a role saved here may be, so it is shown read-only. Shorten it in your editor.</Problem>}
      {outsideChange && dirty && (
        <Problem testId="bot-role-conflict">
          ROLE.md changed while you were editing.{" "}
          <button type="button" className="underline" onClick={() => { setDraft(role.text); setBase(role.text); }}>Load the new text</button>{" "}
          or save yours over it.
        </Problem>
      )}
      <textarea
        aria-label="Standing instructions"
        value={draft}
        spellCheck={false}
        readOnly={!role.editable}
        onChange={(event) => setDraft(event.target.value)}
        className="mt-1 block h-[360px] w-full min-w-0 resize-y rounded-lg border border-hairline bg-input px-3 py-2.5 font-mono text-[12.5px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        data-testid="bot-role-text"
      />
      <div className="mt-2 flex items-center gap-2">
        <span role="status" className={cn("text-[12px]", dirty ? "text-warning" : "text-faint")} data-testid="bot-role-state">{state}</span>
        {error && <span role="alert" className="min-w-0 truncate text-[12px] text-destructive">{error}</span>}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => setDraft(base)}>Discard</Button>
          <Button variant="accent" size="sm" disabled={!dirty || saving || !role.editable} onClick={save} data-testid="bot-role-save">
            {saving && <Loader2 className="animate-spin" />} Save
          </Button>
        </div>
      </div>
    </div>
  );
}

function versionLabel(version: BotRoleVersion): string {
  switch (version.kind) {
    case "template":
      return "The role it was built from";
    case "role":
      return "Edited";
    case "restored":
      return "An earlier version put back";
    case "outside":
      return "Edited outside the app";
    case "undo":
      return "A change undone";
    default:
      return version.kind;
  }
}

function RoleHistory({ bot, bots, versions, current }: { bot: Bot; bots: Bot[]; versions: BotRoleVersion[]; current: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restore = (version: BotRoleVersion) => botMemoryApi.restoreRole(bot.id, version.change).then(() => setError(null), (cause) => setError(errorMessage(cause)));
  return (
    <div className="mt-3 rounded-lg border border-hairline" data-testid="bot-role-history">
      {error && <p role="alert" className="px-3 pt-2 text-[12px] text-destructive">{error}</p>}
      <ul className="divide-y divide-hairline">
        {versions.map((version, index) => {
          const key = version.change ?? "template";
          const isCurrent = (version.text ?? "").trimEnd() === current.trimEnd() && versions.findIndex((other) => (other.text ?? "").trimEnd() === current.trimEnd()) === index;
          return (
            <li key={key} className="px-3 py-2 text-[12.5px]" data-testid="bot-role-version">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-foreground">{versionLabel(version)}</span>
                  <span className="text-faint"> · {changeTime(version.at)} · {version.kind === "template" ? "at hire" : byLabel(version.by, bots)}</span>
                </span>
                {isCurrent && <span className="text-[11.5px] text-faint">Current</span>}
                <Button variant="ghost" size="xs" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>{open === key ? "Hide" : "Show"}</Button>
                {!isCurrent && version.text !== null && <Button variant="outline" size="xs" onClick={() => void restore(version)} data-testid="bot-role-restore">Restore</Button>}
              </div>
              {open === key && <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-well px-3 py-2 font-mono text-[11.5px] text-muted-foreground">{version.text ?? "(no file)"}</pre>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TemplateDiff({ lines }: { lines: BotDiffLine[] | null }) {
  if (!lines) return <p className="mt-3 text-[12.5px] text-faint">The role is too long to compare line by line.</p>;
  const changed = lines.filter((line) => line.kind !== "same").length;
  return (
    <div className="mt-3 rounded-lg border border-hairline" data-testid="bot-role-template-diff">
      <p className="border-b border-hairline px-3 py-1.5 text-[12px] text-faint">{changed === 0 ? "Unchanged from the role it was built from." : `${changed} line${changed === 1 ? "" : "s"} differ from the role it was built from.`}</p>
      <pre className="max-h-72 overflow-auto py-1.5 font-mono text-[11.5px] leading-relaxed">
        {lines.map((line, index) => (
          <div key={index} className={cn("px-3 whitespace-pre-wrap", line.kind === "added" && "bg-success/10 text-success", line.kind === "removed" && "bg-destructive/10 text-destructive", line.kind === "same" && "text-faint")}>
            {line.kind === "added" ? "+ " : line.kind === "removed" ? "− " : "  "}{line.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------- memory

function PlaceIcon({ place, className }: { place: string; className?: string }) {
  if (place === "bot") return <UserRound className={className} />;
  if (place === "personal") return <Lock className={className} />;
  return <Building2 className={className} />;
}

function workingName(key: string) {
  return key === "personal" ? "Personal" : key;
}

function MemorySection({ bot, view }: { bot: Bot; view: RoleMemory }) {
  const memory = view.memory;
  const [selected, setSelected] = useState(memory.workingPlace);
  const place = memory.places.find((value) => value.key === selected) ?? memory.places[0];
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const topics = memory.topics.filter((topic) => topic.place === place?.key);
  const notRead = memory.places.reduce((sum, value) => sum + value.notRead, 0);
  const overLimit = memory.places.filter((value) => value.read && value.overLimit);

  const turn = (on: boolean) => {
    setSwitching(true);
    updateBot(bot.id, { memoryOff: !on }).then(() => setError(null), (cause) => setError(errorMessage(cause))).finally(() => setSwitching(false));
  };

  return (
    <section aria-labelledby="bot-memory-heading" className="min-w-0" data-testid="bot-memory">
      <SectionTitle id="bot-memory-heading" title="Memory" note={`What ${bot.name} has learned`}>
        <label className="inline-flex items-center gap-2 text-[12.5px] text-muted-foreground">
          Memory
          <Switch checked={!memory.off} disabled={switching} onCheckedChange={turn} aria-label={`${bot.name}'s memory`} data-testid="bot-memory-switch" />
        </label>
      </SectionTitle>
      {error && <p role="alert" className="mb-2 text-[12px] text-destructive">{error}</p>}
      {memory.off ? (
        <Problem testId="bot-memory-off">Memory is off. Conversations with {bot.name} start with none of its notes, and {bot.name} cannot write any. You can still read and change them here.</Problem>
      ) : (
        <div className="mb-3 text-[12.5px]">
          <p className="text-foreground" data-testid="bot-memory-read">
            <span className="font-semibold">{memory.read}</span> of {memory.budget} lines read at the start of each conversation in {workingName(memory.workingPlace)}
          </p>
          <p className="text-faint">Older notes move to the archive, which {bot.name} searches when it needs them.</p>
        </div>
      )}
      {notRead > 0 && <Problem testId="bot-memory-not-read">{notRead} line{notRead === 1 ? " is" : "s are"} past the {memory.budget}-line budget and not read at the start of a conversation. The next note added moves the oldest to the archive.</Problem>}
      {overLimit.map((value) => (
        <Problem key={value.key} testId="bot-memory-over-limit">{placeLabel(value.key, bot.name)}: MEMORY.md is {kb(value.bytes)}, and only the first {kb(memory.readLimit)} is read.</Problem>
      ))}

      <h3 className="mb-2 mt-4 text-[11px] font-medium uppercase tracking-[.08em] text-faint">Where it is kept</h3>
      <div className="grid gap-2" role="radiogroup" aria-label="Where it is kept">
        {memory.places.map((value) => (
          <button
            key={value.key}
            type="button"
            role="radio"
            aria-checked={value.key === place?.key}
            onClick={() => setSelected(value.key)}
            className={cn("flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40", value.key === place?.key ? "border-accent/50 bg-selected" : "border-hairline hover:bg-selected/50")}
            data-testid="bot-memory-place"
            data-place={value.key}
          >
            <PlaceIcon place={value.key} className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-foreground">{placeLabel(value.key, bot.name)}</span>
              <span className="block truncate text-[12px] text-faint">{placeNote(value.key, value.read, bot.name)}</span>
            </span>
            <span className="shrink-0 text-[12px] text-muted-foreground">{value.lines.length} line{value.lines.length === 1 ? "" : "s"}</span>
          </button>
        ))}
      </div>

      {place && <PlaceNotes bot={bot} place={place} />}

      <h3 className="mb-2 mt-4 text-[11px] font-medium uppercase tracking-[.08em] text-faint">Topics in {place ? (place.key === "bot" ? bot.name : workingName(place.key)) : ""}</h3>
      {topics.length === 0 ? <p className="text-[12.5px] text-faint">No topic files yet. Longer notes go in memory/ beside MEMORY.md.</p> : (
        <ul className="grid gap-1" data-testid="bot-memory-topics">
          {topics.map((topic) => (
            <li key={topic.path}>
              <button type="button" onClick={() => fs.openPath(topic.path).catch((cause) => setError(errorMessage(cause)))} className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-selected/50" title={topic.path}>
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-foreground">{topic.name}</span>
                <span className="shrink-0 text-faint">{topic.lines} line{topic.lines === 1 ? "" : "s"}{topic.modified ? ` · ${versionAge(topic.modified)}` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const DATED = /^- (\d{4}-\d{2}-\d{2}) (.*)$/;

function PlaceNotes({ bot, place }: { bot: Bot; place: BotMemoryPlace }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notes = useMemo(() => place.lines.map((line, index) => ({ line, index, dated: DATED.exec(line) })), [place.lines]);
  const act = (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    action().then(() => { setError(null); after?.(); }, (cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    act(() => botMemoryApi.add(bot.id, place.key, text), () => setText(""));
  };
  return (
    <div className="mt-3 rounded-lg border border-hairline" data-testid="bot-memory-notes">
      <div className="flex min-w-0 items-center gap-2 border-b border-hairline px-3 py-1.5 text-[12px]">
        <span className="min-w-0 flex-1 truncate font-mono text-faint" title={place.path}>{place.path}</span>
        {/* A place's file is made with its first note: there is nothing to open before that. */}
        {place.bytes > 0 && <Button variant="ghost" size="xs" onClick={() => fs.openPath(place.path).catch((cause) => setError(errorMessage(cause)))}><ExternalLink /> Open</Button>}
      </div>
      {place.problem && <div className="px-3 pt-2"><Problem>MEMORY.md: {place.problem}</Problem></div>}
      <ul className="max-h-64 overflow-y-auto py-1 scrollbar-thin">
        {notes.length === 0 && <li className="px-3 py-1.5 text-[12.5px] text-faint">Nothing kept here yet.</li>}
        {notes.map(({ line, index, dated }) => (
          <li key={`${index}:${line}`} className={cn("group flex min-w-0 items-start gap-2 px-3 py-0.5 text-[12.5px]", place.read && index >= place.readLines && "opacity-60")} data-testid="bot-memory-line">
            {dated ? (
              <>
                <span className="shrink-0 font-mono text-[11.5px] text-faint">{dated[1]}</span>
                <span className="min-w-0 flex-1 break-words text-foreground">{dated[2]}</span>
                <WithTooltip label="Forget this note">
                  <Button variant="ghost" size="icon-xs" disabled={busy} aria-label={`Forget “${dated[2]}”`} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => act(() => botMemoryApi.forget(bot.id, place.key, line))} data-testid="bot-memory-forget">
                    <X />
                  </Button>
                </WithTooltip>
              </>
            ) : (
              <span className="min-w-0 flex-1 break-words text-muted-foreground">{line || " "}</span>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="flex items-center gap-2 border-t border-hairline px-3 py-2">
        <input aria-label="Add a note" placeholder="Add a note, one line" value={text} maxLength={400} spellCheck={false} onChange={(event) => setText(event.target.value)} className={fieldClass} data-testid="bot-memory-add-text" />
        <Button type="submit" variant="outline" size="sm" disabled={busy || !text.trim()} data-testid="bot-memory-add">
          {busy ? <Loader2 className="animate-spin" /> : <Plus />} Add
        </Button>
      </form>
      {error && <p role="alert" className="px-3 pb-2 text-[12px] text-destructive">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- changes

function ChangesSection({ bot, bots, view }: { bot: Bot; bots: Bot[]; view: RoleMemory }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const undo = (change: BotChange) => {
    setBusy(change.id);
    botMemoryApi.undo(bot.id, change.id).then(() => setError(null), (cause) => setError(errorMessage(cause))).finally(() => setBusy(null));
  };
  return (
    <section aria-labelledby="bot-changes-heading" className="min-w-0" data-testid="bot-changes">
      <h2 id="bot-changes-heading" className="mb-2 text-[11px] font-medium uppercase tracking-[.08em] text-faint">Changes kept outside {bot.name}’s reach</h2>
      {error && <p role="alert" className="mb-2 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{error}</p>}
      {view.unreadableChanges > 0 && <Problem>{view.unreadableChanges} recorded change{view.unreadableChanges === 1 ? "" : "s"} cannot be read by this version. They are kept.</Problem>}
      {view.changes.length === 0 ? (
        <p className="rounded-lg border border-dashed border-hairline-strong px-4 py-3 text-[12.5px] text-faint">No changes yet. Every note {bot.name} learns or forgets, and every change to its role, is listed here with Undo.</p>
      ) : (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline">
          {view.changes.map((change) => (
            <li key={change.id} className="flex min-w-0 items-start gap-3 px-3 py-2 text-[12.5px]" data-testid="bot-change" data-kind={change.kind}>
              <span className="w-12 shrink-0 pt-px font-mono text-[11.5px] text-faint">{changeTime(change.at)}</span>
              <span className="min-w-0 flex-1">
                <span className={cn("block break-words", change.undoneBy ? "text-faint line-through" : "text-foreground")}>{changeHeadline(change)}</span>
                <span className="block truncate text-[12px] text-faint">{changeSource(change, bots)}</span>
              </span>
              {change.undoneBy ? (
                <span className="shrink-0 text-[12px] text-faint">Undone</span>
              ) : change.notUndoable ? (
                change.undoes ? null : <WithTooltip label={change.notUndoable}><span className="shrink-0 text-[12px] text-faint">Can't undo</span></WithTooltip>
              ) : (
                <Button variant="ghost" size="xs" disabled={busy !== null} onClick={() => undo(change)} data-testid="bot-change-undo">
                  {busy === change.id ? <Loader2 className="animate-spin" /> : <Undo2 />} Undo
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {view.totalChanges > view.changes.length && <p className="mt-1 text-[12px] text-faint">Showing the newest {view.changes.length} of {view.totalChanges} changes.</p>}
    </section>
  );
}
