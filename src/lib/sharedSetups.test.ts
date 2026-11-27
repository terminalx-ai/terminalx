import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus } from "@/lib/api";
import { setPrefs } from "@/lib/prefs";

const { ready, invoke } = vi.hoisted(() => ({ ready: { on: true }, invoke: vi.fn() }));

function account() {
  return {
    status: {
      state: "signed-in",
      identity: { organizationId: "org-a" },
      organizations: [{ id: "org-a", name: "Fixture Labs", role: "member", isPersonal: false }],
      phase2Readiness: ready.on ? { "org-a": ["team.shared-setups.v1"] } : {},
    } as unknown as AccountStatus,
  };
}
vi.mock("@/lib/account", () => ({ getAccount: account, useAccount: account }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { refreshSharedSetups, withActionPrompt, withNewChatPrompts, sharedSetupsOrg } = await import("@/lib/sharedSetups");

const shared = (prompts: Record<string, string>) => ({
  canEdit: false,
  prompts: Object.fromEntries(Object.entries(prompts).map(([key, body]) => [key, { body, updatedBy: "u", updatedAt: "2026-11-27T00:00:00Z", revision: 1 }])),
});

afterEach(() => {
  ready.on = true;
  invoke.mockReset();
  setPrefs({ actionPrompts: {}, fixErrorsInstructions: "" });
});

describe("action prompts", () => {
  it("sends the organization's prompt first, then the person's own", async () => {
    invoke.mockImplementation((_command: string, { op }: { op: { op: string } }) =>
      Promise.resolve(op.op === "listPrompts" ? shared({ createPr: "Title PRs as PRO-123: what changed.", fixChecks: "Run pnpm check." }) : { snippets: [] }));
    await refreshSharedSetups("org-a");
    setPrefs({ actionPrompts: { createPr: "Keep the body under 200 words." }, fixErrorsInstructions: "Quote the failing line." });
    expect(withActionPrompt("Open a pull request.", "createPr")).toBe(
      "Open a pull request.\n\nAdditional instructions:\nTitle PRs as PRO-123: what changed.\n\nKeep the body under 200 words.");
    expect(withActionPrompt("Fix.", "fixChecks")).toBe("Fix.\n\nAdditional instructions:\nRun pnpm check.\n\nQuote the failing line.");
    expect(withActionPrompt("Review.", "review")).toBe("Review.");
  });

  it("uses only the person's prompts while shared setups are off, and adds branch names to a new chat", () => {
    ready.on = false;
    expect(sharedSetupsOrg(account().status)).toBeNull();
    setPrefs({ actionPrompts: { general: "Prefer small commits.", branchNames: "Use feat/<topic>." } });
    expect(withNewChatPrompts("Fix the login bug")).toBe(
      "Fix the login bug\n\nAdditional instructions:\nPrefer small commits.\n\nWhen you name a branch:\nUse feat/<topic>.");
    expect(invoke).not.toHaveBeenCalled();
  });
});
