// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { AGENT_DEFAULT_MODEL, AgentSettingsRows, PickRow } from "./PickRow";
import { appearance, stage } from "./testing/kit";
import { LargeText } from "./text-size";

// PRO-547: the form's row, shared from ui/, and the four rows an agent starts with (25.09, 25.10).
vi.mock("react-native", () => import("@mobile/ui/testing/native"));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());

const page = stage();

it("is a button with a chevron when it opens a choice, and a fact without one when it does not", async () => {
  const open = vi.fn();
  await page.show(<><PickRow label="Stop when idle" value="After 15 minutes" onPress={open} first /><PickRow label="Region" value="Automatic EU placement" /></>);
  const button = page.byId("pick-stop-when-idle")!;
  expect(button.getAttribute("role")).toBe("button");
  expect(button.getAttribute("aria-label")).toBe("Stop when idle: After 15 minutes");
  expect(button.querySelector("[data-icon='ChevronRight']")).not.toBeNull();
  await page.press(button);
  expect(open).toHaveBeenCalledOnce();
  const fact = page.byLabel("Region: Automatic EU placement")!;
  expect(fact.getAttribute("role")).toBeNull();
  expect(fact.querySelector("[data-icon='ChevronRight']")).toBeNull();
  // The second row has the hairline over it; the first does not.
  expect(page.styleOf(button).borderTopWidth).toBeUndefined();
  expect(page.styleOf(fact).borderTopWidth).toBe(1);
});

it("puts the value under its label, in full, at the accessibility text sizes (PRO-563)", async () => {
  await page.show(<PickRow label="Region" value="Automatic EU placement" onPress={() => undefined} />);
  // Side by side at the ordinary sizes: one line, the row's own child.
  expect(page.byText("Automatic EU placement")!.getAttribute("data-lines")).toBe("1");
  expect(page.byText("Automatic EU placement")!.parentElement).toBe(page.byId("pick-region"));
  await page.show(<LargeText.Provider value><PickRow label="Region" value="Automatic EU placement" onPress={() => undefined} /></LargeText.Provider>);
  const value = page.byText("Automatic EU placement")!;
  expect(value.getAttribute("data-lines")).toBeNull();
  expect(value.parentElement!.textContent).toBe("RegionAutomatic EU placement");
  expect(page.styleOf(value).textAlign).toBeUndefined();
  // Still one button, said the same way, with its chevron.
  const button = page.byId("pick-region")!;
  expect(button.getAttribute("aria-label")).toBe("Region: Automatic EU placement");
  expect(button.querySelector("[data-icon='ChevronRight']")).not.toBeNull();
});

it("marks a value that stops a launch in the danger colour, in dark and in light", async () => {
  await page.show(<PickRow label="Agent" value="Claude Code" onPress={() => undefined} bad />);
  const dark = page.styleOf(page.byText("Claude Code")).color;
  appearance.scheme = "light";
  await page.show(<PickRow label="Agent" value="Claude Code" onPress={() => undefined} bad />);
  const light = page.styleOf(page.byText("Claude Code")).color;
  // Ember and Den share their danger colour.
  expect(dark).toBe("#db695f");
  expect(light).toBe("#db695f");
  expect(page.styleOf(page.byText("Agent")).color).not.toBe("#db695f");
});

it("draws Agent, Model, Effort and Permission mode as one card, each opening its own choice", async () => {
  const opened: string[] = [];
  await page.show(<AgentSettingsRows testID="rows" agent="Claude Code" model="Opus" effort="High" mode="Ask every time"
    onAgent={() => opened.push("agent")} onModel={() => opened.push("model")} onEffort={() => opened.push("effort")} onMode={() => opened.push("mode")} />);
  expect([...page.byId("rows")!.querySelectorAll("[aria-label]")].map((row) => row.getAttribute("aria-label"))).toEqual(["Agent: Claude Code", "Model: Opus", "Effort: High", "Permission mode: Ask every time"]);
  for (const id of ["pick-agent", "pick-model", "pick-effort", "pick-permission-mode"]) await page.press(page.byId(id));
  expect(opened).toEqual(["agent", "model", "effort", "mode"]);
});

it("states the agent's own default model with nothing to choose, and leaves out an effort or a mode there is none of", async () => {
  await page.show(<AgentSettingsRows testID="rows" agent="Codex" model={null} effort={null} mode="Ask every time" onAgent={() => undefined} onMode={() => undefined} />);
  expect([...page.byId("rows")!.querySelectorAll("[aria-label]")].map((row) => row.getAttribute("aria-label"))).toEqual(["Agent: Codex", `Model: ${AGENT_DEFAULT_MODEL}`, "Permission mode: Ask every time"]);
  expect(AGENT_DEFAULT_MODEL).toBe("Agent’s default");
  expect(page.byId("model-fact")!.querySelector("[data-icon='ChevronRight']")).toBeNull();
  expect(page.byId("pick-model")).toBeNull();
  expect(page.byText("Effort")).toBeNull();
  await page.show(<AgentSettingsRows testID="rows" agent="Codex" model={null} effort={null} mode={null} />);
  expect(page.byText("Permission mode")).toBeNull();
});
