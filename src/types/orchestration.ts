/** An orchestration run (PRO-274): one lead session, a plan of pieces, a worker per piece.
 * Mirrors `src-tauri/src/orchestration/mod.rs`, as `engine::shown` sends it. */

export type RunState = "planned" | "awaitingApproval" | "running" | "verifying" | "merging" | "done" | "stopped" | "failed";
export type PieceState = "queued" | "running" | "done" | "blocked" | "failed" | "stopped";

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
  state: PieceState;
  note?: string;
}

export interface RunWaiting {
  piece: string;
  on: string[];
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
  created: string;
  modified: string;
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
  projects: Record<string, ProjectOrchestratorSettings>;
}

export interface ProjectOrchestratorSettings {
  requireApproval?: boolean;
  pieceLimit?: number;
  workerMode?: string;
}

/** One change. With `project`, that project's own answer; `null` there follows the app again. */
export interface OrchestratorPatch {
  project?: string;
  requireApproval?: boolean | null;
  pieceLimit?: number | null;
  workerMode?: string | null;
}
