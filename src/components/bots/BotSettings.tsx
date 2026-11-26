import { ThisComputer, thisComputer } from "@/lib/platform";
import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import { AppWindow, Building2, ChevronDown, Cloud, Eye, Github, Laptop, Loader2, Plus, Send, Server, ShieldAlert, ShieldOff, Hash, SquareKanban, UserRound } from "@/icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MachineHostError } from "@/components/machines/MachineHostError";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { WithTooltip } from "@/components/ui/tooltip";
import { useAccount } from "@/lib/account";
import { botsApi, errorMessage, gh, issues, type GitHubConnectionStatus, type LinearStatus, type OrganizationSummary } from "@/lib/api";
import { getBotStore, updateBot, useBotStore } from "@/lib/bots";
import { cn } from "@/lib/cn";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { readOrganizationRoster } from "@/lib/organizationRoster";
import type { OrganizationMember } from "@/lib/organizationMembers";
import { openSettingRow } from "@/lib/settingsLinks";
import { relativeTime } from "@/lib/time";
import type { BotChannelsView, BotMention, BotPost } from "@/types/botChannels";
import { effectiveAccess, runsOnPlace, type Bot, type BotAccess, type BotAsker, type BotAskerMay, type BotPatch } from "@/types/bots";
import { BOT_IDLE_SUSPEND_MINUTES, bringBotBack, moveBot, type MoveStep } from "@/lib/botMove";
import { useCloudChoices, useMachineChoices, usePlaceName, type PlaceChoice } from "./useBotPlace";
import { BotAvatar } from "./BotAvatar";
import { ChatAppDialog, chatAppRow } from "./BotChatApps";
import { useChatApps } from "@/lib/botChatApps";
import type { ChatAppService } from "@/types/botChatApps";

/**
 * A bot's settings (PRO-478, design 23.07): where it runs, its access, where it works, its channels and who may ask
 * it for work. The things the owner sets rarely. Every change is saved at once; nothing here is a budget or a cap.
 */
export function BotSettings({ bot }: { bot: Bot }) {
  // Each section waits on its own save; the others stay usable.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  // The last save that failed, with how to try it again: a change that gives the bot more is confirmed by this window,
  // and a runtime that cannot verify it is restarted from the error (`MachineHostError`), then the save is tried again.
  const [error, setError] = useState<{ message: string; retry: () => void } | null>(null);
  // This page's saves go one after another, so each is sent against the bot as the one before it left it.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = (what: string, patch: () => BotPatch) => {
    setBusy((current) => new Set(current).add(what));
    const sent = queue.current.then(() => updateBot(bot.id, patch()));
    queue.current = sent.catch(() => undefined);
    void sent
      .then(() => setError(null), (cause) => setError({ message: errorMessage(cause), retry: () => save(what, patch) }))
      .finally(() => setBusy((current) => {
        const next = new Set(current);
        next.delete(what);
        return next;
      }));
  };
  // A whole list is saved against the bot as this page read it, so a change made elsewhere meanwhile is not undone.
  // A save of this page's own that went first (another section's) moved `modified` on: while the list is still the one
  // shown when it was changed, it is sent against the bot as it is now (PRO-494).
  const saveList = (what: "worksIn" | "whoCanAsk", change: Pick<BotPatch, "worksIn" | "whoCanAsk">) => {
    const seen = bot;
    save(what, () => {
      const now = getBotStore().bots.find((value) => value.id === seen.id);
      const unchanged = now !== undefined && JSON.stringify(now[what] ?? null) === JSON.stringify(seen[what] ?? null);
      return { ...change, ifModified: unchanged ? now.modified : seen.modified };
    });
  };
  return (
    <div className="flex min-w-0 max-w-[1040px] flex-col" data-testid="bot-settings">
      {error && (
        <div data-testid="bot-settings-error">
          <MachineHostError error={error.message} onRestarted={() => { setError(null); error.retry(); }} onFailed={(message) => setError({ message, retry: error.retry })} className="mb-3 rounded-md bg-destructive/10 px-3 py-2" />
        </div>
      )}
      <Section title="Runs on" note={`Where ${bot.name} lives and works. Moving a bot takes its role, memory and duties with it.`}>
        <RunsOn bot={bot} />
      </Section>
      <Section title="Access" note={`What ${bot.name} may do without asking you first.`}>
        <Access bot={bot} busy={busy.has("access")} onChange={(access) => save("access", () => ({ access }))} />
      </Section>
      <Section title="Works in" note={`${bot.name} is yours and goes where you work. Its role and skills go everywhere. What it learns inside an organisation stays there.`}>
        <WorksIn bot={bot} busy={busy.has("worksIn")} onChange={(worksIn) => saveList("worksIn", { worksIn })} />
      </Section>
      <Section title="Channels" note={`Where you can reach ${bot.name} and where it reports.`}>
        <Channels bot={bot} />
        <ChannelActivity bot={bot} />
      </Section>
      <Section title="Who can ask" note={`People and bots that may give ${bot.name} work. ${bot.name} acts with your accounts. Its lead hands it work anyway; any other bot, a report of ${bot.name} included, hands it work only when listed here with "Can hand off work".`}>
        <WhoCanAsk bot={bot} busy={busy.has("whoCanAsk")} onChange={(whoCanAsk) => saveList("whoCanAsk", { whoCanAsk })} />
      </Section>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  const id = `bot-settings-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="grid min-w-0 grid-cols-1 gap-x-8 gap-y-2 border-t border-hairline py-3 first:border-t-0 first:pt-0 @3xl/editor-host:grid-cols-[220px_minmax(0,1fr)]" data-testid="bot-settings-section">
      <div className="min-w-0">
        <h2 id={id} className="text-[13px] font-medium text-foreground">{title}</h2>
        <p className="mt-1 text-[12px] leading-[17px] text-faint">{note}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/**
 * Arrow keys move between a radio group's enabled cards; Space or Enter chooses the one reached (PRO-494). A choice
 * here is saved at once and may need this window's confirmation, so passing over a level on the way to another must
 * not choose it.
 */
function moveBetweenRadios(event: KeyboardEvent<HTMLElement>) {
  const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
  if (!step) return;
  const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]:not(:disabled)")];
  const at = radios.indexOf(document.activeElement as HTMLButtonElement);
  if (radios.length === 0 || at < 0) return;
  event.preventDefault();
  radios[(at + step + radios.length) % radios.length].focus();
}

/** One choice of a set of cards: its icon, title and what it means. */
function ChoiceCard({ icon: Icon, title, note, checked, focusable = false, disabled, busy = false, badge, onSelect, testId }: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  note: string;
  checked: boolean;
  /** Takes the group's tab stop though not chosen: the level an unknown value is held to. */
  focusable?: boolean;
  disabled?: boolean;
  /** Its group is saving: it takes no choice, but keeps the focus it has. */
  busy?: boolean;
  badge?: string;
  onSelect?: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      // One stop in the tab order per group: the chosen card; arrows move within it.
      tabIndex={checked || focusable ? 0 : -1}
      disabled={disabled}
      aria-disabled={busy || undefined}
      onClick={checked || busy ? undefined : onSelect}
      className={cn(
        "flex min-w-0 flex-1 basis-[200px] flex-col rounded-md border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        checked ? "border-accent/55 bg-accent/[.06]" : "border-hairline-strong hover:bg-muted/40",
        (disabled || busy) && "cursor-not-allowed opacity-60 hover:bg-transparent",
      )}
      data-testid={testId}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon className={cn("size-3.5 shrink-0", checked ? "text-accent" : "text-muted-foreground")} />
        <span className="min-w-0 truncate text-[12.5px] font-medium text-foreground">{title}</span>
        <span aria-hidden className={cn("ml-auto grid size-3.5 shrink-0 place-items-center rounded-full border", checked ? "border-accent" : "border-hairline-strong")}>
          {checked && <span className="size-1.5 rounded-full bg-accent" />}
        </span>
      </span>
      <span className="mt-1 text-[11.5px] leading-4 text-faint">{note}</span>
      {badge && <span className="mt-1.5 text-[11px] text-muted-foreground">{badge}</span>}
    </button>
  );
}

const MOVE_STEPS: Record<MoveStep, string> = {
  connecting: "Connecting…",
  reading: "Reading its role, memory, duties and items…",
  sending: "Sending…",
  bringing: "Bringing it in…",
  settling: "Finishing…",
};

/**
 * Where the bot lives (PRO-482): this Mac, a cloud workspace or a paired machine. Moving it takes its role, memory,
 * duties and items with it; on a cloud workspace its duties wake the workspace, which sleeps two idle minutes later.
 */
function RunsOn({ bot }: { bot: Bot }) {
  const place = runsOnPlace(bot.runsOn);
  const here = usePlaceName(bot.runsOn);
  const [choosing, setChoosing] = useState<"cloud" | "machine" | "back" | null>(null);
  const [step, setStep] = useState<MoveStep | null>(null);
  const [outcome, setOutcome] = useState<{ error?: string; notes: string[] } | null>(null);
  const run = (work: (onStep: (step: MoveStep) => void) => Promise<{ notes: string[] }>) => {
    setChoosing(null);
    setOutcome(null);
    setStep("connecting");
    void work(setStep)
      .then(({ notes }) => setOutcome({ notes }), (cause) => setOutcome({ error: errorMessage(cause), notes: [] }))
      .finally(() => setStep(null));
  };
  const busy = step !== null;
  const elsewhere = place.kind === "cloud" || place.kind === "machine";
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div role="radiogroup" aria-label="Runs on" aria-busy={busy} onKeyDown={moveBetweenRadios} className="flex min-w-0 flex-wrap gap-2.5">
        <ChoiceCard icon={Laptop} title={ThisComputer} note={`Works while ${thisComputer} is awake. Uses your local agent logins. No compute cost.`} checked={place.kind === "thisMac"} busy={busy} disabled={place.kind === "other"} onSelect={() => setChoosing("back")} testId="bot-runs-on-this-mac" />
        <ChoiceCard icon={Cloud} title="Cloud workspace" note={`Always on. Keeps working when ${thisComputer} is off or asleep. Billed per hour of work.`} checked={place.kind === "cloud"} busy={busy} disabled={place.kind === "other" || place.kind === "machine"} badge={place.kind === "cloud" ? here : undefined} onSelect={() => setChoosing("cloud")} testId="bot-runs-on-cloud" />
        <ChoiceCard icon={Server} title="Another machine" note="A paired computer or a headless server you own." checked={place.kind === "machine"} busy={busy} disabled={place.kind === "other" || place.kind === "cloud"} badge={place.kind === "machine" ? here : undefined} onSelect={() => setChoosing("machine")} testId="bot-runs-on-machine" />
      </div>
      {place.kind === "other" && (
        <p className="text-[12px] text-warning" data-testid="bot-runs-on-unknown">
          A newer version of TerminalX set this bot to run on “{bot.runsOn}”. This version shows it as it is and cannot change it.
        </p>
      )}
      {elsewhere && !busy && (
        <p className="text-[12px] text-faint" data-testid="bot-runs-on-elsewhere">
          {place.kind === "cloud"
            ? `${bot.name} lives on ${here}: its duties run there on the workspace's schedule, and the workspace sleeps after ${BOT_IDLE_SUSPEND_MINUTES} idle minutes. Its questions reach you on the phone. To move it to another place, bring it back to ${thisComputer} first.`
            : `${bot.name} lives on ${here}: its duties run there. To move it to another place, bring it back to ${thisComputer} first.`}
        </p>
      )}
      {busy && (
        <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground" role="status" data-testid="bot-runs-on-moving">
          <Loader2 className="size-3 animate-spin" /> {MOVE_STEPS[step]}
        </p>
      )}
      {outcome?.error && <p className="text-[12px] text-destructive" role="alert" data-testid="bot-runs-on-error">{outcome.error}</p>}
      {outcome && !outcome.error && outcome.notes.length > 0 && (
        <ul className="flex flex-col gap-1 text-[12px] text-warning" data-testid="bot-runs-on-notes">
          {outcome.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
      {(choosing === "cloud" || choosing === "machine") && (
        <MoveDialog bot={bot} kind={choosing} onClose={() => setChoosing(null)} onMove={(to) => run((onStep) => moveBot(bot, to, onStep))} />
      )}
      {choosing === "back" && elsewhere && (
        <Dialog open onOpenChange={(next) => { if (!next) setChoosing(null); }}>
          <DialogContent width="max-w-[26rem]" className="p-4" data-testid="bot-bring-back">
            <DialogTitle className="mr-8 truncate text-sm font-semibold">Bring {bot.name} back to {thisComputer}?</DialogTitle>
            <DialogDescription className="mt-1 text-xs leading-[18px] text-muted-foreground">
              {`Its role, memory, duties and items come back from ${here}, with what it learned there. Its duties then run only while ${thisComputer} is awake. Its chats there stay there.`}
            </DialogDescription>
            <div className="mt-3 flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setChoosing(null)}>Cancel</Button>
              <Button type="button" size="sm" onClick={() => run((onStep) => bringBotBack(bot, onStep))} data-testid="bot-bring-back-confirm">Bring back</Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function MoveDialog({ bot, kind, onClose, onMove }: { bot: Bot; kind: "cloud" | "machine"; onClose: () => void; onMove: (to: PlaceChoice["place"]) => void }) {
  const clouds = useCloudChoices();
  const machines = useMachineChoices();
  const choices = kind === "cloud" ? clouds : machines;
  const [picked, setPicked] = useState<string | null>(() => choices.find((choice) => !choice.unavailable)?.place.key ?? null);
  const chosen = choices.find((choice) => choice.place.key === picked && !choice.unavailable);
  const what = kind === "cloud" ? "cloud workspace" : "machine";
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent width="max-w-[28rem]" className="p-4" data-testid="bot-move-dialog">
        <DialogTitle className="mr-8 truncate text-sm font-semibold">Move {bot.name} to a {what}</DialogTitle>
        <DialogDescription className="mt-1 text-xs leading-[18px] text-muted-foreground">
          {kind === "cloud"
            ? `${bot.name} takes its role, memory, duties and items there and keeps working when ${thisComputer} is off. Its duties wake the workspace on their schedule; it sleeps after ${BOT_IDLE_SUSPEND_MINUTES} idle minutes, so you pay only while it works.`
            : `${bot.name} takes its role, memory, duties and items there and works while that machine is on.`}
        </DialogDescription>
        {choices.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground" data-testid="bot-move-none">
            {kind === "cloud" ? "You have no cloud workspace yet. Create one under Cloud in the sidebar, then move the bot." : `No machine is paired with ${thisComputer}. Pair one in Settings → Machines, then move the bot.`}
          </p>
        ) : (
          <div role="radiogroup" aria-label={`Choose a ${what}`} onKeyDown={moveBetweenRadios} className="mt-3 flex max-h-64 min-w-0 flex-col gap-1.5 overflow-y-auto">
            {choices.map((choice) => (
              <ChoiceCard
                key={choice.place.key}
                icon={kind === "cloud" ? Cloud : Server}
                title={choice.name}
                note={choice.unavailable ?? choice.note ?? (kind === "cloud" ? "Ready" : "Connected")}
                checked={picked === choice.place.key}
                disabled={Boolean(choice.unavailable)}
                onSelect={() => setPicked(choice.place.key)}
                testId={`bot-move-choice-${choice.place.key}`}
              />
            ))}
          </div>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="button" size="sm" disabled={!chosen} onClick={() => chosen && onMove(chosen.place)} data-testid="bot-move-confirm">Move</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const ACCESS: { value: BotAccess; icon: ComponentType<{ className?: string }>; title: string; note: string }[] = [
  { value: "full", icon: ShieldOff, title: "Full access", note: "Runs without asking, like your sessions. May push, merge and post." },
  { value: "askOutward", icon: ShieldAlert, title: "Ask before outward actions", note: "Reads, searches the web and runs commands that read. Asks before anything else, opening a web page too." },
  { value: "readReport", icon: Eye, title: "Read and report", note: "Reads, searches the web and runs only commands that read. Asks before a comment, a message or opening a web page. Changes nothing." },
];

function Access({ bot, busy, onChange }: { bot: Bot; busy: boolean; onChange: (access: BotAccess) => void }) {
  const known = effectiveAccess(bot.access) === bot.access;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div role="radiogroup" aria-label="Access" aria-busy={busy} onKeyDown={moveBetweenRadios} className="flex min-w-0 flex-wrap gap-2.5">
        {ACCESS.map((level) => (
          <ChoiceCard key={level.value} icon={level.icon} title={level.title} note={level.note} checked={bot.access === level.value} focusable={!known && level.value === "readReport"} busy={busy} onSelect={() => onChange(level.value)} testId={`bot-access-${level.value}`} />
        ))}
      </div>
      {!known && (
        <p className="text-[12px] text-warning" data-testid="bot-access-unknown">
          A newer version of TerminalX set this bot's access to “{bot.access}”. Here it is held to Read and report until you pick a level.
        </p>
      )}
      <p className="text-[12px] text-faint" data-testid="bot-access-hint">
        The next thing the bot does is held to the level you pick, in a conversation already open too. While it is paused it only reads. A web
        search goes to the agent's provider, and reading a connected server's resources reaches that server: both count as reads, so keep secrets
        from a bot that should not send them anywhere. On native Codex, which cannot ask before each action, Ask before outward actions runs in plan
        mode.
      </p>
    </div>
  );
}

/** A row of a bordered list: icon, name, a state with its dot, what it means, and an action. */
function ListRow({ icon: Icon, name, state, on, detail, action, testId }: {
  icon: ComponentType<{ className?: string }>;
  name: ReactNode;
  state: string;
  on: boolean;
  detail: ReactNode;
  action?: ReactNode;
  testId: string;
}) {
  return (
    <li className="flex min-h-10 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-hairline py-2 first:border-t-0" data-testid={testId}>
      <Icon className="size-[15px] shrink-0 text-muted-foreground" />
      <span className="w-[150px] min-w-0 truncate text-[13px] text-foreground">{name}</span>
      <span className={cn("flex w-[110px] shrink-0 items-center gap-1.5 text-[12.5px]", on ? "text-muted-foreground" : "text-faint")} data-testid={`${testId}-state`}>
        <span aria-hidden className={cn("size-1.5 rounded-full", on ? "bg-add" : "bg-muted-foreground/40")} />
        {state}
      </span>
      <span className="min-w-0 flex-1 basis-[180px] truncate text-[12.5px] text-faint">{detail}</span>
      {action && <span className="ml-auto flex shrink-0 items-center gap-2">{action}</span>}
    </li>
  );
}

function ListBox({ children, label }: { children: ReactNode; label: string }) {
  return <ul aria-label={label} className="min-w-0 rounded-lg border border-hairline bg-card/60 px-3.5">{children}</ul>;
}

/** The organisations the owner is in, other than the server's personal one (the Personal row stands for working alone). */
function useOrganizations(): OrganizationSummary[] {
  return useOrganizationList() ?? [];
}

/** The organisations, or null while they cannot be known (signed out, or the account not read yet). */
function useOrganizationList(): OrganizationSummary[] | null {
  const { status } = useAccount();
  if (status.state !== "signed-in" || !status.organizations) return null;
  return status.organizations.filter((org) => !org.isPersonal);
}

function WorksIn({ bot, busy, onChange }: { bot: Bot; busy: boolean; onChange: (worksIn: string[]) => void }) {
  const known = useOrganizationList();
  const orgs = known ?? [];
  const places = bot.worksIn;
  const on = (place: string) => places.includes(place);
  // A bot works somewhere: the last place it works in cannot be switched off.
  const last = (place: string) => on(place) && places.length === 1;
  const toggle = (place: string, next: boolean) => onChange(next ? [...places, place] : places.filter((value) => value !== place));
  // Places this app does not know (an organisation left, a value a newer app wrote) are shown as they are.
  const unknown = places.filter((place) => place !== "personal" && !orgs.some((org) => org.id === place));
  // While the organisations cannot be known, one switched off could not be switched back on here.
  const placeSwitch = (place: string, label: string, locked = false) => (
    <Switch size="md" checked={on(place)} disabled={busy || last(place) || locked} onCheckedChange={(next) => toggle(place, next)} aria-label={label} data-testid={`bot-works-in-switch-${place}`} />
  );
  return (
    <ListBox label="Works in">
      <ListRow icon={UserRound} name="Personal" state={on("personal") ? "On" : "Off"} on={on("personal")} detail={`No organisation · your own logins and ${thisComputer}`} action={placeSwitch("personal", "Works for you personally")} testId="bot-works-in-personal" />
      {orgs.map((org) => (
        <ListRow
          key={org.id}
          icon={Building2}
          name={<span title={org.name}>{org.name}</span>}
          state={on(org.id) ? "On" : "Off"}
          on={on(org.id)}
          detail={on(org.id) ? `Its agent logins and connections · cloud time billed to ${org.name}` : `You are a member. Turn on to let ${bot.name} take work there`}
          action={placeSwitch(org.id, `Works in ${org.name}`)}
          testId="bot-works-in-org"
        />
      ))}
      {unknown.map((place) => (
        <ListRow
          key={place}
          icon={Building2}
          name={<span title={place}>{place}</span>}
          state="On"
          on
          detail={known ? "An organisation you are not in now, or one this version does not know" : "Sign in to TerminalX to see your organisations and change this"}
          action={placeSwitch(place, `Works in ${place}`, !known)}
          testId="bot-works-in-unknown"
        />
      ))}
    </ListBox>
  );
}

type Connection = "checking" | "connected" | "not-connected" | "unknown";

function useGithubConnection(): Connection {
  const [state, setState] = useState<Connection>("checking");
  useEffect(() => {
    let live = true;
    gh.connectionStatus().then(
      (status: GitHubConnectionStatus) => live && setState(status.state === "connected" ? "connected" : "not-connected"),
      () => live && setState("unknown"),
    );
    return () => { live = false; };
  }, []);
  return state;
}

function useLinearConnection(): { state: Connection; viewer?: string | null } {
  const [state, setState] = useState<{ state: Connection; viewer?: string | null }>({ state: "checking" });
  useEffect(() => {
    let live = true;
    issues.linearStatus().then(
      (status: LinearStatus) => live && setState({ state: status.connected ? "connected" : "not-connected", viewer: status.viewer }),
      () => live && setState({ state: "unknown" }),
    );
    return () => { live = false; };
  }, []);
  return state;
}

const CONNECTION_LABEL: Record<Connection, string> = { checking: "Checking…", connected: "Connected", "not-connected": "Not connected", unknown: "Can't tell" };

function Channels({ bot }: { bot: Bot }) {
  const github = useGithubConnection();
  const linear = useLinearConnection();
  // Slack and Telegram (PRO-481): null while the runtime cannot say, when their rows wait as before.
  const apps = useChatApps(bot.id);
  const [open, setOpen] = useState<ChatAppService | null>(null);
  const appRow = (service: ChatAppService, label: string, testId: string, icon: typeof Hash) => {
    const shown = apps?.services.find((entry) => entry.service === service);
    const row = chatAppRow(bot, service, shown);
    const action = apps
      ? <Button variant="ghost" size="xs" onClick={() => setOpen(service)} aria-label={`${shown?.connected ? "Manage" : "Connect"} ${label}`}>{shown?.connected ? "Manage" : "Connect"}</Button>
      : later(label);
    return <ListRow icon={icon} name={label} state={row.state} on={row.on} detail={row.detail} action={action} testId={testId} />;
  };
  const manage = (row: "integrations.github" | "integrations.linear", label: string, connected: boolean) => (
    <Button variant="ghost" size="xs" onClick={() => openSettingRow(row)} aria-label={label}>{connected ? "Manage" : "Connect"}</Button>
  );
  const later = (name: string) => (
    <WithTooltip label={`${name} comes in a later build`}>
      <span>
        <Button variant="ghost" size="xs" disabled aria-label={`Connect ${name} (coming later)`}>Connect</Button>
      </span>
    </WithTooltip>
  );
  return (
    <ListBox label="Channels">
      <ListRow icon={AppWindow} name="TerminalX" state="On" on detail="Desktop and phone · questions arrive as cards and push" testId="bot-channel-terminalx" />
      <ListRow
        icon={Github}
        name="GitHub"
        state={CONNECTION_LABEL[github]}
        on={github === "connected"}
        detail={github === "connected" ? `Mention @${bot.slug} on a pull request or issue · reviews and comments with your GitHub CLI login, signed as ${bot.name}'s` : "Connect the GitHub CLI to let it read and comment"}
        action={manage("integrations.github", "Manage the GitHub connection", github === "connected")}
        testId="bot-channel-github"
      />
      <ListRow
        icon={SquareKanban}
        name="Linear"
        state={CONNECTION_LABEL[linear.state]}
        on={linear.state === "connected"}
        detail={linear.state === "connected" ? `As ${linear.viewer ?? "you"} · comments on issues it is mentioned in, signed as ${bot.name}'s` : "Add a Linear API key to let it read and comment"}
        action={manage("integrations.linear", "Manage the Linear connection", linear.state === "connected")}
        testId="bot-channel-linear"
      />
      {appRow("slack", "Slack", "bot-channel-slack", Hash)}
      {appRow("telegram", "Telegram", "bot-channel-chat-app", Send)}
      {/* WhatsApp's Cloud API delivers only by webhook to a public address: it needs a relay, which this build has not. */}
      <ListRow icon={Send} name="WhatsApp" state="Not connected" on={false} detail={`Message ${bot.name} on WhatsApp`} action={later("WhatsApp")} testId="bot-channel-whatsapp" />
      {open && <ChatAppDialog bot={bot} service={open} onClose={() => setOpen(null)} />}
    </ListBox>
  );
}

/** The channels view of `id`, read now and every minute while shown: mentions arrive between reads of the page. */
function useChannelsView(id: string): BotChannelsView | null {
  const [view, setView] = useState<BotChannelsView | null>(null);
  useEffect(() => {
    let live = true;
    setView(null);
    // A runtime that does not know the call yet answers with an error: the list is then not shown.
    const read = () => Promise.resolve().then(() => botsApi.channels(id)).then((value) => live && setView(value), () => live && setView(null));
    void read();
    const timer = window.setInterval(() => void read(), 60_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [id]);
  return view;
}

const MENTION_STATE: Record<string, string> = { waiting: "Waiting", delivered: "In a chat", notAccepted: "Not accepted", failed: "Didn't reach it" };
const POST_KIND: Record<string, string> = { review: "Posted a review", changesRequested: "Asked for changes", comment: "Commented", reply: "Answered" };

function threadName(thread: BotMention["thread"]): string {
  const label = thread.kind === "linear" ? thread.issue ?? "" : `${thread.repo ?? ""}#${thread.number ?? ""}`;
  return thread.title ? `${label} · ${thread.title}` : label;
}

/**
 * What reached the bot from GitHub and Linear, and what it posted there on the owner's behalf, newest first. Built
 * from the Channels list's own rows: no screen of the design shows it. A mention from someone not in Who can ask is
 * shown here with why, so the owner can add them.
 */
function ChannelActivity({ bot }: { bot: Bot }) {
  const view = useChannelsView(bot.id);
  if (!view) return null;
  type Row = { at: string; mention?: BotMention; post?: BotPost };
  const rows: Row[] = [...view.mentions.map((mention) => ({ at: mention.at, mention })), ...view.posts.map((post) => ({ at: post.at, post }))]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 6);
  if (rows.length === 0) return null;
  return (
    <div className="mt-3 min-w-0" data-testid="bot-channel-activity">
      <h3 className="mb-1.5 text-[12px] font-medium text-muted-foreground">Lately on GitHub and Linear</h3>
      <ListBox label="Lately on GitHub and Linear">
        {rows.map(({ mention, post }) => {
          const thread = (mention ?? post)!.thread;
          const icon = thread.kind === "linear" ? SquareKanban : Github;
          const open = thread.url ? <Button variant="ghost" size="xs" onClick={() => void openUrl(thread.url)} aria-label={`Open ${threadName(thread)}`}>Open</Button> : undefined;
          if (post) {
            return <ListRow key={`post:${post.at}:${post.url}`} icon={icon} name={<span title={threadName(thread)}>{threadName(thread)}</span>} state={POST_KIND[post.kind] ?? post.kind} on detail={`On your behalf · ${relativeTime(post.at)}`} action={open} testId="bot-channel-post" />;
          }
          const m = mention!;
          const detail = m.state === "notAccepted" || m.state === "failed" ? `${m.by} · ${m.why}` : `${m.by} mentioned ${view.handle} · ${relativeTime(m.at)}`;
          return <ListRow key={`mention:${m.id}`} icon={icon} name={<span title={threadName(thread)}>{threadName(thread)}</span>} state={MENTION_STATE[m.state] ?? m.state} on={m.state === "delivered"} detail={detail} action={open} testId="bot-channel-mention" />;
        })}
      </ListBox>
    </div>
  );
}

const MAY_LABEL: Record<string, string> = { askApprove: "Can ask and approve", ask: "Can ask", handOff: "Can hand off work" };
/** What each kind may be given: only a person's words count as approval, and handing work over is between bots. */
const MAY_FOR: Record<string, BotAskerMay[]> = { person: ["askApprove", "ask"], bot: ["handOff", "ask"] };

function mayLabel(may: string): string {
  return MAY_LABEL[may] ?? may;
}

function initials(name: string): string {
  const words = name.trim().split(/[\s@._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}

function PersonMark({ name, owner = false }: { name: string; owner?: boolean }) {
  return (
    <span aria-hidden className={cn("grid size-[22px] shrink-0 place-items-center rounded-full text-[10px] font-medium", owner ? "bg-accent/15 text-accent" : "bg-merge/15 text-merge")}>
      {initials(name)}
    </span>
  );
}

function WhoCanAsk({ bot, busy, onChange }: { bot: Bot; busy: boolean; onChange: (whoCanAsk: BotAsker[]) => void }) {
  const { status } = useAccount();
  const store = useBotStore();
  const askers = bot.whoCanAsk ?? [];
  const ownerName = status.state === "signed-in" ? status.identity?.name || status.identity?.email || "You" : "You";
  const set = (index: number, may: BotAskerMay) => onChange(askers.map((asker, at) => (at === index ? { ...asker, may } : asker)));
  const remove = (index: number) => onChange(askers.filter((_, at) => at !== index));
  // The person whose GitHub login is being given (PRO-480): their comments that mention the bot reach it.
  const [login, setLogin] = useState<number | null>(null);
  const editing = login === null ? undefined : askers[login];
  return (
    <>
    {editing && (
      <GithubLoginDialog
        bot={bot}
        asker={editing}
        onClose={() => setLogin(null)}
        onSave={(github) => {
          onChange(askers.map((asker, at) => (at === login ? { ...asker, github: github || undefined } : asker)));
          setLogin(null);
        }}
      />
    )}
    <ul aria-label="Who can ask" className="min-w-0 rounded-lg border border-hairline bg-card/60 px-3.5" data-testid="bot-who-can-ask">
      <AskerRow mark={<PersonMark name={ownerName} owner />} name={ownerName} role="Owner" testId="bot-asker-owner">
        <span className="text-[12.5px] text-muted-foreground">{MAY_LABEL.askApprove}</span>
      </AskerRow>
      {askers.map((asker, index) => {
        const other = asker.kind === "bot" ? store.bots.find((value) => value.id === asker.id) : undefined;
        const name = asker.kind === "bot" ? other?.name ?? (store.unreadable > 0 ? "A bot this version can't read" : "A removed bot") : asker.name || asker.id;
        // A person added from an organisation the bot no longer works in is kept, inactive, until it works there again.
        const inactive = asker.kind === "person" && !!asker.org && !bot.worksIn.includes(asker.org);
        const role = inactive ? "Inactive · the bot no longer works in their organisation" : asker.kind === "person" ? (asker.github ? `Member · @${asker.github} on GitHub` : "Member") : asker.kind === "bot" ? (other ? `${other.roleTitle}${bot.reportsTo === other.id ? " · its lead" : ""}` : "Bot") : asker.kind;
        const choices = MAY_FOR[asker.kind];
        const mark = asker.kind === "bot" ? <BotAvatar roleTemplateId={other?.roleTemplateId ?? ""} size="xs" className="size-[22px]! rounded-md!" /> : <PersonMark name={name} />;
        return (
          <AskerRow key={`${asker.kind}:${asker.id}`} mark={mark} name={name} role={role} inactive={inactive} testId="bot-asker">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" disabled={busy} className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12.5px] text-muted-foreground outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60" aria-label={`What ${name} may do: ${mayLabel(asker.may)}`} data-testid="bot-asker-may">
                  {mayLabel(asker.may)} <ChevronDown className="size-3.5 text-faint" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {choices && (
                  <DropdownMenuRadioGroup value={asker.may} onValueChange={(may) => set(index, may)}>
                    {choices.map((may) => <DropdownMenuRadioItem key={may} value={may}>{MAY_LABEL[may]}</DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                )}
                {choices && <DropdownMenuSeparator />}
                {asker.kind === "person" && (
                  <DropdownMenuItem onSelect={() => setLogin(index)} data-testid="bot-asker-github">{asker.github ? "Change GitHub login…" : "Add GitHub login…"}</DropdownMenuItem>
                )}
                <DropdownMenuItem destructive onSelect={() => remove(index)} data-testid="bot-asker-remove">Remove</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </AskerRow>
        );
      })}
      <AddAsker bot={bot} busy={busy} onAdd={(asker) => onChange([...askers, asker])} />
    </ul>
    </>
  );
}

const FIELD = "h-8 w-full min-w-0 rounded-md border border-hairline bg-transparent px-2 text-[13px] outline-none focus:border-ring";

/** A person's GitHub login: a comment of theirs that mentions the bot on GitHub reaches it. Saved with the list. */
function GithubLoginDialog({ bot, asker, onClose, onSave }: { bot: Bot; asker: BotAsker; onClose: () => void; onSave: (github: string) => void }) {
  const [value, setValue] = useState(asker.github ?? "");
  const clean = value.trim().replace(/^@/, "");
  const valid = clean === "" || /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(clean);
  const name = asker.name || asker.id;
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent width="max-w-[26rem]" className="p-4">
        <DialogTitle className="mr-8 truncate text-sm font-semibold" title={`${name}'s GitHub login`}>{name}'s GitHub login</DialogTitle>
        <DialogDescription className="mt-1 text-xs leading-[18px] text-muted-foreground">
          {`When ${name} mentions @${bot.slug} on a pull request or issue, ${bot.name} takes it as theirs. On Linear they are known by their email.`}
        </DialogDescription>
        <form className="mt-3 flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (valid) onSave(clean); }}>
          <input autoFocus spellCheck={false} maxLength={40} value={value} placeholder="octocat" onChange={(event) => setValue(event.target.value)} aria-label="GitHub login" className={FIELD} data-testid="bot-asker-github-input" />
          {!valid && <p className="text-xs text-destructive">A GitHub login is letters, digits and dashes.</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" disabled={!valid} data-testid="bot-asker-github-save">Save</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AskerRow({ mark, name, role, inactive = false, children, testId }: { mark: ReactNode; name: string; role: string; inactive?: boolean; children: ReactNode; testId: string }) {
  return (
    <li className={cn("flex min-h-9 min-w-0 items-center gap-3 border-t border-hairline py-1.5 first:border-t-0", inactive && "opacity-60")} data-inactive={inactive || undefined} data-testid={testId}>
      {mark}
      <span className="w-[160px] min-w-0 truncate text-[13px] text-foreground" title={name}>{name}</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-faint">{role}</span>
      <span className="ml-auto shrink-0">{children}</span>
    </li>
  );
}

function AddAsker({ bot, busy, onAdd }: { bot: Bot; busy: boolean; onAdd: (asker: BotAsker) => void }) {
  const [open, setOpen] = useState(false);
  const store = useBotStore();
  const orgs = useOrganizations();
  const askers = bot.whoCanAsk ?? [];
  const listed = (kind: string, id: string) => askers.some((asker) => asker.kind === kind && asker.id === id);
  const bots = store.bots.filter((other) => other.id !== bot.id && !listed("bot", other.id));
  // People come from the organisations the bot works in.
  const places = orgs.filter((org) => bot.worksIn.includes(org.id));
  return (
    <li className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-hairline py-1.5 first:border-t-0">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button type="button" disabled={busy} className="inline-flex items-center gap-2 rounded-md text-[12.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60" data-testid="bot-asker-add">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Add a person or a bot
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[360px] w-[280px] overflow-y-auto">
          <DropdownMenuLabel>Bots</DropdownMenuLabel>
          {bots.length === 0 && <p className="px-2 py-1.5 text-[12px] text-faint">No other bot to add.</p>}
          {bots.map((other) => (
            <DropdownMenuItem key={other.id} onSelect={() => onAdd({ kind: "bot", id: other.id, may: "handOff" })} data-testid="bot-asker-add-bot">
              <BotAvatar roleTemplateId={other.roleTemplateId} size="xs" /> <span className="truncate">{other.name}</span>
              <span className="ml-auto truncate text-[11.5px] text-faint">{other.roleTitle}</span>
            </DropdownMenuItem>
          ))}
          {open && places.map((org) => <OrganizationPeople key={org.id} org={org} listed={(id) => listed("person", id)} onAdd={onAdd} />)}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="ml-auto text-[12px] text-faint" data-testid="bot-asker-note">
        {orgs.length === 0 ? "Other people can ask once you work in an organisation" : places.length === 0 ? "Turn on an organisation above to add its people" : "Only you approve what it asks, unless you say otherwise"}
      </span>
    </li>
  );
}

/** The members of one organisation, read when the menu opens. Data privacy mode reads no one. */
function OrganizationPeople({ org, listed, onAdd }: { org: OrganizationSummary; listed: (id: string) => boolean; onAdd: (asker: BotAsker) => void }) {
  const privacy = useDataPrivacy();
  const { status } = useAccount();
  const [members, setMembers] = useState<OrganizationMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const me = status.state === "signed-in" ? status.identity?.email : null;
  useEffect(() => {
    if (privacy.enabled) return;
    let live = true;
    readOrganizationRoster(org.id).then(
      (roster) => live && setMembers(roster.members),
      (cause) => live && setError(errorMessage(cause)),
    );
    return () => { live = false; };
  }, [org.id, privacy.enabled]);
  const people = (members ?? []).filter((member) => member.email !== me && !listed(member.userId));
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>People in {org.name}</DropdownMenuLabel>
      {privacy.enabled ? (
        <p className="px-2 py-1.5 text-[12px] text-faint">Data privacy mode is on: members are not read.</p>
      ) : error ? (
        <p className="px-2 py-1.5 text-[12px] text-destructive">Couldn't read the members: {error}</p>
      ) : !members ? (
        <p className="flex items-center gap-1.5 px-2 py-1.5 text-[12px] text-faint"><Loader2 className="size-3 animate-spin" /> Reading the members…</p>
      ) : people.length === 0 ? (
        <p className="px-2 py-1.5 text-[12px] text-faint">No one else to add.</p>
      ) : (
        people.map((member) => {
          const name = member.displayName || member.email;
          return (
            <DropdownMenuItem key={member.userId} onSelect={() => onAdd({ kind: "person", id: member.userId, name, may: "ask", org: org.id, email: member.email })} data-testid="bot-asker-add-person">
              <PersonMark name={name} /> <span className="truncate">{name}</span>
            </DropdownMenuItem>
          );
        })
      )}
    </>
  );
}
