import type { LocalVmSetupReadiness, LocalVmSetupReport } from "@/types/localVm";
import { environment } from "./localVm.testSupport";

export function setupReadiness(overrides: Partial<LocalVmSetupReadiness> = {}): LocalVmSetupReadiness {
  const check = { state: "unknown", reasonCode: "not_verified", actionCode: null };
  return {
    protocol: 1, environmentId: environment.id, generation: environment.generation,
    runtime: { version: "test-version", identity: { protocol: 1, environmentId: environment.id, generation: environment.generation }, state: "ready" },
    driver: { ...check, state: "running", installedVersion: "0.28.0", requiredVersion: "0.28.0", runtimeVersion: null },
    accessibility: { ...check, state: "granted" }, screenRecording: { ...check, state: "granted" },
    session: { ...check }, desktop: { ...check }, capture: { ...check, state: "notProbed" },
    provider: { ...check, harness: "codex", state: "authenticated", evidence: "localFileLoginStatus" },
    manualControl: false, activeTaskTargets: [], actionAdmission: { ...check, state: "ready" }, ...overrides,
  };
}

export function setupReport(overrides: Partial<LocalVmSetupReport> = {}): LocalVmSetupReport {
  return { protocol: 1, environmentId: environment.id, generation: environment.generation, harness: "codex", status: "needsAttention",
    steps: [{ id: "runtime", label: "Install guest tools", state: "complete" }, { id: "desktop", label: "Verify desktop access", state: "waiting", actionCode: "desktop.verify" }],
    readiness: setupReadiness(), lastCheckedAt: "2026-10-25T15:00:00Z", detail: "Verify desktop access when you are ready.", ...overrides };
}
