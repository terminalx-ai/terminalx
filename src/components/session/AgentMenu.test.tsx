import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
async function renderChip(split = false) {
  const { AgentMenu } = await import("./AgentMenu");
  const { useSessionAgent } = await import("@/lib/useSessionAgent");
  function Chip() {
    return <AgentMenu split={split} selection={useSessionAgent(HARNESSES)} />;
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

describe("split in two chips, as the new-session box shows them (PRO-396)", () => {
  it("puts the model and effort on one chip and the permission mode on its own, each with its own menu", async () => {
    const chip = await renderChip(true);
    expect(chip.textContent).toBe("OpusHigh");
    expect(chip.getAttribute("aria-label")).toBe("Opus High");
    const mode = screen.getByTestId("agent-mode");
    expect(mode.tagName).toBe("BUTTON");
    expect(mode.textContent).toBe("Ask every time");
    expect(mode.getAttribute("aria-label")).toBe("Permissions: Ask every time");

    fireEvent.click(chip);
    expect(within(await screen.findByRole("menu")).queryByText("Permissions")).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.click(mode);
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitemradio", { name: /^Plan/ }));
    expect(screen.getByTestId("agent-mode").textContent).toBe("Plan");
    expect(screen.getByTestId("agent-mode").className).toContain("text-info");
  });

  it("still marks Bypass as a warning on its chip", async () => {
    localStorage.setItem("raccoon.prefs", JSON.stringify({ lastMode: "bypassPermissions" }));
    await renderChip(true);
    const mode = screen.getByTestId("agent-mode");
    expect(mode.textContent).toBe("Bypass");
    expect(mode.className).toContain("text-warning");
    expect(mode.getAttribute("title")).toBe("The agent runs commands and edits files without asking");
  });
});

describe("the picker's rows (PRO-397)", () => {
  it("has an Agent, a Model and an Effort row, each naming what is chosen and opening its choices", async () => {
    fireEvent.click(await renderChip());
    const menu = await screen.findByRole("menu");
    const rows = within(menu).getAllByRole("menuitem").filter((row) => row.getAttribute("aria-haspopup") === "menu");
    expect(rows.map((row) => row.textContent)).toEqual(["AgentClaude Code", "ModelOpus", "EffortHigh", "PermissionsAsk every time"]);
    // The agents and the efforts are behind their rows, not listed in the menu itself.
    expect(within(menu).queryAllByRole("menuitemradio")).toEqual([]);
    expect(within(menu).queryByRole("menuitem", { name: /^Codex/ })).toBeNull();

    fireEvent.keyDown(screen.getByTestId("agent-menu-effort"), { key: "ArrowRight" });
    await waitFor(() => expect(screen.getAllByRole("menu", { hidden: true }).length).toBe(2));
    const efforts = screen.getAllByRole("menu", { hidden: true }).at(-1)!;
    expect(within(efforts).getAllByRole("menuitemradio", { hidden: true }).map((item) => item.textContent)).toEqual(["Low", "High"]);

    fireEvent.click(within(efforts).getByRole("menuitemradio", { name: "Low", hidden: true }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.getByTestId("agent-effort").textContent).toBe("Low");
  });
});
