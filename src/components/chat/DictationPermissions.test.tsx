import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { useDictationInto } = await import("./Dictation");
const { TranscriptionTab } = await import("@/components/settings/TranscriptionTab");

/**
 * Commands behind this boundary can make macOS consult the microphone or
 * speech-recognition TCC services. Keeping the boundary injected here makes
 * an accidental mount-time call observable without asking the test runner for
 * a real device permission.
 */
const PERMISSION_TRIGGERING_COMMANDS = new Set(["dictation_start", "transcription_settings", "transcription_inputs"]);

function permissionCalls(): string[] {
  return invoke.mock.calls.map(([command]) => command as string).filter((command) => PERMISSION_TRIGGERING_COMMANDS.has(command));
}

function ComposerDictation() {
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useDictationInto("tab-1", draft, setDraft, field);
  return <textarea ref={field} value={draft} onChange={(event) => setDraft(event.target.value)} />;
}

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("passive dictation surfaces", () => {
  it("does not cross the permission gateway when the composer mounts", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "dictation_available") return true;
      if (command === "transcription_preferences") return { model: "apple", inputDevice: null, muteWhileRecording: false };
      if (command === "transcription_models") return [];
      return undefined;
    });

    render(<ComposerDictation />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("dictation_available"));

    expect(permissionCalls()).toEqual([]);
  });

  it("does not cross the permission gateway when Transcription settings renders", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "transcription_models") return [];
      if (command === "transcription_preferences") return { model: "apple", inputDevice: "Studio Microphone", muteWhileRecording: false };
      return undefined;
    });

    render(<TranscriptionTab />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("transcription_models"));

    expect(screen.getByRole("button", { name: /Studio Microphone/i })).toBeTruthy();
    expect(permissionCalls()).toEqual([]);
  });

  it("enumerates inputs only when the microphone picker opens", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "transcription_models" || command === "transcription_inputs") return [];
      if (command === "transcription_preferences") return { model: "apple", inputDevice: null, muteWhileRecording: false };
      return undefined;
    });

    render(<TranscriptionTab />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("transcription_models"));
    expect(invoke).not.toHaveBeenCalledWith("transcription_inputs");

    fireEvent.pointerDown(screen.getByRole("button", { name: /System default/i }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("transcription_inputs"));
  });
});
