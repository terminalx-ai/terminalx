/** An orchestration run (PRO-274): one lead session, a plan of pieces, a worker per piece.
 * Mirrors `src-tauri/src/orchestration/mod.rs`, as `engine::shown` sends it. */

export type RunState = "planned" | "awaitingApproval" | "running" | "needsYou" | "verifying" | "merging" | "done" | "stopped" | "failed";
export type PieceState = "queued" | "running" | "stalled" | "verifying" | "done" | "blocked" | "failed" | "stopped";
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

/** One of the checks a result goes through, in the order they run (`verify::Gate`). Only `review` uses a model. */
export type RunGate = "report" | "scope" | "branch" | "commands" | "review";

/** One command of the command gate, as TerminalX ran it in the worker's worktree. */
export interface CommandRun {
  run: string;
  /** The project's own check command, not one the plan wrote. */
  project?: boolean;
  /** Absent when it was stopped at its deadline or could not be started. */
  exitCode?: number;
  passed: boolean;
  millis: number;
  /** The last 100 lines it printed, kept for one that failed. */
  output?: string;
}

export interface GateResult {
  gate: RunGate;
  passed: boolean;
  /** One line on a pass; what failed, as the next try reads it, on a failure. */
  detail?: string;
  commands?: CommandRun[];
}

export interface VerifierTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
}

/** One verifier session: a conversation in the worker's worktree that reads the diff and cannot edit. */
export interface RunVerifier {
  session?: RunSessionRef;
  model: string;
  effort?: string;
  verdict?: "pass" | "fail";
  /** `file:line: what is wrong`, for a fail. */
  evidence?: string[];
  /** Why it gave no verdict. */
  problem?: string;
  tokens?: VerifierTokens;
}

/** The model step of a check: who was asked, why, and what they said. */
export interface RunReview {
  reasons: string[];
  voters: number;
  threshold: number;
  verifiers: RunVerifier[];
  promptChars: number;
}

/** How one try's result was checked (`verify::Verification`): the gates that ran, in order, a failure last. */
export interface RunVerification {
  gates: GateResult[];
  facts?: { files: string[]; changedLines: number; securityAreas?: string[]; /** The piece has commands and TerminalX did not run them unasked. */ commandsNotRun?: boolean; commit?: string };
  review?: RunReview;
  /** Absent while it is under way. */
  outcome?: "passed" | "failed" | "inconclusive";
  failure?: string;
  started?: string;
  ended?: string;
}

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
  /** How its result was checked; absent before its worker reported. */
  verification?: RunVerification;
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
  /** The plan named no model: the one here is its kind's. */
  modelByKind?: boolean;
  /** The plan named no effort: the one here is its kind's. */
  effortByKind?: boolean;
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
  /** How its worker's agent was signed in when it started. */
  login?: "apiKey" | "subscription";
  /** It was asked for, but a limit holds it. */
  queuedFor?: RunHold;
  state: PieceState;
  note?: string;
  /** What came of merging its accepted result; absent before that was tried. */
  merge?: PieceMerge;
}

/** What came of bringing a piece's accepted result into the lead's branch (`orchestration::MergeState`). */
export type MergeState = "merged" | "nothingToMerge" | "conflict" | "integrationFailed" | "skipped" | "failed";

/** One file a merge conflicts in. */
export interface ConflictFile {
  path: string;
  /** How many places in it conflict; 0 when the conflict is not in its lines. */
  hunks: number;
  /** The first conflicting place, both sides, as git marks it. */
  excerpt?: string;
  /** The line of the merged file the excerpt starts at. */
  line?: number;
  /** The pieces already merged that changed this file. */
  with?: string[];
  /** The piece the plan gives this file to, when it is not this one. */
  owner?: string;
}

/** The last try at merging a piece's accepted result. */
export interface PieceMerge {
  state: MergeState;
  /** The accepted commit that was merged, or that the merge was tried with. */
  commit: string;
  /** Where the lead's branch was before; after a conflict or a failed check it is there still. */
  before: string;
  /** The merge commit, for a piece TerminalX merged. */
  after?: string;
  /** The lead merged it itself. */
  byHand?: boolean;
  files?: ConflictFile[];
  /** The integration check as it ran on the merged result. */
  check?: CommandRun;
  note?: string;
  at: string;
}

/** Where the merge of a run stands. */
export interface RunMerge {
  /** The lead's branch. */
  into: string;
  /** A merge whose integration check has not ended. */
  pending?: { piece: string; before: string; after?: string };
  /** The piece the last pass stopped at. */
  stoppedAt?: string;
  checkedHead?: string;
  /** The integration check on the whole merged result, when it failed there. */
  check?: CommandRun;
  /** Every piece's command done-checks, run again once all were merged. */
  finalChecks?: (CommandRun & { piece: string })[];
  finalHead?: string;
  at?: string;
  /** The lead is resolving a conflict a person gave it: a model call the run's budget counts. */
  resolving?: { piece: string; login: "apiKey" | "subscription"; leadUsd?: number; usd?: number };
  /** What earlier such calls cost a lead on an API key. */
  resolvedUsd?: number;
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
  /** The command run in the lead's checkout after each piece is merged; the project's own check when absent. */
  integrationCheck?: string;
  /** Where merging the pieces into the lead's branch stands; absent before the first merge. */
  merge?: RunMerge;
  /** The pieces in the order they are merged. */
  mergeOrder?: string[];
  /** A pass is merging the pieces now. */
  mergeUnderWay?: boolean;
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
  /** The most tries a piece gets, the first included. */
  maxTries?: number;
  /** What the run's workers cost so far; `null` before any cost was read. */
  costUsd?: number | null;
  costUnpricedModels?: string[];
  /** What every verifier session used, apart from the workers; `null` when none was asked. */
  verifierTokens?: number | null;
}

/** A plan as `runs create` reads it, and as Edit saves it. */
export interface RunPlan {
  goal: string;
  budget: RunBudget;
  /** The command TerminalX runs after it merges each accepted piece. */
  integrationCheck?: string;
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
  workersPerRun: number;
  workersAtOnce: number;
  budgetDollars: number;
  budgetPoints: number;
  windowCeiling: number;
  stallMinutes: number;
  /** Over how many changed lines a result is read by a verifier though its commands pass. */
  reviewDiffLines: number;
  /** The rows of the routing table changed for the app; absent when none is. */
  routing?: RoutingRows;
  projects: Record<string, ProjectOrchestratorSettings>;
}

/** What holds for runs in one project: its own answers, the app's where it gave none. */
export interface OrchestratorLimits {
  requireApproval: boolean;
  pieceLimit: number;
  workerMode: string;
  workersPerRun: number;
  workersAtOnce: number;
  budgetDollars: number;
  budgetPoints: number;
  windowCeiling: number;
  stallMinutes: number;
  reviewDiffLines: number;
  routing: RoutingTable;
}

export interface ProjectOrchestratorSettings {
  requireApproval?: boolean;
  pieceLimit?: number;
  workerMode?: string;
  budgetDollars?: number;
  budgetPoints?: number;
  windowCeiling?: number;
  reviewDiffLines?: number;
  /** The project's own rows of the routing table. */
  routing?: RoutingRows;
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
  reviewDiffLines?: number | null;
  /** Cells to change. `null` takes a cell's override away: it follows the app (for a project) or the built-in table. */
  routing?: Partial<Record<PieceKind, Partial<Record<RoutedAgent, Route | null>>>>;
  /** Take every override away first. */
  resetRouting?: boolean;
}
