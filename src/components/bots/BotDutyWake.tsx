import { useEffect, useState } from "react";
import { AutomationSourceFields, defaultLinearTrigger, defaultPullRequestTrigger, eventTriggerReady } from "@/components/automations/AutomationSourceFields";
import { Segmented } from "@/components/ui/controls";
import { issues as issuesApi, type IssueTeam } from "@/lib/api";
import type { AutomationEventTrigger } from "@/types/automations";
import type { Bot } from "@/types/bots";
import type { BotMessageKind, BotWakeKind, BotWakeSource, DutyWake } from "@/types/botDuties";

const INPUT = "h-8 w-full rounded-md bg-well px-2.5 text-[13px] outline-none ring-offset-background focus:ring-2 focus:ring-ring/30";
const LABEL = "flex flex-col gap-1.5 text-xs font-medium";
const NOTE = "col-span-2 rounded-lg border border-hairline bg-well px-3 py-2 text-[11px] leading-relaxed text-muted-foreground";

/** What wakes a duty, as the editor and the "Add a duty that wakes on" tiles group it. */
export type WakeGroup = "schedule" | "github" | "linear" | "bot" | "watch";

/** Wakes on a pull request event, or a Linear issue (PRO-485's sources), or one of a bot's own kinds. */
type WakeKind = "githubPullRequest" | "linearIssue" | BotWakeKind;

const GITHUB: { value: WakeKind; label: string }[] = [
  { value: "githubPullRequest", label: "A pull request is opened, pushed, asks for your review or fails a check" },
  { value: "githubMention", label: "A comment mentions the bot" },
  { value: "githubSecurityAlert", label: "A security alert is created" },
  { value: "githubBranchCheck", label: "A check fails on a branch" },
];

const LINEAR: { value: WakeKind; label: string }[] = [
  { value: "linearIssue", label: "An issue matching a filter is created or comes to match" },
  { value: "linearMention", label: "A comment mentions the bot" },
];

const MESSAGE_KINDS: { value: BotMessageKind; label: string }[] = [
  { value: "handoff", label: "Hand-off" },
  { value: "question", label: "Question" },
  { value: "status", label: "Status" },
];

/** The most wakes of one duty an hour and a day (`bots::wakes::WAKES_PER_HOUR`, `WAKES_PER_DAY`). */
export const WAKES_PER_HOUR = 6;
export const WAKES_PER_DAY = 48;

/** The group a duty's wake is in; `schedule` for none. A kind this app does not know stays in its own. */
export function wakeGroupOf(wake: DutyWake | null): WakeGroup | "unknown" {
  if (!wake) return "schedule";
  const kind = wake.source.kind as string;
  if (kind.startsWith("github")) return "github";
  if (kind.startsWith("linear")) return "linear";
  if (kind === "botMessage") return "bot";
  if (kind === "watch") return "watch";
  return "unknown";
}

/** A new wake of `kind`, keeping the repository already typed. */
export function newWake(kind: WakeKind, bot: Pick<Bot, "slug">, repo = ""): DutyWake {
  if (kind === "githubPullRequest") return { ...defaultPullRequestTrigger(repo), maxRunsPerTick: 1 } as DutyWake;
  if (kind === "linearIssue") {
    const trigger = defaultLinearTrigger();
    return { ...trigger, maxRunsPerTick: 1, source: { ...trigger.source, report: { comment: false, moveToStateId: null, moveToStateName: null, commentOnFailure: false } } } as DutyWake;
  }
  const source: BotWakeSource = { kind };
  if (kind.startsWith("github")) source.repo = repo;
  if (kind === "githubMention" || kind === "linearMention") source.handle = bot.slug;
  if (kind === "githubBranchCheck") source.branch = "main";
  if (kind === "watch") source.target = "url";
  return { source, pollIntervalMinutes: kind === "botMessage" ? 1 : 5, maxRunsPerTick: 1 };
}

/** The first wake of a group, as its tile opens the editor. */
export function wakeForGroup(group: WakeGroup, bot: Pick<Bot, "slug">): DutyWake | null {
  switch (group) {
    case "schedule": return null;
    case "github": return newWake("githubPullRequest", bot);
    case "linear": return newWake("linearIssue", bot);
    case "bot": return newWake("botMessage", bot);
    case "watch": return newWake("watch", bot);
  }
}

const HANDLE = /^[A-Za-z0-9._-]{1,64}$/;
const REPO = /^[^/\s]+\/[^/\s]+$/;

/** Whether the wake has what saving it needs. A kind this app does not know is saved as it is. */
export function wakeReady(wake: DutyWake | null): boolean {
  if (!wake) return true;
  const kind = wake.source.kind as string;
  if (kind === "githubPullRequest" || kind === "linearIssue") return eventTriggerReady(wake as AutomationEventTrigger);
  const source = wake.source as BotWakeSource;
  const value = (source.value ?? "").trim();
  switch (kind) {
    case "githubMention": return REPO.test((source.repo ?? "").trim()) && HANDLE.test((source.handle ?? "").replace(/^@/, ""));
    case "githubSecurityAlert": return REPO.test((source.repo ?? "").trim());
    case "githubBranchCheck": return REPO.test((source.repo ?? "").trim()) && !!(source.branch ?? "").trim();
    case "linearMention": return HANDLE.test((source.handle ?? "").replace(/^@/, ""));
    case "watch":
      if (source.target === "url") return /^https?:\/\//.test(value);
      if (source.target === "file") return value.startsWith("/");
      return !!value;
    default: return true;
  }
}

/**
 * The fields of what wakes a duty besides a schedule (PRO-472): which event, and where. Whatever an event brings (a
 * pull request's title, a comment, an alert, a page, another bot's message) reaches the bot as information.
 */
export function BotDutyWake({ bot, bots, home, wake, onChange }: {
  bot: Bot;
  bots: readonly Bot[];
  home: string | null;
  wake: DutyWake;
  onChange: (next: DutyWake) => void;
}) {
  const group = wakeGroupOf(wake);
  const kind = wake.source.kind as WakeKind;
  const source = wake.source as BotWakeSource;
  const patch = (next: Partial<BotWakeSource>) => onChange({ ...wake, source: { ...source, ...next } });
  const repo = typeof (wake.source as { repo?: unknown }).repo === "string" ? String((wake.source as { repo?: string }).repo) : "";
  const choices = group === "github" ? GITHUB : group === "linear" ? LINEAR : null;
  const every = (
    <label className={LABEL}>
      Check every (minutes)
      <input type="number" min={1} value={wake.pollIntervalMinutes} onChange={(event) => onChange({ ...wake, pollIntervalMinutes: Math.max(1, Number(event.target.value)) })} className={INPUT} />
    </label>
  );

  return (
    <>
      {choices && (
        <label className={`${LABEL} col-span-2`}>
          {group === "github" ? "On GitHub, when" : "In Linear, when"}
          <select value={kind} onChange={(event) => onChange(newWake(event.target.value as WakeKind, bot, repo))} className={INPUT} data-testid="duty-wake-kind">
            {choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </select>
        </label>
      )}
      {(kind === "githubPullRequest" || kind === "linearIssue") && (
        <AutomationSourceFields projectPath={home ?? ""} trigger={wake as AutomationEventTrigger} onChange={(next) => onChange({ ...(next as DutyWake), maxRunsPerTick: 1 })} forDuty />
      )}
      {(kind === "githubMention" || kind === "githubSecurityAlert" || kind === "githubBranchCheck") && (
        <label className={LABEL}>
          Repository
          <input value={source.repo ?? ""} onChange={(event) => patch({ repo: event.target.value })} className={`${INPUT} font-mono`} placeholder="owner/repo" spellCheck={false} />
        </label>
      )}
      {(kind === "githubMention" || kind === "linearMention") && (
        <label className={LABEL}>
          Mentioned as
          <span className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[13px] text-faint">@</span>
            <input value={(source.handle ?? "").replace(/^@/, "")} onChange={(event) => patch({ handle: event.target.value.replace(/^@/, "") })} className={`${INPUT} pl-6 font-mono`} placeholder={bot.slug} spellCheck={false} />
          </span>
        </label>
      )}
      {kind === "githubBranchCheck" && (
        <label className={LABEL}>
          Branch
          <input value={source.branch ?? ""} onChange={(event) => patch({ branch: event.target.value })} className={`${INPUT} font-mono`} placeholder="main" spellCheck={false} />
        </label>
      )}
      {kind === "linearMention" && <LinearTeam teamId={source.teamId ?? null} teamName={source.teamName ?? null} onChange={(teamId, teamName) => patch({ teamId, teamName })} />}
      {kind === "botMessage" && <FromBots bot={bot} bots={bots} source={source} onChange={patch} />}
      {kind === "watch" && <WatchFields bot={bot} source={source} onChange={patch} />}
      {kind !== "githubPullRequest" && kind !== "linearIssue" && every}
      {kind === "githubSecurityAlert" && <div className={NOTE}>Reads the repository's open Dependabot alerts with gh, which needs to be signed in with access to them.</div>}
      <div className={NOTE} data-testid="duty-wake-note">
        What wakes it is given to its first check (a file named in <span className="font-mono">$TERMINALX_EVENTS</span>) and to {bot.name} as information, never as instructions or your approval.
        <div className="mt-1">
          Each event wakes it once; what is there when it starts never does. It wakes at most {WAKES_PER_HOUR} times an hour and {WAKES_PER_DAY} a day, one run at a time; past that events wait, and the duty says until when. While {bot.name} is paused they wait, and wake it when you resume it.
        </div>
      </div>
    </>
  );
}

function LinearTeam({ teamId, teamName, onChange }: { teamId: string | null; teamName: string | null; onChange: (teamId: string | null, teamName: string | null) => void }) {
  const [teams, setTeams] = useState<IssueTeam[]>([]);
  useEffect(() => {
    let live = true;
    issuesApi.linearTeams().then((values) => live && setTeams(values), () => {});
    return () => { live = false; };
  }, []);
  return (
    <label className={LABEL}>
      Team
      <select value={teamId ?? ""} onChange={(event) => onChange(event.target.value || null, teams.find((team) => team.id === event.target.value)?.name ?? null)} className={INPUT}>
        <option value="">Any team</option>
        {teamId && !teams.some((team) => team.id === teamId) && <option value={teamId}>{teamName ?? teamId}</option>}
        {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
      </select>
    </label>
  );
}

function FromBots({ bot, bots, source, onChange }: { bot: Bot; bots: readonly Bot[]; source: BotWakeSource; onChange: (next: Partial<BotWakeSource>) => void }) {
  const others = bots.filter((other) => other.id !== bot.id);
  const from = source.from ?? [];
  const kinds = source.kinds ?? [];
  // A bot this list does not show (gone, or not read yet) stays chosen.
  const missing = from.filter((id) => !others.some((other) => other.id === id));
  const toggle = <T,>(list: T[], value: T, on: boolean) => (on ? [...list.filter((item) => item !== value), value] : list.filter((item) => item !== value));
  return (
    <>
      <fieldset className="col-span-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs" aria-label="From">
        <legend className="mb-1.5 font-medium">From <span className="font-normal text-faint">(none chosen: any of your bots)</span></legend>
        {others.length === 0 && missing.length === 0 && <span className="text-faint">You have no other bot yet.</span>}
        {others.map((other) => (
          <label key={other.id} className="flex items-center gap-2"><input type="checkbox" checked={from.includes(other.id)} onChange={(event) => onChange({ from: toggle(from, other.id, event.target.checked) })} /> {other.name}</label>
        ))}
        {missing.map((id) => (
          <label key={id} className="flex items-center gap-2 text-faint"><input type="checkbox" checked onChange={() => onChange({ from: from.filter((value) => value !== id) })} /> A bot that is not listed</label>
        ))}
      </fieldset>
      <fieldset className="col-span-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs" aria-label="Kinds of message">
        <legend className="mb-1.5 font-medium">Wakes on <span className="font-normal text-faint">(none chosen: every kind)</span></legend>
        {MESSAGE_KINDS.map((choice) => (
          <label key={choice.value} className="flex items-center gap-2"><input type="checkbox" checked={kinds.includes(choice.value)} onChange={(event) => onChange({ kinds: toggle(kinds, choice.value, event.target.checked) })} /> {choice.label}</label>
        ))}
      </fieldset>
      <div className={NOTE}>
        A bot leaves {bot.name} a message with <span className="font-mono">terminalx bots message {bot.slug} "…"</span>, and a duty that reports to {bot.name} leaves it a status. A message that has passed between bots three times wakes nobody, so two bots cannot keep waking each other.
      </div>
    </>
  );
}

function WatchFields({ bot, source, onChange }: { bot: Bot; source: BotWakeSource; onChange: (next: Partial<BotWakeSource>) => void }) {
  const target = source.target ?? "url";
  return (
    <>
      <div className="col-span-2 flex flex-col gap-1.5">
        <span className="text-xs font-medium">Wait until this changes</span>
        <Segmented<"url" | "file" | "command">
          aria-label="What it watches"
          value={target}
          onChange={(next) => onChange({ target: next, value: "" })}
          options={[{ value: "url", label: "A URL" }, { value: "file", label: "A file" }, { value: "command", label: "A check's output" }]}
        />
      </div>
      <label className={`${LABEL} col-span-2`}>
        {target === "url" ? "URL" : target === "file" ? "File (its full path)" : "Command"}
        <input
          value={source.value ?? ""}
          onChange={(event) => onChange({ value: event.target.value })}
          className={`${INPUT} font-mono`}
          placeholder={target === "url" ? "https://status.example.com" : target === "file" ? "/Users/you/notes/release.md" : "gh run list --branch main --limit 1 --json conclusion"}
          spellCheck={false}
        />
        {target === "command" && <span className="font-normal text-faint">Runs as you, not as {bot.name}: in an empty folder of the duty's own, never in {bot.name}'s home. A failing command is shown as an error and wakes nothing.</span>}
      </label>
      {target === "command" && (
        <label className={LABEL}>
          Timeout (seconds)
          <input type="number" min={1} max={300} value={source.timeoutSeconds ?? 60} onChange={(event) => onChange({ timeoutSeconds: Math.min(300, Math.max(1, Number(event.target.value))) })} className={INPUT} />
        </label>
      )}
    </>
  );
}
