import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";
import type { Payload } from "@/types/events";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set<string>() }));
vi.mock("@/lib/changes", () => ({ changeRange: () => ({}), useChanges: () => ({ files: [] }) }));
// The real module's exports with its state held empty, so new tab-view fields arrive with their defaults.
vi.mock("@/lib/tabViews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tabViews")>()),
  useTabViews: () => ({ views: {}, errors: {}, info: {}, switching: {}, waiting: {} }), isPtyFirst: () => true, startTabAgent: vi.fn(),
  clearTabViewError: vi.fn(), forgetTabView: vi.fn(), leaveTerminalView: vi.fn(), enterTerminalView: vi.fn(), cancelTerminalView: vi.fn(),
}));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: () => null }));
// The empty chat's canvas animation needs a 2D context jsdom does not have.
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonScene: () => null, RaccoonRunner: () => null }));
vi.mock("@/components/chat/Composer", () => ({ Composer: ({ agentHandoff }: { agentHandoff?: { name: string; run?: () => void; unavailable?: string } }) => agentHandoff ? <button disabled={!agentHandoff.run} title={agentHandoff.unavailable} onClick={agentHandoff.run}>Hand off to {agentHandoff.name}</button> : null }));

import { TabDialogs } from "./TabDialogs";
import { TabView } from "./TabView";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyEvent } from "@/lib/agentEvents";
import { refreshHarnesses, upsertSession } from "@/lib/sessions";
import { closeAgentHandoff, useDialogs } from "@/lib/dialogs";
import { HANDOFF_OLD_RUNTIME, localSessionBackend, REMOTE_UNAVAILABLE, RESEND_ATTACHMENTS, type HandoffActions, type SessionBackend } from "@/lib/sessionBackend";
import { getErrorToasts } from "@/lib/errorToasts";
import { getDraft, setDraft } from "@/lib/drafts";

let seq = 0;
let session: SessionEntry;
const emit = (payload: Payload) => act(() => applyEvent({ id: `e${++seq}`, seq, sessionId: session.id, tabId: session.tabs[0].id, harness: session.tabs[0].harness, ts: new Date().toISOString(), payload }));
function Harness({ dialogs = false }: { dialogs?: boolean }) {
  const request = useDialogs().agentHandoff;
  return <TooltipProvider><TabView session={session} tab={session.tabs[0]} active />{dialogs && <TabDialogs />}<output data-testid="request">{JSON.stringify(request)}</output></TooltipProvider>;
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

it.each([undefined, "experimentalCodexStdio"] as const)("hands off a %s source and reviews its historical turn without touching its draft or sending to it", async (transport) => {
  session.tabs[0].transport = transport;
  upsertSession(session);
  render(<Harness />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("load_tab_events", expect.anything()));
  fireEvent.click(screen.getByRole("button", { name: "Hand off to Claude Code" }));
  expect(request()).toMatchObject({ session: { id: session.id, cwd: session.cwd }, source: { id: session.tabs[0].id }, harness: "claude" });
  expect(request().source.transport).toBe(transport);
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
  // Lists are empty; anything else answers as the backend does with nothing,
  // so a turn's checkpoint, read after the turn ends, is null rather than [].
  mocks.invoke.mockImplementation(async (command: string) => command === "list_harnesses" ? [{ id: "codex", name: "Codex", available: true }]
    : ["load_tab_events", "list_workspaces", "list_models"].includes(command) ? [] : null);
  await refreshHarnesses();
  render(<Harness />);
  emit({ type: "user_message", queued: false, text: "Prompt" });
  emit({ type: "assistant_text", text: "Answer" });
  emit({ type: "turn_completed", status: "ok", authFailed: false });
  expect(screen.queryByRole("button", { name: /Hand off/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Second opinion" })).toBeNull();
});


it.each([
  { text: "Inspect these attachments", image: true, file: true },
  { text: "Inspect this image", image: true, file: false },
  { text: "Read this file", image: false, file: true },
  { text: "", image: true, file: false },
  { text: "", image: false, file: true },
  { text: "Text only", image: false, file: false },
])("retries $text (images: $image, files: $file) through the attachment-capable native request", async ({ text, image, file }) => {
  const images = image ? [{ url: "/saved/one.png", name: "one.png" }, { url: "/saved/two.png", name: "two.png" }] : [];
  const files = file ? [{ path: "/saved/notes.md", name: "notes.md", mediaType: "text/markdown", size: 12 }] : [];
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "read_image_file") return { mediaType: "image/png", data: args.path === images[0].url ? "b25l" : "dHdv", name: "stored.png" };
    if (command === "add_tab") return { ...session.tabs[0], id: "retry-tab" };
    if (command === "send_message") return { events: [] };
    return original(command, args);
  });
  render(<Harness dialogs />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("load_tab_events", expect.anything()));
  emit({ type: "user_message", queued: false, text, images, files });
  emit({ type: "error", message: "Request failed", fatal: true });
  emit({ type: "turn_completed", status: "error", authFailed: false });
  fireEvent.click(await screen.findByRole("button", { name: "Retry in a new chat" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("send_message", expect.objectContaining({
    sessionId: session.id, tabId: "retry-tab", text, ...(file ? { files } : {}),
    // send_message routes true to text-only send_confirmed (and rejects files).
    // false selects send_pressed, the same attachment-aware path as the composer.
    confirmDelivery: !image && !file,
    images: image ? [{ mediaType: "image/png", data: "b25l", name: "one.png" }, { mediaType: "image/png", data: "dHdv", name: "two.png" }] : file ? [] : null,
  })));
  expect(getDraft(session.tabs[0].id)).toBe("Keep my draft");
});

it("explains an unavailable image instead of sending a partial retry", async () => {
  render(<Harness dialogs />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("load_tab_events", expect.anything()));
  emit({ type: "user_message", queued: false, text: "Inspect", images: [{ url: "/missing.png", name: "missing.png" }] });
  emit({ type: "error", message: "Request failed", fatal: true });
  emit({ type: "turn_completed", status: "error", authFailed: false });
  fireEvent.click(await screen.findByRole("button", { name: "Retry in a new chat" }));
  expect(await screen.findByText(/Cannot retry attachment.*missing.png/)).toBeTruthy();
  expect(mocks.invoke.mock.calls.filter(([command]) => ["add_tab", "send_message"].includes(command))).toEqual([]);
});

describe("on a remote session (#1327)", () => {
  // A runtime that lists Claude Code and Codex (`agents/1`), each with one model.
  const agent = (id: string, name: string, model: string) => ({ id, name, caps: {}, modes: [], defaultMode: "default",
    models: [{ id: model, label: model, efforts: [], defaultEffort: null, acceptsImages: true, isDefault: true, upgrade: null, description: null }] });
  const connection = { state: "connected", runtimeGeneration: 1, runtimeVersion: "1", capabilities: ["agents/1", "handoff/1"], authority: "manage" };
  const modelClient = { connection, onState: () => () => {}, hasCapability: (capability: string) => capability === "agents/1",
    listRuntimeAgents: async () => [agent("claude", "Claude Code", "opus"), agent("codex", "Codex", "gpt-6")] };
  function remote(handoff?: HandoffActions): SessionBackend {
    const local = localSessionBackend(session.id);
    return { ...local, kind: "cloud", key: `cloud:o:w:${session.id}`, caps: { ...local.caps, local: false, recovery: false }, modelClient: modelClient as never,
      handoff, unavailable: handoff ? REMOTE_UNAVAILABLE : { ...REMOTE_UNAVAILABLE, ...HANDOFF_OLD_RUNTIME } };
  }
  const actions = () => ({ open: vi.fn(async () => ({ tabId: "tab-review", startError: null })), context: vi.fn(async () => ({
    sessionId: session.id, tabId: session.tabs[0].id, title: "Work", provider: "codex", providerSessionId: "c-1", cwd: "/home/vm/work",
    sourceActive: false, transcriptPath: "/home/vm/.codex/sessions/c-1.jsonl", fullUnavailableReason: null, lastPrompt: "Ship it", lastUpdate: null, partialCapture: null,
  })) });
  const view = (backend: SessionBackend) => render(<TooltipProvider><TabView session={session} tab={session.tabs[0]} active backend={backend} /></TooltipProvider>);
  const turn = (prompt: Record<string, unknown>, failed = false) => {
    emit({ type: "user_message", queued: false, ...prompt } as Payload);
    if (failed) emit({ type: "error", message: "Request failed", fatal: true });
    else emit({ type: "assistant_text", text: "The answer" });
    emit({ type: "turn_completed", status: failed ? "error" : "ok", authFailed: false });
  };
  const nothingLocal = () => expect(mocks.invoke.mock.calls.filter(([command]) => ["add_tab", "send_message"].includes(command))).toEqual([]);

  it("a second opinion goes to the runtime's other agent on Plan, in one call", async () => {
    const handoff = actions();
    view(remote(handoff));
    turn({ text: "Fix the build" });
    fireEvent.click(await screen.findByRole("button", { name: "Second opinion" }));
    await waitFor(() => expect(handoff.open).toHaveBeenCalledOnce());
    const [opened] = handoff.open.mock.calls[0] as unknown as [{ agent: string; mode: string; model: string; prompt: string }];
    expect([opened.agent, opened.mode, opened.model]).toEqual(["claude", "plan", "opus"]);
    expect(opened.prompt).toContain("Fix the build");
    expect(opened.prompt).toContain("The answer");
    expect(getDraft(session.tabs[0].id)).toBe("Keep my draft");
    nothingLocal();
  });

  it("the composer hands the conversation to the other agent, read on the runtime", async () => {
    const handoff = actions();
    view(remote(handoff));
    fireEvent.click(await screen.findByRole("button", { name: "Hand off to Claude Code" }));
    expect(await screen.findByText(/that carries over this tab's conversation/)).toBeTruthy();
    expect(handoff.context).toHaveBeenCalledWith(session.tabs[0].id);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(handoff.open).toHaveBeenCalledOnce());
    const [opened] = handoff.open.mock.calls[0] as unknown as [{ agent: string; prompt: string }];
    expect(opened.agent).toBe("claude");
    expect(opened.prompt).toContain("/home/vm/.codex/sessions/c-1.jsonl");
    nothingLocal();
  });

  it("Retry in a new chat sends the failed prompt to the tab's own agent; one with attachments says why instead", async () => {
    const handoff = actions();
    view(remote(handoff));
    turn({ text: "Run the tests" }, true);
    fireEvent.click(await screen.findByRole("button", { name: "Retry in a new chat" }));
    await waitFor(() => expect(handoff.open).toHaveBeenCalledOnce());
    expect(handoff.open.mock.calls[0]).toEqual([expect.objectContaining({ agent: "codex", model: "gpt-6", mode: "plan", prompt: "Run the tests" })]);
    cleanup();
    view(remote(handoff));
    turn({ text: "Look at this", images: [{ url: "https://example.test/a.png", name: "a.png" }] }, true);
    fireEvent.click(await screen.findByRole("button", { name: "Retry in a new chat" }));
    await waitFor(() => expect(getErrorToasts().some((toast) => toast.action === "Couldn't retry in a new chat" && toast.cause === RESEND_ATTACHMENTS)).toBe(true));
    expect(handoff.open).toHaveBeenCalledOnce();
    nothingLocal();
  });

  it("a runtime that cannot take a handoff shows the composer's handoff off, with why", async () => {
    view(remote());
    const handOff = await screen.findByRole("button", { name: "Hand off to Claude Code" });
    expect((handOff as HTMLButtonElement).disabled).toBe(true);
    expect(handOff.getAttribute("title")).toBe(HANDOFF_OLD_RUNTIME.agentHandoff);
  });
});
