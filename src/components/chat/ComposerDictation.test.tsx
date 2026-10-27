import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TabEntry } from "@/types/session";
import type { TranscriptionOptions } from "@/lib/transcriptionPersonalization";
import privacyCases from "@/lib/__fixtures__/dictation-privacy.json";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), rows: [] as string[] }));
let deliver: (payload: unknown) => void = () => {};
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, cb) => {
  if (name === "dictation") deliver = payload => cb({ payload });
  return () => {};
}) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/lib/hotkeys", () => ({ keycaps: () => [], useHotkey: vi.fn(), useShortcut: vi.fn(), useHeldShortcut: vi.fn(), useShortcutKeys: () => [], useShortcutKeycaps: () => () => [] }));
vi.mock("@/lib/models", async original => ({
  ...(await original<typeof import("@/lib/models")>()), EFFORT_LABEL: {},
  PERMISSION_MODES: [{ id: "auto", label: "Auto", hint: "" }],
  refreshModels: vi.fn(), upgradeHint: () => null, useModels: () => [],
}));
vi.mock("@/lib/sessions", async original => ({
  ...(await original<typeof import("@/lib/sessions")>()), getSessionStore: () => ({ sessions: [] }),
}));
vi.mock("@/lib/terminal", async original => ({
  ...(await original<typeof import("@/lib/terminal")>()),
  peekInstance: () => ({ term: { rows: mocks.rows.length, buffer: { active: {
    viewportY: 0, length: mocks.rows.length,
    getLine: (i: number) => ({ translateToString: () => mocks.rows[i] }),
  } } } }),
}));

// Real Composer, context hook, dictation hook, store and reducer. Only native
// I/O and unrelated UI services are replaced; onSend remains an awaited boundary.
import { Composer } from "./Composer";
import { sensitiveSurface } from "@/lib/dictationContext";
import { resetComposerHistory } from "./useComposerHistory";
const tab: TabEntry = { id: "learning-race", harness: "codex", model: "default", permissionMode: "auto", status: "idle", created: "2026-10-25T00:00:00Z", modified: "2026-10-25T00:00:00Z" };
let options: TranscriptionOptions;
function Field({ onSend, initial = "" }: { onSend: (text: string) => Promise<void>; initial?: string }) {
  const [draft, setDraft] = useState(initial);
  return <Composer tab={tab} busy={false} draft={draft} onDraftChange={setDraft} onSend={onSend}
    onStop={vi.fn()} onSetModel={vi.fn()} onSetEffort={vi.fn()} onSetMode={vi.fn()} />;
}
const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const edit = (value: string) => fireEvent.input(box(), { target: { value } });
const event = async (payload: unknown) => { await act(async () => deliver(payload)); };
const learnCalls = () => mocks.invoke.mock.calls.filter(([cmd]) => cmd === "transcription_learn");
async function record(text: string) {
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Dictate" })));
  await event({ kind: "listening" });
  await event({ kind: "partial", text, raw: text, segment: 0 });
  await event({ kind: "final", text, raw: text, segment: 0 });
  await event({ kind: "stopped" });
}
async function mount(onSend: (text: string) => Promise<void>, initial = "") {
  render(<Field onSend={onSend} initial={initial} />);
  await act(async () => {});
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function send() {
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
}
beforeEach(() => {
  resetComposerHistory();
  mocks.rows = [];
  options = { context: false, project: false, session: false, terminal: false, composer: false,
    remoteContext: false, dictionary: false, replacements: false, snippets: false, learn: true,
    guards: false, noiseGuard: false, retakes: false, normalize: false, code: false, fillers: false,
    language: null, sensitiveTargets: [] };
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async cmd => {
    if (cmd === "dictation_available") return true;
    if (cmd === "transcription_personalization_load") return { options, entries: [] };
    if (cmd === "transcription_preferences") return { model: "apple" };
    if (cmd === "transcription_models") return [];
    return undefined;
  });
});
afterEach(async () => { await event({ kind: "stopped" }); cleanup(); });

it.each(["success", "rejection"] as const)("binds deferred A %s to A while pending ownership preserves B and blocks repeat sends", async outcome => {
  const a = deferred();
  const onSend = vi.fn().mockImplementationOnce(() => a.promise).mockResolvedValue(undefined);
  await mount(onSend);
  await record("open paraquet files");
  edit("open Parakeet files");
  await send();
  expect(onSend).toHaveBeenNthCalledWith(1, "open Parakeet files", []);
  const pending = screen.getByRole("button", { name: "Sending" });
  expect(pending.hasAttribute("disabled")).toBe(true);
  fireEvent.click(pending);
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(learnCalls()).toHaveLength(0);
  edit("");
  await record("open parcel files");
  expect(box().value).toBe("open parcel files");
  await act(async () => { if (outcome === "success") a.resolve(); else a.reject(new Error("send rejected")); });
  if (outcome === "success") {
    expect(learnCalls()).toHaveLength(1);
    expect(learnCalls()[0][1]).toMatchObject({ before: "open paraquet files", after: "open Parakeet files" });
  } else expect(learnCalls()).toHaveLength(0);
  // #637 preserves B's visible draft; #439 separately retains B's learning
  // candidate. A's success still learns A even after it loses draft ownership.
  expect(box().value).toBe("open parcel files");
  expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
  edit("open package files");
  await send();
  expect(learnCalls()).toHaveLength(outcome === "success" ? 2 : 1);
  expect(learnCalls().at(-1)?.[1]).toMatchObject({ before: "open parcel files", after: "open package files" });
});

it("preserves A for retry after rejection and learns once on success", async () => {
  const first = deferred();
  const onSend = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
  await mount(onSend);
  await record("open paraquet files");
  edit("open Parakeet files");
  await send();
  await act(async () => first.reject(new Error("retry")));
  expect(learnCalls()).toHaveLength(0);
  expect(box().value).toBe("open Parakeet files");
  await send();
  expect(learnCalls()).toHaveLength(1);
  expect(learnCalls()[0][1]).toMatchObject({ before: "open paraquet files", after: "open Parakeet files" });
  edit("open Parakeet files");
  await send();
  expect(learnCalls()).toHaveLength(1);
});

it.each(privacyCases)("matches the Rust privacy contract for $text", ({ text, sensitive }) => {
  expect(sensitiveSurface(text)).toBe(sensitive);
});

it.each([
  { context: false, source: "draft" }, { context: true, source: "draft" },
  { context: false, source: "terminal" }, { context: true, source: "terminal" },
])("gates privacy before excluded $source sources with context=$context", async ({ context, source }) => {
  options.context = context; // composer and terminal source switches remain OFF
  const prefix = source === "draft" ? "token=private-value " : "";
  if (source === "terminal") mocks.rows = ["Password:", "", "", "", "", ""];
  await mount(vi.fn().mockResolvedValue(undefined), prefix);
  await record("open parcel files");
  const start = mocks.invoke.mock.calls.find(([cmd]) => cmd === "dictation_start");
  expect(start?.[1]).toMatchObject({ personalization: { sensitive: true, learn: false, composer: "", terminal: [] } });
  edit(`${prefix}open Parakeet files`);
  await send();
  expect(learnCalls()).toHaveLength(0);
});

it("allows normal learning with context sources OFF", async () => {
  await mount(vi.fn().mockResolvedValue(undefined));
  await record("open parcel files");
  expect(mocks.invoke.mock.calls.find(([cmd]) => cmd === "dictation_start")?.[1])
    .toMatchObject({ personalization: { sensitive: false, learn: true, composer: "", terminal: [] } });
  edit("open Parakeet files");
  await send();
  expect(learnCalls()[0]?.[1]).toMatchObject({ before: "open parcel files", after: "open Parakeet files" });
});

it("rechecks the current privacy surface before preparing an edited send", async () => {
  await mount(vi.fn().mockResolvedValue(undefined));
  await record("open parcel files");
  mocks.rows = ["Password:", "", "", "", ""];
  edit("open Parakeet files");
  await send();
  expect(learnCalls()).toHaveLength(0);
});

it.each(["api key: hidden", "access token = hidden", "one.time.code: hidden"])("retains frontend prompt protection for %s", text => {
  expect(sensitiveSurface(text)).toBe(true);
});
