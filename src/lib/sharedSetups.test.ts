import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus } from "@/lib/api";
import { setPrefs } from "@/lib/prefs";

const { ready, active, invoke } = vi.hoisted(() => ({ ready: { on: true }, active: { id: "org-a" }, invoke: vi.fn() }));

function account() {
  return {
    status: {
      state: "signed-in",
      identity: { organizationId: active.id },
      organizations: [
        { id: "org-a", name: "Fixture Labs", role: "member", isPersonal: false },
        { id: "org-b", name: "Sample Works", role: "member", isPersonal: false },
        { id: "me", name: "Personal", role: "owner", isPersonal: true },
        { id: "org-c", name: "Third Fixture", role: "member", isPersonal: false },
        { id: "org-d", name: "Fourth Fixture", role: "member", isPersonal: false },
      ],
      phase2Readiness: ready.on ? { "org-a": ["team.shared-setups.v1"], "org-b": ["team.shared-setups.v1"], me: ["team.shared-setups.v1"], "org-c": ["team.shared-setups.v1"], "org-d": ["team.shared-setups.v1"] } : {},
    } as unknown as AccountStatus,
  };
}
vi.mock("@/lib/account", () => ({ getAccount: account, useAccount: account }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { orgLabel, primeSharedPrompts, refreshSharedSetups, refreshStaleSharedSetups, withActionPrompt, withNewChatPrompts, sharedSetupsOrg, SHARED_SETUPS_FRESH_MS } = await import("@/lib/sharedSetups");

const shared = (prompts: Record<string, string>, revision = 1) => ({
  canEdit: false,
  prompts: Object.fromEntries(Object.entries(prompts).map(([key, body]) => [key, { body, updatedBy: "u", updatedAt: "2026-11-27T00:00:00Z", revision }])),
});
const byOrg: Record<string, ReturnType<typeof shared>> = {};

beforeEach(() => {
  byOrg["org-a"] = shared({ createPr: "A: title PRs as PRO-123.", fixChecks: "A: run pnpm check.", general: "A: use pnpm." });
  byOrg["org-b"] = shared({ createPr: "B: title PRs as SW-1.", general: "B: use bun." });
  invoke.mockImplementation((_command: string, { orgId, op }: { orgId: string; op: { op: string } }) =>
    op.op === "listPrompts" ? (byOrg[orgId] ? Promise.resolve(byOrg[orgId]) : Promise.reject(new Error("offline"))) : Promise.resolve({ snippets: [] }));
});

afterEach(() => {
  ready.on = true;
  active.id = "org-a";
  invoke.mockReset();
  vi.useRealTimers();
  setPrefs({ actionPrompts: {}, fixErrorsInstructions: "" });
});

describe("orgLabel", () => {
  it("shortens a long organization name for tabs and scope labels", () => {
    expect(orgLabel("Fixture Labs")).toBe("Fixture Labs");
    expect(orgLabel("The Extremely Long Fixture Organization Name")).toBe("The Extremely Long Fixt…");
    expect([...orgLabel("The Extremely Long Fixture Organization Name")].length).toBeLessThanOrEqual(24);
  });
});

describe("action prompts", () => {
  it("sends the target organization's prompt first, then the person's own", async () => {
    await refreshSharedSetups("org-a");
    setPrefs({ actionPrompts: { createPr: "Keep the body under 200 words." }, fixErrorsInstructions: "Quote the failing line." });
    expect(withActionPrompt("Open a pull request.", "createPr", "cloud:org-a:ws-1:s-1")).toBe(
      "Open a pull request.\n\nAdditional instructions:\nA: title PRs as PRO-123.\n\nKeep the body under 200 words.");
    expect(withActionPrompt("Fix.", "fixChecks", "cloud:org-a:ws-1:s-1")).toBe("Fix.\n\nAdditional instructions:\nA: run pnpm check.\n\nQuote the failing line.");
    expect(withActionPrompt("Review.", "review", "cloud:org-a:ws-1:s-1")).toBe("Review.");
  });

  it("uses the organization the message goes to, not the active one, in both directions", async () => {
    await refreshSharedSetups("org-a");
    await refreshSharedSetups("org-b");
    active.id = "org-a";
    expect(withActionPrompt("PR.", "createPr", "cloud:org-b:ws-9:s-2")).toBe("PR.\n\nAdditional instructions:\nB: title PRs as SW-1.");
    active.id = "org-b";
    expect(withActionPrompt("PR.", "createPr", "cloud:org-a:ws-1:s-1")).toBe("PR.\n\nAdditional instructions:\nA: title PRs as PRO-123.");
    expect(withNewChatPrompts("Fix the bug", "cloud:org-a")).toBe("Fix the bug\n\nAdditional instructions:\nA: use pnpm.");
  });

  it("gives local, machine and personal sessions no organization's prompts, only the person's", async () => {
    await refreshSharedSetups("org-a");
    setPrefs({ actionPrompts: { general: "Prefer small commits.", branchNames: "Use feat/<topic>." } });
    for (const target of ["local-session-1", "machine:host:s-1", "cloud:me:ws:s", null])
      expect(withNewChatPrompts("Fix the login bug", target)).toBe(
        "Fix the login bug\n\nAdditional instructions:\nPrefer small commits.\n\nWhen you name a branch:\nUse feat/<topic>.");
    expect(withActionPrompt("PR.", "createPr", "/repos/app")).toBe("PR.");
  });

  it("waits for an organization's prompts on the first send to it, but not past the timeout", async () => {
    byOrg["org-c"] = shared({ createPr: "C: link the issue." });
    active.id = "org-a";
    await primeSharedPrompts("cloud:org-c:ws:s");
    expect(withActionPrompt("PR.", "createPr", "cloud:org-c:ws:s")).toBe("PR.\n\nAdditional instructions:\nC: link the issue.");
    // A server that never answers holds the send only for the timeout.
    invoke.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    await primeSharedPrompts("cloud:org-d:ws:s", 20);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(withActionPrompt("PR.", "createPr", "cloud:org-d:ws:s")).toBe("PR.");
    // Local sessions never wait.
    invoke.mockClear();
    await primeSharedPrompts("local-1");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses only the person's prompts while shared setups are off", () => {
    ready.on = false;
    expect(sharedSetupsOrg(account().status)).toBeNull();
    expect(withActionPrompt("PR.", "createPr", "cloud:org-a:ws-1:s-1")).toBe("PR.");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reads an admin's change again after a few minutes, and keeps the last copy while offline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await refreshSharedSetups("org-a");
    byOrg["org-a"] = shared({ createPr: "A: new rule." }, 2);
    expect(withActionPrompt("PR.", "createPr", "cloud:org-a:w:s")).toContain("A: title PRs as PRO-123.");
    vi.setSystemTime(Date.now() + SHARED_SETUPS_FRESH_MS);
    refreshStaleSharedSetups();
    await refreshSharedSetups("org-a");
    expect(withActionPrompt("PR.", "createPr", "cloud:org-a:w:s")).toBe("PR.\n\nAdditional instructions:\nA: new rule.");
    delete byOrg["org-a"];
    vi.setSystemTime(Date.now() + SHARED_SETUPS_FRESH_MS);
    refreshStaleSharedSetups();
    await refreshSharedSetups("org-a");
    expect(withActionPrompt("PR.", "createPr", "cloud:org-a:w:s")).toBe("PR.\n\nAdditional instructions:\nA: new rule.");
  });
});
