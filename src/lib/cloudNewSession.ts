import { api, type CloudWorkspaceProviderId, type CloudWorkspaceQuote, type CloudWorkspaceSetup, type CloudWorkspaceSnapshot } from "@/lib/api";
import { getAccount } from "@/lib/account";
import { isMultiOrg } from "@/lib/multiOrg";
import { createCloudAgentTab, getCloudAgents } from "@/lib/cloudAgents";
import { cloudOrgArg, defaultOrgId, findCloudWorkspace, getCloudCatalog, isChanging, rememberCreatedWorkspace, subscribeCloudCatalog } from "@/lib/cloudCatalog";
import {
  CreateRefused,
  createWorkspace,
  launchInput,
  phaseOf,
  repositoriesInput,
  savePending,
  usableProviders,
  validateForm,
  type CreateForm,
  type PendingCreate,
} from "@/lib/cloudCreate";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { retainCloudConnection, waitCloudConnected, wakeCloudConnection, type CloudLease } from "@/lib/cloudConnections";
import { archiving, deletion, isOpen } from "@/lib/cloudLifecycle";
import { bootCloudSessions, refreshCloudSessions } from "@/lib/cloudSessions";
import { providerLabel } from "@/lib/organizationCompute";
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
  agent: string;
  model: string;
  effort: string | null;
  mode: string;
  prompt: string;
  useWorktree: boolean;
}

export type CloudStartPlan = { kind: "reuse" | "wake"; node: CloudWorkspaceNode } | { kind: "create" };

function usable(node: CloudWorkspaceNode): boolean {
  const { item } = node;
  return !deletion(item) && !archiving(item) && item.workspace.state !== "attention-required" && phaseOf(item) !== "failed";
}

/** Where Start runs a new session of this project. Workspaces are already ordered by last activity. */
export function planCloudStart(project: CloudProject): CloudStartPlan {
  const candidates = project.workspaces.filter(usable);
  const running = candidates.find((node) => node.item.workspace.state === "ready" && !isChanging(node.item));
  if (running) return { kind: "reuse", node: running };
  // Starting or resuming: waiting on it costs nothing more than it already does.
  const coming = candidates.find((node) => node.item.workspace.state === "provisioning" || (node.item.workspace.state === "ready" && isChanging(node.item)) || (node.item.workspace.state === "suspended" && isOpen(node.item.latestOperation)));
  if (coming) return { kind: "wake", node: coming };
  const stopped = candidates.find((node) => node.item.workspace.state === "suspended");
  if (stopped) return { kind: "wake", node: stopped };
  return { kind: "create" };
}

/** The session's title: the prompt's first line, as local sessions do. */
export function titleOf(prompt: string): string {
  return prompt.trim().split("\n")[0].slice(0, 60);
}

const WAKE_WITHIN_MS = 5 * 60 * 1000;

function worktreeRefused(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /not a git|git repository|worktree/i.test(text);
}

/**
 * A new session in an existing workspace: connect (or wake it once), then
 * `session.create`. Returns the new session's key, which is selected.
 */
export async function startInWorkspace(plan: Extract<CloudStartPlan, { kind: "reuse" | "wake" }>, request: CloudSessionRequest): Promise<string> {
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
      lease.release();
      lease = await wakeCloudConnection(target);
      client = await waitCloudConnected(lease, WAKE_WITHIN_MS);
    }
    const scope = { organizationId: orgId, workspaceId };
    const params = {
      agent: request.agent,
      model: request.model || undefined,
      effort: request.effort,
      mode: request.mode || undefined,
      title: titleOf(request.prompt) || undefined,
      prompt: request.prompt.trim() ? request.prompt : undefined,
      useWorktree: request.useWorktree,
    };
    let tabId: string;
    try {
      tabId = await createCloudAgentTab(scope, client, params);
    } catch (error) {
      // A workspace whose folder has no Git repository cannot cut a worktree; the session works in the folder.
      if (!request.useWorktree || !worktreeRefused(error)) throw error;
      tabId = await createCloudAgentTab(scope, client, { ...params, useWorktree: false });
    }
    const sessionId = getCloudAgents(scope).tabs.find((tab) => tab.tabId === tabId)?.info.sessionId;
    if (!sessionId) throw new Error("cloud_session_not_created");
    // The list follows `session.sessions` on session/2 runtimes; read it now either way so the row is there.
    void refreshCloudSessions(target, client).catch(() => undefined);
    const key = cloudSessionKey(orgId, workspaceId, sessionId);
    selectCloudSession(key);
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
  /** Non-archived workspaces against the organization's limit; null from an older server. */
  quota: { used: number; limit: number } | null;
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

/** Providers in the order the desktop prefers them when the organization's provider list cannot be read. */
const PROVIDER_ORDER: readonly CloudWorkspaceProviderId[] = ["machine0", "box", "hetzner", "local-docker"];

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
    const provider = usableProviders((await api.cloudProviders()).providers)[0];
    if (!provider) throw new CreateRefused("cloud_provider_connection_required");
    return { id: provider.id, label: provider.displayName || provider.id, setup: null };
  }
  const flags = status.organizations?.find((org) => org.id === orgId)?.cloud?.flags ?? {};
  for (const id of PROVIDER_ORDER.filter((provider) => flags[`cloud.workspaces.provider.${provider}.v1`] === true)) {
    try {
      return { id, label: providerLabel(id), setup: await api.cloudWorkspaceSetup(id, orgId) };
    } catch (error) {
      // Only "not connected here" moves on to the next provider; anything else
      // (not an admin, offline, rate-limited) is the real answer and is shown.
      const code = error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : null;
      if (code !== "cloud_provider_connection_required") throw error;
    }
  }
  throw new CreateRefused("cloud_provider_connection_required");
}

/**
 * Everything a new workspace needs before the person confirms the cost: the
 * quota (refused at the limit, sending nothing), the provider, the checks and
 * a quote. Nothing is created here.
 */
export async function prepareCloudCreate(project: CloudProject, request: CloudSessionRequest): Promise<PreparedCreate> {
  const orgId = project.orgId;
  const quota = getCloudCatalog().orgs[orgId]?.quota ?? null;
  if (quota && quota.used >= quota.limit) throw new CreateRefused("cloud_workspace_quota_exceeded");
  const provider = await providerFor(orgId);
  const org = cloudOrgArg(orgId);
  const name = project.blank ? project.fullName : titleOf(request.prompt) || project.fullName.split("/").pop() || project.fullName;
  const form: CreateForm = {
    name: [...name].slice(0, 80).join(""),
    provider: provider.id,
    repositories: project.blank ? [] : [{ cloneUrl: cloneUrlOf(project)!, fullName: project.fullName, ref: "" }],
    prompt: request.prompt,
    agent: request.agent,
    model: request.model,
    effort: request.effort ?? "",
    mode: request.mode,
    accessMode: "private",
  };
  const errors = Object.values(validateForm(form));
  if (errors[0]) throw new CreateRefused("cloud_workspace_form_invalid", errors[0]);
  const repositories = repositoriesInput(form);
  if (repositories.length) {
    const preflight = await api.cloudWorkspacePreflight(repositories, org);
    const failed = preflight.checks.find((check) => check.status === "failed" && check.kind !== "agent-credential");
    if (failed) throw new CreateRefused(failed.errorCode ?? "cloud_workspace_request_invalid", failed.cloneUrl);
  }
  const setup = provider.setup ?? (await api.cloudWorkspaceSetup(provider.id, org));
  const quote = await api.cloudWorkspaceQuote({ provider: provider.id, ...setup.defaults }, org);
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
      launch: launchInput(form),
    },
  };
  return { orgId, project, form, pending, quote, quota, providerLabel: provider.label };
}

/**
 * Create the confirmed workspace (the same request and key on a retry), then
 * select its first session once its runtime names it.
 */
export async function confirmCloudCreate(prepared: PreparedCreate): Promise<CloudWorkspaceSnapshot> {
  const snapshot = await createWorkspace(api, prepared.form, {
    orgId: cloudOrgArg(prepared.orgId),
    pending: prepared.pending,
    onPending: (pending) => savePending(prepared.orgId, pending),
    onCreated: (created, request) => rememberCreatedWorkspace(created, request.repositories),
  });
  followLaunch(prepared.orgId, snapshot.workspace.id, prepared.project.key);
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
