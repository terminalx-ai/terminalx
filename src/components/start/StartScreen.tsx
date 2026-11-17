import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { getName } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FIRST_RUN_PERMISSION_MODE, PERMISSION_MODES, pickerMode } from "@terminalx/portable/agentSettings";
import appMark from "../../../src-tauri/icons/128x128.png";
import { BookOpen, Check, ChevronsUpDown, FolderGit2, FolderOpen, Loader2, Zap, type LucideIcon } from "@/icons";
import { AgentMark } from "@/components/AgentMark";
import { AgentSetupCard, ReadyBadge } from "@/components/session/AgentSetup";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { PrivacyImage } from "@/components/ui/privacy-image";
import { useAccount } from "@/lib/account";
import { READINESS_LABELS, useAgentReadiness, useAllSignedOut, type AgentReadiness } from "@/lib/agentReadiness";
import { setupActive, startAgentSetup, useAgentSetupFlows } from "@/lib/agentSetupFlow";
import { errorMessage } from "@/lib/api";
import { onAppResume } from "@/lib/appResume";
import { cn } from "@/lib/cn";
import { chooseMode } from "@/lib/dialogs";
import { registerFileDropTarget } from "@/lib/fileDrop";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { START_ACTIONS, attachProject, projectStartDialogOpen, type StartAction } from "@/lib/projectStart";
import { REPO_URL } from "@/lib/repo";
import { refreshHarnesses, useSessionStore } from "@/lib/sessions";
import type { HarnessInfo } from "@/types/session";

const ICONS: Record<StartAction["id"], LucideIcon> = { local: FolderOpen, github: FolderGit2, quick: Zap };
const MOVES: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
/** Step 2 while an agent is still being set up: the two ways to a project that exists already, as buttons. */
const BRIEF_ACTIONS: { id: StartAction["id"]; label: string }[] = [
  { id: "local", label: "Open folder" },
  { id: "github", label: "Clone from GitHub" },
];

/**
 * Home and the first-run screen (PRO-399): three numbered steps. Set up an
 * agent, open a project, and choose how much the agent may do alone.
 *
 * Until an agent can run, step 1 is the one in hand: a card per agent, each
 * installed and signed in to from here, and step 2 offers its two buttons.
 * Once one is ready step 1 folds to "Agents ready" and step 2 opens into the
 * three ways to a project. A folder dropped anywhere on the screen is opened
 * like "Open local project"; opening a project leads to its new-session view.
 */
export function StartScreen({ onOpenSettings }: { onOpenSettings: (tab?: "agents") => void }) {
  const store = useSessionStore();
  const account = useAccount();
  const root = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<StartAction["id"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("TerminalX");
  useEffect(() => {
    void getName().then(setName).catch(() => {});
  }, []);

  useEffect(
    () =>
      registerFileDropTarget({
        element: () => root.current,
        anywhere: true,
        onDragChange: (over, kind) => setDragging(over && kind === "files"),
        onDrop: async (paths) => {
          // A dialog over the screen is its own task: a drop on it adds nothing behind it.
          if (!paths.length || projectStartDialogOpen()) return;
          setError(null);
          try {
            await attachProject(paths[0]);
          } catch (cause) {
            // Only a folder can be a project; the backend refuses anything else.
            const message = errorMessage(cause);
            setError(message.startsWith("Not a directory") ? "Drop a folder to open it as a project." : message);
          }
        },
      }),
    [],
  );

  // An agent installed in a terminal of the reader's own shows when they come back: each card asks about
  // its login again by itself, and this is what says the agent is there at all.
  useEffect(() => onAppResume(() => { void refreshHarnesses().catch(() => {}); }), []);

  const run = async (action: StartAction) => {
    setError(null);
    setBusy(action.id);
    try {
      await action.run();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  /** The arrow keys walk the cards, in a row or stacked; Home and End jump to the ends. */
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const cards = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-start-card]")];
    const at = cards.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next = event.key === "Home" ? 0 : event.key === "End" ? cards.length - 1 : event.key in MOVES ? (at + MOVES[event.key] + cards.length) % cards.length : -1;
    if (next < 0) return;
    event.preventDefault();
    cards[next].focus();
  };

  // The probe answers a moment after launch: nothing is claimed before it has.
  const known = store.harnesses.length > 0;
  const noAgent = known && !store.harnesses.some((harness) => harness.available);
  // A run started here stays in view, terminal and all, until it ends or is put away.
  const flows = useAgentSetupFlows();
  const settingUp = store.harnesses.some((harness) => setupActive(flows[harness.id]));
  // Installed but never signed in (a sign-in left half way, the app quit
  // during it): the way on is the same as from nothing.
  const signedOut = useAllSignedOut(store.harnesses.filter((harness) => harness.available).map((harness) => harness.id));
  /** The step in hand: an agent until one can run, then a project. */
  const stage = noAgent || settingUp || signedOut ? "agent" : "project";
  const identity = account.ready && account.status.state === "signed-in" ? account.status.identity : null;

  return (
    <div ref={root} data-testid="start-screen" data-stage={stage} className="relative flex h-full min-h-0 flex-col">
      <div className="@container flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-6 pb-8 pt-10 text-[13px] leading-5">
        <div className="mx-auto w-full max-w-[620px]">
          <header className="flex items-center gap-3">
            <PrivacyImage src={appMark} alt="" className="size-10 shrink-0 rounded-lg" />
            <div className="min-w-0">
              <h1 className="text-[22px] font-semibold leading-7">Welcome to {name}</h1>
              <p className="text-muted-foreground">Run coding agents side by side, each in its own worktree.</p>
            </div>
          </header>

          <div className="mt-8 grid gap-2.5">
            {stage === "agent" ? (
              <div data-testid="start-no-agent">
                <Step number={1} active title="Set up an agent" description="TerminalX runs the agent's own command-line tool. Pick one; we install it and open its sign-in." />
                <ul aria-label="Agents" className="my-1.5 grid gap-2.5 pt-2.5">
                  {store.harnesses.map((harness) => <StartAgent key={harness.id} harness={harness} />)}
                </ul>
              </div>
            ) : known ? (
              <Step
                number={1}
                done
                title="Agents ready"
                aside={<button type="button" onClick={() => onOpenSettings("agents")} className={cn(LINK, "text-xs leading-5 text-muted-foreground")}>Manage in Settings › Agents</button>}
              >
                <ul aria-label="Agents" className="mt-2.5 grid gap-1.5">
                  {store.harnesses.map((harness) => <ReadyAgent key={harness.id} harness={harness} />)}
                </ul>
              </Step>
            ) : (
              <Step number={1} title="Set up an agent" description="TerminalX runs the agent's own command-line tool. Pick one; we install it and open its sign-in." />
            )}

            {stage === "agent" ? (
              <Step
                number={2}
                title="Open a project"
                description="A folder on this Mac, a GitHub repository, or a fresh empty project to try things in."
                aside={
                  <div role="group" aria-label="Get started" className="flex flex-wrap gap-2" onKeyDown={moveFocus}>
                    {BRIEF_ACTIONS.map(({ id, label }) => {
                      const action = START_ACTIONS.find((candidate) => candidate.id === id)!;
                      return (
                        <Button key={id} variant="outline" data-start-card={id} disabled={busy !== null} className="text-[12.5px] font-normal text-muted-foreground" onClick={() => void run(action)}>
                          {busy === id && <Loader2 aria-hidden className="animate-spin" />}
                          {label}
                        </Button>
                      );
                    })}
                  </div>
                }
              />
            ) : (
              <Step number={2} active emphasized title="Open a project" description="A folder on this Mac, a GitHub repository, or a fresh empty project to try things in.">
                <div role="group" aria-label="Get started" className="mt-3.5 grid grid-cols-1 gap-2.5 @lg:grid-cols-3" onKeyDown={moveFocus}>
                  {START_ACTIONS.map((action) => {
                    const Icon = ICONS[action.id];
                    // Each title hangs a fixed way under its icon, so the three sit on one line however far a hint wraps.
                    return (
                      <button
                        key={action.id}
                        type="button"
                        data-start-card={action.id}
                        aria-labelledby={`start-card-label-${action.id}`}
                        aria-describedby={`start-card-hint-${action.id}`}
                        disabled={busy !== null}
                        onClick={() => void run(action)}
                        className="flex min-h-[104px] flex-col gap-4 rounded-xl border border-border bg-raised p-3.5 text-left outline-none transition-colors hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-60"
                      >
                        {busy === action.id ? <Loader2 aria-hidden className="size-[19px] animate-spin text-muted-foreground" /> : <Icon aria-hidden className="size-[19px] text-muted-foreground" />}
                        <span className="min-w-0">
                          <span id={`start-card-label-${action.id}`} className="block font-medium">
                            {action.label}
                          </span>
                          <span id={`start-card-hint-${action.id}`} className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                            {action.hint}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="mt-3.5 text-right text-xs text-muted-foreground">Or drop a folder anywhere on this window</p>
              </Step>
            )}

            <PermissionStep />
          </div>

          {error && (
            <div role="alert" className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <footer className="mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[12.5px] text-faint">
            <span>{identity ? `Signed in as ${identity.name || identity.email}. You can sign out in Settings › Account.` : "A TerminalX account is optional for local work."}</span>
            <button type="button" onClick={() => void openUrl(`${REPO_URL}#readme`)} className={cn(LINK, "inline-flex items-center gap-1")}>
              <BookOpen aria-hidden className="size-[13px]" /> Read the guide
            </button>
          </footer>
        </div>
      </div>

      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-3 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent/70 bg-background text-sm font-medium transition-opacity",
          dragging ? "opacity-100" : "opacity-0",
        )}
      >
        Drop a folder to open it as a project
      </div>
    </div>
  );
}

const LINK = "rounded-sm underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/40";

/**
 * One numbered step: its number (amber for the step in hand, a check once it is
 * done), its title and one line about it, and its control at the right. What a
 * step opens into goes under them.
 */
function Step({ number, title, description, aside, children, active = false, done = false, emphasized = false }: {
  number: number;
  title: string;
  description?: string;
  aside?: ReactNode;
  children?: ReactNode;
  active?: boolean;
  done?: boolean;
  /** The step in hand, when it is open: its card takes the accent too. */
  emphasized?: boolean;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} data-step={number} className={cn("flex items-start gap-3 rounded-lg border bg-card p-4", emphasized ? "border-accent/40" : "border-border")}>
      <span
        aria-hidden
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold",
          done ? "bg-add/15 text-add" : active ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground",
        )}
      >
        {done ? <Check className="size-[13px]" /> : number}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2.5">
          <div className="min-w-0 flex-1 basis-56">
            <h2 id={id} className="font-medium">{title}</h2>
            {description && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{description}</p>}
          </div>
          {aside}
        </div>
        {children}
      </div>
    </section>
  );
}

/** One agent while step 1 is in hand: its card, with its install or sign-in. */
function StartAgent({ harness }: { harness: HarnessInfo }) {
  const readiness = useAgentReadiness(harness.id);
  return (
    <li className="min-w-0" data-start-agent={harness.id}>
      <AgentSetupCard harness={harness} value={readiness.value} checking={readiness.checking} />
    </li>
  );
}

/** What a ready agent's row says after its name: the login it found, and whose. */
function readyLine(value: AgentReadiness | null, checking: boolean): string {
  if (!value) return checking ? "Checking installation and login…" : READINESS_LABELS.unknown;
  if (value.state !== "ready") return READINESS_LABELS[value.state];
  return ["Local login found", value.account].filter(Boolean).join(" · ");
}

/** One agent under "Agents ready": a line with its version and login. One that is not ready yet keeps its way on. */
function ReadyAgent({ harness }: { harness: HarnessInfo }) {
  const { value, checking } = useAgentReadiness(harness.id);
  const state = value?.state;
  const install = state === "missing";
  return (
    <li data-start-agent={harness.id}>
      <section aria-label={`${harness.name} setup`} className="flex min-h-11 min-w-0 items-center gap-3 rounded-md border border-hairline bg-raised px-3 py-1.5">
        <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-md bg-muted"><AgentMark id={harness.id} className="size-[15px]" decorative /></span>
        <span className="shrink-0 font-medium">{harness.name}</span>
        {value?.version && <span className="shrink-0 font-mono text-xs text-faint">{value.version}</span>}
        <span role="status" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{readyLine(value, checking)}</span>
        {state === "ready" ? <ReadyBadge />
          : harness.installable && (state === "missing" || state === "signed_out") ? (
            <Button size="sm" variant="outline" disabled={checking} aria-label={install ? `Install ${harness.name} and sign in` : `Sign in to ${harness.name}`}
              onClick={() => void startAgentSetup(harness.id, install ? "install" : "login", { chain: install })}>
              {install ? "Install and sign in" : "Sign in"}
            </Button>
          ) : null}
      </section>
    </li>
  );
}

/**
 * Step 3: the permission mode new chats start in (`prefs.lastMode`), the same
 * choice as the picker in a new session. Bypass asks first, as it does there.
 */
function PermissionStep() {
  const prefs = usePrefs();
  const mode = pickerMode(prefs.lastMode ?? "") ?? pickerMode(FIRST_RUN_PERMISSION_MODE)!;
  const safe = mode.id === FIRST_RUN_PERMISSION_MODE;
  return (
    <Step
      number={3}
      title="Choose how much the agent may do alone"
      description={safe
        ? "Ask every time is the safe default: you approve each edit and command, with the diff shown."
        : `${mode.label}: ${mode.hint} Ask every time is the safe default.`}
      aside={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Permissions: ${mode.label}`}
              data-testid="start-permissions"
              className="flex h-8 min-w-[150px] items-center justify-between gap-3 rounded-md border border-border bg-card px-2.5 text-[12.5px] outline-none transition-colors hover:bg-veil-raised focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              <span className="truncate">{mode.label}</span>
              <ChevronsUpDown aria-hidden className="size-3 shrink-0 text-faint" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[17rem]">
            <DropdownMenuRadioGroup value={mode.id} onValueChange={(id) => chooseMode(prefs.lastAgent ?? "", id, (picked) => setPrefs({ lastMode: picked }))}>
              {PERMISSION_MODES.map((candidate) => (
                <DropdownMenuRadioItem key={candidate.id} value={candidate.id} className="flex-col items-start gap-0">
                  <span>{candidate.label}</span>
                  <span className="whitespace-normal text-xs text-faint">{candidate.hint}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    />
  );
}
