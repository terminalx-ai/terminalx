/** An orchestration run (PRO-274): one lead session, a plan of pieces, a worker per piece.
 * Mirrors `src-tauri/src/orchestration/mod.rs`, as `engine::shown` sends it. */

export type RunState = "planned" | "awaitingApproval" | "running" | "needsYou" | "verifying" | "merging" | "done" | "stopped" | "failed";
export type PieceState = "queued" | "running" | "stalled" | "done" | "blocked" | "failed" | "stopped";
/** What keeps a piece the lead asked for from starting (PRO-280). */
export type RunHold = "runLimit" | "appLimit" | "budget";

/** A run's worker limit and budget (`budget::RunLimits`). */
export interface RunLimits {
  /** Workers of the run in a turn at once. */
  workers: number;
  /** Dollars its workers on an API key may spend. */
  dollars: number;
  /** Points of one usage window the run itself may use. */
  points: number;
  /** No new piece starts once a window it draws on is this full, in percent. */
  ceiling: number;
}

/** One usage window a run draws on, as the run has seen it. */
export interface RunWindowUse {
  agent: string;
  key: string;
  label: string;
  /** How full it is now, whoever filled it. */
  percent: number;
  /** How full it was when the run's first worker started in it. */
  start?: number;
  /** Milliseconds since the epoch. */
  resetsAt?: number;
  /** The run's own share: how far the window moved while it was active. */
  points: number;
}

export interface RunUsage {
  dollars: number;
  apiKey?: boolean;
  subscription?: boolean;
  windows?: RunWindowUse[];
}

export interface RunPause {
  kind: "dollars" | "points" | "window";
  message: string;
  window?: RunWindowUse;
  /** The person asked for it to go on when the window resets: then, in ms since the epoch. */
  resumeAt?: number;
}

export interface RunSessionRef {
  sessionId: string;
  tabId?: string;
}

export interface RunBudget {
  /** Points of a subscription's usage window. */
  points?: number;
  /** Dollars, for an agent billed by an API key. */
  dollars?: number;
}

/** What the lead expects a piece to cost, in API-equivalent dollars. */
export interface RunEstimate {
  low: number;
  high: number;
}

export interface PieceBrief {
  goal: string;
  why: string;
  scope: string;
  outOfScope: string;
  known: string[];
  readFirst: string[];
  limits: string[];
}

export interface RunPiece {
  id: string;
  title: string;
  brief: PieceBrief;
  owns: string[];
  dependsOn: string[];
  doneCheck: string;
  kind?: string;
  agent: string;
  /** Empty for the agent's own default model. */
  model: string;
  effort?: string;
  /** The plan's own choice; the run's `workerMode` when absent. */
  permissionMode?: string;
  readsUntrusted: boolean;
  estimate?: RunEstimate;
  attempts: number;
  worker?: RunSessionRef;
  branch?: string;
  startedMode?: string;
  /** Why its worker has a session but was not sent its brief; the next start tries again. */
  held?: string;
  /** How its worker's agent was signed in when it started. */
  login?: "apiKey" | "subscription";
  /** It was asked for, but a limit holds it. */
  queuedFor?: RunHold;
  state: PieceState;
  note?: string;
}

export interface RunWaiting {
  piece: string;
  on: string[];
  queuedFor?: RunHold;
}

export interface Run {
  id: string;
  lead: RunSessionRef;
  projectPath: string;
  goal: string;
  state: RunState;
  budget: RunBudget;
  pieces: RunPiece[];
  /** The mode of a piece that names none. */
  workerMode: string;
  planEdited?: boolean;
  approval?: { at: string };
  reason?: string;
  /** Absent from a runtime older than PRO-280, as are `usage`, `inTurn` and `fit`. */
  limits?: RunLimits;
  usage?: RunUsage;
  /** Why it is `needsYou`. */
  pause?: RunPause;
  created: string;
  modified: string;
  /** Its workers in a turn now: what the worker limits count. */
  inTurn?: number;
  /** Before it starts: what it may use that would not fit in what is left. */
  fit?: string[];
  /** The pieces the next start would start. */
  ready: string[];
  waiting: RunWaiting[];
  /** The summed estimate of the pieces that carry one. */
  estimate: RunEstimate | null;
  /** How many pieces carry no estimate. */
  unestimated: number;
}

/** A plan as `runs create` reads it, and as Edit saves it. */
export interface RunPlan {
  goal: string;
  budget: RunBudget;
  pieces: RunPlanPiece[];
}

export interface RunPlanPiece {
  id: string;
  title: string;
  goal: string;
  why: string;
  scope: string;
  outOfScope: string;
  known: string[];
  readFirst: string[];
  limits: string[];
  owns: string[];
  dependsOn: string[];
  doneCheck: string;
  kind?: string;
  agent: string;
  model: string;
  effort?: string;
  permissionMode?: string;
  readsUntrusted: boolean;
  estimate?: RunEstimate;
}

/** What starting or approving a run did. */
export interface RunStart {
  run: Run;
  started: string[];
  waiting: RunWaiting[];
  failed: { piece: string; error: string }[];
}

export interface RunStop {
  run: Run;
  stopped: string[];
  failed: { piece: string; error: string }[];
}

/** A refusal with its rule: `details.piece` names the piece a plan rule refused. */
export interface RunRefusal {
  code: string;
  message: string;
  recovery?: string;
  details?: { piece?: string; other?: string; path?: string; limit?: number; [key: string]: unknown };
}

/** Settings → Orchestrator: the app-wide values, and each project's own by its path. */
export interface OrchestratorSettings {
  requireApproval: boolean;
  pieceLimit: number;
  workerMode: string;
  workersPerRun: number;
  workersAtOnce: number;
  budgetDollars: number;
  budgetPoints: number;
  windowCeiling: number;
  stallMinutes: number;
  projects: Record<string, ProjectOrchestratorSettings>;
}

export interface ProjectOrchestratorSettings {
  requireApproval?: boolean;
  pieceLimit?: number;
  workerMode?: string;
  budgetDollars?: number;
  budgetPoints?: number;
  windowCeiling?: number;
}

/** One change. With `project`, that project's own answer; `null` there follows the app again. */
export interface OrchestratorPatch {
  project?: string;
  requireApproval?: boolean | null;
  pieceLimit?: number | null;
  workerMode?: string | null;
  /** App-wide only. */
  workersPerRun?: number;
  workersAtOnce?: number;
  stallMinutes?: number;
  budgetDollars?: number | null;
  budgetPoints?: number | null;
  windowCeiling?: number | null;
}
