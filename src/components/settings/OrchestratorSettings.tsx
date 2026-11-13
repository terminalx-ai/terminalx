import { useEffect, useState, type ReactNode } from "react";
import { Segmented, Switch } from "@/components/ui/controls";
import { errorMessage, orchestration } from "@/lib/api";
import { EFFORT_LABEL, modeLabel, PERMISSION_MODES } from "@/lib/models";
import { ROUTE_EFFORTS } from "@/lib/orchestration";
import { useSettingsFile } from "@/lib/settingsFile";
import { useSessionStore } from "@/lib/sessions";
import type { Cap, OrchestratorPatch, OrchestratorSettings as Settings } from "@/types/orchestration";
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

function effortName(effort: string): string {
  return EFFORT_LABEL[effort] ?? effort;
}

/** The levels a ceiling can be: every routing effort, and the stored one should the file name another. */
function ceilingChoices(...stored: (string | undefined)[]): string[] {
  const extra = stored.filter((effort): effort is string => !!effort && !ROUTE_EFFORTS.includes(effort));
  return [...ROUTE_EFFORTS, ...new Set(extra)];
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

/** The most changed lines the diff threshold takes (`MAX_REVIEW_DIFF_LINES` in orchestration/verify.rs). */
const MAX_DIFF_LINES = 100_000;

/** A number typed into a field: saved when the field is left or Enter is pressed, and only when it is in range.
 * Empty is "no value of its own", which only a repository has (`placeholder` is then the app's value). */
function NumberField({ value, placeholder, disabled, label, min, max, step = 1, prefix, suffix, wide, onSave }: {
  value: number | undefined; placeholder?: string; disabled: boolean; label: string; min: number; max: number; step?: number; prefix?: string; suffix?: string; wide?: boolean; onSave: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === undefined ? "" : String(value));
  const commit = () => {
    if (draft === null) return;
    const text = draft.trim();
    setDraft(null);
    if (text === "") {
      if (placeholder !== undefined && value !== undefined) onSave(null);
      return;
    }
    const next = Number(text);
    const whole = step >= 1 ? Number.isInteger(next) : true;
    if (Number.isFinite(next) && whole && next >= min && next <= max && next !== value) onSave(next);
  };
  const input = (
    <input
      type="number"
      inputMode={step >= 1 ? "numeric" : "decimal"}
      min={min}
      max={max}
      step={step}
      aria-label={label}
      className={prefix || suffix ? "w-14 bg-transparent text-right text-xs tabular-nums outline-none disabled:opacity-60" : wide ? numberClass.replace("w-16", "w-20") : numberClass}
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
  if (!prefix && !suffix) return input;
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-background px-2 text-xs focus-within:ring-2 focus-within:ring-ring/40">
      {prefix && <span className="text-faint">{prefix}</span>}
      {input}
      {suffix && <span className="text-faint">{suffix}</span>}
    </span>
  );
}

/** A budget or the window level (PRO-335): a number, or No limit with the switch beside it; off, `offText` (when given) stands in for the field.
 * Turned back on, the app-wide field returns to `fallback`; a repository's field (with a `placeholder`) follows the default again. */
function CapField({ value, placeholder, label, offLabel, offText, fallback, disabled, stack, onSave, ...bounds }: {
  value: Cap | undefined; placeholder?: string; label: string; offLabel: string; offText?: string; fallback?: number; disabled: boolean;
  /** The switch under the field, for a half-width card. */
  stack?: boolean;
  min: number; max: number; step?: number; prefix?: string; suffix?: string; onSave: (value: Cap | null) => void;
}) {
  const off = value === "none";
  return (
    <span className={stack ? "inline-flex flex-col items-end gap-1" : "inline-flex flex-wrap items-center justify-end gap-x-3 gap-y-1"}>
      {off ? offText && <span className={stack ? "max-w-[9.5rem] text-right text-xs text-muted-foreground" : "text-xs text-muted-foreground"}>{offText}</span> : (
        <NumberField label={label} value={value} placeholder={placeholder} disabled={disabled} {...bounds} onSave={onSave} />
      )}
      <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Switch size="sm" aria-label={`${label}: ${offLabel}`} checked={off} disabled={disabled} onCheckedChange={(on) => onSave(on ? "none" : (fallback ?? null))} />
        {offLabel}
      </label>
    </span>
  );
}

/** `$15`, `25 pts`, `85%` or `No limit`: a value a repository follows, as its field's placeholder. */
function capPlaceholder(cap: Cap | undefined): string {
  return cap === undefined ? "" : cap === "none" ? "No limit" : String(cap);
}

/** The most pieces or workers the settings take (`MAX_PIECE_LIMIT`, `MAX_WORKERS` in store/settings.rs). */
const MAX_WORKERS = 50;
const MAX_DOLLARS = 10000;
const MAX_STALL_MINUTES = 240;
/** The most tries a piece takes (the runtime's bound on `triesPerPiece`; it defaults to 3 there). */
const MAX_TRIES = 6;
/** The effort a retry is raised no higher than unless set (the runtime's default for `effortCeiling`). */
const DEFAULT_EFFORT_CEILING = "high";
/** What a budget turned back on starts from: the defaults (`DEFAULT_BUDGET_*`, `DEFAULT_WINDOW_CEILING` in store/settings.rs). */
const DEFAULT_DOLLARS = 15;
const DEFAULT_POINTS = 25;
const DEFAULT_CEILING = 85;
/** What the window level says when it is off, here and in a repository. */
const CEILING_OFF = "Off: a run can use the whole window";

/** A titled group of rows on a raised card, as design 18.05 has them. */
function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={title} className="min-w-0">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-faint">{title}</div>
      <div className="rounded-lg bg-well hairline">{children}</div>
    </div>
  );
}

/** One row of a card, with the hairline between rows. */
function CardRow({ children }: { children: ReactNode }) {
  return <div className="min-w-0 border-b border-hairline px-4 last:border-b-0">{children}</div>;
}

/** Settings → Orchestrator: what a lead's run of workers may do without asking, for every project. */
export function OrchestratorTab() {
  const { settings, error, save } = useOrchestratorSettings();
  const ready = settings !== null;
  return (
    <div className="flex flex-col gap-5 @container/orchestrator" data-testid="orchestrator-settings">
      <p className="text-[13px] text-muted-foreground">How a lead session splits work across worker sessions: whether it asks first, how far it may split, the permissions its workers run with, which model each kind of piece starts on, and the limits a run stays inside. A repository can answer for itself in its own settings.</p>
      <div className="grid items-start gap-5 @[38rem]/orchestrator:grid-cols-2">
        <Card title="Runs">
          <CardRow><RegisteredSetting setting="orchestrator.requireApproval"
            control={<Switch aria-label="Ask before a run starts" checked={settings?.requireApproval ?? true} disabled={!ready} onCheckedChange={(on) => void save({ requireApproval: on })} />}
          /></CardRow>
          <CardRow><RegisteredSetting setting="orchestrator.workersPerRun"
            control={<NumberField label="Workers at once, per run" value={settings?.workersPerRun} min={1} max={MAX_WORKERS} disabled={!ready} onSave={(value) => value !== null && void save({ workersPerRun: value })} />}
          /></CardRow>
          <CardRow><RegisteredSetting setting="orchestrator.workersAtOnce"
            control={<NumberField label="Workers at once, whole app" value={settings?.workersAtOnce} min={1} max={MAX_WORKERS} disabled={!ready} onSave={(value) => value !== null && void save({ workersAtOnce: value })} />}
          /></CardRow>
          <CardRow><RegisteredSetting setting="orchestrator.pieceLimit"
            control={<NumberField label="Pieces per run, at most" value={settings?.pieceLimit} min={1} max={MAX_PIECES} disabled={!ready} onSave={(limit) => void save({ pieceLimit: limit })} />}
          /></CardRow>
          <CardRow><RegisteredSetting setting="orchestrator.workerMode"
            control={
              <select aria-label="Workers run in" className={selectClass} value={settings?.workerMode ?? "bypassPermissions"} disabled={!ready} onChange={(event) => void save({ workerMode: event.target.value })}>
                {WORKER_MODES.map((mode) => <option key={mode} value={mode}>{modeName(mode)}</option>)}
              </select>
            }
          /></CardRow>
          <CardRow><RegisteredSetting setting="orchestrator.triesPerPiece"
            control={<NumberField label="Tries per piece" value={settings?.triesPerPiece} min={1} max={MAX_TRIES} disabled={!ready} onSave={(value) => value !== null && void save({ triesPerPiece: value })} />}
          /></CardRow>
        </Card>
        <Card title="Budget and stalls">
          <CardRow><RegisteredSetting setting="orchestrator.budgetDollars"
            control={<CapField stack label="Budget per run, API key" offLabel="No limit" fallback={DEFAULT_DOLLARS} value={settings?.budgetDollars} min={0.01} max={MAX_DOLLARS} step={0.01} prefix="$" disabled={!ready} onSave={(value) => value !== null && void save({ budgetDollars: value })} />}
          /></CardRow>
          <CardRow><RegisteredSetting setting="orchestrator.budgetPoints"
            control={<CapField stack label="Budget per run, subscription" offLabel="No limit" fallback={DEFAULT_POINTS} value={settings?.budgetPoints} min={1} max={100} suffix="pts" disabled={!ready} onSave={(value) => value !== null && void save({ budgetPoints: value })} />}
          /></CardRow>
          <CardRow><RegisteredSetting setting="orchestrator.windowCeiling"
            control={<CapField stack label="Pause when a window passes" offLabel="Off" offText={CEILING_OFF} fallback={DEFAULT_CEILING} value={settings?.windowCeiling} min={1} max={100} suffix="%" disabled={!ready} onSave={(value) => value !== null && void save({ windowCeiling: value })} />}
          /></CardRow>
          <CardRow><RegisteredSetting setting="orchestrator.stallMinutes"
            control={<NumberField label="Mark a worker stalled after" value={settings?.stallMinutes} min={1} max={MAX_STALL_MINUTES} suffix="min" disabled={!ready} onSave={(value) => value !== null && void save({ stallMinutes: value })} />}
          /></CardRow>
          <CardRow><RegisteredSetting setting="orchestrator.effortCeiling"
            control={
              <select aria-label="Raise effort no higher than" className={selectClass} value={settings?.effortCeiling ?? DEFAULT_EFFORT_CEILING} disabled={!ready} onChange={(event) => void save({ effortCeiling: event.target.value })}>
                {ceilingChoices(settings?.effortCeiling).map((effort) => <option key={effort} value={effort}>{effortName(effort)}</option>)}
              </select>
            }
          /></CardRow>
        </Card>
      </div>
      <Card title="Checking results">
        <p className="border-b border-hairline px-4 py-2 text-xs leading-relaxed text-muted-foreground">When a worker reports done, TerminalX checks the result itself before the piece is done: its report, the files it touched, its branch, and the plan's commands. None of that uses a model. A verifier session reads the diff only when the piece has no command, the change touches a security area, the piece is a refactor, the plan asks for a review, or the diff is large. The verifier's model is the <span className="font-mono">verify</span> row of the table below.</p>
        <CardRow><RegisteredSetting setting="orchestrator.reviewDiffLines"
          control={<NumberField wide min={1} max={MAX_DIFF_LINES} label="Changed lines a result is accepted at without a verifier, at most" value={settings?.reviewDiffLines} disabled={!ready} onSave={(lines) => void save({ reviewDiffLines: lines })} />}
        /></CardRow>
      </Card>
      <RegisteredSetting setting="orchestrator.routing">
        <div><RoutingTableSettings settings={settings} save={(patch) => void save(patch)} /></div>
      </RegisteredSetting>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
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
          <NumberField label={`Pieces per run in ${project.name}, at most`} value={own.pieceLimit} placeholder={settings ? String(settings.pieceLimit) : ""} min={1} max={MAX_PIECES} disabled={!ready} onSave={(limit) => void save({ project: projectPath, pieceLimit: limit })} />
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
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">Tries per piece</div>
            <div className="text-xs leading-relaxed text-muted-foreground">Retry, raise effort, then move up a model. Leave empty to follow the default.</div>
          </div>
          <NumberField label={`Tries per piece in ${project.name}`} value={own.triesPerPiece} placeholder={settings ? String(settings.triesPerPiece) : ""} min={1} max={MAX_TRIES} disabled={!ready} onSave={(tries) => void save({ project: projectPath, triesPerPiece: tries })} />
        </div>
        {([
          ["budgetDollars", "Budget per run, API key", "Dollars its workers on an API key may spend.", "No limit", undefined, { min: 0.01, max: MAX_DOLLARS, step: 0.01, prefix: "$" }],
          ["budgetPoints", "Budget per run, subscription", "Points of a usage window one run may use.", "No limit", undefined, { min: 1, max: 100, suffix: "pts" }],
          ["windowCeiling", "Pause when a window passes", "Whoever used it. Off, a run can use the whole window.", "Off", CEILING_OFF, { min: 1, max: 100, suffix: "%" }],
        ] as const).map(([key, title, hint, offLabel, offText, bounds]) => (
          <div key={key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{title}</div>
              <div className="text-xs leading-relaxed text-muted-foreground">{hint} Leave empty to follow the default.</div>
            </div>
            <CapField label={`${title} in ${project.name}`} offLabel={offLabel} offText={offText} value={own[key]} placeholder={capPlaceholder(settings?.[key])} disabled={!ready} {...bounds} onSave={(value) => void save({ project: projectPath, [key]: value })} />
          </div>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">Raise effort no higher than</div>
            <div className="text-xs leading-relaxed text-muted-foreground">Past this, the next model up is tried.</div>
          </div>
          <select aria-label={`Raise effort in ${project.name} no higher than`} className={selectClass} value={own.effortCeiling ?? ""} disabled={!ready} onChange={(event) => void save({ project: projectPath, effortCeiling: event.target.value || null })}>
            <option value="">Default ({effortName(settings?.effortCeiling ?? DEFAULT_EFFORT_CEILING)})</option>
            {ceilingChoices(own.effortCeiling, settings?.effortCeiling).map((effort) => <option key={effort} value={effort}>{effortName(effort)}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">A verifier reads a diff over</div>
            <div className="text-xs leading-relaxed text-muted-foreground">Changed lines. A smaller result whose commands pass is accepted without a model. Leave empty to follow the default.</div>
          </div>
          <NumberField wide min={1} max={MAX_DIFF_LINES} label={`Changed lines a result in ${project.name} is accepted at without a verifier, at most`} value={own.reviewDiffLines} placeholder={settings ? String(settings.reviewDiffLines) : ""} disabled={!ready} onSave={(lines) => void save({ project: projectPath, reviewDiffLines: lines })} />
        </div>
        <RoutingTableSettings settings={settings} project={{ path: projectPath, name: project.name }} save={(patch) => void save(patch)} />
        <p className="text-xs text-muted-foreground">The defaults are in Settings → Orchestrator.</p>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </section>
    </RegisteredSetting>
  );
}
