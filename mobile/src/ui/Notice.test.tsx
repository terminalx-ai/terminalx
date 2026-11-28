// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { Notice } from "./Notice";
import { appearance, stage } from "./testing/kit";

// PRO-542: the inline notice of board 25.07, in its four tones.
vi.mock("react-native", () => import("@mobile/ui/testing/native"));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());

const page = stage();
const box = () => page.byId("notice")!;

it.each([
  ["warning", "CircleAlert", "#d6a744", "#d6a74452", "#d6a7440f", "alert"],
  ["danger", "CircleAlert", "#db695f", "#db695f57", "#db695f12", "alert"],
  ["success", "CircleCheck", "#55b979", "#55b9794d", "#55b9790f", null],
] as const)("draws a %s notice with its mark, tint and ink text", async (tone, mark, color, border, fill, role) => {
  await page.show(<Notice testID="notice" tone={tone} text="The code expired. Start device login again." />);
  expect(page.styleOf(box())).toMatchObject({ borderColor: border, backgroundColor: fill, borderRadius: 12, borderWidth: 1 });
  expect(page.icon(mark)!.getAttribute("data-color")).toBe(color);
  expect(page.styleOf(page.byText("The code expired. Start device login again."))).toMatchObject({ color: "#f4ecee", fontSize: 13, lineHeight: 19 });
  expect(box().getAttribute("role")).toBe(role);
});

it("draws an info notice quietly: the raised fill, a hairline, muted words, and not as an alert", async () => {
  await page.show(<Notice testID="notice" tone="info" text="Sign-in canceled. Nothing was saved." />);
  expect(page.styleOf(box())).toMatchObject({ borderColor: "#ffffff1a", backgroundColor: "#20181b" });
  expect(page.icon("Info")!.getAttribute("data-color")).toBe("#ab9aa0");
  expect(page.styleOf(page.byText("Sign-in canceled. Nothing was saved.")).color).toBe("#ab9aa0");
  expect(box().getAttribute("role")).toBeNull();
});

it("uses WCAG AA darker status colours and takes the light palette's ink and fill in light", async () => {
  appearance.scheme = "light";
  await page.show(<Notice testID="notice" tone="danger" text="Device login failed. Start it again." />);
  expect(page.styleOf(box())).toMatchObject({ borderColor: "#991b1b57", backgroundColor: "#991b1b12" });
  expect(page.styleOf(page.byText("Device login failed. Start it again.")).color).toBe("#29282b");
  await page.show(<Notice testID="notice" tone="info" text="Owners and admins manage agent logins." />);
  expect(page.styleOf(box())).toMatchObject({ borderColor: "#706d7035", backgroundColor: "#f2f0ec" });
  expect(page.styleOf(page.byText("Owners and admins manage agent logins.")).color).toBe("#706d70");
});

it("lists every failed check under a heading", async () => {
  await page.show(<Notice testID="notice" tone="danger" title="Two things to fix before this can be priced" items={["acme/app: this repository needs a GitHub personal access token.", "Codex: sign-in required."]} />);
  expect(page.styleOf(page.byText("Two things to fix before this can be priced")).fontWeight).toBe("600");
  expect(page.byText("acme/app: this repository needs a GitHub personal access token.")).not.toBeNull();
  expect(page.byText("Codex: sign-in required.")).not.toBeNull();
});

it("draws the caller's mark in the tone's colour, and one small action under the words", async () => {
  const retry = vi.fn();
  await page.show(<Notice testID="notice" tone="warning" text="Offline." icon={(color) => <i data-testid="own-mark" data-color={color} />} action={{ label: "Try again", onPress: retry }} />);
  expect(page.byId("own-mark")!.getAttribute("data-color")).toBe("#d6a744");
  expect(page.icon("CircleAlert")).toBeNull();
  const button = page.container.querySelector("[role='button']")!;
  expect(button.textContent).toBe("Try again");
  expect(page.styleOf(button)).toMatchObject({ minHeight: 40, backgroundColor: "#20181b" });
  await page.press(button);
  expect(retry).toHaveBeenCalledTimes(1);
  await page.show(<Notice testID="notice" tone="warning" text="Offline." action={{ label: "Try again", onPress: retry, disabled: true }} />);
  await page.press(page.container.querySelector("[role='button']"));
  expect(retry).toHaveBeenCalledTimes(1);
});
