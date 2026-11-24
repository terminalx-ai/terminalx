import { api, experimental, type AccountStatus, type CloudWorkspaceProviderId, type CloudWorkspaceQuota, type CloudWorkspaceQuote, type CloudWorkspaceSetup, type CloudWorkspaceSnapshot } from "@/lib/api";
import { getAccount } from "@/lib/account";
import { isMultiOrg } from "@/lib/multiOrg";
import { getCloudAgents, newCloudAgentTab } from "@/lib/cloudAgents";
import { takeStartedPipeline } from "@/lib/cloudPipelines";
import { cloudOrgArg, defaultOrgId, findCloudWorkspace, getCloudCatalog, isChanging, rememberCreatedWorkspace, subscribeCloudCatalog } from "@/lib/cloudCatalog";
import {
  CreateRefused,
  PROVIDER_CREATION_PAUSED,
  REAUTH_REQUIRED,
  SERVER_CREATION_DISABLED,
  listedNames,
  createWorkspace,
  personLaunchInput,
  phaseOf,
  preflightCreate,
  repositoriesInput,
  savePending,
  validateForm,
  type CreateForm,
  type PendingCreate,
} from "@/lib/cloudCreate";
import { creatableProviders, noProviderRefusal } from "@/lib/hiddenProviders";
import { cloudProviderDescriptor, cloudProviderLabel, cloudProviderOffered, orderedCloudProviderIds, orderedCloudProviders } from "@/lib/cloudProviders";
import type { RuntimeIssuePipeline, RuntimeIssueRef, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { IssuePipelineSettings } from "@/types/issuePipeline";
import { normalizeRepositoryIdentity } from "@terminalx/portable/repositoryIdentity";
import { retainCloudConnection, waitCloudConnected, wakeCloudConnection, type CloudLease } from "@/lib/cloudConnections";
import { archiving, deletion, isOpen } from "@/lib/cloudLifecycle";
import { bootCloudSessions, cloudAgentRan, refreshCloudSessions } from "@/lib/cloudSessions";
import { resolveCloudAttention } from "@/lib/cloudAttention";
import { atLimit } from "@/lib/runningLimit";
import { idleSuspendChoices } from "@/lib/idleSuspend";
import { getSessionStore, selectCloudSession } from "@/lib/sessions";
import { cloudSessionKey, type CloudProject, type CloudWorkspaceNode } from "@/types/target";

/**
 * Starting a session in a cloud project (PRO-23 CS-13, the project row's `+`).
 * Sessions are cheap and a workspace is a VM, so Start picks, in order:
 *
 * 1. the project's most recently active running workspace (reuse);
 * 2. one that is starting or resuming, or else a stopped one (one wake);
 * 3. none: a new workspace, only after a cost confirmation that shows the
 *    quota. Its launch intent carries the first prompt; the session it
 *    starts is selected once the runtime names it.
 *
 * In an existing workspace the runtime's `session.create` makes the session,
 * with its own worktree when the local preference asks for one.
 */

export interface CloudSessionRequest {
  pipeline?: import("@/lib/pipelineLaunch").PipelineLaunch;
  pipelineSettings?: IssuePipelineSettings;
  agent: string;
  model: string;
  effort: string | null;
  mode: string;
  prompt: string;
  useWorktree: boolean;
  /** The session's title; the prompt's first line otherwise. */
  title?: string;
  /** Started from an issue (#433): named after it, and carried on to a pull request unless `pipeline` is false. */
  issue?: CloudIssueStart;
  /** A new workspace's idle window, 0 for never (PRO-410); absent or null takes the provider's default. Unused when a workspace is reused. */
  idleSuspendMinutes?: number | null;
}

/** What starting a cloud session from an issue adds, sent only to a runtime that granted `pipeline/1`. */
export interface CloudIssueStart {
  ref: RuntimeIssueRef;
  /** The issue as read here, for the reviewer: the workspace cannot read the tracker. */
  body: string | null;
  worktreeName: string;
  pipeline: boolean;
  settings: IssuePipelineSettings;
}

/** What became of an issue's pipeline when its session started in a workspace. */
export interface CloudIssueOutcome {
  /** The runtime carries issues on (`pipeline/1`); an older one started a plain session. */
  supported: boolean;
  pipeline: RuntimeIssuePipeline | null;
  /** Why the runtime started no pipeline. */
  note: string | null;
}

export type CloudStartPlan = { kind: "reuse" | "wake"; node: CloudWorkspaceNode; repository: { identity: string; directory: string | null } | null } | { kind: "create" };

function usable(node: CloudWorkspaceNode): boolean {
  const { item } = node;
  // A preparation workspace (PRO-20) does one job and is stopped for good after an hour: never a home for another session.
  if (item.workspace.preparation) return false;
  // A failed first prompt stops being in the way once an agent has run there (#499): like a local checkout, the
  // workspace then takes the next session. The same rule decides whether it can be opened (`workspaceOpenable`).
  return !deletion(item) && !archiving(item) && !resolveCloudAttention(item, { agentRan: cloudAgentRan(item) });
}

/**
 * Whether this person manages the workspace, which is what adding a session
 * to it (and resuming it) takes: an owner or admin for any workspace, a
 * member for the ones they created (PRO-73). The list's role says so; a
 * server that reports no role says it by the attachment it would grant.
 */
function manages(node: CloudWorkspaceNode): boolean {
  const { workspace } = node.item;
  return workspace.you ? workspace.you.role === "manager" : workspace.authority !== "participate";
}

/**
 * Where Start runs a new session of this project. Workspaces are already
 * ordered by last activity. Only one this person manages is reused or woken:
 * a member's new session never lands in, or starts, someone else's
 * workspace; with none of their own it creates one.
 */
export function planCloudStart(project: CloudProject): CloudStartPlan {
  const candidates = project.workspaces.filter((node) => usable(node) && manages(node));
  const target = (kind: "reuse" | "wake", node: CloudWorkspaceNode): CloudStartPlan => {
    const advertised = project.selected ? node.item.workspace.repositories?.find((repository) => repository.fullName != null && normalizeRepositoryIdentity(repository.identity) === project.identity) : undefined;
    return { kind, node, repository: project.blank ? null : { identity: project.identity, directory: advertised?.targetDirectory ?? null } };
  };
  // A reconciled launch can be recovered before the server leaves attention-required.
  // `usable` has already ruled out any attention that still needs recovery.
  const runningState = (node: CloudWorkspaceNode) => ["ready", "attention-required"].includes(node.item.workspace.state);
  const running = candidates.find((node) => runningState(node) && !isChanging(node.item));
  if (running) return target("reuse", running);
  // Starting or resuming: waiting on it costs nothing more than it already does.
  const coming = candidates.find((node) => node.item.workspace.state === "provisioning" || (runningState(node) && isChanging(node.item)) || (node.item.workspace.state === "suspended" && isOpen(node.item.latestOperation)));
  if (coming) return target("wake", coming);
  const stopped = candidates.find((node) => node.item.workspace.state === "suspended");
  if (stopped) return target("wake", stopped);
  return { kind: "create" };
}

/** The session's title: the prompt's first line, as local sessions do. */
export function titleOf(prompt: string): string {
  return prompt.trim().split("\n")[0].slice(0, 60);
}

const WAKE_WITHIN_MS = 5 * 60 * 1000;

// SaaS standard root and the older persisted-runtime layout. This is only a
// pre-wake compatibility filter: the runtime must enforce its own configured root.
const SESSION_CHECKOUT_ROOTS = ["/var/lib/terminalx/workspace", "/srv/terminalx/state/workspace"];

function checkCheckoutLayout(directory: string): void {
  const parts = directory.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) throw new Error("cloud_repository_checkout_unavailable");
  if (!directory.startsWith("/")) return;
  const normalized = "/" + parts.join("/");
  if (!SESSION_CHECKOUT_ROOTS.some((root) => normalized === root || normalized.startsWith(root + "/")))
    throw new Error("cloud_repository_checkout_scope_unsupported: Environment checkout paths outside the standard workspace scope are not supported for new sessions.");
}

function worktreeRefused(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /not a git|git repository|worktree/i.test(text);
}

/**
 * A new session in an existing workspace: connect (or wake it once), then
 * `session.create`. Returns the new session's key, which is selected.
 */
export async function startInWorkspace(
  plan: Extract<CloudStartPlan, { kind: "reuse" | "wake" }>,
  request: CloudSessionRequest,
  /**
   * `select: false` leaves the window where it is (the CLI starts sessions
   * without moving the reader). `wakeIfStopped` decides what happens when the
   * list said running and the runtime turns out to be stopped: the app's form
   * wakes it (starting a session there is the person's own action); a caller
   * that was not told to wake passes false, or a question to ask first, and
   * gets `cloud_workspace_stopped` instead.
   */
  options: { select?: boolean; wakeIfStopped?: boolean | (() => Promise<boolean>); onIssue?: (outcome: CloudIssueOutcome) => void } = {},
): Promise<string> {
  if (plan.repository && !plan.repository.directory) throw new Error("cloud_repository_checkout_unavailable");
  if (plan.repository?.directory) checkCheckoutLayout(plan.repository.directory);
  bootCloudSessions();
  const { orgId, id: workspaceId } = plan.node.item.workspace;
  const target = { orgId, workspaceId };
  let lease: CloudLease = plan.kind === "reuse" ? await retainCloudConnection(target, "connect") : await wakeCloudConnection(target);
  try {
    // The lease's client of now: the connection is replaced when the workspace stopped and came back.
    let client: WorkspaceRpcClient;
    try {
      client = await waitCloudConnected(lease, WAKE_WITHIN_MS, { stoppedIsError: plan.kind === "reuse" });
    } catch (error) {
      // The list said running, the runtime says stopped: starting a session is an action, so wake it (once).
      if (!(error instanceof Error) || error.message !== "cloud_workspace_stopped") throw error;
      const wake = options.wakeIfStopped ?? true;
      if (!(typeof wake === "function" ? await wake() : wake)) throw error;
      lease.release();
      lease = await wakeCloudConnection(target);
      client = await waitCloudConnected(lease, WAKE_WITHIN_MS);
    }
    const scope = { organizationId: orgId, workspaceId };
    if (plan.repository && !client.hasCapability("session-repository/1")) throw new Error("cloud_repository_session_runtime_update_required");
    // An issue goes only to a runtime that knows what to do with one: an older one would start a plain session silently.
    const issue = request.issue && client.hasCapability("pipeline/1") ? request.issue : null;
    // Settings → Experimental → Native Codex follows the reader into a workspace (#644).
    const nativeCodex = (await experimental.nativeCodexFor(request.agent)) || undefined;
    const params = {
      nativeCodex,
      agent: request.agent,
      model: request.model || undefined,
      effort: request.effort,
      mode: request.mode || undefined,
      title: request.title || titleOf(request.prompt) || undefined,
      prompt: request.prompt.trim() ? request.prompt : undefined,
      useWorktree: request.useWorktree,
      ...(plan.repository ? { repository: { identity: plan.repository.identity, directory: plan.repository.directory! } } : {}),
      ...(request.pipeline?.resolveConflicts ? { pipeline: true, pipelineOptions: { ...request.pipeline, autoMerge: false }, pipelineSettings: request.pipelineSettings as unknown as Record<string, unknown> } : {}),
      ...(issue
        ? { issue: issue.ref, issueBody: issue.body, worktreeName: issue.worktreeName, pipeline: issue.pipeline, pipelineSettings: issue.settings as unknown as Record<string, unknown>,
            ...(issue.pipeline && request.pipeline ? { pipelineOptions: { ...request.pipeline, autoMerge: false } } : {}) }
        : {}),
    };
    let created: Awaited<ReturnType<typeof newCloudAgentTab>>;
    try {
      created = await newCloudAgentTab(scope, client, params);
    } catch (error) {
      // A workspace whose folder has no Git repository cannot cut a worktree; the session works in the folder.
      if (plan.repository || !request.useWorktree || !worktreeRefused(error)) throw error;
      created = await newCloudAgentTab(scope, client, { ...params, useWorktree: false });
    }
    const tabId = created.tabId;
    if (created.pipeline) takeStartedPipeline(target, created.pipeline);
    if (request.issue) options.onIssue?.({ supported: issue != null, pipeline: created.pipeline, note: created.pipelineNote });
    const sessionId = getCloudAgents(scope).tabs.find((tab) => tab.tabId === tabId)?.info.sessionId;
    if (!sessionId) throw new Error("cloud_session_not_created");
    // The list follows `session.sessions` on session/2 runtimes; read it now either way so the row is there.
    void refreshCloudSessions(target, client).catch(() => undefined);
    const key = cloudSessionKey(orgId, workspaceId, sessionId);
    if (options.select !== false) selectCloudSession(key);
    return key;
  } finally {
    lease.release();
  }
}

// ---- a new workspace -------------------------------------------------------

export interface PreparedCreate {
  orgId: string;
  project: CloudProject;
  form: CreateForm;
  pending: PendingCreate;
  quote: CloudWorkspaceQuote;
  /** The organization's workspaces in use, against its limit where it has one; null from an older server. */
  quota: CloudWorkspaceQuota | null;
  providerLabel: string;
}

/** The repository a project's workspaces are built from, as the create takes it. */
function cloneUrlOf(project: CloudProject): string | null {
  const org = getCloudCatalog().orgs[project.orgId];
  const selected = org?.repositories?.find((repository) => repository.cloneUrl && project.identity.endsWith(`/${repository.fullName.toLowerCase()}`));
  if (selected?.cloneUrl) return selected.cloneUrl;
  for (const node of project.workspaces) {
    const listed = node.item.workspace.repositories?.find((repository) => repository.primary) ?? node.item.workspace.repositories?.[0];
    if (listed?.cloneUrl) return listed.cloneUrl;
  }
  return `https://${project.identity}.git`;
}

const PROVIDER_FLAG = /^cloud\.workspaces\.provider\.(.+)\.v1$/;

export function sessionPlacementReady(status: AccountStatus, orgId: string): boolean {
  const features = status.phase2Readiness?.[orgId];
  return status.state === "signed-in" && Array.isArray(features) && features.includes("cloud.workspaces.session-placement.v1");
}

/**
 * The providers an organization's capability flags offer (PRO-69), in their
 * descriptors' order (PRO-415). The app names none: each
 * `cloud.workspaces.provider.<id>.v1` flag that is on is one. The flags reach
 * the webview through the account status, whose map sorts them by key, so
 * their own order says nothing and the descriptors decide.
 */
function offeredByFlags(flags: Record<string, boolean>): CloudWorkspaceProviderId[] {
  return orderedCloudProviderIds(
    Object.entries(flags).flatMap(([flag, on]) => {
      const id = on ? PROVIDER_FLAG.exec(flag)?.[1] : undefined;
      return id ? [id] : [];
    }),
  );
}

export interface CloudPlacementOffer {
  id: CloudWorkspaceProviderId;
  label: string;
  setup: CloudWorkspaceSetup | null;
  error: unknown;
}

/** The active org has a provider list. Other orgs expose their offerings through scoped flags and setup. */
export async function cloudPlacementOffers(orgId: string): Promise<CloudPlacementOffer[]> {
  const status = getAccount().status;
  const org = cloudOrgArg(orgId);
  const readSetup = async (id: string, label: string): Promise<CloudPlacementOffer> => {
    try {
      return { id, label, setup: await api.cloudWorkspaceSetup(id, org), error: null };
    } catch (error) {
      return { id, label, setup: null, error: placementRefusal(error, label) };
    }
  };
  if (orgId === defaultOrgId(status)) {
    const { providers } = await api.cloudProviders();
    return Promise.all(orderedCloudProviders(providers.filter(cloudProviderOffered)).map((provider) =>
      provider.availability === "available"
        ? readSetup(provider.id, cloudProviderLabel(provider))
        : { id: provider.id, label: cloudProviderLabel(provider), setup: null, error: noProviderRefusal([provider]) },
    ));
  }
  const flags = status.organizations?.find((item) => item.id === orgId)?.cloud?.flags ?? {};
  return Promise.all(offeredByFlags(flags)
    .filter((id) => cloudProviderDescriptor(id)?.listed !== false)
    .map((id) => readSetup(id, cloudProviderLabel(id))));
}

function placementRefusal(error: unknown, provider: string): unknown {
  return error && typeof error === "object" && "code" in error && error.code === SERVER_CREATION_DISABLED
    ? new CreateRefused(PROVIDER_CREATION_PAUSED, provider)
    : error;
}

function projectRepositories(project: CloudProject, placement = false): CreateForm["repositories"] {
  if (project.blank) return [];
  const cloneUrl = placement
    ? getCloudCatalog().orgs[project.orgId]?.repositories?.find(
      (repository) => normalizeRepositoryIdentity(repository.cloneUrl) === project.identity,
    )?.cloneUrl ?? `https://${project.identity}.git`
    : cloneUrlOf(project)!;
  return [{ cloneUrl, fullName: project.fullName, ref: "" }];
}

/** A legacy credential check (one without an agent) cannot establish this agent's readiness. */
export async function checkCloudPlacement(project: CloudProject, agent: string): Promise<void> {
  const org = cloudOrgArg(project.orgId);
  if (!project.selected || (!project.blank && !project.identity.startsWith("github.com/"))) {
    throw new Error("Choose a GitHub repository available to this organization.");
  }
  const repositories = projectRepositories(project, true).map(({ cloneUrl }) => ({ cloneUrl, ref: null }));
  const result = await api.cloudWorkspacePreflight(repositories, org, agent);
  const checks = result.checks.filter((check) => check.kind !== "agent-credential" || check.agent === agent);
  const failed = checks.find((check) => check.status === "failed");
  if (failed?.kind === "agent-credential") {
    throw new CreateRefused(failed.errorCode === REAUTH_REQUIRED ? REAUTH_REQUIRED : "cloud_workspace_agent_credential_required", agent);
  }
  if (failed) throw new CreateRefused(failed.errorCode ?? "cloud_workspace_request_invalid", failed.cloneUrl);
  if (!checks.some((check) => check.kind === "agent-credential" && check.status === "verified")) {
    throw new Error("Could not verify the agent login for this organization.");
  }
  if (!result.ready) throw new Error("The cloud preflight did not report ready.");
}

export async function quoteCloudPlacement(orgId: string, setup: CloudWorkspaceSetup, idleSuspendMinutes: number | null): Promise<CloudWorkspaceQuote> {
  const minutes = idleSuspendMinutes ?? setup.defaults.idleSuspendMinutes;
  const quote = await api.cloudWorkspaceQuote({
    provider: setup.provider,
    ...setup.defaults,
    idleSuspendMinutes: minutes,
  }, cloudOrgArg(orgId));
  if (quote.provider !== setup.provider || quote.configuration.idleSuspendMinutes !== minutes) {
    throw new Error("The provider returned a price for different machine settings.");
  }
  if (!Number.isFinite(quote.expiresAt) || quote.expiresAt <= Date.now()) throw new CreateRefused("cloud_workspace_quote_expired");
  return quote;
}

export interface CloudCreatePlacement {
  quote: CloudWorkspaceQuote;
  accessMode: CreateForm["accessMode"];
}

/**
 * The provider a new workspace in this organization uses. In the default
 * organization, the first available one of its provider list, as before.
 * Another organization's provider list is answered only while it is the
 * default one, so its per-organization capability flags (PRO-69) name the
 * providers it offers and setup, which is reachable by membership (CS-18),
 * picks the first that is connected. Nothing here creates anything.
 */
async function providerFor(orgId: string): Promise<{ id: CloudWorkspaceProviderId; label: string; setup: CloudWorkspaceSetup | null }> {
  const status = getAccount().status;
  if (!isMultiOrg(status) || orgId === defaultOrgId(status)) {
    const { providers } = await api.cloudProviders();
    const provider = creatableProviders(providers)[0];
    if (!provider) throw noProviderRefusal(providers);
    return { id: provider.id, label: cloudProviderLabel(provider), setup: null };
  }
  const flags = status.organizations?.find((org) => org.id === orgId)?.cloud?.flags ?? {};
  // Connected here with new machines paused (PRO-372): named if no other provider is usable.
  const paused: string[] = [];
  for (const id of offeredByFlags(flags)) {
    try {
      return { id, label: cloudProviderLabel(id), setup: await api.cloudWorkspaceSetup(id, orgId) };
    } catch (error) {
      // Only "not connected here" or "paused here" moves on to the next provider;
      // anything else (not an admin, offline, rate-limited) is the real answer and is shown.
      const code = error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : null;
      if (code === SERVER_CREATION_DISABLED) paused.push(cloudProviderLabel(id));
      else if (code !== "cloud_provider_connection_required") throw error;
    }
  }
  if (paused.length) throw new CreateRefused(PROVIDER_CREATION_PAUSED, listedNames(paused));
  throw new CreateRefused("cloud_provider_connection_required");
}

/**
 * Everything a new workspace needs before the person confirms the cost: the
 * quota (refused at the limit, if there is one, sending nothing), the provider, the checks and
 * a quote. Nothing is created here.
 */
export async function prepareCloudCreate(project: CloudProject, request: CloudSessionRequest, placement?: CloudCreatePlacement): Promise<PreparedCreate> {
  const orgId = project.orgId;
  const quota = getCloudCatalog().orgs[orgId]?.quota ?? null;
  // Only against a limit: an organization without one (PRO-371) is never refused here.
  if (atLimit(quota) || (placement && atLimit(quota?.running))) throw new CreateRefused("cloud_workspace_quota_exceeded");
  const provider = placement
    ? { id: placement.quote.provider, label: cloudProviderLabel(placement.quote.provider), setup: null }
    : await providerFor(orgId);
  const org = cloudOrgArg(orgId);
  const name = project.blank ? project.fullName : titleOf(request.prompt) || project.fullName.split("/").pop() || project.fullName;
  const form: CreateForm = {
    name: [...name].slice(0, 80).join(""),
    provider: provider.id,
    repositories: projectRepositories(project, !!placement),
    prompt: request.prompt,
    agent: request.agent,
    model: request.model,
    effort: request.effort ?? "",
    mode: request.mode,
    accessMode: placement?.accessMode ?? "private",
    idleSuspendMinutes: request.idleSuspendMinutes ?? null,
  };
  const errors = Object.values(validateForm(form));
  if (errors[0]) throw new CreateRefused("cloud_workspace_form_invalid", errors[0]);
  const repositories = repositoriesInput(form);
  let quote: CloudWorkspaceQuote;
  if (placement) {
    const { status } = getAccount();
    if (!sessionPlacementReady(status, orgId)) throw new Error("Cloud session placement is unavailable for this organization.");
    await checkCloudPlacement(project, request.agent);
    const current = getAccount().status;
    if (!sessionPlacementReady(current, orgId) || current.context?.revision !== status.context?.revision) {
      throw new Error("The organization changed while checking cloud readiness. Try again.");
    }
    quote = placement.quote;
    if (quote.expiresAt <= Date.now() || quote.configuration.idleSuspendMinutes !== request.idleSuspendMinutes) {
      throw new CreateRefused("cloud_workspace_quote_expired");
    }
  } else {
    await preflightCreate(api, form, org);
    const setup = provider.setup ?? (await api.cloudWorkspaceSetup(provider.id, org));
    quote = await api.cloudWorkspaceQuote({ provider: provider.id, ...setup.defaults, idleSuspendMinutes: form.idleSuspendMinutes ?? setup.defaults.idleSuspendMinutes }, org);
  }
  const idempotencyKey = crypto.randomUUID();
  const pending: PendingCreate = {
    idempotencyKey,
    createdAt: Date.now(),
    request: {
      name: form.name.trim(),
      quoteId: quote.id,
      accessMode: form.accessMode,
      confirmProviderSpend: true,
      idempotencyKey,
      repositories,
      launch: await personLaunchInput(form),
    },
  };
  return { orgId, project, form, pending, quote, quota, providerLabel: provider.label };
}

/** The idle windows a new workspace of an organization may have (PRO-410). */
export interface CloudIdleOptions {
  /** Shortest first, then 0 (never) when offered. */
  choices: number[];
  /** The provider's default; the server has already brought it under the organization's cap. */
  defaultMinutes: number;
  /** The organization's idle cap; null with none, or from an older server. */
  cap: number | null;
}

/**
 * What "Stop when idle" offers for a new workspace in this organization: the
 * setup of the provider a create would use, as `prepareCloudCreate` picks
 * it. Nothing is created or quoted.
 */
export async function cloudIdleOptions(orgId: string): Promise<CloudIdleOptions> {
  const provider = await providerFor(orgId);
  const setup = provider.setup ?? (await api.cloudWorkspaceSetup(provider.id, cloudOrgArg(orgId)));
  return {
    choices: idleSuspendChoices(setup.allowedIdleSuspendMinutes),
    defaultMinutes: setup.defaults.idleSuspendMinutes,
    cap: setup.maxIdleSuspendMinutes ?? null,
  };
}

/**
 * Create the confirmed workspace (the same request and key on a retry), then
 * select its first session once its runtime names it.
 */
export async function confirmCloudCreate(prepared: PreparedCreate, options: { follow?: boolean } = {}): Promise<CloudWorkspaceSnapshot> {
  const snapshot = await createWorkspace(api, prepared.form, {
    orgId: cloudOrgArg(prepared.orgId),
    pending: prepared.pending,
    onPending: (pending) => savePending(prepared.orgId, pending),
    onCreated: (created, request) => rememberCreatedWorkspace(created, request.repositories),
  });
  // `follow: false` (the CLI) leaves the window's selection alone.
  if (options.follow !== false) followLaunch(prepared.orgId, snapshot.workspace.id, prepared.project.key);
  return snapshot;
}

/**
 * Select a new workspace's first session as soon as the catalog knows it,
 * provided the person is still on the new-session form of that project.
 */
export function followLaunch(orgId: string, workspaceId: string, projectKey: string): () => void {
  let done = false;
  const check = () => {
    if (done) return;
    const item = findCloudWorkspace(getCloudCatalog(), orgId, workspaceId);
    if (!item) return;
    const sessionId = item.workspace.launch?.sessionId;
    const phase = phaseOf(item);
    if (sessionId) {
      stop();
      if (getSessionStore().cloudSessionPreset?.projectKey === projectKey) selectCloudSession(cloudSessionKey(orgId, workspaceId, sessionId));
    } else if (phase === "failed" || phase === "canceled") {
      stop();
    }
  };
  const unsubscribe = subscribeCloudCatalog(check);
  const stop = () => {
    done = true;
    unsubscribe();
  };
  check();
  return stop;
}
