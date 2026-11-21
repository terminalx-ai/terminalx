import { useEffect, useState, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import { AppWindow, Building2, ChevronDown, Cloud, Eye, Github, Laptop, Loader2, Plus, Send, Server, ShieldAlert, ShieldOff, Hash, SquareKanban, UserRound } from "@/icons";
import { MachineHostError } from "@/components/machines/MachineHostError";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { WithTooltip } from "@/components/ui/tooltip";
import { useAccount } from "@/lib/account";
import { errorMessage, gh, issues, type GitHubConnectionStatus, type LinearStatus, type OrganizationSummary } from "@/lib/api";
import { updateBot, useBotStore } from "@/lib/bots";
import { cn } from "@/lib/cn";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { readOrganizationRoster } from "@/lib/organizationRoster";
import type { OrganizationMember } from "@/lib/organizationMembers";
import { openSettingRow } from "@/lib/settingsLinks";
import { effectiveAccess, type Bot, type BotAccess, type BotAsker, type BotAskerMay, type BotPatch } from "@/types/bots";
import { BotAvatar } from "./BotAvatar";

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
  const save = (what: string, patch: BotPatch) => {
    setBusy((current) => new Set(current).add(what));
    updateBot(bot.id, patch)
      .then(() => setError(null), (cause) => setError({ message: errorMessage(cause), retry: () => save(what, patch) }))
      .finally(() => setBusy((current) => {
        const next = new Set(current);
        next.delete(what);
        return next;
      }));
  };
  // A whole list is saved against the bot as this page read it, so a change made elsewhere meanwhile is not undone.
  const saveList = (what: "worksIn" | "whoCanAsk", patch: BotPatch) => save(what, { ...patch, ifModified: bot.modified });
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
        <Access bot={bot} busy={busy.has("access")} onChange={(access) => save("access", { access })} />
      </Section>
      <Section title="Works in" note={`${bot.name} is yours and goes where you work. Its role and skills go everywhere. What it learns inside an organisation stays there.`}>
        <WorksIn bot={bot} busy={busy.has("worksIn")} onChange={(worksIn) => saveList("worksIn", { worksIn })} />
      </Section>
      <Section title="Channels" note={`Where you can reach ${bot.name} and where it reports.`}>
        <Channels bot={bot} />
      </Section>
      <Section title="Who can ask" note={`People and bots that may give ${bot.name} work. ${bot.name} acts with your accounts.`}>
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

/** Arrow keys move between a radio group's enabled cards and choose the one reached, as a radio group does. */
function moveBetweenRadios(event: KeyboardEvent<HTMLElement>) {
  const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
  if (!step) return;
  const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]:not(:disabled)")];
  const at = radios.indexOf(document.activeElement as HTMLButtonElement);
  if (radios.length === 0 || at < 0) return;
  event.preventDefault();
  const next = radios[(at + step + radios.length) % radios.length];
  next.focus();
  next.click();
}

/** One choice of a set of cards: its icon, title and what it means. */
function ChoiceCard({ icon: Icon, title, note, checked, focusable = false, disabled, badge, onSelect, testId }: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  note: string;
  checked: boolean;
  /** Takes the group's tab stop though not chosen: the level an unknown value is held to. */
  focusable?: boolean;
  disabled?: boolean;
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
      onClick={checked ? undefined : onSelect}
      className={cn(
        "flex min-w-0 flex-1 basis-[200px] flex-col rounded-md border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        checked ? "border-accent/55 bg-accent/[.06]" : "border-hairline-strong hover:bg-muted/40",
        disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
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

function RunsOn({ bot }: { bot: Bot }) {
  const known = bot.runsOn === "thisMac";
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div role="radiogroup" aria-label="Runs on" onKeyDown={moveBetweenRadios} className="flex min-w-0 flex-wrap gap-2.5">
        <ChoiceCard icon={Laptop} title="This Mac" note="Works while this Mac is awake. Uses your local agent logins. No compute cost." checked={known} testId="bot-runs-on-this-mac" />
        <ChoiceCard icon={Cloud} title="Cloud workspace" note="Always on. Keeps working when this Mac is off or asleep. Billed per hour of work." checked={false} disabled badge="Comes with cloud bots" testId="bot-runs-on-cloud" />
        <ChoiceCard icon={Server} title="Another machine" note="A paired Mac or a headless server you own." checked={false} disabled badge="Comes with cloud bots" testId="bot-runs-on-machine" />
      </div>
      {!known && (
        <p className="text-[12px] text-warning" data-testid="bot-runs-on-unknown">
          A newer version of TerminalX set this bot to run on “{bot.runsOn}”. This version shows it as it is and cannot change it.
        </p>
      )}
    </div>
  );
}

const ACCESS: { value: BotAccess; icon: ComponentType<{ className?: string }>; title: string; note: string }[] = [
  { value: "full", icon: ShieldOff, title: "Full access", note: "Runs without asking, like your sessions. May push, merge and post." },
  { value: "askOutward", icon: ShieldAlert, title: "Ask before outward actions", note: "Reads freely. Asks before it changes anything or runs a command." },
  { value: "readReport", icon: Eye, title: "Read and report", note: "Reads and runs only commands that read. Asks before a comment or a message. Changes nothing." },
];

function Access({ bot, busy, onChange }: { bot: Bot; busy: boolean; onChange: (access: BotAccess) => void }) {
  const known = effectiveAccess(bot.access) === bot.access;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div role="radiogroup" aria-label="Access" aria-busy={busy} onKeyDown={moveBetweenRadios} className="flex min-w-0 flex-wrap gap-2.5">
        {ACCESS.map((level) => (
          <ChoiceCard key={level.value} icon={level.icon} title={level.title} note={level.note} checked={bot.access === level.value} focusable={!known && level.value === "readReport"} disabled={busy} onSelect={() => onChange(level.value)} testId={`bot-access-${level.value}`} />
        ))}
      </div>
      {!known && (
        <p className="text-[12px] text-warning" data-testid="bot-access-unknown">
          A newer version of TerminalX set this bot's access to “{bot.access}”. Here it is held to Read and report until you pick a level.
        </p>
      )}
      <p className="text-[12px] text-faint" data-testid="bot-access-hint">
        The next thing the bot does is held to the level you pick, in a conversation already open too. While it is paused it only reads. On native
        Codex, which cannot ask before each action, Ask before outward actions runs in plan mode.
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
      <ListRow icon={UserRound} name="Personal" state={on("personal") ? "On" : "Off"} on={on("personal")} detail="No organisation · your own logins and this Mac" action={placeSwitch("personal", "Works for you personally")} testId="bot-works-in-personal" />
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
        detail={github === "connected" ? "Through your GitHub CLI login on this Mac" : "Connect the GitHub CLI to let it read and comment"}
        action={manage("integrations.github", "Manage the GitHub connection", github === "connected")}
        testId="bot-channel-github"
      />
      <ListRow
        icon={SquareKanban}
        name="Linear"
        state={CONNECTION_LABEL[linear.state]}
        on={linear.state === "connected"}
        detail={linear.state === "connected" ? `As ${linear.viewer ?? "you"}, with your API key` : "Add a Linear API key to let it read and comment"}
        action={manage("integrations.linear", "Manage the Linear connection", linear.state === "connected")}
        testId="bot-channel-linear"
      />
      <ListRow icon={Hash} name="Slack" state="Not connected" on={false} detail={`Message ${bot.name} in Slack`} action={later("Slack")} testId="bot-channel-slack" />
      <ListRow icon={Send} name="Telegram or WhatsApp" state="Not connected" on={false} detail={`Message ${bot.name} from your phone's chat app`} action={later("Telegram or WhatsApp")} testId="bot-channel-chat-app" />
    </ListBox>
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
  return (
    <ul aria-label="Who can ask" className="min-w-0 rounded-lg border border-hairline bg-card/60 px-3.5" data-testid="bot-who-can-ask">
      <AskerRow mark={<PersonMark name={ownerName} owner />} name={ownerName} role="Owner" testId="bot-asker-owner">
        <span className="text-[12.5px] text-muted-foreground">{MAY_LABEL.askApprove}</span>
      </AskerRow>
      {askers.map((asker, index) => {
        const other = asker.kind === "bot" ? store.bots.find((value) => value.id === asker.id) : undefined;
        const name = asker.kind === "bot" ? other?.name ?? (store.unreadable > 0 ? "A bot this version can't read" : "A removed bot") : asker.name || asker.id;
        // A person added from an organisation the bot no longer works in is kept, inactive, until it works there again.
        const inactive = asker.kind === "person" && !!asker.org && !bot.worksIn.includes(asker.org);
        const role = inactive ? "Inactive · the bot no longer works in their organisation" : asker.kind === "person" ? "Member" : asker.kind === "bot" ? (other ? `${other.roleTitle}${bot.reportsTo === other.id ? " · its lead" : ""}` : "Bot") : asker.kind;
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
                <DropdownMenuItem destructive onSelect={() => remove(index)} data-testid="bot-asker-remove">Remove</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </AskerRow>
        );
      })}
      <AddAsker bot={bot} busy={busy} onAdd={(asker) => onChange([...askers, asker])} />
    </ul>
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
            <DropdownMenuItem key={member.userId} onSelect={() => onAdd({ kind: "person", id: member.userId, name, may: "ask", org: org.id })} data-testid="bot-asker-add-person">
              <PersonMark name={name} /> <span className="truncate">{name}</span>
            </DropdownMenuItem>
          );
        })
      )}
    </>
  );
}
