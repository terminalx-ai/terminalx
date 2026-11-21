export type ScheduleKind = "preset" | "cron";
export type SchedulePreset = "hourly" | "daily" | "weekdays" | "weekly";

export interface AutomationSchedule {
  kind: ScheduleKind;
  preset?: SchedulePreset;
  cron?: string;
  hour?: number;
  minute?: number;
  weekdays: string[];
  timezone: string;
  dtstart: string;
}

export type AutomationWorkspace = "newWorktree" | "session";

export interface AutomationPrecheck {
  command: string;
  timeoutSeconds: number;
}

export interface AutomationFailureReport {
  comment: boolean;
  addLabels: string[];
}

export interface AutomationIssueReport {
  comment: boolean;
  addLabels: string[];
  removeLabels: string[];
  openPr: boolean;
  onFailure: AutomationFailureReport;
}

export interface AutomationIssueTrigger {
  provider: "github";
  repo: string;
  query: string;
  pollIntervalMinutes: number;
  maxRunsPerTick: number;
  runOnExisting: boolean;
  report: AutomationIssueReport;
}

export type PullRequestEvent = "opened" | "pushed" | "reviewRequested" | "checkFailed";

export interface LinearIssueReport {
  comment: boolean;
  moveToStateId?: string | null;
  moveToStateName?: string | null;
  commentOnFailure: boolean;
}

/** A Linear team's issues, optionally narrowed. */
export interface LinearIssueSource {
  kind: "linearIssue";
  teamId: string;
  teamName?: string | null;
  /** `open` (the default), `all`, or a Linear workflow state type. */
  state?: string | null;
  /** Issues with any of these labels. */
  labels: string[];
  /** `me`, `unassigned`, or a Linear user id. */
  assignee?: string | null;
  text?: string | null;
  report: LinearIssueReport;
}

/** Pull request events in the automation's repository, read with `gh`. */
export interface PullRequestSource {
  kind: "githubPullRequest";
  repo: string;
  events: PullRequestEvent[];
  base?: string | null;
  author?: string | null;
  /** Pull requests with all of these labels. */
  labels: string[];
  /** Only drafts (true), only ready ones (false), or either. */
  draft?: boolean | null;
  /** Also wake on pull requests from forks: anyone can open one. Off by default. */
  fromForks?: boolean;
}

/** Open to more kinds later (another bot's event, a watched file, a webhook). */
export type AutomationEventSource = LinearIssueSource | PullRequestSource;

export interface AutomationEventTrigger {
  source: AutomationEventSource;
  pollIntervalMinutes: number;
  maxRunsPerTick: number;
  /** The most runs the automation starts in any 24 hours, across everything it wakes on (PRO-490). Read as 48 when absent. */
  maxRunsPerDay?: number;
}

/** One thing an event source would wake on now. */
export interface SourceMatch {
  id: string;
  identifier: string;
  title: string;
  url: string;
  detail: string;
}

export type AutomationRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timedOut"
  | "skippedPrecheck"
  | "skippedMissed"
  | "skippedUnavailable";

export interface Automation {
  pipeline?: import("@/lib/pipelineLaunch").PipelineLaunch | null;
  id: string;
  name: string;
  enabled: boolean;
  projectPath: string;
  harness: string;
  model: string;
  effort?: string | null;
  mode: string;
  prompt: string;
  workspace: AutomationWorkspace;
  sessionId?: string | null;
  reuseSession: boolean;
  /** Archive a run's session when the run completes. A failed run, a stopped one and one waiting on a person stay in the sidebar. */
  archiveOnComplete: boolean;
  /** With archiveOnComplete: the newest completed run's session stays in the sidebar; the one it replaces is archived. */
  keepLatestRunVisible: boolean;
  baseRef?: string | null;
  schedule: AutomationSchedule;
  precheck?: AutomationPrecheck | null;
  missedRunGraceMinutes: number;
  runTimeoutMinutes?: number | null;
  nextRunAt: string;
  lastRunAt?: string | null;
  lastOutcome?: AutomationRunStatus | null;
  issueTrigger?: AutomationIssueTrigger | null;
  /** A Linear issue or pull request source; never set with issueTrigger. */
  eventTrigger?: AutomationEventTrigger | null;
  /** A bot's duty (PRO-471): listed on its bot's Duties tab, not on the Automations page. */
  bot?: import("@/types/botDuties").DutyOwner | null;
  created: string;
  modified: string;
}

export type AutomationInput = Omit<
  Automation,
  "id" | "nextRunAt" | "lastRunAt" | "lastOutcome" | "created" | "modified" | "bot"
>;

export type AutomationTrigger = "scheduled" | "manual" | "issue" | "linearIssue" | "pullRequest";

/** The pull request event a run was woken by. */
export interface AutomationRunPullRequest {
  number: number;
  title: string;
  url: string;
  head: string;
  headSha: string;
  base: string;
  event: PullRequestEvent;
}

export interface AutomationUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheTokens?: number | null;
  model: string;
}

export interface AutomationPrecheckResult {
  exitCode?: number | null;
  stdoutTail: string;
  stderrTail: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

/** What a run does after its first check: skip, go ahead, or fail. */
export type PrecheckOutcome = "nothingNew" | "proceed" | "failed";

/** One try of a first check from the editor. Nothing is recorded. */
export interface PrecheckTrial {
  outcome: PrecheckOutcome;
  reason?: string | null;
  result: AutomationPrecheckResult;
}

export interface PrecheckTryInput {
  projectPath: string;
  workspace: AutomationWorkspace;
  sessionId?: string | null;
  precheck: AutomationPrecheck;
}

export interface AutomationRun {
  runId: string;
  runNumber: number;
  automationId: string;
  trigger: AutomationTrigger;
  scheduledFor?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  status: AutomationRunStatus;
  sessionId?: string | null;
  tabId?: string | null;
  worktreeName?: string | null;
  issue?: AutomationIssueRef | null;
  pullRequest?: AutomationRunPullRequest | null;
  finalMessage?: string | null;
  changedFiles?: number | null;
  usage?: AutomationUsage | null;
  precheck?: AutomationPrecheckResult | null;
  error?: string | null;
  reported?: AutomationReported | null;
  repeatCount: number;
  lastRepeatAt?: string | null;
  /** A duty's run: what its reply reported, and to whom (PRO-471). */
  duty?: import("@/types/botDuties").DutyRunReport | null;
}

export interface AutomationIssueRef {
  provider: string;
  id: string;
  identifier: string;
  title: string;
  url: string;
}

export interface AutomationReported {
  comment?: string | null;
  labels?: string[];
  prUrl?: string | null;
}

export interface AutomationIssueState {
  automationId: string;
  lastPolledAt?: string | null;
  lastPollError?: string | null;
  /** Something to know that is not a failure to read. */
  notice?: string | null;
}

export interface AutomationRef {
  id: string;
  name: string;
  runId: string;
  runNumber: number;
}
