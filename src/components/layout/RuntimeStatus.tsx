import { useEffect, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Loader2, Server, TriangleAlert } from "@/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { errorMessage, type LocalRuntimeOutdated } from "@/lib/api";
import { bootLocalRuntime, replaceLocalRuntime, useRuntimeSwitch } from "@/lib/localRuntime";

/**
 * The runtime the app came with, while it is not yet the one running (#766):
 * its version and what moving to it waits for, quietly, in the status bar.
 * An update chose when to move before it installed, so nothing asks again;
 * restarting now is here for whoever wants it. A switch that failed also gets
 * a notice of its own (`LocalRuntimeNotice`), so it is never left behind
 * silently.
 */
export function RuntimeStatus({ tier }: { tier: "full" | "compact" | "icon" }) {
  const runtime = useRuntimeSwitch();
  useEffect(() => { void bootLocalRuntime(); }, []);
  if (!runtime) return null;
  if (runtime.kind === "updating") {
    const label = `Updating the runtime to ${runtime.to}`;
    return (
      <span role="status" aria-label={label} className="flex h-[19px] items-center gap-1 px-1.5 text-muted-foreground">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        {tier !== "icon" ? <span>{tier === "full" ? `${label}…` : "Updating runtime…"}</span> : null}
      </span>
    );
  }
  const { outdated } = runtime;
  const version = outdated.running ?? "older";
  const waiting = outdated.failed ? "not updated"
    : outdated.work === null ? "checking"
    : outdated.work.length === 0 ? "updating shortly"
    : `waiting for ${outdated.work.length}`;
  return (
    // Each runtime is news of its own: a popover opened for the last one closes.
    <PopoverPrimitive.Root key={runtime.epoch}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={`Runtime ${version}, ${waiting}`}
          data-testid="runtime-status"
          className={cn(
            "flex h-[19px] items-center gap-1 rounded px-1.5 leading-[18px] outline-none hover:bg-veil-raised focus-visible:ring-1 focus-visible:ring-ring/50",
            outdated.failed || outdated.problem ? "text-warning" : "text-muted-foreground",
          )}
        >
          {outdated.failed ? <TriangleAlert className="size-3" aria-hidden /> : <Server className="size-3" aria-hidden />}
          {tier !== "icon" ? <span className="tabular-nums">Runtime {version}</span> : null}
          {tier === "full" ? <span> · {waiting}</span> : null}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="end"
          sideOffset={5}
          data-status-context-exempt
          onContextMenu={(event) => event.stopPropagation()}
          className="z-(--z-menu) w-[24rem] max-w-[calc(100vw-2rem)] rounded-xl bg-(--surface-card) p-3 text-popover-foreground shadow-surface hairline outline-none data-[state=open]:animate-fade-in"
        >
          <RuntimeDetails epoch={runtime.epoch} outdated={outdated} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** What the switch waits for, and a restart now, which stops all of it. Only
 * the runtime this window was told about: another window may already have
 * replaced it. */
function RuntimeDetails({ epoch, outdated }: { epoch: string; outdated: LocalRuntimeOutdated }) {
  const [restarting, setRestarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { running, app, work, problem, failed } = outdated;
  const restart = async () => {
    setRestarting(true);
    setFailure(null);
    try { await replaceLocalRuntime(epoch); }
    catch (error) { setFailure(errorMessage(error)); }
    finally { setRestarting(false); }
  };
  const busy = !failed && work !== null && work.length > 0;
  const waiting = failed
    ? `Moving to ${app} failed, and it does not try again by itself.`
    : work === null ? `It moves to ${app} by itself once it has checked that nothing it runs would be cut short.`
    : work.length === 0 ? `Nothing it runs would be cut short: it moves to ${app} in a moment.`
    : `It moves to ${app} by itself once nothing it runs would be cut short. It is waiting for:`;
  return (
    <div className="text-xs">
      <div className="font-medium">Runtime {running ?? "older"} → {app}</div>
      <p className="mt-1 text-muted-foreground">
        The runtime your agents and terminals run in is {running ? `version ${running}` : "an earlier version"}; this app is {app}. {waiting}
      </p>
      {busy && <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-4 text-muted-foreground">{work.map((item, index) => <li key={index}>{item}</li>)}</ul>}
      {(failure ?? problem) && <p role="alert" className="mt-1 text-destructive">{failure ?? problem}</p>}
      <p className="mt-2 text-muted-foreground">
        {failed ? "Trying again" : "Restarting now"} stops {busy ? (work.length === 1 ? "that" : "all of that") : "its agents"}, and its terminals and whatever they run; each agent picks up its conversation again when its tab starts.
      </p>
      <div className="mt-2.5 flex justify-end">
        <Button variant="outline" size="sm" disabled={restarting} onClick={() => void restart()}>
          {restarting ? "Restarting…" : failed ? "Try again" : "Restart now"}
        </Button>
      </div>
    </div>
  );
}
