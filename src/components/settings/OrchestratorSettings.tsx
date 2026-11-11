import { useEffect, useState } from "react";
import { Segmented, Switch } from "@/components/ui/controls";
import { errorMessage, orchestration } from "@/lib/api";
import { modeLabel, PERMISSION_MODES } from "@/lib/models";
import { useSettingsFile } from "@/lib/settingsFile";
import { useSessionStore } from "@/lib/sessions";
import type { OrchestratorPatch, OrchestratorSettings as Settings } from "@/types/orchestration";
import { RegisteredSetting } from "./settingsRegistry";
import { RoutingTableSettings } from "./RoutingTableSettings";

/** The most pieces the setting takes (`MAX_PIECE_LIMIT` in store/settings.rs). */
const MAX_PIECES = 50;
/** The modes a worker may start in (`WORKER_MODES` in store/settings.rs), in the picker's own words. */
const WORKER_MODES = ["plan", "manual", "acceptEdits", "auto", "bypassPermissions"];
const selectClass = "h-7 rounded-md border border-hairline bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60";
const numberClass = "h-7 w-16 rounded-md border border-hairline bg-background px-2 text-right text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60";

function modeName(mode: string): string {
  return PERMISSION_MODES.some((known) => known.id === mode) ? modeLabel(mode) : mode;
}

/** The settings as stored, read again whenever the file changes, and one way to change them. */
function useOrchestratorSettings() {
  const { revision } = useSettingsFile();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => orchestration.settings())
      .then((loaded) => live && setSettings(loaded))
      .catch((e: unknown) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [revision]);
  const save = async (patch: OrchestratorPatch) => {
    setError(null);
    try {
      setSettings(await orchestration.setSettings(patch));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return { settings, error, save };
}

/** A count of pieces typed into a field: saved when the field is left or Enter is pressed, and only when it is one. */
function PieceLimitField({ value, placeholder, disabled, label, onSave }: { value: number | undefined; placeholder?: string; disabled: boolean; label: string; onSave: (limit: number | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === undefined ? "" : String(value));
  const commit = () => {
    if (draft === null) return;
    const text = draft.trim();
    setDraft(null);
    if (text === "") {
      // An empty field is "no value of its own": only a repository has that.
      if (placeholder !== undefined && value !== undefined) onSave(null);
      return;
    }
    const limit = Number(text);
    if (Number.isInteger(limit) && limit >= 1 && limit <= MAX_PIECES && limit !== value) onSave(limit);
  };
  return (
    <input
      type="number"
      inputMode="numeric"
      min={1}
      max={MAX_PIECES}
      aria-label={label}
      className={numberClass}
      value={shown}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

/** Settings → Orchestrator: what a lead's run of workers may do without asking, for every project. */
export function OrchestratorTab() {
  const { settings, error, save } = useOrchestratorSettings();
  const ready = settings !== null;
  return (
    <div className="flex flex-col" data-testid="orchestrator-settings">
      <p className="pb-3 text-[13px] text-muted-foreground">How a lead session splits work across worker sessions: whether it asks first, how far it may split, the permissions its workers run with, and which model each kind of piece starts on. A repository can answer for itself in its own settings.</p>
      <div className="mb-1 mt-2 text-xs font-medium uppercase tracking-wide text-faint">Runs</div>
      <RegisteredSetting setting="orchestrator.requireApproval"
        control={<Switch aria-label="Ask before a run starts" checked={settings?.requireApproval ?? true} disabled={!ready} onCheckedChange={(on) => void save({ requireApproval: on })} />}
      />
      <RegisteredSetting setting="orchestrator.pieceLimit"
        control={<PieceLimitField label="Pieces per run, at most" value={settings?.pieceLimit} disabled={!ready} onSave={(limit) => void save({ pieceLimit: limit })} />}
      />
      <RegisteredSetting setting="orchestrator.workerMode"
        control={
          <select aria-label="Workers run in" className={selectClass} value={settings?.workerMode ?? "bypassPermissions"} disabled={!ready} onChange={(event) => void save({ workerMode: event.target.value })}>
            {WORKER_MODES.map((mode) => <option key={mode} value={mode}>{modeName(mode)}</option>)}
          </select>
        }
      />
      <RegisteredSetting setting="orchestrator.routing">
        <div><RoutingTableSettings settings={settings} save={(patch) => void save(patch)} /></div>
      </RegisteredSetting>
      {error && <p role="alert" className="pb-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

type Approval = "default" | "on" | "off";

/** One repository's own answers, in its settings. Each follows the app until it is given a value. */
export function RepositoryOrchestratorSettings({ projectPath }: { projectPath: string }) {
  const { projects } = useSessionStore();
  const { settings, error, save } = useOrchestratorSettings();
  const project = projects.find((candidate) => !candidate.archived && candidate.path === projectPath);
  if (!project || project.kind === "folder") return null;
  const own = settings?.projects[projectPath] ?? {};
  const ready = settings !== null;
  const approval: Approval = own.requireApproval === undefined ? "default" : own.requireApproval ? "on" : "off";
  return (
    <RegisteredSetting setting="repositories.orchestrator" instance={projectPath}>
      <section className="flex flex-col gap-1" aria-label="Repository orchestrator" data-testid="repository-orchestrator-settings">
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-faint">Orchestrator</div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">Ask before a run starts</div>
            <div className="text-xs leading-relaxed text-muted-foreground">Off: a lead in this repository starts its workers without showing you the plan.</div>
          </div>
          <Segmented<Approval>
            aria-label={`Ask before a run starts in ${project.name}`}
            disabled={!ready}
            value={approval}
            onChange={(next) => void save({ project: projectPath, requireApproval: next === "default" ? null : next === "on" })}
            options={[
              { value: "default", label: `Default (${settings?.requireApproval ?? true ? "on" : "off"})` },
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">Pieces per run, at most</div>
            <div className="text-xs leading-relaxed text-muted-foreground">Leave empty to follow the default.</div>
          </div>
          <PieceLimitField label={`Pieces per run in ${project.name}, at most`} value={own.pieceLimit} placeholder={settings ? String(settings.pieceLimit) : ""} disabled={!ready} onSave={(limit) => void save({ project: projectPath, pieceLimit: limit })} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">Workers run in</div>
            <div className="text-xs leading-relaxed text-muted-foreground">Push, merge and deploy stay blocked by deny rules in every mode.</div>
          </div>
          <select aria-label={`Workers of ${project.name} run in`} className={selectClass} value={own.workerMode ?? ""} disabled={!ready} onChange={(event) => void save({ project: projectPath, workerMode: event.target.value || null })}>
            <option value="">Default ({modeName(settings?.workerMode ?? "bypassPermissions")})</option>
            {WORKER_MODES.map((mode) => <option key={mode} value={mode}>{modeName(mode)}</option>)}
          </select>
        </div>
        <RoutingTableSettings settings={settings} project={{ path: projectPath, name: project.name }} save={(patch) => void save(patch)} />
        <p className="text-xs text-muted-foreground">The defaults are in Settings → Orchestrator.</p>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </section>
    </RegisteredSetting>
  );
}
