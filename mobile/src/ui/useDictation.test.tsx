// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDictation, WAVE_LENGTH } from "./useDictation";

const speech = vi.hoisted(() => ({
  handlers: new Map<string, (event: any) => void>(),
  module: { start: vi.fn(), stop: vi.fn(), abort: vi.fn(), requestPermissionsAsync: vi.fn(async () => ({ granted: true })) },
}));
vi.mock("expo-speech-recognition", () => ({
  ExpoSpeechRecognitionModule: speech.module,
  useSpeechRecognitionEvent: (name: string, handler: (event: any) => void) => { speech.handlers.set(name, handler); },
}));

let root: Root;
let container: HTMLDivElement;
const said: string[] = [];
const probe: { current: ReturnType<typeof useDictation> | null } = { current: null };
function Probe() {
  const dictation = useDictation((text) => said.push(text));
  useEffect(() => { probe.current = dictation; });
  return null;
}
const emit = (name: string, event: unknown) => act(async () => { speech.handlers.get(name)?.(event); });

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  said.length = 0;
  for (const fn of Object.values(speech.module)) fn.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Probe />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("dictating into the composer", () => {
  it("hears words as they are said and draws how loud", async () => {
    await act(async () => probe.current!.start());
    expect(speech.module.start).toHaveBeenCalledWith(expect.objectContaining({ interimResults: true, continuous: true, volumeChangeEventOptions: { enabled: true, intervalMillis: 80 } }));
    expect(probe.current!.listening).toBe(true);
    await emit("result", { results: [{ transcript: "fix the " }] });
    await emit("result", { results: [{ transcript: "fix the login" }] });
    expect(said).toEqual(["fix the", "fix the login"]);
    await emit("volumechange", { value: 5 });
    await emit("volumechange", { value: -2 });
    expect(probe.current!.levels).toHaveLength(WAVE_LENGTH);
    expect(probe.current!.levels.slice(-2)).toEqual([0.5, 0]);
  });

  it("stops and keeps, or cancels and keeps nothing, and goes quiet", async () => {
    await act(async () => probe.current!.start());
    await act(async () => probe.current!.stop());
    expect(speech.module.stop).toHaveBeenCalled();
    expect(probe.current!.listening).toBe(false);
    await act(async () => probe.current!.start());
    await emit("volumechange", { value: 10 });
    await act(async () => probe.current!.cancel());
    expect(speech.module.abort).toHaveBeenCalled();
    expect(probe.current!.levels.every((level) => level === 0)).toBe(true);
  });

  it("asks for the microphone first, and says why it cannot listen", async () => {
    speech.module.requestPermissionsAsync.mockResolvedValueOnce({ granted: false });
    await act(async () => probe.current!.start());
    expect(speech.module.start).not.toHaveBeenCalled();
    expect(probe.current!.error).toContain("Allow the microphone");
    // Nothing more heard is no error.
    await emit("error", { error: "no-speech", message: "No speech" });
    await emit("error", { error: "network", message: "The network is down." });
    expect(probe.current!.error).toBe("The network is down.");
  });
});

describe("a long dictation", () => {
  it("keeps each sentence iOS settles on its own, and the one being said after them", async () => {
    await act(async () => probe.current!.start());
    await emit("result", { isFinal: true, results: [{ transcript: "Fix the login." }] });
    // iOS 18 starts the next sentence afresh.
    await emit("result", { isFinal: false, results: [{ transcript: "Then the" }] });
    await emit("result", { isFinal: true, results: [{ transcript: "Then the tests." }] });
    expect(said.at(-1)).toBe("Fix the login. Then the tests.");
    // A recognizer that hands back everything at once is not doubled.
    await emit("result", { isFinal: false, results: [{ transcript: "Fix the login. Then the tests. And" }] });
    expect(said.at(-1)).toBe("Fix the login. Then the tests. And");
  });

  it("hears nothing more once cancelled or sent, and starts afresh", async () => {
    await act(async () => probe.current!.start());
    await emit("result", { isFinal: true, results: [{ transcript: "One." }] });
    await act(async () => probe.current!.cancel());
    await emit("result", { isFinal: true, results: [{ transcript: "One. Two." }] });
    expect(said.at(-1)).toBe("One.");
    await act(async () => probe.current!.start());
    await emit("result", { isFinal: false, results: [{ transcript: "Fresh" }] });
    expect(said.at(-1)).toBe("Fresh");
  });
});
