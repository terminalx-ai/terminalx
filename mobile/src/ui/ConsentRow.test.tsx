// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { ConsentRow } from "./ConsentRow";
import { appearance, stage } from "./testing/kit";

// PRO-542: an acknowledgement the server requires, as a sentence beside a switch (25.07).
vi.mock("react-native", () => import("@mobile/ui/testing/native"));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());

const page = stage();
const SENTENCE = "I understand Agent37 bills this organization directly and every admin here can launch machines with this key.";
const toggle = () => page.container.querySelector("[role='switch']") as HTMLInputElement;

it("draws the sentence beside a switch that is off, in a card", async () => {
  await page.show(<ConsentRow testID="consent" text={SENTENCE} value={false} onValueChange={() => undefined} />);
  expect(page.styleOf(page.byText(SENTENCE))).toMatchObject({ fontSize: 14, lineHeight: 21, color: "#f4ecee" });
  expect(toggle().checked).toBe(false);
  expect(page.styleOf(page.byId("consent"))).toMatchObject({ borderRadius: 16, backgroundColor: "#171113", borderColor: "#ffffff1a" });
});

it("names the switch with the whole sentence, said once", async () => {
  await page.show(<ConsentRow text={SENTENCE} value={false} onValueChange={() => undefined} />);
  expect(toggle().getAttribute("aria-label")).toBe(SENTENCE);
  expect(page.byText(SENTENCE)!.getAttribute("aria-hidden")).toBe("true");
});

it("reports a flip either way and shows what it is given", async () => {
  const change = vi.fn();
  await page.show(<ConsentRow text={SENTENCE} value={false} onValueChange={change} />);
  await page.press(toggle());
  expect(change).toHaveBeenLastCalledWith(true);
  await page.show(<ConsentRow text={SENTENCE} value onValueChange={change} />);
  expect(toggle().checked).toBe(true);
  await page.press(toggle());
  expect(change).toHaveBeenLastCalledWith(false);
});

it("locks while a request is under way", async () => {
  const change = vi.fn();
  await page.show(<ConsentRow text={SENTENCE} value disabled onValueChange={change} />);
  expect(toggle().disabled).toBe(true);
  await page.press(toggle());
  expect(change).not.toHaveBeenCalled();
});

it("fills the track with the accent when on and the selected grey when off, in dark and in light", async () => {
  await page.show(<ConsentRow text={SENTENCE} value onValueChange={() => undefined} />);
  expect(JSON.parse(toggle().dataset.track!)).toEqual({ false: "#2f2327", true: "#e7806d" });
  appearance.scheme = "light";
  await page.show(<ConsentRow text={SENTENCE} value={false} onValueChange={() => undefined} />);
  expect(JSON.parse(toggle().dataset.track!)).toEqual({ false: "#e5e1da", true: "#a96f27" });
  expect(page.styleOf(page.byText(SENTENCE)).color).toBe("#29282b");
});
