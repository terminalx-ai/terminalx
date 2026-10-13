import type { IssueRef } from "@/types/session";

/** The five stages a session started from an issue goes through. */
export type PipelineStage = "work" | "pullRequest" | "review" | "address" | "merge";
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
  issue: IssueRef;
  /** The branch the pull request is opened from. */
  branch: string;
  author: PipelineSessionRef;
  /** Never the author's session. */
  reviewer?: PipelineSessionRef | null;
  /** "Merge automatically when the review is addressed", for this issue. */
  autoMerge: boolean;
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
  securityAreas: string[];
  merged?: { commit: string; at: string; by: "pipeline" | "person" | "elsewhere" } | null;
  events: PipelineEvent[];
  created: string;
  modified: string;
}

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
  /** A person merges whatever the switch says. */
  requirePerson: boolean;
  maxRounds: number;
  mergeMethod: "merge" | "squash" | "rebase";
  protected: { migrations: boolean; deploy: boolean; security: boolean; paths: string[] };
  /** Checks that never hold a merge, by a part of their name. */
  ignoredChecks: string[];
}
