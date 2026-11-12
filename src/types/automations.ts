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
  created: string;
  modified: string;
}

export type AutomationInput = Omit<
  Automation,
  "id" | "nextRunAt" | "lastRunAt" | "lastOutcome" | "created" | "modified"
>;

export type AutomationTrigger = "scheduled" | "manual" | "issue";

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
  finalMessage?: string | null;
  changedFiles?: number | null;
  usage?: AutomationUsage | null;
  precheck?: AutomationPrecheckResult | null;
  error?: string | null;
  reported?: AutomationReported | null;
  repeatCount: number;
  lastRepeatAt?: string | null;
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
}

export interface AutomationRef {
  id: string;
  name: string;
  runId: string;
  runNumber: number;
}
