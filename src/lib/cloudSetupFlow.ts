// The full-window cloud setup (PRO-370): six steps from creating an
// organization to inviting its team, then the setup check. Where the person
// is in it is kept on the organization's setup record (see
// organizationSetup.ts), so "Finish later" resumes at the same step from
// that organization's row in Settings → Organizations.
//
// The record's `step` is what the server facts say (reconcileSetup); the
// flow's step is where the person chose to be. They are kept apart: the
// person may go on from a step that can wait (GitHub, compute, logins) and
// the facts still say it is not done.

import type { OrganizationSetupRecord } from "@/lib/organizationSetup";

export const FLOW_STEPS = ["organization", "github", "compute", "logins", "environment", "invite"] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

export const FLOW_LABELS: Record<FlowStep, string> = {
  organization: "Organization",
  github: "GitHub",
  compute: "Compute",
  logins: "Agent logins",
  environment: "Environment",
  invite: "Invite team",
};

/** Where the person is in the flow, and the steps they went on from. */
export interface FlowProgress {
  step: FlowStep;
  passed: FlowStep[];
  /** Set by "Finish and open the setup check". */
  finishedAt: number | null;
}

export const isFlowStep = (value: unknown): value is FlowStep => typeof value === "string" && (FLOW_STEPS as readonly string[]).includes(value);

/** The record's flow progress, read defensively: a stored value of another shape is ignored, not guessed at. */
export function flowOf(record: OrganizationSetupRecord | null | undefined): FlowProgress | null {
  const flow = record?.flow;
  if (!flow || typeof flow !== "object" || !isFlowStep(flow.step)) return null;
  const passed = Array.isArray(flow.passed) ? flow.passed.filter(isFlowStep) : [];
  return { step: flow.step, passed, finishedAt: typeof flow.finishedAt === "number" ? flow.finishedAt : null };
}

/** An organization whose flow was started here and not finished: its row offers "Finish setting up". */
export function unfinishedFlow(record: OrganizationSetupRecord | null | undefined): boolean {
  const flow = flowOf(record);
  return Boolean(record?.organizationId && flow && flow.finishedAt === null);
}

/** The record moved to `step`, the step it leaves counted as passed when the person goes forward. */
export function moveFlow(record: OrganizationSetupRecord, step: FlowStep): OrganizationSetupRecord {
  const flow = flowOf(record) ?? { step: "organization", passed: [], finishedAt: null };
  const from = flow.step;
  const forward = FLOW_STEPS.indexOf(step) > FLOW_STEPS.indexOf(from);
  const passed = forward && !flow.passed.includes(from) ? [...flow.passed, from] : flow.passed;
  return { ...record, flow: { ...flow, step, passed } };
}

export function finishFlow(record: OrganizationSetupRecord, now = Date.now()): OrganizationSetupRecord {
  const flow = flowOf(record) ?? { step: "invite", passed: [], finishedAt: null };
  const passed = flow.passed.includes(flow.step) ? flow.passed : [...flow.passed, flow.step];
  return { ...record, flow: { ...flow, passed, finishedAt: now } };
}

// ---- opening the flow

const OPEN_CLOUD_SETUP = "terminalx:open-cloud-setup";

/** What the flow opens on: a new organization, or an existing one's setup where it was left. */
export type CloudSetupTarget = { kind: "create" } | { kind: "resume"; organizationId: string };

export function openCloudSetup(target: CloudSetupTarget): void {
  window.dispatchEvent(new CustomEvent<CloudSetupTarget>(OPEN_CLOUD_SETUP, { detail: target }));
}

export function onOpenCloudSetup(listener: (target: CloudSetupTarget) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<CloudSetupTarget>).detail);
  window.addEventListener(OPEN_CLOUD_SETUP, handler);
  return () => window.removeEventListener(OPEN_CLOUD_SETUP, handler);
}
