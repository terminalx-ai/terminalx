import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, recording } = vi.hoisted(() => ({ invoke: vi.fn(), recording: { phase: "idle" } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/dictation", () => ({ useDictation: () => recording }));
const { TranscriptionInputPicker } = await import("./TranscriptionInputPicker");
let selected: string | null;
let devices: { id: string; name: string; isDefault: boolean }[];
beforeEach(() => {
  selected = "Studio Microphone";
  devices = [{ id: selected, name: selected, isDefault: false }, { id: "Built-in", name: "Built-in", isDefault: true }];
  recording.phase = "idle";
  invoke.mockImplementation(async (command: string, args?: { device: string | null }) => {
    if (command === "transcription_preferences") return { inputDevice: selected };
    if (command === "transcription_inputs") return devices;
    if (command === "transcription_set_input") selected = args!.device;
  });
});
afterEach(() => { cleanup(); invoke.mockReset(); });
async function open(index = 0) {
  const button = screen.getAllByRole("button", { name: /Transcription audio input/ })[index];
  fireEvent.keyDown(button, { key: "Enter" });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("transcription_inputs"));
  await waitFor(() => expect(screen.queryByText("Looking for audio inputs…")).toBeNull());
}
describe("transcription input picker", () => {
  it("reads saved selection passively and synchronizes composer/settings after persistence", async () => {
    render(<><TranscriptionInputPicker compact /><TranscriptionInputPicker /></>);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Studio Microphone/ })).toHaveLength(2));
    expect(invoke).not.toHaveBeenCalledWith("transcription_inputs");
    await open();
    expect(screen.getByRole("menuitemradio", { name: "Studio Microphone" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Built-in/ }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Built-in/ })).toHaveLength(2));
    expect(invoke).toHaveBeenCalledWith("transcription_set_input", { device: "Built-in" });
    await open(1);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "System default" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /System default/ })).toHaveLength(2));
    expect(selected).toBeNull();
  });
  it("marks a missing saved input and refreshes devices on every open", async () => {
    devices = [{ id: "Built-in", name: "Built-in", isDefault: true }];
    render(<TranscriptionInputPicker compact />);
    await open();
    expect(screen.getByRole("menuitemradio", { name: /Studio Microphone · unavailable/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/The next recording will use the system default/)).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.getByRole("button", { name: /fallback/ })).toBeTruthy();
    devices.push({ id: "Studio Microphone", name: "Studio Microphone", isDefault: false });
    await open();
    expect(invoke.mock.calls.filter(([command]) => command === "transcription_inputs")).toHaveLength(2);
    expect(screen.getByRole("menuitemradio", { name: "Studio Microphone" })).toBeTruthy();
    expect(selected).toBe("Studio Microphone");
  });
  it("explains empty inputs and allows retaining System default", async () => {
    devices = [];
    render(<TranscriptionInputPicker />);
    await open();
    expect(screen.getByText(/No audio inputs available/)).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "System default" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.getByRole("button", { name: /No audio inputs/ })).toBeTruthy();
  });
  it("does not promise fallback when inputs exist but there is no system default", async () => {
    devices = [{ id: "External", name: "External", isDefault: false }];
    render(<TranscriptionInputPicker />);
    await open();
    expect(screen.getByText(/No system default microphone is available/)).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.getByRole("button", { name: /No default input/ })).toBeTruthy();
  });
  it("reports enumeration errors without presenting stale devices, and retries", async () => {
    render(<TranscriptionInputPicker />);
    await open();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    invoke.mockImplementation(async (command: string) => {
      if (command === "transcription_preferences") return { inputDevice: selected };
      if (command === "transcription_inputs") throw new Error("Audio unavailable");
    });
    await open();
    expect(screen.getByRole("alert").textContent).toContain("Audio unavailable");
    expect(screen.queryByRole("menuitemradio", { name: /Built-in/ })).toBeNull();
  });
  it.each(["starting", "listening", "finishing"])("disables changes while %s", async (phase) => {
    recording.phase = phase;
    render(<TranscriptionInputPicker />);
    await act(async () => {});
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith("transcription_inputs");
  });
  it("keeps the persisted choice after a failed save and exposes the error", async () => {
    render(<TranscriptionInputPicker />);
    await open();
    invoke.mockRejectedValueOnce(new Error("Could not save input"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Built-in/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Input error"));
    expect(screen.getByRole("button", { name: /Studio Microphone/ })).toBeTruthy();
    expect(selected).toBe("Studio Microphone");
  });
  it("disables selection until the preference has been saved", async () => {
    render(<TranscriptionInputPicker />);
    await open();
    let finish!: () => void;
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Built-in/ }));
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish(); });
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("keeps long input names accessible while truncating the compact label", async () => {
    selected = "External studio microphone with an exceptionally long device name";
    render(<TranscriptionInputPicker compact />);
    await waitFor(() => expect(screen.getByRole("button", { name: `Transcription audio input: ${selected}` })).toBeTruthy());
    expect(screen.getByText(selected).className).toContain("truncate");
  });
});
