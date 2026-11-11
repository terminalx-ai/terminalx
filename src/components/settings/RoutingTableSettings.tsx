import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Info, RotateCcw, TriangleAlert } from "@/icons";
import { orchestration } from "@/lib/api";
import { cn } from "@/lib/cn";
import { EFFORT_LABEL } from "@/lib/models";
import { appRouting, PIECE_KINDS, ROUTE_EFFORTS, ROUTED_AGENTS, sameRoute, TIER_DOT, TIERS } from "@/lib/orchestration";
import type { OrchestratorPatch, OrchestratorSettings, PieceKind, Route, RoutedAgent, Tier, TierModels } from "@/types/orchestration";

const kicker = "text-[10.5px] font-medium uppercase tracking-[.08em] text-faint";
const box = "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-hairline bg-background px-2 text-xs focus-within:ring-2 focus-within:ring-ring/40";
const bare = "min-w-0 flex-1 appearance-none bg-transparent outline-none disabled:opacity-60";
// Kind and both agents always. What a kind is used for has a column of its own where there is room, and sits under the kind where there is not.
const columns = "grid-cols-[minmax(6.25rem,1fr)_minmax(0,15.75rem)_minmax(0,15.75rem)] @[860px]/routing:grid-cols-[6.75rem_minmax(0,1fr)_16rem_16rem]";

/** The model each tier runs on today, read once: the table names tiers, and shows what a tier means here. */
function useTierModels(): TierModels | null {
  const [models, setModels] = useState<TierModels | null>(null);
  useEffect(() => {
    let live = true;
    orchestration.tierModels().then((loaded) => live && setModels(loaded)).catch(() => null);
    return () => {
      live = false;
    };
  }, []);
  return models;
}

/** A tier as its select names it: the model it runs on, or its family when the agent lists none. */
function tierText(models: TierModels | null, agent: RoutedAgent, tier: Tier): string {
  const family = TIERS.find((known) => known.tier === tier)!.family[agent];
  if (!models) return family;
  return models[agent]?.[tier]?.label ?? `${family} (not installed)`;
}

function effortText(effort: string | undefined): string {
  return effort ? EFFORT_LABEL[effort] ?? effort : "Default";
}

/** One cell: the tier a kind starts on for one agent, and its effort. */
function RouteCell({ kind, agent, agentName, route, inherited, models, disabled, onChange }: {
  kind: PieceKind;
  agent: RoutedAgent;
  agentName: string;
  /** The cell's own route; absent for a repository that follows the app here. */
  route: Route | undefined;
  /** What the cell follows when it has no route of its own: only a repository has that. */
  inherited?: Route;
  models: TierModels | null;
  disabled: boolean;
  onChange: (route: Route | null) => void;
}) {
  const shown = route ?? inherited!;
  const model = models?.[agent]?.[shown.tier] ?? null;
  // The efforts the tier's model offers; every level while that is not known. The stored one is always listed.
  const offered = model ? model.efforts : models ? [] : ROUTE_EFFORTS;
  const efforts = ROUTE_EFFORTS.filter((effort) => offered.includes(effort) || effort === shown.effort);
  const follows = route === undefined;
  const missing = !!models && !model;
  return (
    <div role="cell" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 @[860px]/routing:gap-x-3">
      <span className={cn(box, "w-[9.25rem]")}>
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full bg-current", TIER_DOT[shown.tier])} />
        <select
          aria-label={`${agentName} model for ${kind}`}
          className={bare}
          disabled={disabled}
          value={follows ? "" : shown.tier}
          onChange={(event) => {
            if (event.target.value === "") return onChange(null);
            const tier = event.target.value as Tier;
            const next = models?.[agent]?.[tier];
            // An effort the new tier's model does not offer goes back to that model's default.
            const effort = shown.effort && (!next || next.efforts.includes(shown.effort)) ? shown.effort : undefined;
            onChange({ tier, ...(effort ? { effort } : {}) });
          }}
        >
          {inherited && <option value="">Default ({tierText(models, agent, inherited.tier)})</option>}
          {TIERS.map(({ tier }) => <option key={tier} value={tier}>{tierText(models, agent, tier)}</option>)}
        </select>
      </span>
      <span className={cn(box, "w-[5.75rem]")}>
        <select
          aria-label={`${agentName} effort for ${kind}`}
          className={cn(bare, !shown.effort && "text-muted-foreground")}
          // A cell that follows the app takes its effort with its tier.
          disabled={disabled || follows}
          value={shown.effort ?? ""}
          onChange={(event) => onChange({ tier: shown.tier, ...(event.target.value ? { effort: event.target.value } : {}) })}
        >
          <option value="">Default</option>
          {efforts.map((effort) => <option key={effort} value={effort}>{effortText(effort)}</option>)}
        </select>
      </span>
      {missing && (
        <span role="note" className="flex basis-full items-center gap-1 text-[11.5px] text-warning">
          <TriangleAlert aria-hidden className="size-3 shrink-0" />No {shown.tier} model installed: runs on the lead's model
        </span>
      )}
    </div>
  );
}

/**
 * The routing table: which model and effort each kind of piece starts on, a
 * column per agent. With `project`, that repository's own rows, each
 * following the app until it is given a value.
 */
export function RoutingTableSettings({ settings, project, save }: {
  settings: OrchestratorSettings | null;
  project?: { path: string; name: string };
  save: (patch: OrchestratorPatch) => void;
}) {
  const models = useTierModels();
  const ready = settings !== null;
  const app = appRouting(settings?.routing);
  const own = project ? settings?.projects[project.path]?.routing : settings?.routing;
  const changed = !!own && Object.values(own).some((row) => row && Object.keys(row).length > 0);
  const scope = project ? { project: project.path } : {};
  return (
    <section aria-label={project ? `Starting model by kind of piece in ${project.name}` : "Starting model by kind of piece"} className="@container/routing mt-5 min-w-0" data-testid="routing-table">
      <div className="mb-2 flex items-center gap-2">
        <div className={project ? "text-[13px] font-medium" : "text-xs font-medium uppercase tracking-wide text-faint"}>Starting model by kind of piece</div>
        <Button size="sm" variant="outline" className="ml-auto" disabled={!ready || !changed} onClick={() => save({ ...scope, resetRouting: true })}>
          <RotateCcw />{project ? "Follow the defaults" : "Reset to defaults"}
        </Button>
      </div>
      <div role="table" aria-label="Routing table" className="rounded-lg bg-well hairline">
        <div role="row" className={cn("grid items-center gap-x-3 border-b border-hairline px-4 py-2", columns)}>
          <div role="columnheader" className={kicker}>Kind</div>
          <div role="columnheader" className={cn(kicker, "hidden @[860px]/routing:block")}>Used for</div>
          {ROUTED_AGENTS.map(({ agent, name }) => <div key={agent} role="columnheader" className={kicker}>{name} workers</div>)}
        </div>
        {PIECE_KINDS.map(({ kind, usedFor }) => (
          <div key={kind} role="row" data-kind={kind} className={cn("grid items-center gap-x-3 border-b border-hairline px-4 py-1.5 last:border-b-0", columns)}>
            <div role="cell" className="min-w-0">
              <span className="inline-flex h-5 items-center rounded-[5px] bg-veil-raised px-1.5 font-mono text-[11px] text-muted-foreground">{kind}</span>
              <span className="mt-0.5 block text-[11.5px] leading-4 text-faint @[860px]/routing:hidden">{usedFor}</span>
            </div>
            <div role="cell" className="hidden truncate text-[12.5px] text-muted-foreground @[860px]/routing:block">{usedFor}</div>
            {ROUTED_AGENTS.map(({ agent, name }) => {
              const cell = own?.[kind]?.[agent];
              return (
                <RouteCell
                  key={agent}
                  kind={kind}
                  agent={agent}
                  agentName={name}
                  // The app's own cell is always a route: its changed one, or the built-in one.
                  route={project ? cell : app[kind][agent]}
                  inherited={project ? app[kind][agent] : undefined}
                  models={models}
                  disabled={!ready}
                  onChange={(route) => {
                    if (route && sameRoute(route, project ? cell : app[kind][agent])) return;
                    save({ ...scope, routing: { [kind]: { [agent]: route } } });
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <p className="mt-2 flex items-start gap-2 text-[11.5px] text-faint">
        <Info aria-hidden className="mt-0.5 size-3 shrink-0" />
        <span>
          {project
            ? "A row left at Default follows Settings → Orchestrator. A single plan can still name a model for a piece."
            : "A worker uses the column of the agent it runs on. Rows name a tier, so a new release of a model takes its place. A project or a single plan can override any row."}
        </span>
      </p>
    </section>
  );
}
