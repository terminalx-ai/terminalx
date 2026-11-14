import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DictationContext } from "@/lib/dictationContext";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
let deliver: (payload: unknown) => void = () => {};
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_name, cb) => { deliver = (payload) => cb({ payload }); return () => {}; }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
import { useDictationInto } from "./Dictation";

const request: DictationContext = { target: "learning-tab", project: "/example", coding: true, learn: true, remote: false, sensitive: false, projectTerms: [], session: [], terminal: [], composer: "" };
function Field({ remote = false, learn = true }: { remote?: boolean; learn?: boolean }) {
  const [draft, setDraft] = useState("Prefix: ");
  const ref = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictationInto(request.target, draft, setDraft, ref, () => ({ ...request, remote, learn }));
  return <><textarea ref={ref} value={draft} onChange={(e) => setDraft(e.target.value)} /><button onClick={dictation.toggle}>mic</button><button onClick={() => dictation.prepareSend(draft)()}>send</button></>;
}
async function event(payload: unknown) { await act(async () => deliver(payload)); }
async function start(props = {}) {
  mocks.invoke.mockImplementation(async (cmd) => cmd === "dictation_available" ? true : cmd === "transcription_preferences" ? { model: "apple" } : cmd === "transcription_models" ? [] : undefined);
  render(<Field {...props} />);
  await act(async () => fireEvent.click(screen.getByText("mic")));
  await event({ kind: "listening" });
  await event({ kind: "partial", text: "open paraquet files" });
}
async function stop() {
  await event({ kind: "final", text: "open paraquet files" });
  await event({ kind: "stopped" });
}
afterEach(async () => { await event({ kind: "stopped" }); cleanup(); mocks.invoke.mockClear(); });

it("learns only the dictated segment after sending an edit, once", async () => {
  await start(); await stop();
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "Prefix: open Parakeet files" } });
  fireEvent.click(screen.getByText("send"));
  expect(mocks.invoke).toHaveBeenCalledWith("transcription_learn", { request, before: "open paraquet files", after: "open Parakeet files" });
  fireEvent.click(screen.getByText("send"));
  expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "transcription_learn")).toHaveLength(1);
});

it("does not learn a reanchored deletion during recognition", async () => {
  await start();
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "Prefix: " } });
  await stop();
  fireEvent.click(screen.getByText("send"));
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "transcription_learn")).toBe(false);
});

it.each([{ remote: true }, { learn: false }])("does not retain a learning candidate for %j", async (props) => {
  await start(props); await stop();
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "Prefix: open Parakeet files" } });
  fireEvent.click(screen.getByText("send"));
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "transcription_learn")).toBe(false);
});

it("rejects edits to the surrounding draft", async () => {
  await start(); await stop();
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "Another task entirely" } });
  fireEvent.click(screen.getByText("send"));
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "transcription_learn")).toBe(false);
});
