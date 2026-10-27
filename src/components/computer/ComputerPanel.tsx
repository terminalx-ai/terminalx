import { useCallback, useEffect, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { Ellipsis, LoaderCircle, Monitor } from "@/icons";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { api, errorMessage, type LocalVmStatus } from "@/lib/api";
import { cn } from "@/lib/cn";
import { VncView, type VncState } from "./VncView";

type Place = "local" | "cloud";
type Busy = "start" | "stop" | "reset" | "runtime" | null;

const BUSY_TEXT: Record<Exclude<Busy, null>, string> = {
  start: "Starting the Local VM… The first start downloads the desktop (about 450 MB).",
  stop: "Stopping the Local VM…",
  reset: "Removing the Local VM…",
  runtime: "Starting the container runtime…",
};

/**
 * The right panel's Computer tab: a desktop the reader can watch, and take
 * control of, while agents use it to see and test what they build. The Local
 * VM runs in a container on this machine (`local_vm.rs`); a cloud VM is not
 * built yet.
 */
export function ComputerPanel({ active }: { active: boolean }) {
  const [place, setPlace] = useState<Place>("local");
  return (
    <div className="flex h-full flex-col" data-testid="panel-computer">
      <div role="radiogroup" aria-label="Computer" className="flex shrink-0 gap-3 border-b border-hairline px-3 text-xs">
        {(["local", "cloud"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={place === id}
            onClick={() => setPlace(id)}
            className={cn("border-b py-1.5", place === id ? "border-foreground/60 text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {id === "local" ? "Local VM" : "Cloud VM"}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">{place === "local" ? <LocalVm active={active} /> : <CloudVm />}</div>
    </div>
  );
}

/**
 * The VM's screen, at its own 1280×900 shape: the live desktop while it runs,
 * and in its place, while it does not, what it needs and the button for it.
 */
function Screen({ children, live = false }: { children: ReactNode; live?: boolean }) {
  return (
    <div className="flex h-full items-start justify-center overflow-auto p-3">
      <div
        className={cn(
          "relative aspect-[1280/900] w-full overflow-hidden rounded-lg ring-1 ring-hairline-strong",
          live ? "bg-background" : "bg-[radial-gradient(120%_90%_at_30%_10%,var(--surface-raised),var(--surface-page))]",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Words on the idle screen, centred, with the action under them. */
function Message({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-xs">
      <Monitor className="mb-1 size-5 text-faint" aria-hidden />
      <p className="text-sm font-medium text-foreground">{title}</p>
      <div className="max-w-[34ch] leading-relaxed text-muted-foreground">{children}</div>
      {actions && <div className="mt-2 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  );
}

function LocalVm({ active }: { active: boolean }) {
  const [status, setStatus] = useState<LocalVmStatus | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [control, setControl] = useState(false);
  const [view, setView] = useState<VncState>("connecting");
  const [attempt, setAttempt] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.localVm.status());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  // Read when the tab is shown; the runtime may have been started or stopped elsewhere.
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);
  // An agent started or stopped it (`terminalx vm …`).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let gone = false;
    void listen("local_vm_changed", () => void refresh())
      .then((stop) => (gone ? stop() : (unlisten = stop)))
      .catch(() => {});
    return () => {
      gone = true;
      unlisten?.();
    };
  }, [refresh]);

  const act = async (kind: Exclude<Busy, null>, call: () => Promise<LocalVmStatus>) => {
    setBusy(kind);
    setError(null);
    try {
      setStatus(await call());
      setControl(false);
    } catch (e) {
      setError(errorMessage(e));
      void refresh();
    } finally {
      setBusy(null);
    }
  };
  const check = <Button size="sm" variant="ghost" onClick={() => void refresh()}>Check again</Button>;
  const failure = error && (
    <p role="alert" className="px-4 text-center text-xs text-destructive">
      {error}
    </p>
  );
  const idle = (screen: ReactNode) => (
    <div className="flex h-full flex-col">
      <div className="min-h-0">
        <Screen>{screen}</Screen>
      </div>
      {failure}
    </div>
  );

  if (busy) {
    return idle(
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground" role="status">
        <LoaderCircle className="size-4 animate-spin" />
        <span className="max-w-[34ch] leading-relaxed">{BUSY_TEXT[busy]}</span>
      </div>,
    );
  }
  if (!status) return failure || null;

  if (status.state === "no_runtime") {
    return idle(
      <Message title="Needs Docker or Podman" actions={check}>
        The Local VM is a Linux desktop in a container. Install Docker Desktop, or Colima with <code className="font-mono">brew install colima docker</code>.
      </Message>,
    );
  }
  if (status.state === "runtime_down") {
    const runtime = status.runtime === "podman" ? "Podman" : "Docker";
    return idle(
      <Message
        title={`${runtime} isn't running`}
        actions={
          <>
            {status.runtime !== "podman" && (
              <Button size="sm" onClick={() => void act("runtime", api.localVm.startRuntime)}>
                {status.colima ? "Start Colima" : "Open Docker Desktop"}
              </Button>
            )}
            {check}
          </>
        }
      >
        The Local VM runs on {runtime}. Start it to use the VM.
      </Message>,
    );
  }
  if (status.state !== "running" || !status.viewer) {
    return idle(
      <Message title="A Linux desktop for you and your agents" actions={<Button size="sm" onClick={() => void act("start", api.localVm.start)}>Start Local VM</Button>}>
        Watch it here and take control when you need to. Agents use it to see and test your app.
      </Message>,
    );
  }

  const { port, password } = status.viewer;
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <Screen live>
          <VncView port={port} password={password} control={control} attempt={attempt} onState={setView} />
          {control && <div className="pointer-events-none absolute inset-0 rounded-lg ring-2 ring-inset ring-ring/70" aria-hidden />}
          {view !== "connected" && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted-foreground">
              {view === "connecting" ? (
                <>
                  <LoaderCircle className="size-3.5 animate-spin" /> Connecting…
                </>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
                  Reconnect
                </Button>
              )}
            </div>
          )}
        </Screen>
      </div>
      {failure}
      <div className="flex shrink-0 items-center gap-2 border-t border-hairline px-3 py-1.5 text-xs">
        <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title="Dev servers on this machine are at host.docker.internal:<port> inside the VM.">
          {control ? "You have control" : "Agents can use it · host.docker.internal"}
        </span>
        <Button size="sm" variant={control ? "default" : "outline"} disabled={view !== "connected"} onClick={() => setControl((on) => !on)}>
          {control ? "Release" : "Take control"}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Local VM actions">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void act("stop", api.localVm.stop)}>Stop</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void act("reset", api.localVm.reset)}>Reset (start fresh)</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function CloudVm() {
  return (
    <Screen>
      <Message title="Cloud VM — coming soon">Connect a desktop on your own server (over SSH) or a hosted VM, and use it like the Local VM.</Message>
    </Screen>
  );
}
