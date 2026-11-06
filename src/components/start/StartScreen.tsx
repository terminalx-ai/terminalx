import { openCloudSetup } from "@/lib/cloudSetupNavigation";
import { EmptyView } from "./EmptyView";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CircleAlert, ExternalLink, FolderGit2, FolderOpen, Loader2, RefreshCw, Zap, type LucideIcon } from "@/icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AgentMark } from "@/components/AgentMark";
import { AgentSetup } from "@/components/session/AgentSetup";
import { Button } from "@/components/ui/button";
import { signIn, useAccount } from "@/lib/account";
import { announceReadiness, checkAgentReadiness, useAgentReadiness, useAllSignedOut } from "@/lib/agentReadiness";
import { useAgentSetupFlows } from "@/lib/agentSetupFlow";
import type { HarnessInfo } from "@/types/session";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { registerFileDropTarget } from "@/lib/fileDrop";
import { START_ACTIONS, attachProject, projectStartDialogOpen, type StartAction } from "@/lib/projectStart";
import { REPO_URL } from "@/lib/repo";
import { refreshHarnesses, useSessionStore } from "@/lib/sessions";

const ICONS: Record<StartAction["id"], LucideIcon> = { local: FolderOpen, github: FolderGit2, quick: Zap };
const MOVES: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Home and the first-run screen: the wordmark and three ways to open a project.
 * A folder dropped anywhere on it is opened like "Open local project".
 * Opening a project leads to its new-session view.
 */
export function StartScreen({ onOpenSettings }: { onOpenSettings: (tab?: "agents") => void }) {
  const store = useSessionStore();
  const account = useAccount();
  const root = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<StartAction["id"] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  const noAgent = store.harnesses.length > 0 && !store.harnesses.some((harness) => harness.available);
  // Once an install starts here it stays in view through sign-in to Ready,
  // although the agent counts as installed half way (PRO-152).
  const flows = useAgentSetupFlows();
  const settingUp = store.harnesses.some((harness) => flows[harness.id]);
  // Installed but never signed in (a sign-in left half way, the app quit
  // during it): the way on is the same as from nothing.
  const signedOut = useAllSignedOut(store.harnesses.filter((harness) => harness.available).map((harness) => harness.id));
  const accountSignedOut = account.ready && account.status.state === "signed-out";

  return (
    <div ref={root} data-testid="start-screen" className="relative flex h-full min-h-0 flex-col">
      <EmptyView branded guidance="Welcome. Open a project to start working with an agent.">

        <div role="group" aria-label="Get started" className="mt-8 grid grid-cols-1 gap-3 @xl:grid-cols-3" onKeyDown={moveFocus}>
          {START_ACTIONS.map((action) => {
            const Icon = ICONS[action.id];
            return (
              <button
                key={action.id}
                type="button"
                data-start-card={action.id}
                aria-labelledby={`start-card-label-${action.id}`}
                aria-describedby={`start-card-hint-${action.id}`}
                disabled={busy !== null}
                onClick={() => void run(action)}
                className="flex h-28 flex-col justify-between rounded-xl bg-composer glass p-3.5 text-left shadow-surface hairline outline-none transition-colors hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-60"
              >
                {busy === action.id ? <Loader2 aria-hidden className="size-5 animate-spin text-muted-foreground" /> : <Icon aria-hidden className="size-5 text-muted-foreground" />}
                <span className="min-w-0">
                  <span id={`start-card-label-${action.id}`} className="block text-sm font-medium">
                    {action.label}
                  </span>
                  <span id={`start-card-hint-${action.id}`} className="mt-0.5 block text-xs text-muted-foreground">
                    {action.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-center text-xs text-faint">Or drop a folder anywhere here.</p>

        {error && (
          <div role="alert" className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {(noAgent || settingUp || signedOut) && (
          <section aria-label="Set up an agent" data-testid="start-no-agent" className={cn("mt-5 rounded-lg px-3 py-2.5 text-xs", noAgent || signedOut ? "bg-warning/10" : "bg-composer glass hairline")}>
            {noAgent || signedOut ? <div className="flex items-center gap-1.5 font-medium text-warning">
              <CircleAlert className="size-3.5" /> {noAgent ? "No agent is installed" : "No agent is signed in"}
            </div> : <div className="font-medium">Set up an agent</div>}
            <p className="mt-1 text-muted-foreground">
              TerminalX runs each agent's own command-line tool on this computer. Install it and sign in to it here, with no Terminal needed.
            </p>
            <ul className="mt-2 flex flex-col gap-2">
              {store.harnesses.map((harness) => <StartAgent key={harness.id} harness={harness} />)}
            </ul>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Button size="xs" variant="ghost" onClick={() => void recheckAgents(store.harnesses)}>
                <RefreshCw /> Check again
              </Button>
              <Button size="xs" variant="ghost" onClick={() => onOpenSettings("agents")}>
                Agent settings
              </Button>
            </div>
          </section>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {account.status.state === "signed-in" && <SecondaryLink onClick={() => openCloudSetup()}>Set up cloud computer</SecondaryLink>}
          {accountSignedOut && <SecondaryLink onClick={() => void signIn()}>Sign in</SecondaryLink>}
          <SecondaryLink onClick={() => onOpenSettings()}>Settings</SecondaryLink>
          <SecondaryLink onClick={() => void openUrl(`${REPO_URL}#readme`)}>
            Read the docs <ExternalLink className="size-3" />
          </SecondaryLink>
        </div>
      </EmptyView>

      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-3 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent/70 bg-background/80 text-sm font-medium transition-opacity",
          dragging ? "opacity-100" : "opacity-0",
        )}
      >
        Drop a folder to open it as a project
      </div>
    </div>
  );
}

/** Look for the agents again, and check each one's login, for every view of them. */
async function recheckAgents(harnesses: HarnessInfo[]) {
  try { await refreshHarnesses(); } catch { /* the checks below still answer */ }
  await Promise.all(harnesses.map(async (harness) => announceReadiness(harness.id, await checkAgentReadiness(harness.id))));
}

/** One agent on the welcome screen: its state, and installing it and signing in to it from here. */
function StartAgent({ harness }: { harness: HarnessInfo }) {
  const readiness = useAgentReadiness(harness.id);
  return (
    <li className="flex min-w-0 items-start gap-2.5" data-start-agent={harness.id}>
      <AgentMark id={harness.id} className="mt-3.5 size-4 shrink-0" decorative />
      <div className="min-w-0 flex-1">
        <AgentSetup compact harness={harness} value={readiness.value} checking={readiness.checking} onRefresh={() => void readiness.refresh()} />
      </div>
    </li>
  );
}

function SecondaryLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 rounded-sm underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/40">
      {children}
    </button>
  );
}
