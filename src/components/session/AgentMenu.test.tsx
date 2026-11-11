import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "@/lib/api";
import type { HarnessInfo } from "@/types/session";

// The agents' own model lists are read from the machine; everything else (modes, labels, preferences) is real.
const catalog = vi.hoisted(() => ({ models: [] as ModelInfo[] }));
vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  useModels: (harness?: string) => catalog.models.filter((m) => !harness || m.harness === harness),
}));

const HARNESSES = [{ id: "claude", name: "Claude Code", available: true }] as HarnessInfo[];

/** New Session's chip as it draws from the saved preferences, with the modules as a fresh start loads them. */
async function renderChip() {
  const { AgentMenu } = await import("./AgentMenu");
  const { useSessionAgent } = await import("@/lib/useSessionAgent");
  function Chip() {
    return <AgentMenu selection={useSessionAgent(HARNESSES)} />;
  }
  render(<Chip />);
  return screen.getByTestId("agent-menu");
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  catalog.models = [{ id: "opus", label: "Opus", harness: "claude", efforts: ["low", "high"], defaultEffort: "high", acceptsImages: true, isDefault: true, upgrade: null, description: null }];
});
afterEach(cleanup);

describe("the new-session chip shows the permission mode (PRO-162)", () => {
  it("reads Ask every time on a fresh profile, in the screen reader's name too", async () => {
    const chip = await renderChip();
    expect(screen.getByTestId("agent-mode").textContent).toBe("·Ask every time");
    expect(chip.getAttribute("aria-label")).toBe("Opus High, Ask every time");
    expect(chip.getAttribute("title")).toBe("Claude Code · Ask every time");
  });

  it.each([
    ["plan", "Plan", "text-info"],
    ["auto", "Auto", "text-muted-foreground"],
    ["acceptEdits", "Accept edits", "text-muted-foreground"],
    ["manual", "Ask every time", "text-muted-foreground"],
  ])("shows the remembered %s mode as %s", async (mode, label, tone) => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ lastMode: mode }));
    const chip = await renderChip();
    const shown = screen.getByTestId("agent-mode");
    expect(shown.textContent).toBe(`·${label}`);
    expect(shown.className).toContain(tone);
    expect(shown.querySelector("[data-icon]")).toBeNull();
    expect(chip.getAttribute("aria-label")).toBe(`Opus High, ${label}`);
  });

  it("marks Bypass as a warning, with its icon and what it means", async () => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ lastMode: "bypassPermissions" }));
    const chip = await renderChip();
    const shown = screen.getByTestId("agent-mode");
    expect(shown.textContent).toBe("·Bypass");
    expect(shown.className).toContain("text-warning");
    expect(shown.querySelector("[data-icon]")).not.toBeNull();
    expect(shown.getAttribute("title")).toBe("The agent runs commands and edits files without asking");
    expect(chip.getAttribute("aria-label")).toBe("Opus High, Bypass permissions");
  });
});
