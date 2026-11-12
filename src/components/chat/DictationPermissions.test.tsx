import { TooltipProvider } from "@/components/ui/tooltip";
import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mouseClick } from "@/test/press";

const { invoke, heard, openUrl } = vi.hoisted(() => ({ invoke: vi.fn(), heard: new Map<string, (event: { payload: unknown }) => void>(), openUrl: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => { heard.set(event, handler); return () => {}; }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

const { useDictationInto, MicButton, DictationStatus } = await import("./Dictation");
const { TranscriptionTab } = await import("@/components/settings/TranscriptionTab");
const { TranscriptionInputSubmenu } = await import("./TranscriptionInputPicker");
const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } = await import("@/components/ui/menu");

/** The composer's options menu, open, with the microphone in it. */
function ComposerOptions() {
  return (
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger>More options</DropdownMenuTrigger>
      <DropdownMenuContent><TranscriptionInputSubmenu /></DropdownMenuContent>
    </DropdownMenu>
  );
}

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

function ComposerDictation({ target = "tab-1" }: { target?: string }) {
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictationInto(target, draft, setDraft, field);
  return <><DictationStatus dictation={dictation} /><textarea ref={field} value={draft} onChange={(event) => setDraft(event.target.value)} /><MicButton dictation={dictation} /></>;
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

    render(<TooltipProvider><ComposerDictation /><ComposerDictation target="new-session" /></TooltipProvider>);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("dictation_available"));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Dictate" })).toHaveLength(2));

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

  it("does not start capture through the shortcut while an input preference is saving", async () => {
    const { selectTranscriptionInput } = await import("@/lib/transcriptionInput");
    const { startDictation } = await import("@/lib/dictation");
    let finish!: () => void;
    invoke.mockImplementation((command: string) => command === "transcription_set_input"
      ? new Promise<void>((resolve) => { finish = resolve; }) : Promise.resolve());
    const saving = selectTranscriptionInput("Studio Microphone");
    expect(startDictation("tab-1")).toBeNull();
    expect(permissionCalls()).toEqual([]);
    finish();
    await saving;
  });

  it("synchronizes the composer's microphone choice with Transcription settings in both directions", async () => {
    let selected: string | null = "Studio Microphone";
    invoke.mockImplementation(async (command: string, args?: { device: string | null }) => {
      if (command === "transcription_preferences") return { model: "apple", inputDevice: selected, muteWhileRecording: false };
      if (command === "transcription_models") return [];
      if (command === "transcription_inputs") return [{ id: "Studio Microphone", name: "Studio Microphone", isDefault: true }];
      if (command === "transcription_set_input") selected = args!.device;
    });
    render(<TooltipProvider><ComposerOptions /><TranscriptionTab /></TooltipProvider>);
    const composer = () => screen.getByRole("menuitem", { name: /^Transcription audio input:/ });
    const settings = () => screen.getByRole("button", { name: /^Transcription audio input:/ });
    await waitFor(() => expect(composer().getAttribute("aria-label")).toBe("Transcription audio input: Studio Microphone"));
    expect(settings().getAttribute("aria-label")).toBe("Transcription audio input: Studio Microphone");
    expect(permissionCalls()).toEqual([]);

    // Chosen in Settings: the composer's row follows.
    fireEvent.keyDown(settings(), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "System default" }));
    await waitFor(() => expect(composer().getAttribute("aria-label")).toBe("Transcription audio input: System default"));
    expect(selected).toBeNull();

    // Chosen in the composer's submenu: Settings follows.
    fireEvent.keyDown(composer(), { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Studio Microphone/ }));
    await waitFor(() => expect(settings().getAttribute("aria-label")).toBe("Transcription audio input: Studio Microphone"));
    expect(selected).toBe("Studio Microphone");
    expect(invoke).not.toHaveBeenCalledWith("dictation_start");
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

    // A whole mouse click: the picker opens on the click, not on pointerdown alone.
    mouseClick(screen.getByRole("button", { name: /System default/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("transcription_inputs"));
  });

  it("says microphone access is off with the pane, the steps and the reader's own dictation key", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "dictation_available") return true;
      if (command === "transcription_preferences") return { model: "apple", inputDevice: null, muteWhileRecording: false };
      if (command === "transcription_models") return [];
      return undefined;
    });
    render(<TooltipProvider><ComposerDictation /></TooltipProvider>);
    // The reader pressed the mic; macOS has the microphone off for the app.
    mouseClick(await screen.findByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("dictation_start", expect.anything()));
    await waitFor(() => expect(heard.has("dictation")).toBe(true));
    // The message dictation.rs sends for a denied microphone (MIC_DENIED).
    act(() => heard.get("dictation")!({ payload: { kind: "error", settings: "microphone", message: "Dictation needs it. Turn TerminalX on in System Settings › Privacy & Security › Microphone, then press the dictation shortcut again." } }));

    const row = await screen.findByRole("alert");
    expect(row.textContent).toContain("Microphone access is off for TerminalX");
    const { keycaps, isMac } = await import("@/lib/shortcuts");
    const key = keycaps("mod+shift+d").join(isMac ? "" : "+");
    expect(row.textContent).toContain(`Dictation needs it. Turn TerminalX on in System Settings › Privacy & Security › Microphone, then press ${key} again.`);
    fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(openUrl).toHaveBeenCalledWith("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
