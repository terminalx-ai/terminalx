// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { FactRows } from "./FactRows";
import { appearance, stage } from "./testing/kit";

// PRO-542: label and value pairs (25.07): a saved key's facts, the review, the delete facts, the cleanup report.
vi.mock("react-native", () => import("@mobile/ui/testing/native"));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());

const page = stage();
const rows = () => [...page.byId("facts")!.children] as HTMLElement[];

it("draws each pair on a line, the label muted and the value at the end, with hairlines between", async () => {
  await page.show(<FactRows testID="facts" facts={[{ label: "Connected", value: "23 Nov 2026" }, { label: "Last checked", value: "today, 10:02" }]} />);
  expect(page.styleOf(page.byId("facts"))).toMatchObject({ borderRadius: 16, backgroundColor: "#171113" });
  expect(rows()).toHaveLength(2);
  expect(page.styleOf(rows()[0])).toMatchObject({ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 9 });
  expect(page.styleOf(rows()[0]).borderTopWidth).toBeUndefined();
  expect(page.styleOf(rows()[1])).toMatchObject({ borderTopWidth: 1, borderTopColor: "#ffffff1a" });
  expect(page.styleOf(page.byText("Connected"))).toMatchObject({ fontSize: 15, color: "#ab9aa0" });
  expect(page.styleOf(page.byText("23 Nov 2026"))).toMatchObject({ fontSize: 15, color: "#f4ecee", textAlign: "right" });
  expect(rows()[1].getAttribute("aria-label")).toBe("Last checked: today, 10:02");
});

it("draws a fingerprint in the monospaced face, smaller, and lets it be selected", async () => {
  await page.show(<FactRows testID="facts" facts={[{ label: "Key", value: "sha256:9c41e07a", mono: true }, { label: "Account", value: "alex@example.com" }]} />);
  expect(page.styleOf(page.byText("sha256:9c41e07a"))).toMatchObject({ fontFamily: "Menlo", fontSize: 13 });
  expect(page.byText("sha256:9c41e07a")!.dataset.selectable).toBe("true");
  expect(page.styleOf(page.byText("alex@example.com")).fontFamily).toBeUndefined();
  expect(page.byText("alex@example.com")!.dataset.selectable).toBeUndefined();
});

it("colours a cleanup report's values by how each went", async () => {
  await page.show(<FactRows testID="facts" facts={[{ label: "Runtime credentials", value: "Removed", tone: "success" }, { label: "Machine", value: "Not confirmed", tone: "danger" }, { label: "Saved conversations", value: "Pending", tone: "warning" }]} />);
  expect(page.styleOf(page.byText("Removed")).color).toBe("#55b979");
  expect(page.styleOf(page.byText("Not confirmed")).color).toBe("#db695f");
  expect(page.styleOf(page.byText("Pending")).color).toBe("#d6a744");
});

it("draws the delete page's facts as a short label beside a sentence", async () => {
  await page.show(<FactRows testID="facts" layout="sentences" facts={[{ label: "Compute", value: "The machine is removed." }, { label: "Undo", value: "Not possible." }]} />);
  expect(page.styleOf(rows()[0])).toMatchObject({ minHeight: 48, alignItems: "flex-start" });
  expect(page.styleOf(page.byText("Compute"))).toMatchObject({ width: 74, fontSize: 14, color: "#ab9aa0" });
  expect(page.styleOf(page.byText("The machine is removed."))).toMatchObject({ flex: 1, fontSize: 14, lineHeight: 21, color: "#f4ecee" });
});

it("draws the rows alone under what a card already holds, each with a hairline above", async () => {
  await page.show(<FactRows testID="facts" embedded facts={[{ label: "Key", value: "sha256:5be2d913", mono: true }, { label: "Updated", value: "23 Nov 2026" }]} />);
  expect(page.styleOf(page.byId("facts")).borderRadius).toBeUndefined();
  expect(page.styleOf(rows()[0])).toMatchObject({ borderTopWidth: 1 });
  expect(page.styleOf(rows()[1])).toMatchObject({ borderTopWidth: 1 });
});

it("takes the light palette", async () => {
  appearance.scheme = "light";
  await page.show(<FactRows testID="facts" facts={[{ label: "Name", value: "Checkout redesign" }, { label: "Provider", value: "Boat" }]} />);
  expect(page.styleOf(page.byId("facts")).backgroundColor).toBe("#ffffff");
  expect(page.styleOf(page.byText("Name")).color).toBe("#706d70");
  expect(page.styleOf(page.byText("Checkout redesign")).color).toBe("#29282b");
  expect(page.styleOf(rows()[1]).borderTopColor).toBe("#706d7035");
});
