import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { thisComputer } from "@/lib/platform";
import { getName } from "@tauri-apps/api/app";
import { openExternalWebUrl } from "@/lib/externalUrl";
import { BYPASS_MODE, FIRST_RUN_PERMISSION_MODE, PERMISSION_MODES, pickerMode } from "@terminalx/portable/agentSettings";
import appMark from "../../../src-tauri/icons/128x128.png";
import { ArrowUpRight, BookOpen, Check, ChevronsUpDown, Folder, FolderGit2, FolderOpen, Keyboard, Loader2, MousePointerClick, Zap, type LucideIcon } from "@/icons";
import { AgentMark } from "@/components/AgentMark";
import { AgentSetupCard, ReadyBadge } from "@/components/session/AgentSetup";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { PrivacyImage } from "@/components/ui/privacy-image";
import { useAccount } from "@/lib/account";
import { READINESS_LABELS, checkAgentReadiness, startingAgent, useAgentReadiness, useAllSignedOut, useKnownReadiness, type AgentReadiness } from "@/lib/agentReadiness";
import { setupActive, startAgentSetup, useAgentSetupFlows } from "@/lib/agentSetupFlow";
import { errorMessage } from "@/lib/api";
import { onAppResume } from "@/lib/appResume";
import { cn } from "@/lib/cn";
import { chooseMode } from "@/lib/dialogs";
import { registerFileDropTarget } from "@/lib/fileDrop";
import { getPrefs, setPrefs, usePrefs } from "@/lib/prefs";
import { START_ACTIONS, attachProject, openRecentProject, projectStartDialogOpen, recentProjects, type StartAction } from "@/lib/projectStart";
import { repoFile } from "@/lib/repo";
import { homeShort, useHome } from "@/lib/homePath";
import { ago } from "@/lib/time";
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
export function StartScreen({ onOpenSettings }: { onOpenSettings: (tab?: "agents" | "shortcuts") => void }) {
  const store = useSessionStore();
  const account = useAccount();
  const prefs = usePrefs();
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
  const installed = store.harnesses.filter((harness) => harness.available).map((harness) => harness.id);
  // What the checks made in this window have found. Home asks nothing for its lines: the one check a
  // set-up reader costs is `useAllSignedOut`'s below, and none when anything else checked lately.
  const answers = useKnownReadiness(installed);
  // A run started here stays in view, terminal and all, until it ends or is put away.
  const flows = useAgentSetupFlows();
  const settingUp = store.harnesses.some((harness) => setupActive(flows[harness.id]));
  // Installed but never signed in (a sign-in left half way, the app quit
  // during it): the way on is the same as from nothing.
  const signedOut = useAllSignedOut(installed);
  /** The step in hand: an agent until one can run, then a project. */
  const stage = noAgent || settingUp || signedOut ? "agent" : "project";
  // Step 1 is done only on an answer: an agent that is installed and whose login was found.
  const ready = installed.some((id) => answers[id]?.state === "ready");

  // While an agent is being set up, one installed in a terminal of the reader's own shows when they come
  // back: each card asks about its login again by itself, and this is what says the agent is there at all.
  useEffect(() => {
    if (stage !== "agent") return;
    return onAppResume(() => { void refreshHarnesses().catch(() => {}); });
  }, [stage]);
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
                done={ready}
                title={ready ? "Agents ready" : "Set up an agent"}
                aside={<button type="button" onClick={() => onOpenSettings("agents")} className={cn(LINK, "text-xs leading-5 text-muted-foreground")}>Manage in Settings › Agents</button>}
              >
                <ul aria-label="Agents" className="mt-2.5 grid gap-1.5">
                  {store.harnesses.map((harness) => <AgentLine key={harness.id} harness={harness} answer={answers[harness.id] ?? null} />)}
                </ul>
              </Step>
            ) : (
              <Step number={1} title="Set up an agent" description="TerminalX runs the agent's own command-line tool. Pick one; we install it and open its sign-in." />
            )}

            {stage === "agent" ? (
              <Step
                number={2}
                title="Open a project"
                description={`A folder on ${thisComputer}, a GitHub repository, or a fresh empty project to try things in.`}
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
              <Step number={2} active emphasized title="Open a project" description={`A folder on ${thisComputer}, a GitHub repository, or a fresh empty project to try things in.`}>
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
                <RecentProjects busy={busy !== null} onError={setError} />
              </Step>
            )}

            <PermissionStep saved={prefs.lastMode} savedAgent={prefs.lastAgent} harnesses={store.harnesses} />
          </div>

          {error && (
            <div role="alert" className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <footer className="mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[12.5px] text-faint">
            <span>{identity ? `Signed in as ${identity.name || identity.email}. You can sign out in Settings › Account.` : "A TerminalX account is optional for local work."}</span>
            <span className="flex flex-wrap items-center gap-x-5 gap-y-1">
              <button type="button" onClick={() => onOpenSettings("shortcuts")} className={cn(LINK, "inline-flex items-center gap-1.5")}>
                <Keyboard aria-hidden className="size-[13px]" /> Keyboard shortcuts
              </button>
              <button type="button" onClick={() => void openExternalWebUrl(repoFile("README.md"))} className={cn(LINK, "inline-flex items-center gap-1.5")}>
                <BookOpen aria-hidden className="size-[13px]" /> Read the docs <ArrowUpRight aria-hidden className="size-3" />
              </button>
            </span>
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

/**
 * Step 2's last line (01.04): the projects opened or worked in most lately,
 * five at most, each opened with one click on its new-session view; with
 * none yet, a line saying where they will show. A folder dropped anywhere
 * opens too, as the line's other end says.
 */
function RecentProjects({ busy, onError }: { busy: boolean; onError: (message: string | null) => void }) {
  const store = useSessionStore();
  const home = useHome();
  const [opening, setOpening] = useState<string | null>(null);
  const recent = recentProjects(store.projects, store.sessions);
  const open = async (path: string) => {
    onError(null);
    setOpening(path);
    try {
      await openRecentProject(path);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setOpening(null);
    }
  };
  return (
    <div className="mt-3.5 text-xs" data-testid="recent-projects">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 id="recent-projects-title" className="font-normal text-faint">Recent projects</h3>
        {!recent.length && <span className="text-faint">· none yet, projects you open show here</span>}
        <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
          <MousePointerClick aria-hidden className="size-[13px]" /> Or drop a folder anywhere on this window
        </span>
      </div>
      {recent.length > 0 && (
        <ul aria-labelledby="recent-projects-title" className="mt-1.5 grid gap-0.5">
          {recent.map(({ project, openedAt }) => (
            <li key={project.path}>
              <button
                type="button"
                disabled={busy || opening !== null}
                onClick={() => void open(project.path)}
                aria-label={`Open ${project.name}`}
                title={project.path}
                className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left text-[12.5px] outline-none transition-colors hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-60"
              >
                {opening === project.path ? <Loader2 aria-hidden className="size-[14px] shrink-0 animate-spin text-muted-foreground" /> : <Folder aria-hidden className="size-[14px] shrink-0 text-muted-foreground" />}
                <span className="shrink-0 font-medium">{project.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-faint">{homeShort(project.path, home)}</span>
                {openedAt > 0 && <span className="shrink-0 text-faint" data-recent-opened="">{ago(openedAt)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
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

/** What an agent's line says after its name: the login found and whose, or how far it has got. */
function agentLine(harness: HarnessInfo, answer: AgentReadiness | null): string {
  if (!harness.available) return READINESS_LABELS.missing;
  // Installed, and nothing in this window has asked about its login: no more is claimed.
  if (!answer) return "Installed";
  if (answer.state !== "ready") return READINESS_LABELS[answer.state];
  return ["Local login found", answer.account].filter(Boolean).join(" · ");
}

/**
 * One agent on a line, once the project step is the one in hand: its version
 * and login as far as they are known, "Ready" only on an answer, and its way
 * on (install, or sign in when the login is missing or could not be told).
 * It reports what other checks found and makes none of its own.
 */
function AgentLine({ harness, answer }: { harness: HarnessInfo; answer: AgentReadiness | null }) {
  const state = harness.available ? answer?.state : "missing";
  const install = state === "missing";
  const value = harness.available ? answer : null;
  return (
    <li data-start-agent={harness.id}>
      <section aria-label={`${harness.name} setup`} className="flex min-h-11 min-w-0 items-center gap-3 rounded-md border border-hairline bg-raised px-3 py-1.5">
        <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-md bg-muted"><AgentMark id={harness.id} className="size-[15px]" decorative /></span>
        <span className="shrink-0 font-medium">{harness.name}</span>
        {value?.version && <span className="shrink-0 font-mono text-xs text-faint">{value.version}</span>}
        <span role="status" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{agentLine(harness, answer)}</span>
        {state === "ready" ? <ReadyBadge />
          : harness.installable && state ? (
            <Button size="sm" variant="outline" aria-label={install ? `Install ${harness.name} and sign in` : `Sign in to ${harness.name}`}
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
 * choice as the picker in a new session, read the way a new chat reads it.
 *
 * Bypass asks first, in the terms of the agent a new chat would start with:
 * its flag and what that flag turns off differ by agent (Codex loses its
 * sandbox too). Which agent that is takes every installed agent's answer, the
 * way New Session finds it (`startingAgent`); Home asks about one agent at
 * most, so the pick of Bypass asks about them all, then and only then. While
 * no agent can start a chat there is none to name, and Bypass waits.
 */
function PermissionStep({ saved, savedAgent, harnesses }: { saved: string; savedAgent: string; harnesses: readonly HarnessInfo[] }) {
  const mode = pickerMode(saved) ?? pickerMode(FIRST_RUN_PERMISSION_MODE)!;
  const safe = mode.id === FIRST_RUN_PERMISSION_MODE;
  const installed = harnesses.filter((harness) => harness.available);
  const [asking, setAsking] = useState(false);
  // Bypass was picked while every installed agent is signed out.
  const [held, setHeld] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const apply = (picked: string) => setPrefs({ lastMode: picked });
  const choose = async (id: string) => {
    setHeld(false);
    // Every other mode applies itself, and so does Bypass once the reader said not to be asked again.
    if (id !== BYPASS_MODE || getPrefs().bypassConfirmed) {
      chooseMode("", id, apply);
      return;
    }
    if (!installed.length) return;
    setAsking(true);
    const answers = Object.fromEntries(await Promise.all(installed.map(async (harness) => [harness.id, await checkAgentReadiness(harness.id)] as const)));
    if (!alive.current) return;
    setAsking(false);
    const agent = startingAgent(installed, answers, savedAgent);
    if (agent) chooseMode(agent.id, id, apply);
    else setHeld(true);
  };
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
              aria-busy={asking || undefined}
              disabled={asking}
              data-testid="start-permissions"
              className="flex h-8 min-w-[150px] items-center justify-between gap-3 rounded-md border border-border bg-card px-2.5 text-[12.5px] outline-none transition-colors hover:bg-veil-raised focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60"
            >
              <span className="truncate">{mode.label}</span>
              <ChevronsUpDown aria-hidden className="size-3 shrink-0 text-faint" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[17rem]">
            <DropdownMenuRadioGroup value={mode.id} onValueChange={(id) => void choose(id)}>
              {PERMISSION_MODES.map((candidate) => {
                const waits = candidate.id === BYPASS_MODE && !installed.length;
                return (
                  <DropdownMenuRadioItem key={candidate.id} value={candidate.id} disabled={waits} className="flex-col items-start gap-0">
                    <span>{candidate.label}</span>
                    <span className="whitespace-normal text-xs text-faint">{waits ? "Set up an agent first: what this turns off depends on the agent." : candidate.hint}</span>
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      {held && <p role="status" className="mt-2 text-xs text-muted-foreground">Sign in to an agent first: what Bypass permissions turns off depends on the agent that runs. The mode is unchanged.</p>}
    </Step>
  );
}
