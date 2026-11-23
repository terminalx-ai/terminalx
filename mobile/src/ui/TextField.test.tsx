// @vitest-environment jsdom
import { act, createRef } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { TextField, type TextFieldHandle } from "./TextField";
import { appearance, stage } from "./testing/kit";

// PRO-542: the one text field of board 25.07, and its secret mode.
const mocks = vi.hoisted(() => ({ paste: vi.fn(async () => "") }));
vi.mock("expo-clipboard", () => ({ getStringAsync: mocks.paste }));

vi.mock("react-native", () => import("@mobile/ui/testing/native"));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());

const page = stage();
const SECRET = "sk-live-9c41e07a-do-not-show";
const input = () => page.container.querySelector("input") as HTMLInputElement | null;
const field = () => input()?.parentElement ?? page.byLabel("Agent37 API key")!.parentElement;
/** Everything the field put on the page: text, attributes and all. */
const drawn = () => page.container.innerHTML;
const noop = () => undefined;

beforeEach(() => { mocks.paste.mockReset().mockResolvedValue(""); });

it("draws the label, a quiet hint beside it and the helper under the field", async () => {
  await page.show(<TextField label="Whose account this is" hint="optional" helper="A name or email, shown to admins" placeholder="alex@example.com" value="" onChangeText={noop} />);
  expect(page.byText("Whose account this is")).not.toBeNull();
  expect(page.styleOf(page.byText("optional")).color).toBe("#7a6a70");
  expect(page.styleOf(page.byText("A name or email, shown to admins")).color).toBe("#ab9aa0");
  expect(input()!.placeholder).toBe("alex@example.com");
  expect(input()!.getAttribute("aria-label")).toBe("Whose account this is");
  expect(page.container.querySelector("[role='alert']")).toBeNull();
});

it("is the board's field in dark and in light: 44 high, a hairline, the raised fill", async () => {
  await page.show(<TextField label="Name" value="Northwind" onChangeText={noop} />);
  expect(page.styleOf(field())).toMatchObject({ minHeight: 44, borderRadius: 10, paddingHorizontal: 12, borderWidth: 1, backgroundColor: "#20181b", borderColor: "#ffffff1a" });
  expect(page.styleOf(input())).toMatchObject({ fontSize: 16, color: "#f4ecee" });
  appearance.scheme = "light";
  await page.show(<TextField label="Name" value="Northwind" onChangeText={noop} />);
  expect(page.styleOf(field())).toMatchObject({ backgroundColor: "#f2f0ec", borderColor: "#706d7035" });
  expect(page.styleOf(input()).color).toBe("#29282b");
});

it("takes the accent on its border while it has the focus", async () => {
  await page.show(<TextField label="Name" value="" onChangeText={noop} />);
  await act(async () => input()!.focus());
  expect(page.styleOf(field()).borderColor).toBe("#e7806d");
  await act(async () => input()!.blur());
  expect(page.styleOf(field()).borderColor).toBe("#ffffff1a");
});

it("shows an error in place of the helper, in red, and announces it", async () => {
  await page.show(<TextField label="Organization name" helper="2 to 60 characters." error="Use 2 to 60 characters." value="N" onChangeText={noop} />);
  const alert = page.container.querySelector("[role='alert']")!;
  expect(alert.textContent).toBe("Use 2 to 60 characters.");
  expect(page.styleOf(alert).color).toBe("#db695f");
  expect(page.styleOf(field()).borderColor).toBe("#db695f");
  expect(page.byText("2 to 60 characters.")).toBeNull();
});

it("offers a link at the end of the label's line", async () => {
  const open = vi.fn();
  await page.show(<TextField label="Agent37 API key" link={{ label: "Get a key", onPress: open }} value="" onChangeText={noop} />);
  const link = page.container.querySelector("[role='link']")!;
  expect(link.textContent).toBe("Get a key");
  expect(page.icon("ArrowUpRight")).not.toBeNull();
  await page.press(link);
  expect(open).toHaveBeenCalledTimes(1);
});

it("reports what is typed and locks while a request is under way", async () => {
  const change = vi.fn();
  await page.show(<TextField label="Name" value="" onChangeText={change} />);
  await page.type(input(), "Northwind");
  expect(change).toHaveBeenLastCalledWith("Northwind");
  await page.show(<TextField label="Name" value="Northwind" onChangeText={change} disabled paste />);
  expect(input()!.disabled).toBe(true);
  expect(page.styleOf(field()).opacity).toBe(0.55);
  expect(page.byLabel("Paste Name")).toBeNull();
});

it("pastes the clipboard into an empty field without its stray spaces, and offers Paste only while empty", async () => {
  const change = vi.fn();
  mocks.paste.mockResolvedValue("  https://github.com/acme/app\n");
  await page.show(<TextField label="GitHub repository URL" paste value="" onChangeText={change} />);
  expect(page.styleOf(page.byText("Paste"))).toMatchObject({ color: "#e7806d", fontSize: 14, fontWeight: "600" });
  await page.press(page.byLabel("Paste GitHub repository URL"));
  expect(change).toHaveBeenCalledExactlyOnceWith("https://github.com/acme/app");
  await page.show(<TextField label="GitHub repository URL" paste value="https://github.com/acme/app" onChangeText={change} />);
  expect(page.byLabel("Paste GitHub repository URL")).toBeNull();
});

it.each([
  ["an empty clipboard", async () => "   "],
  ["a clipboard that cannot be read", async () => { throw new Error("denied"); }],
])("says so under the field after %s, until something is typed", async (_what, read) => {
  const change = vi.fn();
  mocks.paste.mockImplementation(read);
  await page.show(<TextField label="Name" paste helper="Shown to admins." value="" onChangeText={change} />);
  await page.press(page.byLabel("Paste Name"));
  expect(page.container.querySelector("[role='alert']")!.textContent).toBe("Nothing to paste. Copy it first, then tap Paste.");
  expect(change).not.toHaveBeenCalled();
  await page.type(input(), "N");
  expect(page.container.querySelector("[role='alert']")).toBeNull();
  expect(page.byText("Shown to admins.")).not.toBeNull();
});

it("keeps a typed secret out of everything it draws: a secure input that is never handed the value", async () => {
  const filled = vi.fn();
  const handle = createRef<TextFieldHandle>();
  await page.show(<TextField ref={handle} secret label="Agent37 API key" placeholder="Agent37 API key" helper="Sent once, encrypted at rest, and never shown again, here or anywhere." onFilledChange={filled} />);
  expect(input()!.type).toBe("password");
  expect(input()!.getAttribute("data-controlled")).toBeNull();
  await page.type(input(), SECRET.slice(0, 5));
  await page.type(input(), SECRET);
  expect(filled).toHaveBeenCalledExactlyOnceWith(true);
  expect(handle.current!.read()).toBe(SECRET);
  expect(drawn()).not.toContain(SECRET);
  expect(drawn()).not.toContain(SECRET.slice(0, 5));
  expect(input()!.getAttribute("aria-label")).toBe("Agent37 API key");
  expect(input()!.getAttribute("aria-valuetext")).toBeNull();
  // Drawing again, for whatever reason, still hands nothing back.
  await page.show(<TextField ref={handle} secret label="Agent37 API key" error="Agent37 needs billing set up on that account before it will act." onFilledChange={filled} />);
  expect(drawn()).not.toContain(SECRET);
  expect(handle.current!.read()).toBe(SECRET);
});

it("shows a pasted secret as a fixed row of dots, whatever its length, and never in words or labels", async () => {
  const filled = vi.fn();
  const handle = createRef<TextFieldHandle>();
  mocks.paste.mockResolvedValue(` ${SECRET}\n`);
  await page.show(<TextField ref={handle} secret paste label="Agent37 API key" placeholder="Agent37 API key" onFilledChange={filled} />);
  await page.press(page.byLabel("Paste Agent37 API key"));
  expect(filled).toHaveBeenCalledExactlyOnceWith(true);
  expect(handle.current!.read()).toBe(SECRET);
  expect(input()).toBeNull();
  const dots = page.byLabel("Agent37 API key")!;
  expect(dots.textContent).toBe("•".repeat(24));
  expect(dots.getAttribute("data-hint")).toBe("Entered. Double tap to enter it again.");
  expect(page.byLabel("Paste Agent37 API key")).toBeNull();
  expect(drawn()).not.toContain(SECRET);
  for (const element of page.container.querySelectorAll("*")) for (const attribute of element.attributes) expect(attribute.value).not.toContain(SECRET);
});

it("starts a pasted secret over on a tap: the secret is dropped and the empty field takes the focus", async () => {
  const filled = vi.fn();
  const handle = createRef<TextFieldHandle>();
  mocks.paste.mockResolvedValue(SECRET);
  await page.show(<TextField ref={handle} secret paste label="Agent37 API key" onFilledChange={filled} />);
  await page.press(page.byLabel("Paste Agent37 API key"));
  await page.press(page.byLabel("Agent37 API key"));
  expect(filled.mock.calls).toEqual([[true], [false]]);
  expect(handle.current!.read()).toBe("");
  expect(input()!.value).toBe("");
  expect(document.activeElement).toBe(input());
  expect(page.byLabel("Paste Agent37 API key")).not.toBeNull();
});

it("empties a secret when the form says so, as after a rejected key, and focuses it", async () => {
  const filled = vi.fn();
  const handle = createRef<TextFieldHandle>();
  mocks.paste.mockResolvedValue(SECRET);
  await page.show(<TextField ref={handle} secret paste label="Agent37 API key" onFilledChange={filled} />);
  await page.press(page.byLabel("Paste Agent37 API key"));
  await act(async () => { handle.current!.clear(); handle.current!.focus(); });
  expect(handle.current!.read()).toBe("");
  expect(filled).toHaveBeenLastCalledWith(false);
  expect(document.activeElement).toBe(input());
  // Typed this time: clearing empties the secure input too.
  await page.type(input(), SECRET);
  await act(async () => handle.current!.clear());
  expect(input()!.value).toBe("");
  expect(handle.current!.read()).toBe("");
  expect(filled.mock.calls).toEqual([[true], [false], [true], [false]]);
});

it("drops the secret when the field leaves the screen, and a late clipboard answer lands nowhere", async () => {
  const filled = vi.fn();
  const handle = createRef<TextFieldHandle>();
  await page.show(<TextField ref={handle} secret paste label="Agent37 API key" onFilledChange={filled} />);
  await page.type(input(), SECRET);
  const kept = handle.current!;
  expect(kept.read()).toBe(SECRET);
  await page.show(null);
  expect(kept.read()).toBe("");

  let answer!: (text: string) => void;
  mocks.paste.mockImplementation(() => new Promise<string>((resolve) => { answer = resolve; }));
  const later = createRef<TextFieldHandle>();
  await page.show(<TextField ref={later} secret paste label="Agent37 API key" onFilledChange={filled} />);
  await page.press(page.byLabel("Paste Agent37 API key"));
  const held = later.current!;
  filled.mockClear();
  await page.show(null);
  await act(async () => answer(SECRET));
  expect(held.read()).toBe("");
  expect(filled).not.toHaveBeenCalled();
});

it("answers the form with a plain field's value, and clears it through the form's own state", async () => {
  const change = vi.fn();
  const handle = createRef<TextFieldHandle>();
  await page.show(<TextField ref={handle} label="Name" value="Northwind" onChangeText={change} />);
  expect(handle.current!.read()).toBe("Northwind");
  await act(async () => handle.current!.clear());
  expect(change).toHaveBeenCalledExactlyOnceWith("");
});
