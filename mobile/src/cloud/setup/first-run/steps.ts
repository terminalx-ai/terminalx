import type { CloudApiError, CloudCredential, CloudOrganization, CloudProvider } from "../../api";
import { organizationRoleName } from "../../words";
import type { SetupStepState } from "../../../ui/SetupSteps";
import { AGENT_LOGINS } from "../logins/agents";
import * as W from "./words";

/**
 * The four steps of setting up cloud workspaces (25.01), decided from what
 * the server answered and nothing else: the organization list, the
 * organization's providers and its agent logins. Nothing here is kept on the
 * phone, so a person who stops half-way comes back to the step they left.
 * A list that could not be read leaves its step "Could not be read", never
 * done or missing on a guess.
 */

/** One read as the steps use it: not answered yet, answered, or failed (keeping what was read before, if anything was). */
export type Part<T> =
  | { state: "reading"; value: null; error: null }
  | { state: "read"; value: T; error: null }
  | { state: "failed"; value: T | null; error: CloudApiError };

/** A member is not asked for the agent logins: the server keeps them for owners and admins. */
export type LoginsPart = Part<CloudCredential[]> | { state: "not-asked"; value: null; error: null };

export interface OrganizationReads {
  providers: Part<CloudProvider[]>;
  logins: LoginsPart;
}

export const READING = { state: "reading", value: null, error: null } as const;
export const NOT_ASKED = { state: "not-asked", value: null, error: null } as const;

/** Owners and admins connect compute and agent logins; anyone else is a member here. A personal organization is its owner's. */
export function managesSetup(organization: Pick<CloudOrganization, "role" | "isPersonal">): boolean {
  return organization.isPersonal === true || organization.role === "owner" || organization.role === "admin";
}

const query = (orgId: string) => `orgId=${encodeURIComponent(orgId)}`;
export const hrefs = {
  chooser: (orgId: string | null) => (orgId ? `/cloud/setup/organization?${query(orgId)}` : "/cloud/setup/organization"),
  newOrganization: "/cloud/setup/new-organization",
  compute: (orgId: string) => `/cloud/compute?${query(orgId)}`,
  provider: (orgId: string, providerId: string) => `/cloud/compute/${encodeURIComponent(providerId)}?${query(orgId)}`,
  logins: (orgId: string) => `/cloud/logins?${query(orgId)}`,
  launch: (orgId: string) => `/cloud/launch?${query(orgId)}`,
};

/** Where the organization's compute stands, by its provider list. */
export type ComputeStanding =
  | { kind: "done"; detail: string }
  | { kind: "attention"; provider: CloudProvider }
  | { kind: "missing" };

/**
 * Step 2 is done once one provider is connected or ready to use. A key that
 * is connected and working comes first; then a stored key that stopped
 * working, which is something to fix; then a provider with nothing to
 * connect that the server offers as it is.
 */
export function computeStanding(providers: readonly CloudProvider[]): ComputeStanding {
  const usable = providers.filter((provider) => provider.availability === "available");
  const keyed = usable.filter((provider) => provider.descriptor.credentialFields.length > 0);
  if (keyed.length) return { kind: "done", detail: W.connected(keyed.map((provider) => provider.displayName)) };
  const attention = providers.find((provider) => provider.availability === "attention-required");
  if (attention) return { kind: "attention", provider: attention };
  if (usable.length) return { kind: "done", detail: W.readyToUse(usable.map((provider) => provider.displayName)) };
  return { kind: "missing" };
}

/** The agents with a working login (Codex, Claude Code, Cursor; GitHub is for repositories), by the names the phone gives them. */
export function connectedAgents(credentials: readonly CloudCredential[]): string[] {
  return AGENT_LOGINS.filter((entry) => entry.section === "agents" && credentials.some((credential) => credential.provider === entry.provider && credential.state === "connected")).map((entry) => entry.name);
}

export interface ShownStep {
  key: "organization" | "compute" | "agents" | "launch";
  title: string;
  detail: string;
  state: SetupStepState;
  alert: boolean;
  /** Where the step opens; null where this person has nothing to do there. */
  href: string | null;
}

export interface SetupModel {
  steps: ShownStep[];
  /** How many of the four are done. */
  done: number;
  /** The button under the card: the step to do next, or the key to fix. */
  action: { label: string; href: string; launch: boolean } | null;
  /** A step's list could not be read and nothing was read before: "Pull down to read it again." */
  unread: boolean;
  /** A list has not answered for the first time yet. */
  reading: boolean;
  /** Step 1 is done: the organization is the one being set up. */
  chosen: boolean;
  /** Something of it is set up already, by the server's lists. */
  progress: boolean;
  /** Launching is the step to do. */
  canLaunch: boolean;
  /** A member, and the organization has no compute yet (the console's sentence). */
  noCompute: boolean;
}

type Standing<T> = { kind: "reading" } | { kind: "unread" } | { kind: "unknown" } | ({ kind: "value" } & T);

/**
 * The steps for one organization, or for an account with none (`organization`
 * null): then step 1 is the one to do, by creating one where the server takes
 * that from the phone.
 *
 * `chosen`: the person picked this organization on the organization page in
 * this run of the app. Otherwise step 1 counts as done once the server's
 * lists show something of it set up.
 */
export function setupModel({ organization, reads, chosen, createsOrganizations }: { organization: CloudOrganization | null; reads: OrganizationReads | null; chosen: boolean; createsOrganizations: boolean }): SetupModel {
  if (!organization) {
    return {
      steps: [
        { key: "organization", title: W.STEP_TITLES.organization, detail: W.ORGANIZATION_DETAIL, state: "next", alert: false, href: createsOrganizations ? hrefs.newOrganization : null },
        { key: "compute", title: W.STEP_TITLES.compute, detail: W.COMPUTE_DETAIL, state: "waiting", alert: false, href: null },
        { key: "agents", title: W.STEP_TITLES.agents, detail: W.AGENTS_DETAIL, state: "waiting", alert: false, href: null },
        { key: "launch", title: W.STEP_TITLES.launch, detail: W.LAUNCH_DETAIL, state: "waiting", alert: false, href: null },
      ],
      done: 0,
      action: createsOrganizations ? { label: W.BUTTONS.start, href: hrefs.newOrganization, launch: false } : null,
      unread: false, reading: false, chosen: false, progress: false, canLaunch: false, noCompute: false,
    };
  }

  const { orgId, name } = organization;
  const admin = managesSetup(organization);
  const providers = reads?.providers ?? READING;
  const logins = reads?.logins ?? READING;

  const compute: Standing<{ standing: ComputeStanding }> = providers.value ? { kind: "value", standing: computeStanding(providers.value) } : providers.state === "failed" ? { kind: "unread" } : { kind: "reading" };
  const agents: Standing<{ names: string[] }> = logins.state === "not-asked" ? { kind: "unknown" }
    : logins.value ? { kind: "value", names: connectedAgents(logins.value) }
    // Refused to someone who does not manage logins: not theirs to see, so neither done nor missing.
    : logins.state === "failed" ? (logins.error.refusal === "admin-required" ? { kind: "unknown" } : { kind: "unread" })
    : { kind: "reading" };

  const computeDone = compute.kind === "value" && compute.standing.kind === "done";
  const attention = compute.kind === "value" && compute.standing.kind === "attention" ? compute.standing.provider : null;
  const agentsDone = agents.kind === "value" && agents.names.length > 0;
  const progress = computeDone || agentsDone;
  const stepOne = chosen || progress;
  // A member may launch once compute is there; their organization's logins are an admin's to see.
  const agentsReady = agentsDone || (agents.kind === "unknown" && !admin);
  const canLaunch = stepOne && computeDone && agentsReady;

  const computeStep: ShownStep = { key: "compute", title: W.STEP_TITLES.compute, detail: W.COMPUTE_DETAIL, state: "waiting", alert: false, href: admin ? hrefs.compute(orgId) : null };
  if (compute.kind === "unread") Object.assign(computeStep, { detail: W.COULD_NOT_BE_READ, state: "failed", alert: true });
  else if (attention) Object.assign(computeStep, { detail: W.keyRejected(attention.displayName), state: "failed", alert: true });
  else if (compute.kind === "value" && compute.standing.kind === "done") Object.assign(computeStep, { detail: compute.standing.detail, state: "done" });
  else if (stepOne && admin && compute.kind === "value") computeStep.state = "next";

  const agentsStep: ShownStep = { key: "agents", title: W.STEP_TITLES.agents, detail: W.AGENTS_DETAIL, state: "waiting", alert: false, href: admin ? hrefs.logins(orgId) : null };
  if (agents.kind === "unread") Object.assign(agentsStep, { detail: W.COULD_NOT_BE_READ, state: "failed", alert: true });
  else if (agents.kind === "value" && agentsDone) Object.assign(agentsStep, { detail: W.connected(agents.names), state: "done" });
  else if (stepOne && admin && computeDone && agents.kind === "value") agentsStep.state = "next";

  const launchStep: ShownStep = { key: "launch", title: W.STEP_TITLES.launch, detail: attention ? W.LAUNCH_WAITS : W.LAUNCH_DETAIL, state: canLaunch ? "next" : "waiting", alert: false, href: canLaunch ? hrefs.launch(orgId) : null };

  const steps: ShownStep[] = [
    { key: "organization", title: W.STEP_TITLES.organization, detail: stepOne ? name : W.organizationDetail(name), state: stepOne ? "done" : "next", alert: false, href: hrefs.chooser(orgId) },
    computeStep,
    agentsStep,
    launchStep,
  ];

  const unread = compute.kind === "unread" || agents.kind === "unread";
  const reading = compute.kind === "reading" || agents.kind === "reading";
  let action: SetupModel["action"] = null;
  if (!reading && !unread) {
    if (!stepOne) action = { label: W.BUTTONS.start, href: hrefs.chooser(orgId), launch: false };
    else if (attention && admin) action = { label: W.BUTTONS.fixKey, href: hrefs.provider(orgId, attention.id), launch: false };
    else if (computeStep.state === "next") action = { label: W.BUTTONS.compute, href: hrefs.compute(orgId), launch: false };
    else if (agentsStep.state === "next") action = { label: W.BUTTONS.agents, href: hrefs.logins(orgId), launch: false };
    else if (canLaunch) action = { label: W.BUTTONS.launch, href: hrefs.launch(orgId), launch: true };
  }

  return {
    steps,
    done: steps.filter((step) => step.state === "done").length,
    action,
    unread,
    reading,
    chosen: stepOne,
    progress,
    canLaunch,
    noCompute: !admin && compute.kind === "value" && compute.standing.kind !== "done",
  };
}

/**
 * Under each organization's name on the organization page (25.02): the
 * person's role, and how far its setup is. A personal organization that is
 * the only one says what it is instead.
 */
export function choiceDetail(organization: CloudOrganization, reads: OrganizationReads | null, alone: boolean): string {
  if (alone && organization.isPersonal) return W.PERSONAL_ALONE;
  const parts = [organization.isPersonal ? W.PERSONAL : null, organizationRoleName(organization.role)];
  const providers = reads?.providers.value;
  const computeDone = providers ? computeStanding(providers).kind === "done" : false;
  if (computeDone) parts.push(W.COMPUTE_CONNECTED);
  else if (providers && !managesSetup(organization)) parts.push(W.ADMIN_SETS_UP);
  return parts.filter(Boolean).join(" · ");
}

/** The account's organizations with the personal one first (owner's decision on 25.07), otherwise in the server's order. */
export function personalFirst<T extends { isPersonal?: boolean }>(organizations: readonly T[]): T[] {
  return [...organizations.filter((entry) => entry.isPersonal === true), ...organizations.filter((entry) => entry.isPersonal !== true)];
}

/**
 * The organization the Cloud tab sets up when no organization has a
 * workspace: the one chosen on the organization page in this run, else the
 * first with something set up, else the first (the personal one first).
 */
export function focusOrganization(candidates: readonly CloudOrganization[], chosenId: string | null, progress: (orgId: string) => boolean): CloudOrganization | null {
  const ordered = personalFirst(candidates);
  return ordered.find((entry) => entry.orgId === chosenId) ?? ordered.find((entry) => progress(entry.orgId)) ?? ordered[0] ?? null;
}

/** The organization page's Compute row (25.02): what step 2 holds, or why it is not known. */
export function computeRowDetail(reads: OrganizationReads | null): string | null {
  const providers = reads?.providers;
  if (!providers || providers.state === "reading") return null;
  if (!providers.value) return W.COULD_NOT_BE_READ;
  const standing = computeStanding(providers.value);
  return standing.kind === "done" ? standing.detail : standing.kind === "attention" ? W.keyRejected(standing.provider.displayName) : W.NOT_CONNECTED;
}

/** The organization page's Agent logins row (25.02); nothing for someone the server does not show them to. */
export function loginsRowDetail(reads: OrganizationReads | null): string | null {
  const logins = reads?.logins;
  if (!logins || logins.state === "reading" || logins.state === "not-asked") return null;
  if (!logins.value) return logins.error.refusal === "admin-required" ? null : W.COULD_NOT_BE_READ;
  const names = connectedAgents(logins.value);
  return names.length ? W.connected(names) : W.NOT_CONNECTED;
}
