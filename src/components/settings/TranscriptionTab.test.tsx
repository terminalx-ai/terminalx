import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TranscriptionModel } from "@/lib/api";

const model = (id: string, name: string, liveWords: boolean): TranscriptionModel => ({
  id, name, description: `${name} for testing.`, repo: `test/${id}`, filename: `${id}.gguf`, sizeBytes: 1_000_000,
  languages: "English", license: "MIT", licenseUrl: "https://example.test/license", speed: 50, accuracy: 50,
  recommended: false, liveWords, installed: true, downloading: false, page: `https://example.test/${id}`,
});

vi.mock("@/lib/api", () => ({
  errorMessage: (e: unknown) => String(e),
  transcription: {
    models: vi.fn(async () => [model("parakeet-unified-en-0.6b", "Parakeet Unified EN 0.6B", true), model("whisper-small", "Whisper Small", false)]),
    preferences: vi.fn(async () => ({ model: "parakeet-unified-en-0.6b", inputDevice: null, muteWhileRecording: false })),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/dictation", () => ({ refreshDictationEngine: vi.fn() }));
vi.mock("@/components/chat/TranscriptionInputPicker", () => ({ TranscriptionInputPicker: () => null }));
vi.mock("./TranscriptionPersonalization", () => ({ TranscriptionPersonalization: () => null }));

const { TranscriptionTab } = await import("./TranscriptionTab");
const { TooltipProvider } = await import("@/components/ui/tooltip");

afterEach(cleanup);

/** The card a model's name heads. */
const card = (name: string) => screen.getByText(name).closest(".rounded-lg") as HTMLElement;

it("says on each model's card whether its words appear while you speak (#754)", async () => {
  render(
    <TooltipProvider>
      <TranscriptionTab />
    </TooltipProvider>,
  );
  await screen.findByText("Whisper Small");
  expect(card("Built in").textContent).toContain("Words appear as you speak.");
  expect(card("Parakeet Unified EN 0.6B").textContent).toContain("Words appear as you speak.");
  expect(card("Whisper Small").textContent).toContain("Words appear when you stop.");
  expect(card("Whisper Small").textContent).not.toContain("as you speak");
});
