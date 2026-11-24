import { useState } from "react";
import { joinKeycaps } from "@/lib/shortcuts";
import { useShortcutKeys } from "@/lib/hotkeys";
import { CloudTerminalPane } from "@/components/cloud/CloudTerminalPane";
import { RepositoryIcon } from "@/components/ui/IconPicker";
import { Button } from "@/components/ui/button";
import { RunControls, runStateText } from "@/components/session/RunMenu";
import { SETUP_SCRIPT_PLACE, setupOutcome } from "@/components/terminal/WorkspaceSetupPane";
import { errorMessage } from "@/lib/api";
import type { CloudSessionModel } from "@/lib/cloudSession";
import { cn } from "@/lib/cn";
import { machineFeature, machineFeatureMessage } from "@/lib/machineFeatures";
import { MACHINE_RUNS, startMachineAction, useMachineSessionRuns, type MachineSessionRuns } from "@/lib/machineRuns";

/**
 * The dock's Setup and Run tabs in a machine session (PRO-403). As in a
 * local session's dock (`TerminalDock`), but everything is the machine's: the
 * scripts are the ones saved on it, they run there in the session's folder,
 * and their output is the machine's terminal.
 */

/** Where a machine project's actions are saved, for the Run tab's empty state. */
const RUN_ACTIONS_PLACE = "Settings → Projects → Actions";

const Label = ({ children }: { children: string }) => <h3 className="text-[10.5px] font-medium tracking-[0.08em] text-faint uppercase">{children}</h3>;

/**
 * A machine session's Run menu and Open button in its header: the machine
 * project's actions and preview URLs, run there and opened here through a
 * forward. Absent while the machine is away or too old, as a local session's
 * is absent with nothing saved.
 */
export function MachineRunMenu({ cloud, className }: { cloud: CloudSessionModel; className?: string }) {
  const runs = useMachineSessionRuns(cloud);
  if (!runs?.served || (!runs.source.actions.length && !runs.source.previews.length)) return null;
  return <RunControls source={runs.source} className={className} />;
}

/** One line naming the machine, when it is too old to serve its sessions' scripts. */
export function machineRunsUpdate(cloud: CloudSessionModel): string | null {
  if (!cloud.connected || !cloud.client || cloud.client.hasCapability(MACHINE_RUNS)) return null;
  const feature = machineFeature(MACHINE_RUNS)!;
  const name = cloud.machine?.name ?? "This machine";
  const version = cloud.machine?.record?.version;
  return version ? machineFeatureMessage(name, version, feature) : `Update ${name} to ${feature.action} from here.`;
}

function Notice({ children, testId }: { children: React.ReactNode; testId: string }) {
  return <p className="text-xs text-muted-foreground" data-testid={testId}>{children}</p>;
}

/** The Setup tab: the machine's setup script for this session, its last run there, Stop and Rerun, and that run's terminal. */
export function MachineSetupPane({ cloud, runs }: { cloud: CloudSessionModel; runs: MachineSessionRuns }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = cloud.machine?.name ?? "the machine";
  const update = machineRunsUpdate(cloud);
  const info = runs.info;
  const setup = info?.setup ?? null;
  const going = !!setup && (setup.status === "pending" || setup.status === "running" || setup.status === "stopping");
  const text = setup?.command || info?.setupScript?.trim() || "";
  const act = async (call: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await call();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  let body: React.ReactNode;
  if (update) body = <Notice testId="machine-setup-update">{update}</Notice>;
  else if (!cloud.connected) body = <Notice testId="machine-setup-away">Setup shows once {name} is connected.</Notice>;
  else if (!info) body = <Notice testId="machine-setup-loading">{runs.error ?? `Reading setup on ${name}…`}</Notice>;
  else if (!setup && !text)
    body = (
      <Notice testId="setup-empty">
        No setup script on {name} yet. Add one there in <span className="text-foreground">{SETUP_SCRIPT_PLACE}</span>: it runs on {name} once when a workspace is created, to install dependencies and copy local files.
      </Notice>
    );
  else
    body = (
      <>
        <pre data-testid="setup-script" className="max-h-32 shrink-0 overflow-auto rounded-md border border-hairline bg-veil-card px-3 py-2 font-mono text-xs leading-5 whitespace-pre text-foreground">
          {text}
        </pre>
        {setup ? (
          <p role="status" data-testid="setup-outcome" className={cn("shrink-0 text-xs", setup.status === "succeeded" ? "text-add" : setup.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
            {setupOutcome(setup, null)}
          </p>
        ) : (
          <p role="status" data-testid="setup-outcome" className="shrink-0 text-xs text-muted-foreground">
            {info.setupApplies ? `Not run in this workspace on ${name} yet.` : `This session works in the project's folder on ${name}; setup runs in a workspace's own checkout.`}
          </p>
        )}
        {setup?.error && <p role="alert" className="shrink-0 text-xs text-destructive">{setup.error}</p>}
        {setup && (
          <>
            <Label>Output</Label>
            <div className="relative flex min-h-32 flex-1 flex-col overflow-hidden rounded-md border border-hairline" data-testid="setup-output">
              {runs.setupTerminal && cloud.client ? (
                <CloudTerminalPane
                  key={runs.setupTerminal.id}
                  workspace={cloud.workspaceKey}
                  terminal={runs.setupTerminal}
                  client={cloud.client}
                  connected={cloud.connected}
                  manage={cloud.manage}
                  mayControl={false}
                  base={cloud.terminalBase}
                />
              ) : (
                <p className="px-3 py-2 text-xs text-muted-foreground">{going ? `Waiting for its output on ${name}…` : `${name} no longer keeps this run's output.`}</p>
              )}
            </div>
          </>
        )}
      </>
    );

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto px-3 py-2.5" data-testid="machine-setup-pane">
      <div className="flex shrink-0 items-center gap-2">
        <div className="flex-1">
          <Label>After setup</Label>
        </div>
        {!update && going && setup && (
          <Button size="xs" variant="outline" disabled={busy || setup.status === "stopping" || !!runs.blocked} onClick={() => void act(runs.stopSetup)}>
            {setup.status === "stopping" ? "Stopping…" : "Stop"}
          </Button>
        )}
        {!update && info?.setupApplies && (setup || text) && (
          <Button size="xs" variant="outline" disabled={busy || going || !!runs.blocked} title={runs.blocked ?? undefined} onClick={() => void act(runs.rerunSetup)}>
            {setup ? "Rerun" : "Run setup"}
          </Button>
        )}
      </div>
      {body}
      {error && <p role="alert" className="shrink-0 text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** The Run tab: the machine project's actions with their latest run there. Show brings the run's terminal forward in the dock. */
export function MachineRunPane({ cloud, runs, onShow }: { cloud: CloudSessionModel; runs: MachineSessionRuns; onShow: (terminalId: string) => void }) {
  const runKeys = joinKeycaps(useShortcutKeys("session.runAction"));
  const name = cloud.machine?.name ?? "the machine";
  const update = machineRunsUpdate(cloud);
  const { actions } = runs.source;
  let body: React.ReactNode;
  if (update) body = <Notice testId="machine-run-update">{update}</Notice>;
  else if (!cloud.connected) body = <Notice testId="machine-run-away">Actions show once {name} is connected.</Notice>;
  else if (!runs.info) body = <Notice testId="machine-run-loading">{runs.error ?? `Reading actions on ${name}…`}</Notice>;
  else if (!actions.length)
    body = (
      <Notice testId="run-empty">
        No run script on {name} yet. Add one there in <span className="text-foreground">{RUN_ACTIONS_PLACE}</span>: it starts the project's dev server or app on {name}{runKeys ? <>, and {runKeys} runs it</> : null}.
      </Notice>
    );
  else
    body = (
      <ul className="flex flex-col gap-1.5">
        {actions.map((action) => {
          const run = runs.source.runs.get(action.id);
          const running = run?.state === "running";
          const state = runStateText(run);
          return (
            <li key={action.id} data-action-id={action.id} className="flex min-w-0 items-center gap-2 rounded-md border border-hairline bg-veil-card px-2.5 py-1.5">
              <RepositoryIcon value={action.icon} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-xs text-foreground">{action.name}</span>
                <code className="truncate font-mono text-[11px] text-muted-foreground" title={action.command}>
                  {action.command}
                </code>
              </div>
              {state && <span className={cn("shrink-0 text-[11px]", running ? "text-add" : run?.exitCode ? "text-destructive" : "text-faint")}>{state}</span>}
              {run && (
                <Button size="xs" variant="ghost" onClick={() => onShow(run.paneId)}>
                  Show
                </Button>
              )}
              <Button size="xs" variant="outline" disabled={!!runs.blocked} title={runs.blocked ?? undefined} onClick={() => void startMachineAction(cloud, action, { restart: running && !action.concurrent })}>
                {running && !action.concurrent ? "Restart" : "Run"}
              </Button>
            </li>
          );
        })}
      </ul>
    );
  return (
    <div className="flex h-full flex-col gap-2 overflow-auto px-3 py-2.5" data-testid="machine-run-pane">
      <Label>Run</Label>
      {body}
    </div>
  );
}
