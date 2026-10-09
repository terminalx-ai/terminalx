import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CircleAlert, ExternalLink, FolderGit2, FolderOpen, Loader2, RefreshCw, Zap, type LucideIcon } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { signIn, useAccount } from "@/lib/account";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { registerFileDropTarget } from "@/lib/fileDrop";
import { START_ACTIONS, attachProject, projectStartDialogOpen, type StartAction } from "@/lib/projectStart";
import { REPO_URL } from "@/lib/repo";
import { refreshHarnesses, useSessionStore } from "@/lib/sessions";

const ICONS: Record<StartAction["id"], LucideIcon> = { local: FolderOpen, github: FolderGit2, quick: Zap };
const MOVES: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * What the main area shows while there is no local project: the wordmark and
 * the three ways to get one. A folder dropped anywhere on it is opened like
 * "Open local project". It gives way to the new-session view as soon as a
 * project exists.
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
  const signedOut = account.ready && account.status.state === "signed-out";

  return (
    <div ref={root} data-testid="start-screen" className="@container relative flex h-full min-h-0 flex-col items-center justify-center overflow-y-auto px-6 py-8">
      <div className="w-full max-w-2xl">
        <h1 className="text-center text-3xl font-semibold tracking-tight">TerminalX</h1>
        <p className="mt-2 text-center text-sm text-muted-foreground">Welcome. Open a project to start working with an agent.</p>

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

        {noAgent && (
          <div role="status" data-testid="start-no-agent" className="mt-5 rounded-lg bg-warning/10 px-3 py-2.5 text-xs">
            <div className="flex items-center gap-1.5 font-medium text-warning">
              <CircleAlert className="size-3.5" /> No agent is installed
            </div>
            <p className="mt-1 text-muted-foreground">
              TerminalX runs the agent command-line tools installed on this computer, and found none. Install one to start a session.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {store.harnesses.map((harness) => (
                <Button key={harness.id} size="xs" variant="secondary" title={harness.installHint} onClick={() => void openUrl(harness.installUrl)}>
                  Get {harness.name} <ExternalLink />
                </Button>
              ))}
              <Button size="xs" variant="ghost" onClick={() => void refreshHarnesses()}>
                <RefreshCw /> Check again
              </Button>
              <Button size="xs" variant="ghost" onClick={() => onOpenSettings("agents")}>
                Agent settings
              </Button>
            </div>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {signedOut && <SecondaryLink onClick={() => void signIn()}>Sign in</SecondaryLink>}
          <SecondaryLink onClick={() => onOpenSettings()}>Settings</SecondaryLink>
          <SecondaryLink onClick={() => void openUrl(`${REPO_URL}#readme`)}>
            Read the docs <ExternalLink className="size-3" />
          </SecondaryLink>
        </div>
      </div>

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

function SecondaryLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 rounded-sm underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/40">
      {children}
    </button>
  );
}
