// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { SetupSteps, type SetupStep } from "./SetupSteps";
import { appearance, stage } from "./testing/kit";

// PRO-542: the setup step list of board 25.01.
vi.mock("react-native", () => import("@mobile/ui/testing/native"));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());

const page = stage();
const ORG = "Personal (alex@example.com)";
const steps = (states: SetupStep["state"][], more: Partial<Record<string, Partial<SetupStep>>> = {}): SetupStep[] => [
  { key: "org", title: "Organization", detail: `Workspaces belong to an organization. Yours is ${ORG}.` },
  { key: "compute", title: "Connect compute", detail: "The provider account your workspaces run on." },
  { key: "agents", title: "Sign your agents in", detail: "What Codex, Claude Code and Cursor sign in with there." },
  { key: "launch", title: "Launch a workspace", detail: "Pick a size, see the price, start working." },
].map((step, index) => ({ ...step, state: states[index], ...more[step.key] }));
const row = (key: string) => page.byId(`setup-step-${key}`)!;
const mark = (key: string) => row(key).querySelector("[data-testid='setup-step-mark']") as HTMLElement;

it("draws a first run: the step to do next in the accent with its number, the rest waiting", async () => {
  await page.show(<SetupSteps testID="steps" steps={steps(["next", "waiting", "waiting", "waiting"], { org: { onPress: () => undefined } })} />);
  expect(page.styleOf(page.byId("steps"))).toMatchObject({ borderRadius: 16, backgroundColor: "#171113" });
  expect(mark("org").textContent).toBe("1");
  expect(page.styleOf(mark("org"))).toMatchObject({ width: 26, height: 26, borderRadius: 13, backgroundColor: "#e7806d" });
  expect(page.styleOf(mark("org").firstElementChild).color).toBe("#2a0d08");
  expect(page.styleOf(page.byText("Organization"))).toMatchObject({ fontSize: 16, fontWeight: "600", color: "#f4ecee" });
  expect(mark("launch").textContent).toBe("4");
  expect(page.styleOf(mark("launch"))).toMatchObject({ backgroundColor: "#20181b", borderColor: "#ffffff1a" });
  expect(page.styleOf(mark("launch").firstElementChild).color).toBe("#ab9aa0");
  expect(page.styleOf(page.byText("Launch a workspace")).color).toBe("#ab9aa0");
  expect(page.styleOf(page.byText("Launch a workspace")).fontWeight).toBeUndefined();
  expect(page.styleOf(row("org"))).toMatchObject({ minHeight: 64, alignItems: "flex-start" });
  expect(page.styleOf(row("org")).borderTopWidth).toBeUndefined();
  expect(page.styleOf(row("compute"))).toMatchObject({ borderTopWidth: 1, borderTopColor: "#ffffff1a" });
});

it("ticks a finished step in green and says what it holds", async () => {
  await page.show(<SetupSteps steps={steps(["done", "done", "next", "waiting"], { org: { detail: ORG }, compute: { detail: "Boat · connected" } })} />);
  expect(page.styleOf(mark("compute")).backgroundColor).toBe("#55b97929");
  expect(mark("compute").querySelector("[data-icon='Check']")!.getAttribute("data-color")).toBe("#55b979");
  expect(mark("compute").textContent).toBe("");
  expect(page.styleOf(page.byText("Boat · connected"))).toMatchObject({ fontSize: 13, lineHeight: 18, color: "#ab9aa0" });
  expect(mark("agents").textContent).toBe("3");
});

it("marks a step that could not be read, and reddens a detail that says what is wrong", async () => {
  await page.show(<SetupSteps steps={steps(["done", "failed", "failed", "waiting"], { compute: { detail: "Boat rejected the stored key on its last check.", alert: true }, agents: { detail: "Could not be read. Pull down to try again." } })} />);
  expect(page.styleOf(mark("compute")).backgroundColor).toBe("#db695f29");
  expect(mark("compute").querySelector("[data-icon='TriangleAlert']")!.getAttribute("data-color")).toBe("#db695f");
  expect(page.styleOf(page.byText("Boat rejected the stored key on its last check.")).color).toBe("#db695f");
  expect(page.styleOf(page.byText("Could not be read. Pull down to try again.")).color).toBe("#ab9aa0");
  expect(page.styleOf(page.byText("Connect compute")).fontWeight).toBe("600");
});

it("opens a step that has somewhere to go, and gives the others no chevron and nothing to press", async () => {
  const open = vi.fn();
  await page.show(<SetupSteps steps={steps(["done", "next", "waiting", "waiting"], { org: { onPress: () => open("org") }, compute: { onPress: () => open("compute") } })} />);
  expect(row("compute").getAttribute("role")).toBe("button");
  expect(row("compute").querySelector("[data-icon='ChevronRight']")).not.toBeNull();
  await page.press(row("compute"));
  expect(open).toHaveBeenCalledExactlyOnceWith("compute");
  expect(row("agents").getAttribute("role")).toBeNull();
  expect(row("agents").querySelector("[data-icon='ChevronRight']")).toBeNull();
  await page.press(row("agents"));
  expect(open).toHaveBeenCalledTimes(1);
});

it("says each step's place, state and detail aloud", async () => {
  await page.show(<SetupSteps steps={steps(["done", "failed", "next", "waiting"], { org: { detail: ORG } })} />);
  expect(row("org").getAttribute("aria-label")).toBe(`Step 1 of 4, done: Organization. ${ORG}`);
  expect(row("compute").getAttribute("aria-label")).toBe("Step 2 of 4, needs attention: Connect compute. The provider account your workspaces run on.");
  expect(row("agents").getAttribute("aria-label")).toContain("Step 3 of 4, next: Sign your agents in.");
  expect(row("launch").getAttribute("aria-label")).toContain("Step 4 of 4, not started: Launch a workspace.");
});

it("takes the light palette: the accent's own ink on the next step, the raised grey on a waiting one", async () => {
  appearance.scheme = "light";
  await page.show(<SetupSteps testID="steps" steps={steps(["done", "next", "waiting", "waiting"])} />);
  expect(page.styleOf(page.byId("steps")).backgroundColor).toBe("#ffffff");
  expect(page.styleOf(mark("org")).backgroundColor).toBe("#55b97929");
  expect(page.styleOf(mark("compute")).backgroundColor).toBe("#a96f27");
  expect(page.styleOf(mark("compute").firstElementChild).color).toBe("#ffffff");
  expect(page.styleOf(mark("agents"))).toMatchObject({ backgroundColor: "#f2f0ec", borderColor: "#706d7035" });
  expect(page.styleOf(page.byText("Connect compute")).color).toBe("#29282b");
});
