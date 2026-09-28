import { describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceClientError, CloudWorkspaceSnapshot } from "@/lib/api";
import {
  CreateRefused,
  createErrorMessage,
  createWorkspace,
  failureMessage,
  launchLatency,
  phaseOf,
  validBranch,
  validateForm,
  type CreateApi,
  type CreateForm,
  type PendingCreate,
} from "./cloudCreate";

const form = (patch: Partial<CreateForm> = {}): CreateForm => ({
  name: "Fix login",
  provider: "box",
  repositories: [
    { cloneUrl: "https://github.com/acme/app.git", fullName: "acme/app", ref: "main" },
    { cloneUrl: "https://github.com/acme/lib.git", fullName: "acme/lib", ref: "" },
  ],
  prompt: "Fix the login",
  agent: "claude",
  model: "sonnet",
  effort: "high",
  mode: "acceptEdits",
  accessMode: "private",
  ...patch,
});

const snapshot = (patch: { workspace?: object; operation?: object } = {}): CloudWorkspaceSnapshot =>
  ({
    workspace: { id: "ws-1", orgId: "org-1", name: "Fix login", provider: "box", state: "provisioning", accessMode: "private", createdAt: 1, updatedAt: 1, releaseDisposition: null, ...patch.workspace },
    operation: { id: "op-1", workspaceId: "ws-1", type: "create", action: null, state: "queued", stage: "queued", cancelable: true, createdAt: 1, updatedAt: 1, lastProviderContactAt: null, nextAttemptAt: null, retryReason: null, errorCode: null, progress: null, events: null, ...patch.operation },
  }) as CloudWorkspaceSnapshot;

const launch = (phase: string, extra: object = {}) => ({
  launchId: "launch_1", phase, state: "pending", workBranch: "terminalx/fix-login-3f9a2c1b7d4e", agent: "claude", model: null, effort: null, mode: null,
  hasPrompt: true, category: null, sessionId: null, tabId: null,
  timings: { requestedAt: 1000, bootingAt: null, authenticatingAt: null, syncingAt: null, startingAgentAt: null, runningAt: null, failedAt: null },
  ...extra,
});

function fakeApi(overrides: Partial<CreateApi> = {}) {
  const calls: string[] = [];
  const api: CreateApi = {
    cloudWorkspacePreflight: vi.fn(async () => {
      calls.push("preflight");
      return { ready: true, checks: [{ kind: "repository", cloneUrl: "https://github.com/acme/app.git", status: "verified" as const, errorCode: null, retryable: false }] };
    }),
    cloudWorkspaceSetup: vi.fn(async () => {
      calls.push("setup");
      return { defaults: { sourceId: "s", locationId: "l", machineClassId: "m", idleSuspendMinutes: 10, retentionDays: 30, networkPolicy: "relay-only" } } as never;
    }),
    cloudWorkspaceQuote: vi.fn(async () => {
      calls.push("quote");
      return { id: "quote-1" } as never;
    }),
    cloudWorkspaceCreate: vi.fn(async () => {
      calls.push("create");
      return snapshot();
    }),
    ...overrides,
  };
  return { api, calls };
}

const clientError = (code: string, retryWithSameIdempotencyKey: boolean): CloudWorkspaceClientError =>
  ({ code, status: null, retryable: false, retryAfterSeconds: null, retryWithSameIdempotencyKey, requiresOriginalAccountContext: false }) as CloudWorkspaceClientError;

describe("validation", () => {
  it("follows git's branch rules", () => {
    for (const good of ["main", "feature/fast-launch", "release-1.2"]) expect(validBranch(good)).toBe(true);
    for (const bad of ["", "-x", "a..b", "a b", "a~1", "a:b", "a.lock", "a/", "/a", ".a", "a//b", "a@{1}", "@"]) expect(validBranch(bad)).toBe(false);
  });

  it("checks names, refs, duplicates, count and prompt size before anything is sent", () => {
    expect(validateForm(form())).toEqual({});
    expect(validateForm(form({ name: "  " })).name).toBeTruthy();
    expect(validateForm(form({ provider: null })).provider).toBeTruthy();
    expect(validateForm(form({ repositories: [{ cloneUrl: "https://github.com/acme/app.git", fullName: "acme/app", ref: "bad..ref" }] }))["ref:0"]).toBeTruthy();
    expect(
      validateForm(form({ repositories: [form().repositories[0], { ...form().repositories[0], cloneUrl: "https://github.com/ACME/app" }] })).repositories,
    ).toMatch(/twice/);
    expect(validateForm(form({ repositories: Array.from({ length: 6 }, (_, i) => ({ cloneUrl: `https://github.com/acme/r${i}.git`, fullName: `acme/r${i}`, ref: "" })) })).repositories).toBeTruthy();
    expect(validateForm(form({ prompt: "é".repeat(16 * 1024 + 1) })).prompt).toBeTruthy();
  });
});

describe("createWorkspace", () => {
  it("checks, quotes and creates with the repositories and launch intent", async () => {
    const { api, calls } = fakeApi();
    const steps: string[] = [];
    const kept: (PendingCreate | null)[] = [];
    await createWorkspace(api, form(), { onStep: (step) => steps.push(step), onPending: (p) => kept.push(p), newKey: () => "key-1", now: () => 5 });
    expect(calls).toEqual(["preflight", "setup", "quote", "create"]);
    expect(steps).toEqual(["checking", "quoting", "creating"]);
    expect(api.cloudWorkspacePreflight).toHaveBeenCalledWith([
      { cloneUrl: "https://github.com/acme/app.git", ref: "main" },
      { cloneUrl: "https://github.com/acme/lib.git", ref: null },
    ]);
    expect(api.cloudWorkspaceCreate).toHaveBeenCalledWith({
      name: "Fix login",
      quoteId: "quote-1",
      accessMode: "private",
      confirmProviderSpend: true,
      idempotencyKey: "key-1",
      repositories: [
        { cloneUrl: "https://github.com/acme/app.git", ref: "main" },
        { cloneUrl: "https://github.com/acme/lib.git", ref: null },
      ],
      launch: { agent: "claude", model: "sonnet", effort: "high", mode: "acceptEdits", prompt: "Fix the login" },
    });
    // Kept while in flight, dropped once the server answered.
    expect(kept.at(0)?.idempotencyKey).toBe("key-1");
    expect(kept.at(-1)).toBeNull();
  });

  it("stops at a failed preflight without quoting", async () => {
    const { api, calls } = fakeApi({
      cloudWorkspacePreflight: vi.fn(async () => ({
        ready: false,
        checks: [{ kind: "repository", cloneUrl: "https://github.com/acme/app.git", status: "failed" as const, errorCode: "cloud_workspace_repository_ref_not_found", retryable: false }],
      })),
    });
    const refused = await createWorkspace(api, form()).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CreateRefused);
    expect((refused as CreateRefused).code).toBe("cloud_workspace_repository_ref_not_found");
    expect(calls).toEqual([]);
    expect(createErrorMessage("cloud_workspace_repository_ref_not_found", "https://github.com/acme/app.git")).toContain("acme/app");
  });

  it("never quotes an invalid form", async () => {
    const { api, calls } = fakeApi();
    await expect(createWorkspace(api, form({ repositories: [{ ...form().repositories[0], ref: "-evil" }] }))).rejects.toBeInstanceOf(CreateRefused);
    expect(calls).toEqual([]);
  });

  it("keeps the exact request after an unknown outcome and resends it unchanged", async () => {
    const create = vi.fn().mockRejectedValueOnce(clientError("cloud_workspace_create_outcome_unknown", true)).mockResolvedValueOnce(snapshot());
    const { api, calls } = fakeApi({ cloudWorkspaceCreate: create });
    let kept: PendingCreate | null = null;
    await expect(createWorkspace(api, form(), { onPending: (p) => (kept = p), newKey: () => "key-1" })).rejects.toMatchObject({ code: "cloud_workspace_create_outcome_unknown" });
    expect(kept).not.toBeNull();
    // The retry: no new preflight or quote, the same key and body.
    await createWorkspace(api, form({ prompt: "edited since" }), { pending: kept, onPending: (p) => (kept = p) });
    expect(calls).toEqual(["preflight", "setup", "quote"]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).toEqual(create.mock.calls[0][0]);
    expect(kept).toBeNull();
  });

  it("drops the request after a definite refusal such as the quota", async () => {
    const { api } = fakeApi({ cloudWorkspaceCreate: vi.fn().mockRejectedValue(clientError("cloud_workspace_quota_exceeded", false)) });
    let kept: PendingCreate | null | undefined;
    await expect(createWorkspace(api, form(), { onPending: (p) => (kept = p) })).rejects.toMatchObject({ code: "cloud_workspace_quota_exceeded" });
    expect(kept).toBeNull();
    expect(createErrorMessage("cloud_workspace_quota_exceeded")).toMatch(/limit/);
    expect(createErrorMessage("cloud_workspace_policy_denied")).toMatch(/policy/);
    expect(createErrorMessage("cloud_provisioning_paused")).toMatch(/paused/);
  });
});

describe("phases", () => {
  it("uses the server's launch phase", () => {
    expect(phaseOf(snapshot({ workspace: { launch: launch("syncing-repository") } }))).toBe("syncing-repository");
    expect(phaseOf(snapshot({ workspace: { state: "ready", launch: launch("running") } }))).toBe("running");
  });

  it("places a workspace without a launch intent from its operation", () => {
    expect(phaseOf(snapshot({ operation: { stage: "creating-machine", state: "running" } }))).toBe("allocating");
    expect(phaseOf(snapshot({ operation: { stage: "bootstrapping", state: "running" } }))).toBe("booting");
    expect(phaseOf(snapshot({ operation: { stage: "connecting-relay", state: "running" } }))).toBe("authenticating-runtime");
    expect(phaseOf(snapshot({ workspace: { state: "ready" }, operation: { stage: "ready", state: "succeeded" } }))).toBe("running");
    expect(phaseOf(snapshot({ operation: { state: "canceled" } }))).toBe("canceled");
    expect(phaseOf(snapshot({ workspace: { state: "attention-required" }, operation: { state: "failed" } }))).toBe("failed");
  });

  it("explains failures and measures the launch", () => {
    expect(failureMessage(snapshot({ workspace: { launch: launch("failed", { category: "agent-unavailable" }) } }))).toMatch(/not installed/);
    expect(failureMessage(snapshot({ workspace: { launch: launch("failed", { category: "runtime-interrupted" }) } }))).toMatch(/may not have been sent/);
    expect(failureMessage(snapshot({ operation: { state: "failed", errorCode: "provider_retry_exhausted" } }))).toMatch(/provider_retry_exhausted/);
    const running = snapshot({ workspace: { launch: launch("running", { timings: { ...launch("running").timings, runningAt: 7400 } }) } });
    expect(launchLatency(running)).toBe(6400);
  });
});
