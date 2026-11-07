import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";
import type { Payload } from "@/types/events";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set<string>() }));
vi.mock("@/lib/changes", () => ({ changeRange: () => ({}), useChanges: () => ({ files: [] }) }));
vi.mock("@/lib/tabViews", () => ({
  useTabViews: () => ({ views: {}, errors: {}, info: {}, switching: {} }), isPtyFirst: () => true, startTabAgent: vi.fn(),
  clearTabViewError: vi.fn(), forgetTabView: vi.fn(), leaveTerminalView: vi.fn(),
}));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: () => null }));
vi.mock("@/components/chat/Composer", () => ({ Composer: ({ agentHandoff }: { agentHandoff?: { name: string; run: () => void } }) => agentHandoff ? <button onClick={agentHandoff.run}>Hand off to {agentHandoff.name}</button> : null }));

import { TabView } from "./TabView";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyEvent } from "@/lib/agentEvents";
import { refreshHarnesses, upsertSession } from "@/lib/sessions";
import { closeAgentHandoff, useDialogs } from "@/lib/dialogs";
import { getDraft, setDraft } from "@/lib/drafts";

let seq = 0;
let session: SessionEntry;
const emit = (payload: Payload) => act(() => applyEvent({ id: `e${++seq}`, seq, sessionId: session.id, tabId: session.tabs[0].id, harness: session.tabs[0].harness, ts: new Date().toISOString(), payload }));
function Harness() {
  const request = useDialogs().agentHandoff;
  return <TooltipProvider><TabView session={session} tab={session.tabs[0]} active /><output data-testid="request">{JSON.stringify(request)}</output></TooltipProvider>;
}
const request = () => JSON.parse(screen.getByTestId("request").textContent!);

beforeEach(async () => {
  closeAgentHandoff();
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  session = { id: `session-${++seq}`, projectPath: "/repo", cwd: "/repo/.worktrees/feature", title: "Work", created: "", modified: "", archived: false, pinned: false, worktreeRemoved: false,
    tabs: [{ id: `tab-${seq}`, harness: "codex", model: "gpt-6", permissionMode: "plan", status: "completed", created: "", modified: "" }] };
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "list_harnesses") return [{ id: "claude", name: "Claude Code", available: true }, { id: "codex", name: "Codex", available: true }];
    if (["load_tab_events", "list_workspaces", "list_models"].includes(command)) return [];
  });
  upsertSession(session);
  await refreshHarnesses();
  setDraft(session.tabs[0].id, "Keep my draft");
});
afterEach(() => { cleanup(); closeAgentHandoff(); vi.unstubAllGlobals(); });

it("hands off the source and reviews the clicked historical turn without touching its draft or sending to it", async () => {
  render(<Harness />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("load_tab_events", expect.anything()));
  fireEvent.click(screen.getByRole("button", { name: "Hand off to Claude Code" }));
  expect(request()).toMatchObject({ session: { id: session.id, cwd: session.cwd }, source: { id: session.tabs[0].id }, harness: "claude" });
  act(() => closeAgentHandoff());
  emit({ type: "user_message", queued: false, text: "First prompt" });
  emit({ type: "assistant_text", text: "First answer" });
  emit({ type: "turn_completed", status: "ok", authFailed: false });
  emit({ type: "user_message", queued: false, text: "Second prompt" });
  emit({ type: "assistant_text", text: "Second answer" });
  emit({ type: "turn_completed", status: "ok", authFailed: false });
  const reviews = await screen.findAllByRole("button", { name: "Second opinion" });
  fireEvent.click(reviews[0]);
  const review = request();
  expect(review.harness).toBe("claude");
  expect(review.reviewPrompt).toContain("First prompt");
  expect(review.reviewPrompt).toContain("First answer");
  expect(review.reviewPrompt).not.toContain("Second prompt");
  expect(getDraft(session.tabs[0].id)).toBe("Keep my draft");
  expect(mocks.invoke.mock.calls.filter(([command]) => ["send_message", "stop_tab", "set_model", "set_effort"].includes(command))).toEqual([]);
});

it("hides both actions when the other agent is not installed", async () => {
  mocks.invoke.mockImplementation(async (command: string) => command === "list_harnesses" ? [{ id: "codex", name: "Codex", available: true }] : []);
  await refreshHarnesses();
  render(<Harness />);
  emit({ type: "user_message", queued: false, text: "Prompt" });
  emit({ type: "assistant_text", text: "Answer" });
  emit({ type: "turn_completed", status: "ok", authFailed: false });
  expect(screen.queryByRole("button", { name: /Hand off/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Second opinion" })).toBeNull();
});
