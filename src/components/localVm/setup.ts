import { computerKey, environmentComputer } from "@/types/computer";
import type { LocalVmCreateRequest, LocalVmEnvironment, LocalVmSetupAction, LocalVmSetupActionRequest, LocalVmSetupHarness, LocalVmSetupReadiness, LocalVmSetupReport, LocalVmSetupRequest } from "@/types/localVm";

export const SETUP_ACTIONS: readonly LocalVmSetupAction[] = ["driver.start", "driver.requestPermissions", "provider.codexDeviceLogin.start", "provider.codexDeviceLogin.cancel", "provider.codexAccount.verify", "desktop.verify"];
export type PendingSetup = { kind: "create"; params: LocalVmCreateRequest } | { kind: "setup"; params: LocalVmSetupRequest } | { kind: "action"; harness: LocalVmSetupHarness; loginRequestKey?: string; params: Omit<LocalVmSetupActionRequest, "loginId"> };

export function setupStorageKey(environment?: LocalVmEnvironment): string {
  return `terminalx.local-vm.setup.v1:${environment ? JSON.stringify([environment.id, environment.generation, environment.sandbox]) : "create"}`;
}

export function loadPendingSetup(environment?: LocalVmEnvironment): PendingSetup | null {
  const raw = localStorage.getItem(setupStorageKey(environment));
  if (!raw) return null;
  const saved: PendingSetup = JSON.parse(raw);
  const params = saved?.params;
  if (!params || params.confirm !== true || typeof params.idempotencyKey !== "string" || !params.idempotencyKey || params.idempotencyKey.length > 200) throw new Error("The saved setup request cannot be read. Inspect retained setup history before starting another request.");
  if (saved.kind === "create" && !environment && typeof saved.params.name === "string" && !!saved.params.name.trim() && /^[a-z\d_-]{1,80}$/i.test(saved.params.vmName) && ["codex", "claude"].includes(saved.params.harness)) return saved;
  if (environment && saved.kind !== "create" && saved.params.environmentId === environment.id && saved.params.generation === environment.generation &&
    (saved.kind === "setup" && ["codex", "claude"].includes(saved.params.harness) || saved.kind === "action" && SETUP_ACTIONS.includes(saved.params.action) && ["codex", "claude"].includes(saved.harness) &&
      (saved.params.action !== "provider.codexDeviceLogin.cancel" || typeof saved.loginRequestKey === "string" && !!saved.loginRequestKey))) return saved;
  throw new Error("The saved setup request belongs to different settings or a changed environment. Retain it and inspect setup history.");
}

export function pendingSetupAcknowledged(report: LocalVmSetupReport, pending: PendingSetup): boolean {
  if (report.protocol !== 1) return false;
  const requests = [report, ...(Array.isArray(report.history) ? report.history : [])].filter((prior) =>
    prior?.protocol === 1 && prior.environmentId === report.environmentId && prior.generation === report.generation);
  if (pending.kind === "create") return requests.some((prior) => prior.idempotencyKey === pending.params.idempotencyKey && prior.harness === pending.params.harness);
  if (report.environmentId !== pending.params.environmentId || report.generation !== pending.params.generation) return false;
  if (pending.kind === "setup") return requests.some((prior) => prior.idempotencyKey === pending.params.idempotencyKey && prior.harness === pending.params.harness);
  // The current action can advance before an older view receives its reply.
  // Prefer the keyed canonical receipt; an unknown/malformed operation must
  // never be overridden by an older action snapshot or recovery history.
  const retained = report.operations?.[pending.params.idempotencyKey];
  const receipt = retained === undefined ? report.action : retained?.receipt;
  return report.harness === pending.harness && receipt?.idempotencyKey === pending.params.idempotencyKey &&
    receipt.action === pending.params.action && ["working", "needsAttention", "complete", "failed"].includes(receipt.status);
}

export function setupActions(report: LocalVmSetupReport): LocalVmSetupAction[] {
  const readiness = report.readiness;
  if (!readiness || readiness.manualControl || readiness.activeTaskTargets.length || report.status === "outcomeUnknown") return [];
  // An owned sign-in blocks general effects while its original live actor
  // remains available. Only that actor's advertised cancellation is allowed.
  if (readiness.actionAdmission.state !== "ready") {
    return readiness.actionAdmission.state === "blocked" && readiness.actionAdmission.reasonCode === "guest_setup_helper_exit_unconfirmed" &&
      readiness.actionAdmission.actionCode === "provider.codexDeviceLogin.cancel" && report.harness === "codex" &&
      report.action?.action === "provider.codexDeviceLogin.start" && ["working", "needsAttention"].includes(report.action.status)
      ? ["provider.codexDeviceLogin.cancel"] : [];
  }
  if (report.steps.some((step) => step.id === "runtime" && step.actionCode === "environment.setup")) return [];
  const pending = report.action && ["working", "needsAttention", "outcomeUnknown"].includes(report.action.status);
  const candidates = [...new Set(report.steps.filter((step) => step.state !== "complete").map((step) => step.actionCode).filter((action): action is LocalVmSetupAction => SETUP_ACTIONS.some((candidate) => candidate === action)))];
  return candidates.filter((action) => {
    if (report.creationCapability?.available === false && action !== "provider.codexDeviceLogin.cancel") return false;
    if (report.taskMode === "shellFiles" && (!action.startsWith("provider.codex") || report.steps.find((step) => step.id === "runtime")?.state !== "complete")) return false;
    if (pending && action !== "provider.codexDeviceLogin.cancel") return false;
    if (action === "driver.requestPermissions" && readiness.accessibility.state === "granted" && readiness.screenRecording.state === "granted") return false;
    if (action.startsWith("provider.") && report.harness !== "codex") return false;
    if (action === "provider.codexDeviceLogin.start" && readiness.provider.state === "authenticated") return false;
    return true;
  });
}

export function runtimeUpdateAvailable(report: LocalVmSetupReport): boolean {
  const read = report.readiness;
  return report.creationCapability?.available !== false && report.runtimeUpdateAvailable === true && report.status === "needsAttention" && !!read &&
    !read.manualControl && read.activeTaskTargets.length === 0 && read.actionAdmission.state === "ready" &&
    (!report.action || ["complete", "failed"].includes(report.action.status)) &&
    report.steps.some((step) => step.id === "runtime" && step.state === "waiting" && step.actionCode === "environment.setup");
}

/** The code is shown for deliberate human use; no browser opens or sign-in runs automatically. */
export function deviceLoginUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.origin === "https://auth.openai.com" && !url.username && !url.password && url.pathname === "/codex/device" && !url.search && !url.hash ? url.href : null; }
  catch { return null; }
}

/** Whitelist diagnostic fields; unexpected challenge data must never enter retained-report diagnostics. */
export function setupDiagnostics(report: LocalVmSetupReport) {
  const readiness = report.readiness;
  const check = (value: LocalVmSetupReadiness["capture"]) => ({ state: value.state, reasonCode: value.reasonCode, actionCode: value.actionCode });
  return {
    protocol: report.protocol, environmentId: report.environmentId, generation: report.generation, harness: report.harness,
    status: report.status, lastCheckedAt: report.lastCheckedAt,
    steps: report.steps.map((step) => ({ id: step.id, state: step.state, actionCode: step.actionCode })),
    action: report.action ? { action: report.action.action, idempotencyKey: report.action.idempotencyKey, status: report.action.status } : null,
    readiness: readiness ? { runtime: { version: readiness.runtime.version, state: readiness.runtime.state, identity: { protocol: readiness.runtime.identity.protocol, environmentId: readiness.runtime.identity.environmentId, generation: readiness.runtime.identity.generation } }, driver: { ...check(readiness.driver), installedVersion: readiness.driver.installedVersion, requiredVersion: readiness.driver.requiredVersion, runtimeVersion: readiness.driver.runtimeVersion },
      accessibility: check(readiness.accessibility), screenRecording: check(readiness.screenRecording), session: check(readiness.session),
      desktop: check(readiness.desktop), capture: check(readiness.capture), provider: { ...check(readiness.provider), harness: readiness.provider.harness },
      manualControl: readiness.manualControl, activeTaskTargets: readiness.activeTaskTargets, actionAdmission: check(readiness.actionAdmission) } : null,
  };
}

/** Cached evidence never crosses an environment generation or provider choice. */
export function boundSetupReport(environment: LocalVmEnvironment, retainedReceipt = false): LocalVmSetupReport | null {
  const report = environment.setup;
  if (environment.deletedAt && !retainedReceipt || !report || report.protocol !== 1 || report.environmentId !== environment.id || report.generation !== environment.generation ||
    !["codex", "claude"].includes(report.harness) || !["queued", "working", "needsAttention", "ready", "outcomeUnknown", "failed"].includes(report.status) || !Array.isArray(report.steps)) return null;
  if (environment.transport?.kind === "linuxContainer" && (report.taskMode !== "shellFiles" || !report.computer || computerKey(report.computer) !== computerKey(environmentComputer(environment)))) return null;
  if (report.readiness && !boundReadiness(report.readiness, environment, report.harness)) return null;
  return report;
}

export function boundReadiness(readiness: LocalVmSetupReadiness, environment: LocalVmEnvironment, harness: string): boolean {
  const checks = [readiness.driver, readiness.accessibility, readiness.screenRecording, readiness.session, readiness.desktop, readiness.capture, readiness.provider, readiness.actionAdmission];
  return readiness.protocol === 1 && readiness.environmentId === environment.id && readiness.generation === environment.generation &&
    readiness.runtime?.identity?.environmentId === environment.id && readiness.runtime.identity.generation === environment.generation &&
    readiness.runtime.identity.protocol === 1 && typeof readiness.runtime.version === "string" && typeof readiness.runtime.state === "string" &&
    readiness.provider?.harness === harness && typeof readiness.manualControl === "boolean" && Array.isArray(readiness.activeTaskTargets) &&
    checks.every((check) => check && typeof check.state === "string" && typeof check.reasonCode === "string" && (check.actionCode === null || typeof check.actionCode === "string")) && readiness.driver.runtimeVersion === null;
}

export function setupStatusLabel(report: LocalVmSetupReport): string {
  if (report.creationCapability?.available === false) return "New VM creation unavailable";
  switch (report.status) {
    case "queued": return "Setup queued";
    case "working": return "Setting up your VM";
    case "needsAttention": return "Setup needs your attention";
    case "ready": return report.steps.length > 0 && report.steps.every((step) => step.state === "complete") ? "Setup ready" : "Setup verification incomplete";
    case "outcomeUnknown": return "Setup outcome unknown";
    case "failed": return "Setup could not finish";
    default: return "Setup status unavailable";
  }
}

export function readinessLabel(state: string): string {
  switch (state) {
    case "ready": return "Connected";
    case "running": return "Running";
    case "granted": return "Granted";
    case "authenticated": return "Local sign-in found";
    case "unauthenticated": return "Sign-in needed";
    case "required": return "Your attention is needed";
    case "missing": return "Not installed";
    case "stopped": return "Stopped";
    case "blocked": return "Paused";
    case "notProbed": return "Not checked automatically";
    case "versionMismatch": return "Update needed";
    default: return "Not verified";
  }
}
