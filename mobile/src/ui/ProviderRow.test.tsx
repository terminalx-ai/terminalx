// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { ProviderMark, ProviderRow } from "./ProviderRow";
import { appearance, stage } from "./testing/kit";

// PRO-542: a provider as the server describes it (25.03), and an agent login as the same row (25.04).
vi.mock("react-native", () => import("@mobile/ui/testing/native"));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());

const page = stage();
const AGENT37 = { name: "Agent37", icon: "server", description: "Full virtual machines with Docker in the US, France and India. Sleeps when idle.", billing: "Per minute from your Agent37 wallet; only disk bills while asleep" };

it.each([["cloud", "Cloud"], ["ship", "Ship"], ["server", "Server"], ["container", "Container"], ["box", "Box"]])("draws the shape the server names: %s", async (icon, glyph) => {
  await page.show(<ProviderMark testID="mark" icon={icon} />);
  expect(page.icon(glyph)).not.toBeNull();
  expect(page.container.querySelectorAll("[data-icon]")).toHaveLength(1);
  expect(page.icon(glyph)!.dataset).toMatchObject({ size: "17", color: "#ab9aa0" });
});

it.each([["a shape this app does not have", "rocket"], ["a word that is not a shape at all", "constructor"], ["no shape", undefined]])("draws a box for %s", async (_what, icon) => {
  await page.show(<ProviderMark testID="mark" icon={icon} />);
  expect(page.icon("Box")).not.toBeNull();
  expect(page.container.querySelectorAll("[data-icon]")).toHaveLength(1);
});

it("draws an initial where there is no shape, in the board's rounded square, dark and light", async () => {
  await page.show(<ProviderMark testID="mark" letter="codex" />);
  expect(page.byId("mark")!.textContent).toBe("C");
  expect(page.container.querySelector("[data-icon]")).toBeNull();
  expect(page.styleOf(page.byId("mark"))).toMatchObject({ width: 32, height: 32, borderRadius: 9, backgroundColor: "#20181b", borderColor: "#ffffff1a" });
  expect(page.byId("mark")!.getAttribute("aria-hidden")).toBe("true");
  appearance.scheme = "light";
  await page.show(<ProviderMark testID="mark" letter="G" />);
  expect(page.styleOf(page.byId("mark"))).toMatchObject({ backgroundColor: "#f2f0ec", borderColor: "#706d7035" });
});

it("draws name and state, the description, then how it bills, and opens when pressed", async () => {
  const open = vi.fn();
  await page.show(<ProviderRow testID="row" {...AGENT37} badge="not-connected" onPress={open} />);
  const row = page.byId("row")!;
  expect(page.styleOf(page.byText("Agent37"))).toMatchObject({ fontSize: 16, fontWeight: "600", color: "#f4ecee" });
  expect(page.byText("Not connected")).not.toBeNull();
  expect(page.styleOf(page.byText(AGENT37.description))).toMatchObject({ fontSize: 13, lineHeight: 18, color: "#ab9aa0" });
  expect(page.styleOf(page.byText(AGENT37.billing)).color).toBe("#7a6a70");
  expect(page.icon("Server")).not.toBeNull();
  expect(page.icon("ChevronRight")!.dataset).toMatchObject({ size: "18", color: "#7a6a70" });
  expect(row.getAttribute("role")).toBe("button");
  expect(row.getAttribute("aria-label")).toBe(`Agent37, Not connected, ${AGENT37.description}, ${AGENT37.billing}`);
  expect(page.styleOf(row)).toMatchObject({ minHeight: 56, alignItems: "flex-start", paddingHorizontal: 14, paddingVertical: 12 });
  await page.press(row);
  expect(open).toHaveBeenCalledTimes(1);
});

it("is not a button and has no chevron for someone who may not open it", async () => {
  await page.show(<ProviderRow testID="row" {...AGENT37} badge="available" />);
  expect(page.byId("row")!.getAttribute("role")).toBeNull();
  expect(page.icon("ChevronRight")).toBeNull();
  expect(page.byId("row")!.getAttribute("aria-label")).toContain("Agent37, Available");
});

it("draws a hairline above every row of a card but the first", async () => {
  await page.show(<><ProviderRow testID="first" {...AGENT37} /><ProviderRow testID="second" {...AGENT37} divided /></>);
  expect(page.styleOf(page.byId("first")).borderTopWidth).toBeUndefined();
  expect(page.styleOf(page.byId("second"))).toMatchObject({ borderTopWidth: 1, borderTopColor: "#ffffff1a" });
});

it("draws no pill when the state is not known, and none of the lines it was not given", async () => {
  await page.show(<ProviderRow testID="row" name="Boat" icon="ship" badge={null} />);
  expect(page.byId("row")!.textContent).toBe("Boat");
  expect(page.byId("row")!.getAttribute("aria-label")).toBe("Boat");
});

it("heads a provider's own page with the state at the end, level with the name", async () => {
  await page.show(<ProviderRow testID="row" name="Agent37" icon="server" description={AGENT37.billing} badge="connected" badgeAtEnd />);
  const row = page.byId("row")!;
  expect(page.styleOf(row).alignItems).toBe("center");
  expect(row.lastElementChild!.textContent).toBe("Connected");
  expect(page.byText("Agent37")!.parentElement!.textContent).toBe("Agent37");
});

it("is an agent login's row with an initial and no billing line", async () => {
  await page.show(<ProviderRow testID="row" name="Claude Code" letter="C" description="API key · Updated 2 Nov" badge="sign-in-required" onPress={() => undefined} />);
  expect(page.byId("row")!.getAttribute("aria-label")).toBe("Claude Code, Sign-in required, API key · Updated 2 Nov");
  expect(page.container.querySelectorAll("[data-icon]")).toHaveLength(1);
  expect(page.icon("ChevronRight")).not.toBeNull();
});
