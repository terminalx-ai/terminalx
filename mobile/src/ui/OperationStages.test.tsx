// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { OperationStages } from "./OperationStages";
import { appearance, stage } from "./testing/kit";

// PRO-542: an operation's stages, with the latest event under the current one (25.05).
vi.mock("react-native", () => import("@mobile/ui/testing/native"));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());
vi.mock("./Spinner", () => ({ Spinner: ({ size, color }: { size: number; color: string }) => <i data-testid="spinner" data-size={size} data-color={color} /> }));

const page = stage();
const STAGES = ["Queued", "Checking the provider", "Creating the machine", "Installing the runtime", "Connecting to the relay", "Ready"];
const row = (index: number) => page.byId(`operation-stage-${index}`)!;
const mark = (index: number) => row(index).firstElementChild as HTMLElement;
const said = () => STAGES.map((_name, index) => row(index).getAttribute("aria-label"));

it("ticks the stages passed, spins on the one under way and leaves the rest empty", async () => {
  await page.show(<OperationStages testID="stages" stages={STAGES} current={2} status="running" />);
  expect(page.styleOf(page.byId("stages"))).toMatchObject({ borderRadius: 16, paddingVertical: 6, backgroundColor: "#171113" });
  expect(said()).toEqual(["Queued, done", "Checking the provider, done", "Creating the machine, in progress", "Installing the runtime, not started", "Connecting to the relay, not started", "Ready, not started"]);
  expect(page.styleOf(mark(0))).toMatchObject({ width: 22, height: 22, borderRadius: 11, backgroundColor: "#55b97929" });
  expect(mark(0).querySelector("[data-icon='Check']")!.getAttribute("data-color")).toBe("#55b979");
  expect(mark(2).querySelector<HTMLElement>("[data-testid='spinner']")!.dataset).toMatchObject({ size: "18", color: "#5b8def" });
  expect(page.styleOf(mark(2)).backgroundColor).toBeUndefined();
  expect(mark(4).children).toHaveLength(0);
  expect(page.styleOf(mark(4))).toMatchObject({ borderWidth: 1, borderColor: "#ffffff1a" });
  expect(page.styleOf(page.byText("Queued"))).toMatchObject({ fontSize: 15, color: "#f4ecee" });
  expect(page.styleOf(page.byText("Queued")).fontWeight).toBeUndefined();
  expect(page.styleOf(page.byText("Creating the machine"))).toMatchObject({ fontWeight: "600", color: "#f4ecee" });
  expect(page.styleOf(page.byText("Ready")).color).toBe("#ab9aa0");
  expect(page.container.querySelectorAll("[data-testid='spinner']")).toHaveLength(1);
});

it("starts with nothing ticked", async () => {
  await page.show(<OperationStages stages={STAGES} current={0} status="running" />);
  expect(said()[0]).toBe("Queued, in progress");
  expect(page.container.querySelector("[data-icon='Check']")).toBeNull();
});

it("puts the latest event under the stage it belongs to, and nowhere else", async () => {
  await page.show(<OperationStages stages={STAGES} current={3} status="running" detail="Cloning the repository" />);
  expect(row(3).textContent).toBe("Installing the runtimeCloning the repository");
  expect(page.styleOf(page.byText("Cloning the repository"))).toMatchObject({ fontSize: 13, lineHeight: 18, color: "#ab9aa0" });
  expect(page.styleOf(row(3)).minHeight).toBe(56);
  expect(page.styleOf(row(2)).minHeight).toBe(46);
  expect(row(3).getAttribute("aria-label")).toBe("Installing the runtime, in progress: Cloning the repository");
  expect(page.container.textContent!.split("Cloning the repository")).toHaveLength(2);
});

it("crosses the stage it stopped at, with why, and keeps what came before ticked", async () => {
  await page.show(<OperationStages stages={STAGES} current={1} status="failed" detail="The provider rejected the API key." />);
  expect(said()).toEqual(["Queued, done", "Checking the provider, failed: The provider rejected the API key.", "Creating the machine, not started", "Installing the runtime, not started", "Connecting to the relay, not started", "Ready, not started"]);
  expect(page.styleOf(mark(1)).backgroundColor).toBe("#db695f29");
  expect(mark(1).querySelector("[data-icon='X']")!.getAttribute("data-color")).toBe("#db695f");
  expect(page.styleOf(page.byText("Checking the provider")).fontWeight).toBe("600");
  expect(page.container.querySelector("[data-testid='spinner']")).toBeNull();
});

it("ticks every stage once it has run through, with no spinner and no event left over", async () => {
  await page.show(<OperationStages stages={STAGES} current={5} status="finished" detail="Cloning the repository" />);
  expect(said()).toEqual(STAGES.map((name) => `${name}, done`));
  expect(page.container.querySelectorAll("[data-icon='Check']")).toHaveLength(6);
  expect(page.container.querySelector("[data-testid='spinner']")).toBeNull();
  expect(page.container.textContent).not.toContain("Cloning the repository");
});

it("takes the light palette", async () => {
  appearance.scheme = "light";
  await page.show(<OperationStages testID="stages" stages={STAGES} current={2} status="running" />);
  expect(page.styleOf(page.byId("stages")).backgroundColor).toBe("#ffffff");
  expect(page.styleOf(page.byText("Creating the machine")).color).toBe("#29282b");
  expect(page.styleOf(page.byText("Ready")).color).toBe("#706d70");
  expect(page.styleOf(mark(4)).borderColor).toBe("#706d7035");
  expect(page.styleOf(mark(0)).backgroundColor).toBe("#14532d29");
});
