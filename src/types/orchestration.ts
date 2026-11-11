/** An orchestration run (PRO-274): one lead session, a plan of pieces, a worker per piece.
 * Mirrors `src-tauri/src/orchestration/mod.rs`, as `engine::shown` sends it. */

export type RunState = "planned" | "awaitingApproval" | "running" | "verifying" | "merging" | "done" | "stopped" | "failed";
export type PieceState = "queued" | "running" | "done" | "blocked" | "failed" | "stopped";

/** A model's place in its vendor's line-up; the routing table names tiers, not versions (PRO-275). */
export type Tier = "small" | "mid" | "large" | "top";
/** The kinds of work a piece can be (`routing::KINDS`). */
export type PieceKind = "search" | "logs" | "scoped-code" | "code" | "refactor" | "research" | "review" | "verify";
/** The agents the routing table has a column for. */
export type RoutedAgent = "claude" | "codex";

/** Where a kind of piece starts. No effort means the model's own default. */
export interface Route {
  tier: Tier;
  effort?: string;
}

/** Cells of the routing table, by kind and then by agent. */
export type RoutingRows = Partial<Record<PieceKind, Partial<Record<RoutedAgent, Route>>>>;
/** The whole table: every kind, every agent. */
export type RoutingTable = Record<PieceKind, Record<RoutedAgent, Route>>;

/** The model each tier runs on today, per agent; `null` where the agent's CLI lists none. */
export type TierModels = Record<RoutedAgent, Record<Tier, { id: string; label: string; efforts: string[]; defaultEffort: string | null } | null>>;

/** What made a try differ from the one before it (`ladder::Step`). */
export type TryStep = "first" | "retry" | "effort" | "tier";
export type TryOutcome = "done" | "failed" | "partial" | "checkFailed" | "blocked" | "stopped";

/** One try at a piece: the worker it ran in, on what, at what cost, to what end. */
export interface PieceTry {
  step: TryStep;
  /** Empty for the agent's own default model. */
  model: string;
  effort?: string;
  tier?: Tier;
  /** Absent until its worker is started. */
  worker?: RunSessionRef;
  branch?: string;
  /** Absent while it runs, and before it starts. */
  outcome?: TryOutcome;
  /** The worker's result line, or the failure text the next try is given. */
  detail?: string;
  /** What its worker's session used, at API list prices. */
  costUsd?: number;
  /** Models whose tokens the cost leaves out. */
  costUnpricedModels?: string[];
  started?: string;
  ended?: string;
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

/** One thing that proves a piece done: a command run in the worker's worktree (exit 0 passes),
 * what a reviewer must confirm from the diff, or a claim several reviewers vote on. */
export type RunCheck =
  | { type: "command"; run: string }
  | { type: "review"; text: string }
  | { type: "vote"; text: string; voters?: number; threshold?: number };

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
  /** What proves the piece done, in order: at least one, a command among them unless `reviewOnly`. */
  doneChecks: RunCheck[];
  /** No command can prove this piece: review alone checks it, for the reason given. */
  reviewOnly?: boolean;
  reviewOnlyReason?: string;
  kind?: string;
  agent: string;
  /** The model of its current try. Empty for the agent's own default model. */
  model: string;
  effort?: string;
  tier?: Tier;
  /** Why its model is not the routing table's: the tier has no installed model. */
  modelNote?: string;
  /** The plan's own choice; the run's `workerMode` when absent. */
  permissionMode?: string;
  readsUntrusted: boolean;
  estimate?: RunEstimate;
  attempts: number;
  /** Every try, oldest first; the last is the current one. */
  tries?: PieceTry[];
  /** What its tries cost so far; `null` before any cost was read. */
  costUsd?: number | null;
  costUnpricedModels?: string[];
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
  /** The most tries a piece gets, the first included. */
  maxTries?: number;
  /** What the run's workers cost so far; `null` before any cost was read. */
  costUsd?: number | null;
  costUnpricedModels?: string[];
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
  /** What proves the piece done, in order: at least one, a command among them unless `reviewOnly`. */
  doneChecks: RunCheck[];
  /** No command can prove this piece: review alone checks it, for the reason given. */
  reviewOnly?: boolean;
  reviewOnlyReason?: string;
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
  /** The rows of the routing table changed for the app; absent when none is. */
  routing?: RoutingRows;
  projects: Record<string, ProjectOrchestratorSettings>;
}

/** What holds for runs in one project: its own answers, the app's where it gave none. */
export interface OrchestratorLimits {
  requireApproval: boolean;
  pieceLimit: number;
  workerMode: string;
  routing: RoutingTable;
}

export interface ProjectOrchestratorSettings {
  requireApproval?: boolean;
  pieceLimit?: number;
  workerMode?: string;
  /** The project's own rows of the routing table. */
  routing?: RoutingRows;
}

/** One change. With `project`, that project's own answer; `null` there follows the app again. */
export interface OrchestratorPatch {
  project?: string;
  requireApproval?: boolean | null;
  pieceLimit?: number | null;
  workerMode?: string | null;
  /** Cells to change. `null` takes a cell's override away: it follows the app (for a project) or the built-in table. */
  routing?: Partial<Record<PieceKind, Partial<Record<RoutedAgent, Route | null>>>>;
  /** Take every override away first. */
  resetRouting?: boolean;
}
