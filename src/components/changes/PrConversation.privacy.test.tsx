import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gh } from "@/lib/api";
import { PRIVACY_MESSAGE, refreshDataPrivacy, setDataPrivacy } from "@/lib/dataPrivacy";
import type { PrConversation as Conversation, PrConversationAction } from "@terminalx/portable/workspaceGit";
import type { SessionPr } from "@/lib/sessionPrs";
import { PrConversation } from "./PrConversation";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
const row: SessionPr = { identity: "https://github.com/acme/repo/pull/1", current: true, pr: { number: 1, url: "https://github.com/acme/repo/pull/1", title: "Title", body: "Body", author: "author", state: "OPEN", base: "main", head: "feature", additions: 1, deletions: 0, checks: [], mergeable: "MERGEABLE", isDraft: false, reviewDecision: null } };
const initial = (): Conversation => ({ url: row.identity, title: "Title", body: "Body", author: "author", viewer: "reviewer", state: "OPEN", canEdit: true, reviewers: [{ login: "ada", kind: "user", state: "APPROVED", requested: false }], unresolvedThreads: 2, activity: [] });
let policy: { enabled: boolean; managed: boolean };
let data: Conversation, outcome: "success" | "error" | "readback-error" | "legacy";
let release: (() => void) | undefined;
let mutations: number;
const edited = vi.fn();
const source = { cloud: false, canWrite: true, conversation: () => gh.conversation(row.identity), errorMessage: String };
const view = (refresh = 0) => <PrConversation source={source} row={row} active refresh={refresh} onEdited={edited} />;
const calls = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command).length;
beforeEach(async () => {
  vi.useFakeTimers();
  mocks.invoke.mockReset(); edited.mockReset();
  policy = { enabled: false, managed: false }; data = initial(); mutations = 0; release = undefined;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "data_privacy_set") { policy.enabled = args.enabled as boolean; return policy; }
    if (command === "data_privacy_status") return policy;
    if (policy.enabled) throw new Error(PRIVACY_MESSAGE);
    if (command === "pr_conversation") return structuredClone(data);
    if (command === "pr_reviewer_search") return ["ben"];
    if (command === "pr_conversation_action") {
      const action = args.action as PrConversationAction;
      if (outcome !== "error") {
        mutations++;
        if (action.kind === "edit") { data.title = action.title; data.body = action.body; }
      }
      // Provider mutation/readback completed; delay only the IPC reply.
      const result = outcome === "legacy" ? undefined : { conversation: outcome === "readback-error" ? null : structuredClone(data), error: outcome === "readback-error" ? PRIVACY_MESSAGE : null };
      await new Promise<void>((resolve) => { release = resolve; });
      if (outcome === "error") throw new Error("GitHub refused edit");
      return result;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  await refreshDataPrivacy();
});
afterEach(async () => { cleanup(); policy.enabled = false; policy.managed = false; await refreshDataPrivacy(); vi.useRealTimers(); });

for (const result of ["success", "error", "readback-error", "legacy"] as const) {
  it.each([{ managed: false, cycle: false }, { managed: false, cycle: true }, { managed: true, cycle: false }, { managed: true, cycle: true }])(`does not renew reads/searches from a delayed ${result} reply: %o`, async ({ managed, cycle }) => {
    outcome = result;
    const rendered = render(view());
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Search reviewers"), { target: { value: "ben" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(calls("pr_reviewer_search")).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Edit title and description" }));
    fireEvent.change(screen.getByLabelText("Pull request title"), { target: { value: "Completed title" } });
    fireEvent.change(screen.getByLabelText("Pull request description"), { target: { value: "Completed body" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(release).toBeTypeOf("function");
    expect(mutations).toBe(result === "error" ? 0 : 1);
    await act(async () => {
      if (managed) { policy = { enabled: true, managed: true }; await refreshDataPrivacy(); }
      else await setDataPrivacy(true);
      if (cycle) { policy = { enabled: false, managed: false }; await refreshDataPrivacy(); }
      release!();
    });
    // The 60-second independent background timer has not fired. In particular,
    // a normal error must not restart the existing reviewer-search debounce.
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(calls("pr_conversation")).toBe(1);
    expect(calls("pr_reviewer_search")).toBe(1);
    expect(calls("pr_conversation_action")).toBe(1);
    if (result === "error") {
      expect(screen.getByRole("alert").textContent).toContain("GitHub refused edit");
      expect((screen.getByLabelText("Pull request title") as HTMLInputElement).value).toBe("Completed title");
    } else {
      expect(edited).toHaveBeenCalledWith("Completed title", "Completed body");
      expect(screen.getByText("Completed body")).toBeTruthy();
      expect(screen.queryByLabelText("Pull request title")).toBeNull();
      if (result === "readback-error") expect(screen.getByRole("alert").textContent).toContain(PRIVACY_MESSAGE);
    }
    await act(async () => { policy = { enabled: false, managed: false }; await refreshDataPrivacy(); });
    expect(calls("pr_conversation")).toBe(1);
    rendered.rerender(view(1));
    await act(async () => {});
    expect(calls("pr_conversation")).toBe(2);
    expect(calls("pr_conversation_action")).toBe(1);
  });
}
