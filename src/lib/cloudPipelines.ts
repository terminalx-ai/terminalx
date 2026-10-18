import type { RuntimeIssuePipeline, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { issuePipelines as pipelinesApi } from "@/lib/api";
import { cacheCloudPipelines, dropCachedCloudPipelines, getCloudCatalog, repositoryOf, subscribeCloudCatalog, type CloudCatalogState } from "@/lib/cloudCatalog";
import { onWorkspaceAccess } from "@/lib/cloudCollab";
import { connectedCloudClient, onCloudConnected, retainCloudConnection, waitCloudConnected, wakeCloudConnection, type CloudTarget } from "@/lib/cloudConnections";
import { notePipelineState } from "@/lib/notify";
import { cloudProjectKey, cloudSessionKey, cloudWorkspaceKey, parseCloudWorkspaceKey } from "@/types/target";
import type { CloudMerge, IssuePipeline, IssuePipelineSettings, PipelineAction, PipelineEvent } from "@/types/issuePipeline";

/**
 * Issue pipelines that cloud workspaces carry (#433). A workspace's runtime
 * runs its pipelines with no desktop attached; this is what this desktop
 * knows of them: each workspace's list, read whenever a connection to it comes
 * up, the changes its runtime announces while connected (`pipeline.changed`),
 * and the copy kept with the catalog for a workspace that is asleep.
 *
 * They are shown as this desktop shows its own (`IssuePipeline`), placed
 * under the cloud project their workspace belongs to: `projectPath` is the
 * project's key and the sessions they name are cloud session keys. Acting on
 * one goes to its runtime; merging one is this computer's, with the reader's
 * own `gh` (`issue_pipeline_merge_cloud`), and the runtime is then told.
 */

/** At most this many per workspace are kept, newest first: the runtime keeps a longer record of finished ones. */
const KEPT_PER_WORKSPACE = 50;
/** How long an action may wait for a workspace to wake and connect. */
const WAKE_WITHIN_MS = 5 * 60 * 1000;
/** How long the look a page takes on opening waits for a running workspace to connect. */
const LOOK_WITHIN_MS = 20 * 1000;

let views: IssuePipeline[] = [];
let builtFrom: CloudCatalogState | null = null;
const listeners = new Set<() => void>();

/** `cloud:<orgId>:<workspaceId>` → merges made here that its runtime has not been told of yet. */
const unnoted = new Map<string, { pipeline: string; commit: string }[]>();

function shortCommit(commit: string): string {
  return commit.slice(0, 10);
}

/** The runtime's pipeline, without what this desktop never shows: the issue's text is the reviewer's. */
function kept(raw: RuntimeIssuePipeline): RuntimeIssuePipeline {
  const { issueBody: _issueBody, ...rest } = raw;
  return rest;
}

/**
 * One runtime pipeline as the issue page shows it: under the cloud project of
 * the repository `identity` (its workspace's), with the sessions it names as
 * cloud session keys.
 */
export function cloudPipelineView(raw: RuntimeIssuePipeline, place: { orgId: string; workspaceId: string; identity: string; readAt: number }): IssuePipeline {
  const { orgId, workspaceId, identity, readAt } = place;
  const pipeline = raw as unknown as IssuePipeline;
  const session = (id: string) => cloudSessionKey(orgId, workspaceId, id);
  const repository = identity.startsWith("github.com/") ? identity.slice("github.com/".length) : null;
  return {
    ...pipeline,
    cloud: true,
    projectPath: cloudProjectKey(orgId, identity),
    author: { ...pipeline.author, sessionId: session(pipeline.author.sessionId) },
    reviewer: pipeline.reviewer ? { ...pipeline.reviewer, sessionId: session(pipeline.reviewer.sessionId) } : null,
    events: (pipeline.events ?? []).map((event: PipelineEvent) => (event.sessionId ? { ...event, sessionId: session(event.sessionId) } : event)),
    place: { orgId, workspaceId, projectKey: cloudProjectKey(orgId, identity), repository, readAt },
  };
}

function build(catalog: CloudCatalogState): IssuePipeline[] {
  const out: IssuePipeline[] = [];
  for (const [orgId, org] of Object.entries(catalog.orgs)) {
    for (const [workspaceId, cached] of Object.entries(org.pipelines ?? {})) {
      const item = org.workspaces.find((each) => each.workspace.id === workspaceId);
      const identity = item ? repositoryOf(item, catalog.createMemory)?.identity : null;
      if (!identity) continue;
      for (const raw of cached.pipelines) out.push(cloudPipelineView(raw, { orgId, workspaceId, identity, readAt: cached.at }));
    }
  }
  return out;
}

function publish() {
  for (const listener of listeners) listener();
}

/** Every cloud pipeline this desktop knows of, as the issue page shows them. */
export function getCloudPipelines(): IssuePipeline[] {
  const catalog = getCloudCatalog();
  if (catalog !== builtFrom) {
    builtFrom = catalog;
    views = build(catalog);
  }
  return views;
}

export function subscribeCloudPipelines(listener: () => void): () => void {
  listeners.add(listener);
  const stop = subscribeCloudCatalog(listener);
  return () => {
    listeners.delete(listener);
    stop();
  };
}

const newestFirst = (a: RuntimeIssuePipeline, b: RuntimeIssuePipeline) => String(b.created ?? "").localeCompare(String(a.created ?? ""));

function stored(target: CloudTarget): RuntimeIssuePipeline[] {
  return getCloudCatalog().orgs[target.orgId]?.pipelines?.[target.workspaceId]?.pipelines ?? [];
}

/** What the runtime listed: the whole of what it carries. */
function takeList(target: CloudTarget, pipelines: RuntimeIssuePipeline[]) {
  cacheCloudPipelines(target.orgId, target.workspaceId, [...pipelines].map(kept).sort(newestFirst).slice(0, KEPT_PER_WORKSPACE));
}

/** One pipeline as the runtime wrote it. A change of state that comes to rest is news. */
function takeOne(target: CloudTarget, raw: RuntimeIssuePipeline) {
  const before = stored(target);
  const previous = before.find((each) => each.id === raw.id);
  const next = [kept(raw), ...before.filter((each) => each.id !== raw.id)].sort(newestFirst).slice(0, KEPT_PER_WORKSPACE);
  cacheCloudPipelines(target.orgId, target.workspaceId, next);
  if (previous && previous.state !== raw.state) {
    const view = getCloudPipelines().find((each) => each.id === raw.id && each.place?.workspaceId === target.workspaceId);
    if (view) notePipelineState(view);
  }
}

/** A pipeline a session was just started with: shown at once, before the runtime announces it. */
export function takeStartedPipeline(target: CloudTarget, pipeline: RuntimeIssuePipeline) {
  takeOne(target, pipeline);
}

/** The connection's hello says this person has no role on the workspace. */
function noAccess(client: WorkspaceRpcClient): boolean {
  const state = client.connection;
  return state.state === "connected" && state.authority !== "manage" && state.you?.role === "none" && state.you.listed !== false;
}

/** Pipelines whose Linear issue this desktop already tried to move to review, this run. */
const movedToReview = new Set<string>();

/** The connection manages the workspace: it may write a pipeline's record. */
function manages(client: WorkspaceRpcClient): boolean {
  const state = client.connection;
  return state.state === "connected" && state.authority === "manage" && (!state.you || state.you.listed === false || state.you.role === "manager");
}

/**
 * A Linear issue goes to its team's review state when its pull request opens.
 * The runtime holds no Linear key, so a desktop that manages the workspace
 * makes the move with its reader's key, once, and tells the runtime, which
 * records it. One without a key leaves it to another.
 */
async function moveLinearToReview(target: CloudTarget, client: WorkspaceRpcClient, raw: RuntimeIssuePipeline) {
  const pipeline = raw as unknown as IssuePipeline;
  const due = pipeline.issue?.provider === "linear" && !!pipeline.pr && pipeline.state !== "merged" && !pipeline.stopped && !(pipeline.events ?? []).some((event) => event.kind === "tracker");
  if (!due || !manages(client) || movedToReview.has(raw.id)) return;
  movedToReview.add(raw.id);
  try {
    const message = await pipelinesApi.linearToReview(pipeline.issue.id, pipeline.issue.identifier);
    takeOne(target, await client.noteTracker(raw.id, message));
  } catch {
    /* no Linear key here, or the workspace refused: the next desktop that can, does */
  }
}

/** Tell a runtime of the merges made here while it could not be reached. One it refuses is not asked again. */
async function noteUnnoted(target: CloudTarget, client: WorkspaceRpcClient) {
  const key = cloudWorkspaceKey(target.orgId, target.workspaceId);
  for (const merge of unnoted.get(key) ?? []) {
    try {
      takeOne(target, await client.noteMerge(merge.pipeline, merge.commit));
    } catch {
      /* the runtime reads the pull request itself on its next look */
    }
    unnoted.set(key, (unnoted.get(key) ?? []).filter((each) => each !== merge));
  }
  if (!unnoted.get(key)?.length) unnoted.delete(key);
}

function onConnected(target: CloudTarget, client: WorkspaceRpcClient) {
  if (!client.hasCapability("pipeline/1")) return;
  if (noAccess(client)) {
    dropCachedCloudPipelines(target.orgId, target.workspaceId);
    return;
  }
  let open = true;
  void (async () => {
    await noteUnnoted(target, client);
    const listed = await client.listPipelines();
    if (!open) return;
    takeList(target, listed);
    for (const pipeline of listed) void moveLinearToReview(target, client, pipeline);
  })().catch(() => undefined);
  const stop = client.onPipeline((pipeline) => {
    if (!open) return;
    takeOne(target, pipeline);
    void moveLinearToReview(target, client, pipeline);
  });
  return () => {
    open = false;
    stop();
  };
}

let booted: (() => void) | null = null;

/** Follow every connection's pipelines, and forget a workspace's when access to it ends. Idempotent. */
export function bootCloudPipelines() {
  if (booted) return;
  const stopConnections = onCloudConnected(onConnected);
  const stopAccess = onWorkspaceAccess((key, access) => {
    const parsed = access === "lost" ? parseCloudWorkspaceKey(key) : null;
    if (parsed) dropCachedCloudPipelines(parsed.orgId, parsed.workspaceId);
  });
  booted = () => {
    stopConnections();
    stopAccess();
  };
}

/** For tests. */
export function resetCloudPipelines() {
  booted?.();
  booted = null;
  unnoted.clear();
  movedToReview.clear();
  builtFrom = null;
  views = [];
  publish();
}

function targetOf(pipeline: IssuePipeline): CloudTarget {
  if (!pipeline.place) throw new Error(`${pipeline.issue.identifier} is not carried by a cloud workspace.`);
  return { orgId: pipeline.place.orgId, workspaceId: pipeline.place.workspaceId };
}

/**
 * Stop, resume, carry on, review again or look again: asked of the
 * workspace's runtime. Pressing one is an action, so a workspace that is
 * asleep is woken for it.
 */
export async function actOnCloudPipeline(pipeline: IssuePipeline, action: Exclude<PipelineAction, "merge">): Promise<void> {
  const target = targetOf(pipeline);
  const lease = await wakeCloudConnection(target);
  try {
    const client = await waitCloudConnected(lease, WAKE_WITHIN_MS);
    takeOne(target, await client.actOnPipeline(pipeline.id, action));
  } finally {
    lease.release();
  }
}

/**
 * Opening an issue is a reason to look at its pull request now. Only a
 * workspace that is running is asked; a look never wakes one, and one that
 * fails says nothing.
 */
export async function lookAtCloudPipeline(pipeline: IssuePipeline): Promise<void> {
  const target = targetOf(pipeline);
  const lease = await retainCloudConnection(target, "connect");
  try {
    const client = await waitCloudConnected(lease, LOOK_WITHIN_MS, { stoppedIsError: true });
    takeOne(target, await client.actOnPipeline(pipeline.id, "refresh"));
  } finally {
    lease.release();
  }
}

/** The record of a merge made here, as the runtime writes one, until it says so itself. */
function mergedHere(raw: RuntimeIssuePipeline, outcome: Extract<CloudMerge, { outcome: "merged" | "accepted" }>): RuntimeIssuePipeline {
  const pipeline = raw as unknown as IssuePipeline;
  const at = new Date().toISOString();
  const pr = pipeline.pr;
  if (outcome.outcome === "accepted") {
    return { ...raw, state: "waiting", note: `GitHub accepted the merge of ${shortCommit(outcome.commit)} and has not completed it yet.`, mergeRequested: { commit: outcome.commit, by: "person", at } };
  }
  const message = `Merged from the issue page: pull request #${pr?.number ?? "?"} at ${shortCommit(outcome.commit)} into ${pr?.base ?? "its base"}.`;
  const event: PipelineEvent = { at, stage: "merge", kind: "merged", message, commit: outcome.commit, url: pr?.url ?? null };
  return { ...raw, stage: "merge", state: "merged", reason: null, note: message, merged: { commit: outcome.commit, at, by: "person" }, events: [...(pipeline.events ?? []), event], modified: at };
}

/**
 * Merge a cloud workspace's pull request here, as the person who pressed
 * Merge: the reader's own `gh`, pinned to the reviewed commit, after GitHub
 * is read again (`cloud_merge.rs`). The runtime is told now if it is
 * connected, or as soon as it next is; until then the page shows the merge
 * as made. Returns why nothing was merged, or null.
 */
export async function mergeCloudPipeline(pipeline: IssuePipeline, settings: IssuePipelineSettings): Promise<string | null> {
  const target = targetOf(pipeline);
  const repository = pipeline.place?.repository;
  if (!repository) throw new Error("This cloud project has no GitHub repository to merge into.");
  const outcome = await pipelinesApi.mergeCloud(pipeline, repository, settings);
  const client = connectedCloudClient(cloudWorkspaceKey(target.orgId, target.workspaceId));
  const tellRuntime = (work: (client: WorkspaceRpcClient) => Promise<RuntimeIssuePipeline>) => {
    if (client?.hasCapability("pipeline/1")) void work(client).then((raw) => takeOne(target, raw)).catch(() => undefined);
  };
  switch (outcome.outcome) {
    case "merged":
    case "accepted": {
      const raw = stored(target).find((each) => each.id === pipeline.id);
      if (raw) takeOne(target, mergedHere(raw, outcome));
      if (client?.hasCapability("pipeline/1")) tellRuntime((connected) => connected.noteMerge(pipeline.id, outcome.commit));
      else {
        const key = cloudWorkspaceKey(target.orgId, target.workspaceId);
        unnoted.set(key, [...(unnoted.get(key) ?? []), { pipeline: pipeline.id, commit: outcome.commit }]);
      }
      return null;
    }
    case "alreadyMerged":
      // Merged elsewhere: the runtime records it as that when it looks.
      tellRuntime((connected) => connected.actOnPipeline(pipeline.id, "refresh"));
      return null;
    case "notMerged":
      // Whatever stopped it (a new head, a failing check) is the runtime's to record too.
      tellRuntime((connected) => connected.actOnPipeline(pipeline.id, "refresh"));
      return outcome.reason;
  }
}
