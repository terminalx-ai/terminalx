import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry, TabEntry } from "@/types/session";
import type { ContinuationContext } from "@/lib/continuation";
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), providers: vi.fn(), launch: vi.fn() }));
vi.mock("@/lib/api", () => ({ agent: { prepareContinuation: mocks.prepare }, api: { listHarnesses: mocks.providers }, errorMessage: String }));
vi.mock("@/lib/continuation", async (original) => ({ ...await original<typeof import("@/lib/continuation")>(), launchContinuation: mocks.launch }));
vi.mock("@/lib/prefs", () => ({ getPrefs: () => ({ lastAgent: "codex" }) }));
vi.mock("@/lib/sessions", () => ({ addTab: vi.fn() }));
vi.mock("@/lib/agentEvents", () => ({ applyEvent: vi.fn() }));
vi.mock("@/lib/drafts", () => ({ setDraft: vi.fn() }));
import { ContinuationDialog } from "./ContinuationDialog";
const source = { id: "source", harness: "claude", title: "Fix issue", status: "waiting" } as TabEntry;
const session = { id: "workspace", cwd: "/same/cwd", title: "Workspace" } as SessionEntry;
const context: ContinuationContext = { sessionId: session.id, tabId: source.id, title: "Fix issue", cwd: session.cwd, provider: "claude", providerSessionId: "original", sourceActive: true, transcriptPath: "/history.jsonl", fullUnavailableReason: null, lastPrompt: "Fix issue", lastUpdate: "Halfway", partialCapture: null };
const providers = [{ id: "claude", name: "Claude Code", available: true }, { id: "codex", name: "Codex", available: true }];
beforeEach(() => { vi.resetAllMocks(); mocks.prepare.mockResolvedValue(context); mocks.providers.mockResolvedValue(providers); });
afterEach(cleanup);
function open(onClose = vi.fn()) { return { ...render(<ContinuationDialog session={session} source={source} onClose={onClose} />), onClose }; }
async function loaded() { await waitFor(() => expect(screen.getByRole("button", { name: "Start New Session" }).hasAttribute("disabled")).toBe(false)); }
it("shows accessible source details, source preference, focused default and active-turn notice", async () => {
  open(); await loaded();
  expect(screen.getByRole("dialog").getAttribute("aria-labelledby")).toBeTruthy();
  expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe("claude");
  expect((screen.getByRole("radio", { name: /Focused handoff/ }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText("/same/cwd")).toBeTruthy();
  expect(screen.getByText(/Source work may still be progressing/)).toBeTruthy();
});
it("falls back to configured provider and disables full mode with an explanation", async () => {
  mocks.providers.mockResolvedValue([{ ...providers[0], available: false }, providers[1]]);
  mocks.prepare.mockResolvedValue({ ...context, transcriptPath: null, fullUnavailableReason: "Saved history is unreadable.", partialCapture: "Partial recent history" });
  open(); await loaded();
  expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe("codex");
  expect(screen.getByRole("radio", { name: /Full session transcript/ }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Saved history is unreadable.")).toBeTruthy();
});
it.each(["detection", "none", "context"])("shows %s failure without allowing a launch", async (failure) => {
  if (failure === "detection") mocks.providers.mockRejectedValue(new Error("probe failed"));
  if (failure === "none") mocks.providers.mockResolvedValue([]);
  if (failure === "context") mocks.prepare.mockRejectedValue(new Error("No usable context"));
  open(); await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Start New Session" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(mocks.launch).not.toHaveBeenCalled();
});
it("allows cancellation while loading and ignores the late result", async () => {
  let resolve!: (value: ContinuationContext) => void;
  mocks.prepare.mockReturnValue(new Promise((done) => { resolve = done; }));
  const view = open();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(view.onClose).toHaveBeenCalledTimes(1);
  view.unmount(); resolve(context);
  expect(mocks.launch).not.toHaveBeenCalled();
});
it("prevents duplicate starts and closes only on delivered success", async () => {
  let resolve!: (value: unknown) => void;
  mocks.launch.mockReturnValue(new Promise((done) => { resolve = done; }));
  const view = open(); await loaded();
  const button = screen.getByRole("button", { name: "Start New Session" });
  fireEvent.click(button); fireEvent.click(button);
  expect(mocks.launch).toHaveBeenCalledTimes(1);
  expect(view.onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
  resolve({ stage: "delivered", tab: { id: "new" } });
  await waitFor(() => expect(view.onClose).toHaveBeenCalledTimes(1));
});
it("retains the dialog on launch failure and resets errors and selection on reopening", async () => {
  mocks.launch.mockResolvedValue({ stage: "launch", error: "Could not launch" });
  const view = open(); await loaded();
  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "codex" } });
  fireEvent.click(screen.getByRole("radio", { name: /Full session transcript/ }));
  fireEvent.click(screen.getByRole("button", { name: "Start New Session" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(view.onClose).not.toHaveBeenCalled();
  view.unmount(); open(); await loaded();
  expect(screen.queryByRole("alert")).toBeNull();
  expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe("claude");
  expect((screen.getByRole("radio", { name: /Focused handoff/ }) as HTMLInputElement).checked).toBe(true);
});
it("makes the destination reachable after delivery failure without offering a duplicate launch", async () => {
  mocks.launch.mockImplementation(async (_context, _provider, _prompt, onCreated) => {
    onCreated({ id: "new" });
    return { stage: "delivery", tab: { id: "new" }, error: "Context delivery failed; prompt retained" };
  });
  const view = open(); await loaded();
  fireEvent.click(screen.getByRole("button", { name: "Start New Session" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Start New Session" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open New Session" }));
  expect(view.onClose).toHaveBeenCalledTimes(1);
});
