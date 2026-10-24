import type { IssueRef } from "@/types/session";

/** Work, review, conflict resolution, and merge stages for a Git branch session. */
export type PipelineStage = "work" | "pullRequest" | "review" | "address" | "resolve" | "merge";
export type PipelineState = "working" | "waiting" | "readyToMerge" | "needsYou" | "merged" | "stopped";
export type FindingSeverity = "nit" | "low" | "medium" | "high" | "critical";

export interface PipelineFinding {
  severity: FindingSeverity;
  title: string;
  detail?: string | null;
  file?: string | null;
  line?: number | null;
  /** Raised by the security pass. */
  security: boolean;
}

/** One review of one commit, with the findings still open at it. */
export interface PipelineVerdict {
  commit: string;
  decision: "merge" | "changes";
  securityPass: "notNeeded" | "clean" | "flagged";
  findings: PipelineFinding[];
  round: number;
  at: string;
}

export interface PipelineSessionRef {
  sessionId: string;
  tabId: string;
}

/** One line of the record. */
export interface PipelineEvent {
  at: string;
  stage: PipelineStage;
  kind: string;
  message: string;
  commit?: string | null;
  url?: string | null;
  sessionId?: string | null;
}

/** Why a pipeline is at Ready to merge or Needs you; `note` says it in words. */
export interface PipelineStopReason {
  kind: string;
  [detail: string]: unknown;
}

export interface IssuePipeline {
  id: string;
  projectPath: string;
  issue?: IssueRef | null;
  /** The branch the pull request is opened from. */
  branch: string;
  author: PipelineSessionRef;
  /** Never the author's session. */
  reviewer?: PipelineSessionRef | null;
  /** "Merge automatically when the review is addressed", for this issue. Never on in a cloud workspace. */
  autoMerge: boolean;
  resolveConflicts?: boolean;
  resolutions?: number;
  /** Carried by a cloud workspace's runtime, which stops at Ready to merge: the merge is made here, with the reader's own `gh`. */
  cloud?: boolean;
  /** Where a cloud workspace's pipeline is, as this desktop placed it; absent for one on this computer. */
  place?: CloudPipelinePlace | null;
  stopped: boolean;
  stage: PipelineStage;
  state: PipelineState;
  reason?: PipelineStopReason | null;
  /** What it is doing, waiting for, or stopped on, in a sentence. */
  note?: string | null;
  pr?: { number: number; url: string; base: string } | null;
  round: number;
  maxRounds: number;
  reviewCommit?: string | null;
  verdict?: PipelineVerdict | null;
  /** Author-reported local failures, pinned to commits until explicitly passed. */
  failedLocalChecks?: string[];
  localCheck?: { head: string; command: string } | null;
  checkingLocally?: boolean;
  securityAreas: string[];
  merged?: { commit: string; at: string; by: "pipeline" | "person" | "elsewhere" } | null;
  events: PipelineEvent[];
  created: string;
  modified: string;
}

/**
 * A cloud workspace's pipeline as this desktop shows it: under the cloud
 * project its workspace belongs to (`projectPath` is that project's key, and
 * the sessions it names are cloud session keys).
 */
export interface CloudPipelinePlace {
  orgId: string;
  workspaceId: string;
  /** The cloud project's key, `cloud:<orgId>:<identity>`. */
  projectKey: string;
  /** The project's repository, `owner/name`: a pull request anywhere else is never merged. Null for a project without one. */
  repository: string | null;
  /** When the runtime last said this, in ms. */
  readAt: number;
}

/** How merging a cloud workspace's pull request from this computer ended. */
export type CloudMerge =
  | { outcome: "merged"; commit: string }
  /** GitHub took it into a merge queue. */
  | { outcome: "accepted"; commit: string }
  /** Someone merged it already. */
  | { outcome: "alreadyMerged"; commit: string }
  | { outcome: "notMerged"; reason: string };

/** What a person can do to a pipeline from the issue page. */
export type PipelineAction = "stop" | "resume" | "advance" | "review" | "merge" | "refresh";

export interface StartedIssuePipeline {
  pipeline: IssuePipeline;
  /** Added to the author's first prompt: how the work is handed over. */
  authorBrief: string;
}

/** A project's issue pipeline; stored with the project by the Rust side. */
export interface IssuePipelineSettings {
  enabled: boolean;
  /** What the issue's own switch starts at. */
  autoMerge: boolean;
  resolveConflicts?: boolean;
  maxResolutions?: number;
  /** A person merges whatever the switch says. */
  requirePerson: boolean;
  maxRounds: number;
  mergeMethod: "merge" | "squash" | "rebase";
  protected: { migrations: boolean; deploy: boolean; security: boolean; paths: string[] };
  /** Checks that never hold a merge, by a part of their name. */
  ignoredChecks: string[];
  /** Explicit opt-in for repositories without CI; does not bypass reported validation. */
  allowNoCi?: boolean;
  localCheckCommand?: string | null;
  localChecksOnly?: boolean;
}
