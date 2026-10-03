import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import type { DictationState } from "@/lib/dictation";

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const idle = { phase: "idle", text: "", session: 0, target: null, error: null, settings: null, available: true, engine: "Apple" };
  const store = {
    state: idle as unknown as DictationState,
    listeners,
    set(patch: Partial<DictationState>) {
      store.state = { ...store.state, ...patch };
      for (const listener of listeners) listener();
    },
    reset: () => store.set(idle as unknown as DictationState),
  };
  return store;
});

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/transcriptionInput", () => ({ useTranscriptionInput: () => ({ saving: false }) }));
vi.mock("./TranscriptionInputPicker", () => ({ TranscriptionInputPicker: () => null }));
vi.mock("@/lib/dictation", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useDictation: () =>
      useSyncExternalStore(
        (cb) => {
          store.listeners.add(cb);
          return () => store.listeners.delete(cb);
        },
        () => store.state,
      ),
    dictationAvailable: () => Promise.resolve(true),
    clearDictationError: vi.fn(),
    startDictation: vi.fn((target: string) => {
      if (store.state.phase !== "idle") return null;
      store.set({ phase: "listening", session: store.state.session + 1, target, text: "" });
      return store.state.session;
    }),
    stopDictation: vi.fn(async () => {
      if (store.state.phase !== "idle") store.set({ phase: "idle", target: null });
    }),
  };
});

const { startDictation, stopDictation } = await import("@/lib/dictation");
const { HOLD_DELAY_MS } = await import("@/lib/hotkeys");
const { setPrefs } = await import("@/lib/prefs");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { DictationStatus, MicButton, useDictationInto, useDictationShortcuts } = await import("./Dictation");

// jsdom is not a Mac, so the macOS default (hold Right Option, or ⌘⇧D) is stored explicitly; `mod` is Ctrl here.
const MAC_DICTATION = { "composer.dictate": ["hold:AltRight", "mod+shift+d"] };
const rightOption = { key: "Alt", code: "AltRight", altKey: true };

function Composer({ enabled = true }: { enabled?: boolean }) {
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictationInto("tab-1", draft, setDraft, field);
  useDictationShortcuts(dictation, enabled);
  return (
    <TooltipProvider>
      <DictationStatus dictation={dictation} />
      <textarea ref={field} aria-label="Message" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <MicButton dictation={dictation} />
    </TooltipProvider>
  );
}

const hold = (target: Element = document.body) => {
  fireEvent.keyDown(target, rightOption);
  act(() => void vi.advanceTimersByTime(HOLD_DELAY_MS));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(startDictation).mockClear();
  vi.mocked(stopDictation).mockClear();
  act(() => store.reset());
  setPrefs({ shortcuts: MAC_DICTATION });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("holding Right Option to dictate into the composer", () => {
  it("opens the mic while the key is held and closes it on release", () => {
    render(<Composer />);
    hold(screen.getByLabelText("Message"));
    expect(startDictation).toHaveBeenCalledWith("tab-1");
    expect(screen.getByText("Listening. Speak, then release the key.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop dictating" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyUp(screen.getByLabelText("Message"), { key: "Alt", code: "AltRight" });
    expect(stopDictation).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/^Listening/)).toBeNull();
  });

  it("works from anywhere in the window, not only with the composer focused", () => {
    render(<Composer />);
    hold(document.body);
    expect(startDictation).toHaveBeenCalledWith("tab-1");
    fireEvent.keyUp(document.body, { key: "Alt", code: "AltRight" });
    expect(stopDictation).toHaveBeenCalledTimes(1);
  });

  it("never opens the mic for a Right Option combination, and lets it type", () => {
    render(<Composer />);
    const field = screen.getByLabelText("Message");
    fireEvent.keyDown(field, rightOption);
    const typed = fireEvent.keyDown(field, { key: "´", code: "KeyE", altKey: true });
    act(() => void vi.advanceTimersByTime(HOLD_DELAY_MS * 4));
    fireEvent.keyUp(field, { key: "Alt", code: "AltRight" });
    expect(startDictation).not.toHaveBeenCalled();
    expect(stopDictation).not.toHaveBeenCalled();
    // Not prevented: the character is typed.
    expect(typed).toBe(true);
  });

  it("stops a dictation the hold started when another key is pressed", () => {
    render(<Composer />);
    const field = screen.getByLabelText("Message");
    hold(field);
    expect(startDictation).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(field, { key: "∫", code: "KeyB", altKey: true });
    expect(stopDictation).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(field, { key: "Alt", code: "AltRight" });
    expect(stopDictation).toHaveBeenCalledTimes(1);
  });

  it("leaves Left Option alone", () => {
    render(<Composer />);
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Alt", code: "AltLeft", altKey: true });
    act(() => void vi.advanceTimersByTime(HOLD_DELAY_MS * 4));
    expect(startDictation).not.toHaveBeenCalled();
  });

  it("keeps ⌘⇧D as a toggle, which a hold and its release do not stop", () => {
    render(<Composer />);
    fireEvent.keyDown(document.body, { key: "D", code: "KeyD", ctrlKey: true, shiftKey: true });
    expect(startDictation).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Listening. Speak, then press the mic again.")).toBeTruthy();
    hold();
    fireEvent.keyUp(document.body, { key: "Alt", code: "AltRight" });
    expect(stopDictation).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "D", code: "KeyD", ctrlKey: true, shiftKey: true });
    expect(stopDictation).toHaveBeenCalledTimes(1);
  });

  it("belongs to the active tab's composer only", () => {
    render(<Composer enabled={false} />);
    hold();
    fireEvent.keyDown(document.body, { key: "D", code: "KeyD", ctrlKey: true, shiftKey: true });
    expect(startDictation).not.toHaveBeenCalled();
  });

  it("follows a change of key at once", () => {
    render(<Composer />);
    expect(startDictation).not.toHaveBeenCalled();
    act(() => setPrefs({ shortcuts: { "composer.dictate": ["mod+shift+m"] } }));
    hold();
    expect(startDictation).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "M", code: "KeyM", ctrlKey: true, shiftKey: true });
    expect(startDictation).toHaveBeenCalledTimes(1);
  });
});
