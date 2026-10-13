import { invoke } from "@tauri-apps/api/core";

// The active organization's cloud Environment for one provider (saas PRO-15)
// and the recipes proposed for it (PRO-20). The Environment is the image new
// workspaces launch from: a template (a machine install script, and setup
// steps for each repository, kept apart), the versions built from it, and
// which version is published. Every member can read the active version; only
// owners and admins see or change the template, build, roll back, or decide a
// recipe. Reads never start a machine; a build does, and asks first.

export interface EnvironmentSetupStep {
  workingDirectory: string;
  script: string;
}

export interface EnvironmentRepository {
  owner: string;
  name: string;
  defaultBranch: string;
  setup: EnvironmentSetupStep[];
}

export interface EnvironmentDefinition {
  installScript: string;
  repositories: EnvironmentRepository[];
}

export type EnvironmentVersionState = "queued" | "running" | "succeeded" | "failed" | "canceled";

export interface EnvironmentRepositoryCommit {
  owner: string;
  name: string;
  defaultBranch: string;
  commit: string;
}

export interface EnvironmentLogEntry {
  phase: string;
  content: string;
  occurredAt: number;
}

export interface EnvironmentVersion {
  id: string;
  number: number;
  state: EnvironmentVersionState | (string & {});
  stage: string;
  publication: "published" | "retained" | "expired" | null;
  configurationRevision: number;
  errorCode: string | null;
  failurePhase: string | null;
  retryOf: string | null;
  repositories: EnvironmentRepositoryCommit[];
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  publishedAt: number | null;
  rollbackAvailable: boolean;
  /** Owners and admins only, and only on a single-version read. */
  logs: EnvironmentLogEntry[] | null;
}

export interface EnvironmentTemplate {
  revision: number;
  definition: EnvironmentDefinition;
  updatedAt: number | null;
}

export interface EnvironmentStatus {
  provider: string;
  /** Whether this provider can build Environment images at all. */
  supported: boolean;
  canManage: boolean;
  /** How many versions are kept: the published one and the ones to roll back to. */
  retainedVersions: number | null;
  template: EnvironmentTemplate | null;
  activeVersion: EnvironmentVersion | null;
  rebuildRequired: boolean;
  pendingChanges: string[];
  versions: EnvironmentVersion[];
  contextRevision: string;
}

export const RECIPE_CHECK_KINDS = ["install", "lint", "test", "build", "start"] as const;
export type RecipeCheckKind = (typeof RECIPE_CHECK_KINDS)[number];
export type RecipeCheckStatus = "passed" | "failed" | "timed-out" | "skipped" | "not-run";

export interface RecipeCheck {
  kind: RecipeCheckKind;
  command: string;
  status: RecipeCheckStatus;
  exitCode: number | null;
  durationMs: number | null;
  /** It was already failing before anything from the recipe was applied. */
  preexisting: boolean;
}

export interface RecipeRepositoryResults {
  owner: string;
  name: string;
  commit: string | null;
  checks: RecipeCheck[];
}

export interface RecipeObservations {
  /** `verification`: TerminalX ran each command. `agent`: only the agent's own report. */
  observedBy: "agent" | "verification";
  machine: Pick<RecipeCheck, "status" | "exitCode" | "durationMs"> | null;
  repositories: RecipeRepositoryResults[];
}

export interface EnvironmentRecipe {
  id: string;
  provider: string;
  /** `unknown`: a state this build does not know. It is shown, and offers no action. */
  state: "proposed" | "applied" | "dismissed" | "unknown";
  /** The template revision the proposal was made against. */
  baseRevision: number;
  definition: EnvironmentDefinition;
  observations: RecipeObservations;
  createdAt: number;
  decidedAt: number | null;
  appliedRevision: number | null;
}

export interface EnvironmentRecipes {
  recipes: EnvironmentRecipe[];
  contextRevision: string;
}

export interface OrganizationEnvironmentError {
  code: string;
  status: number | null;
}

const malformed = (): OrganizationEnvironmentError => ({ code: "cloud_environment_unavailable", status: null });
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const objects = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isObject) : []);

// The native layer forwards the server's JSON as-is. Anything a different
// server build leaves out is defaulted here, and a payload without its core
// fields becomes an ordinary "unavailable" error instead of a render crash.
export function normalizeDefinition(value: unknown): EnvironmentDefinition {
  const definition = isObject(value) ? value : {};
  return {
    installScript: text(definition.installScript),
    repositories: objects(definition.repositories).map((repository) => ({
      owner: text(repository.owner),
      name: text(repository.name),
      defaultBranch: text(repository.defaultBranch),
      setup: objects(repository.setup).map((step) => ({ workingDirectory: text(step.workingDirectory) || ".", script: text(step.script) })),
    })),
  };
}

export function normalizeVersion(value: unknown): EnvironmentVersion {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.state !== "string") throw malformed();
  const publication = value.publication;
  return {
    id: value.id,
    number: numberOrNull(value.number) ?? 0,
    state: value.state,
    stage: text(value.stage),
    publication: publication === "published" || publication === "retained" || publication === "expired" ? publication : null,
    configurationRevision: numberOrNull(value.configurationRevision) ?? 0,
    errorCode: text(value.errorCode) || null,
    failurePhase: text(value.failurePhase) || null,
    retryOf: text(value.retryOf) || null,
    repositories: objects(value.repositories).map((repository) => ({
      owner: text(repository.owner),
      name: text(repository.name),
      defaultBranch: text(repository.defaultBranch),
      commit: text(repository.commit),
    })),
    createdAt: numberOrNull(value.createdAt) ?? 0,
    startedAt: numberOrNull(value.startedAt),
    finishedAt: numberOrNull(value.finishedAt),
    publishedAt: numberOrNull(value.publishedAt),
    rollbackAvailable: value.rollbackAvailable === true,
    logs: Array.isArray(value.logs)
      ? objects(value.logs).map((entry) => ({ phase: text(entry.phase), content: text(entry.content), occurredAt: numberOrNull(entry.occurredAt) ?? 0 }))
      : null,
  };
}

const versionOrNull = (value: unknown): EnvironmentVersion | null => {
  try {
    return value === undefined || value === null ? null : normalizeVersion(value);
  } catch {
    return null;
  }
};

export function normalizeStatus(value: unknown): EnvironmentStatus {
  if (!isObject(value) || typeof value.provider !== "string" || typeof value.supported !== "boolean") throw malformed();
  const template = isObject(value.template) && typeof value.template.revision === "number" ? value.template : null;
  return {
    provider: value.provider,
    supported: value.supported,
    canManage: value.canManage === true,
    retainedVersions: isObject(value.retention) ? numberOrNull(value.retention.publishedAndRollback) : null,
    template: template
      ? { revision: template.revision as number, definition: normalizeDefinition(template.definition), updatedAt: numberOrNull(template.updatedAt) }
      : null,
    activeVersion: versionOrNull(value.activeVersion),
    rebuildRequired: value.rebuildRequired === true,
    pendingChanges: Array.isArray(value.pendingChanges) ? value.pendingChanges.filter((change): change is string => typeof change === "string") : [],
    versions: objects(value.versions).flatMap((version) => versionOrNull(version) ?? []),
    contextRevision: text(value.contextRevision),
  };
}

const CHECK_STATUSES: readonly string[] = ["passed", "failed", "timed-out", "skipped", "not-run"];

// A status this build does not know is never shown as a pass: it reads "not run".
const checkStatus = (value: unknown): RecipeCheckStatus => (typeof value === "string" && CHECK_STATUSES.includes(value) ? (value as RecipeCheckStatus) : "not-run");

function normalizeObservations(value: unknown): RecipeObservations {
  const observations = isObject(value) ? value : {};
  const machine = isObject(observations.machine) ? observations.machine : null;
  return {
    // Only a result the server says TerminalX observed is shown as observed.
    observedBy: observations.observedBy === "verification" ? "verification" : "agent",
    machine: machine ? { status: checkStatus(machine.status), exitCode: numberOrNull(machine.exitCode), durationMs: numberOrNull(machine.durationMs) } : null,
    repositories: objects(observations.repositories).map((repository) => {
      const reported = objects(repository.checks);
      return {
        owner: text(repository.owner),
        name: text(repository.name),
        commit: text(repository.commit) || null,
        // Always the five checks, each on its own row, in the same order.
        checks: RECIPE_CHECK_KINDS.map((kind) => {
          const check = reported.find((candidate) => candidate.kind === kind);
          return {
            kind,
            command: text(check?.command),
            status: checkStatus(check?.status),
            exitCode: numberOrNull(check?.exitCode),
            durationMs: numberOrNull(check?.durationMs),
            preexisting: check?.preexisting === true,
          };
        }),
      };
    }),
  };
}

export function normalizeRecipe(value: unknown): EnvironmentRecipe {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.baseRevision !== "number") throw malformed();
  return {
    id: value.id,
    provider: text(value.provider),
    // Only a recipe the server calls proposed is offered for applying.
    state: value.state === "proposed" || value.state === "applied" || value.state === "dismissed" ? value.state : "unknown",
    baseRevision: value.baseRevision,
    definition: normalizeDefinition(value.definition),
    observations: normalizeObservations(value.observations),
    createdAt: numberOrNull(value.createdAt) ?? 0,
    decidedAt: numberOrNull(value.decidedAt),
    appliedRevision: numberOrNull(value.appliedRevision),
  };
}

export function normalizeRecipes(value: unknown): EnvironmentRecipes {
  if (!isObject(value) || !Array.isArray(value.recipes)) throw malformed();
  return {
    recipes: objects(value.recipes).flatMap((recipe) => {
      try {
        return [normalizeRecipe(recipe)];
      } catch {
        return [];
      }
    }),
    contextRevision: text(value.contextRevision),
  };
}

const contextOf = (value: unknown): string => (isObject(value) ? text(value.contextRevision) : "");

export const organizationEnvironment = {
  status: (provider: string) => invoke<unknown>("organization_environment_status", { provider }).then(normalizeStatus),
  update: (provider: string, expectedRevision: number, definition: EnvironmentDefinition, contextRevision: string) =>
    invoke<unknown>("organization_environment_update", { provider, expectedRevision, definition, contextRevision }).then(normalizeStatus),
  /** Starts a builder machine at the provider. `confirmProviderSpend` is the person's own press, never a default. */
  build: (provider: string, idempotencyKey: string, confirmProviderSpend: boolean, contextRevision: string) =>
    invoke<unknown>("organization_environment_build", { provider, idempotencyKey, confirmProviderSpend, contextRevision }).then(normalizeVersion),
  version: (versionId: string) => invoke<unknown>("organization_environment_version", { versionId }).then(normalizeVersion),
  retry: (versionId: string, confirmProviderSpend: boolean, contextRevision: string) =>
    invoke<unknown>("organization_environment_version_retry", { versionId, confirmProviderSpend, contextRevision }).then(normalizeVersion),
  cancel: (versionId: string, contextRevision: string) => invoke<unknown>("organization_environment_version_cancel", { versionId, contextRevision }).then(normalizeVersion),
  rollback: (versionId: string, contextRevision: string) => invoke<unknown>("organization_environment_version_rollback", { versionId, contextRevision }).then(contextOf),
  recipes: (provider: string) => invoke<unknown>("organization_environment_recipes", { provider }).then(normalizeRecipes),
  /** Stores a proposal. It changes nothing by existing. `recipe` is the server's body, observations included. */
  proposeRecipe: (provider: string, recipe: { baseRevision: number; definition: EnvironmentDefinition; observations: unknown; sourceWorkspaceId?: string }, contextRevision: string) =>
    invoke<unknown>("organization_environment_recipe_propose", { provider, recipe, contextRevision }).then(normalizeRecipe),
  /** Writes the recipe's definition into the template. Builds nothing. */
  applyRecipe: (recipeId: string, confirmApply: boolean, contextRevision: string) =>
    invoke<unknown>("organization_environment_recipe_apply", { recipeId, confirmApply, contextRevision }).then(contextOf),
  dismissRecipe: (recipeId: string, contextRevision: string) => invoke<unknown>("organization_environment_recipe_dismiss", { recipeId, contextRevision }).then(normalizeRecipe),
};

export const emptyDefinition = (): EnvironmentDefinition => ({ installScript: "", repositories: [] });

/** The definition as the server stores it: trimmed names, and no step without a script. */
export function cleanDefinition(definition: EnvironmentDefinition): EnvironmentDefinition {
  return {
    installScript: definition.installScript,
    repositories: definition.repositories.map((repository) => ({
      owner: repository.owner.trim(),
      name: repository.name.trim(),
      defaultBranch: repository.defaultBranch.trim(),
      setup: repository.setup.filter((step) => step.script.trim()).map((step) => ({ workingDirectory: step.workingDirectory.trim() || ".", script: step.script })),
    })),
  };
}

const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Why a draft cannot be saved, in words; null when it can. The server checks everything again. */
export function definitionProblem(definition: EnvironmentDefinition): string | null {
  const cleaned = cleanDefinition(definition);
  const seen = new Set<string>();
  for (const repository of cleaned.repositories) {
    if (!GITHUB_NAME.test(repository.owner) || !GITHUB_NAME.test(repository.name)) return "Each repository needs a GitHub owner and name.";
    if (!repository.defaultBranch) return `${repository.owner}/${repository.name} needs a default branch.`;
    const key = `${repository.owner}/${repository.name}`.toLowerCase();
    if (seen.has(key)) return `${repository.owner}/${repository.name} is listed twice.`;
    seen.add(key);
    if (repository.setup.some((step) => step.workingDirectory.startsWith("/") || step.workingDirectory.split("/").includes("..")))
      return `A setup step of ${repository.owner}/${repository.name} must stay inside the repository.`;
  }
  return null;
}

export const sameDefinition = (left: EnvironmentDefinition, right: EnvironmentDefinition) => JSON.stringify(cleanDefinition(left)) === JSON.stringify(cleanDefinition(right));

const repositoryKey = (repository: Pick<EnvironmentRepository, "owner" | "name">) => `${repository.owner}/${repository.name}`.toLowerCase();

export type RepositoryChange = "added" | "changed" | "unchanged";

/** How a proposed definition differs from the current one, with the machine script and each repository judged apart. */
export function compareDefinitions(current: EnvironmentDefinition | null, proposed: EnvironmentDefinition) {
  const base = cleanDefinition(current ?? emptyDefinition());
  const next = cleanDefinition(proposed);
  const existing = new Map(base.repositories.map((repository) => [repositoryKey(repository), repository]));
  const kept = new Set(next.repositories.map(repositoryKey));
  return {
    machineChanged: base.installScript !== next.installScript,
    repositories: next.repositories.map((repository) => {
      const before = existing.get(repositoryKey(repository));
      const change: RepositoryChange = !before ? "added" : JSON.stringify(before) === JSON.stringify(repository) ? "unchanged" : "changed";
      return { repository, change };
    }),
    removed: base.repositories.filter((repository) => !kept.has(repositoryKey(repository))),
  };
}

export const isBuilding = (version: Pick<EnvironmentVersion, "state">) => version.state === "queued" || version.state === "running";

const STAGE_LABEL: Record<string, string> = {
  queued: "Waiting to start",
  "creating-builder": "Starting the builder machine",
  toolchain: "Checking the base tools",
  install: "Running the machine install script",
  repositories: "Cloning repositories",
  setup: "Running repository setup",
  sanitize: "Removing build credentials",
  verify: "Checking the image",
  snapshot: "Saving the image",
  publish: "Publishing",
  cleanup: "Removing the builder machine",
  complete: "Done",
};

export const stageLabel = (stage: string) => STAGE_LABEL[stage] ?? stage;

export function versionStateLabel(version: Pick<EnvironmentVersion, "state" | "stage" | "failurePhase">): string {
  switch (version.state) {
    case "queued":
      return "Waiting to build";
    case "running":
      return `Building: ${stageLabel(version.stage).toLowerCase()}`;
    case "succeeded":
      return "Built";
    case "failed":
      return version.failurePhase ? `Failed while ${stageLabel(version.failurePhase).toLowerCase()}` : "Failed";
    case "canceled":
      return "Canceled";
    default:
      return version.state;
  }
}

export function publicationLabel(publication: EnvironmentVersion["publication"]): string | null {
  switch (publication) {
    case "published":
      return "Active";
    case "retained":
      return "Kept for rollback";
    case "expired":
      return "Expired";
    default:
      return null;
  }
}

const CHANGE_LABEL: Record<string, string> = {
  "install-script": "the machine install script",
  "repositories-added": "repositories added",
  "repositories-removed": "repositories removed",
  "repository-branch": "a repository's default branch",
  "setup-steps": "repository setup steps",
  toolchain: "the base tools",
  runtime: "the TerminalX runtime",
};

export const changeLabel = (change: string) => CHANGE_LABEL[change] ?? change;

export const CHECK_LABEL: Record<RecipeCheckKind, string> = { install: "Install", lint: "Lint", test: "Test", build: "Build", start: "Start" };

/**
 * How a check ended, in words. A failure is always called a failure, never
 * softened into a pass or left out. `preexisting` says what was observed and
 * no more: the same command also fails in a copy of the repository that has
 * none of the recipe's setup. That can be the repository's own fault or the
 * recipe's (a dependency it forgot), so the words do not blame either.
 */
export function checkStatusLabel(check: Pick<RecipeCheck, "status" | "preexisting">): string {
  switch (check.status) {
    case "passed":
      return "Passed";
    case "failed":
      return check.preexisting ? "Failed (also fails without this recipe's setup)" : "Failed";
    case "timed-out":
      return check.preexisting ? "Timed out (also fails without this recipe's setup)" : "Timed out";
    case "skipped":
      return "Skipped";
    default:
      return "Not run";
  }
}

export const checkFailed = (check: Pick<RecipeCheck, "status">) => check.status === "failed" || check.status === "timed-out";

/**
 * Who stands behind a recipe's results. The two are never worded alike, and
 * neither is called independent: TerminalX's own runs happen on the machine
 * the agent has just worked on.
 */
export function observedByLabel(observedBy: RecipeObservations["observedBy"]): string {
  return observedBy === "verification"
    ? "Re-run by TerminalX on the preparation machine: it ran each command there, on a fresh copy fetched from GitHub, and recorded how it ended. The agent had worked on that machine first, so this is not an independent result. That comes only from building a version."
    : "Reported by the agent. TerminalX did not run these commands itself.";
}

/** How many checks failed and how many never ran, the machine script included. */
export function checkCounts(observations: RecipeObservations): { failed: number; notRun: number } {
  const all = [...observations.repositories.flatMap((repository) => repository.checks), ...(observations.machine ? [observations.machine] : [])];
  return { failed: all.filter(checkFailed).length, notRun: all.filter((check) => check.status === "not-run").length };
}

/** The one-line summary of a recipe's results. "Nothing failed" is never said of checks that did not run. */
export function checkSummary(observations: RecipeObservations): string {
  const { failed, notRun } = checkCounts(observations);
  const ran = notRun ? ` ${notRun} check${notRun === 1 ? "" : "s"} did not run.` : "";
  if (failed) return `${failed} check${failed === 1 ? "" : "s"} failed.${ran}`;
  return notRun ? `No check failed, but ${notRun} did not run.` : "No check failed.";
}

// Characters that do not show, or that change how the text around them is
// shown: controls other than tab and newline, zero-width and bidirectional
// marks, and line separators a terminal would not break on.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff9-\ufffb]/gu;

/** A script as it is shown for review: every hidden character written out as its code point, so nothing is applied unseen. */
export function visibleScript(script: string): string {
  return script.replace(/\r\n/g, "\n").replace(HIDDEN, (character) => `\u27e6U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}\u27e7`);
}

/** How many hidden characters a script holds; a reviewer is told before applying it. */
export function hiddenCharacterCount(script: string): number {
  return script.replace(/\r\n/g, "\n").match(HIDDEN)?.length ?? 0;
}

export const lineCount = (script: string) => (script ? script.split("\n").length : 0);

export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return "";
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function environmentErrorMessage(error: unknown): string {
  const failure = error as Partial<OrganizationEnvironmentError> | null;
  const code = typeof failure?.code === "string" ? failure.code : "";
  switch (code) {
    case "organization_admin_required":
      return "Only organization owners and admins can change the environment.";
    case "cloud_environment_revision_conflict":
      return "The environment was changed since you loaded it. The latest has been loaded; review it and try again.";
    case "cloud_environment_definition_invalid":
      return "That environment is not valid. Check the repositories, branches and setup steps.";
    case "cloud_environment_provider_unsupported":
      return "This provider cannot build environment images yet.";
    case "cloud_environment_build_in_progress":
      return "A build is already waiting or running. Wait for it or cancel it first.";
    case "cloud_environment_rollback_unavailable":
      return "That version can no longer be rolled back to.";
    case "cloud_environment_not_found":
      return "Save the environment before building it.";
    case "cloud_environment_version_not_found":
      return "That version is no longer available.";
    case "cloud_environment_recipe_not_found":
      return "That recipe is no longer available.";
    case "cloud_environment_recipe_not_pending":
      return "That recipe was already applied or dismissed.";
    case "cloud_provisioning_paused":
      return "New cloud machines are paused for this organization, so nothing can be built.";
    case "cloud_provider_connection_required":
    case "cloud_provider_connection_attention_required":
      return "Connect this provider, or fix its connection, before building.";
    case "cloud_provider_not_found":
      return "This provider is not available on this server.";
    case "idempotency_key_reused":
      return "That build was already requested. The list has been refreshed.";
    case "cloud_environment_confirmation_required":
      return "Confirm before continuing.";
    case "cloud_workspace_request_invalid":
      return "The server refused that request as invalid.";
    case "cloud_environment_outcome_unknown":
      return "TerminalX lost the response, so the change may or may not have been applied. The environment has been refreshed; check it before trying again.";
    case "account_context_changed_after_send":
      return "Your account or organization changed while this was saving, so it may have been applied. Check the environment before trying again.";
    case "account_context_changed":
      return "Your account or organization changed. The environment has been refreshed.";
    case "account_signed_out":
      return "Sign in to manage the cloud environment.";
    case "account_organization_unavailable":
    case "active_organization_required":
      return "Select an organization to manage its cloud environment.";
    case "cloud_workspace_not_found":
      return "This organization is no longer available.";
    case "invalid_access_token":
      return "Your session expired. Sign in again.";
    default:
      return "TerminalX could not reach the account service. Try again.";
  }
}

/** Recipes are switched off on this server, or it predates them: the section is simply not offered. */
export const recipesUnavailable = (error: unknown) => (error as Partial<OrganizationEnvironmentError> | null)?.code === "not_found";
