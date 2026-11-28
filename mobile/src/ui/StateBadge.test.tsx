// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { badgeLabel, credentialBadge, providerBadge, StateBadge, type BadgeState } from "./StateBadge";
import { appearance, stage } from "./testing/kit";

// PRO-542: the small state pill of boards 25.03 and 25.04.
vi.mock("react-native", () => import("@mobile/ui/testing/native"));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());

const page = stage();
const pill = () => page.byId("badge")!;

it.each([
  ["connected", "Connected", "#55b979", "#55b97924"],
  ["ready", "Ready to use", "#55b979", "#55b97924"],
  ["available", "Available", "#55b979", "#55b97924"],
  ["attention-required", "Needs attention", "#db695f", "#db695f24"],
  ["sign-in-required", "Sign-in required", "#d6a744", "#d6a74424"],
  ["not-connected", "Not connected", "#ab9aa0", "#20181b"],
  ["revoked", "Revoked", "#ab9aa0", "#20181b"],
  ["not-offered", "Not offered", "#ab9aa0", "#20181b"],
] as const)("draws %s as “%s”", async (state, words, color, fill) => {
  await page.show(<StateBadge testID="badge" state={state} />);
  expect(pill().textContent).toBe(words);
  expect(badgeLabel(state)).toBe(words);
  expect(page.styleOf(pill())).toMatchObject({ minHeight: 22, borderRadius: 7, paddingHorizontal: 8, backgroundColor: fill });
  expect(page.styleOf(pill().firstElementChild)).toMatchObject({ color, fontSize: 12, fontWeight: "600" });
});

it("uses WCAG AA darker status colours in light, and takes the light palette's grey at rest", async () => {
  appearance.scheme = "light";
  await page.show(<StateBadge testID="badge" state="connected" />);
  expect(page.styleOf(pill()).backgroundColor).toBe("#14532d24");
  expect(page.styleOf(pill().firstElementChild).color).toBe("#14532d");
  await page.show(<StateBadge testID="badge" state="not-connected" />);
  expect(page.styleOf(pill()).backgroundColor).toBe("#f2f0ec");
  expect(page.styleOf(pill().firstElementChild).color).toBe("#706d70");
});

const field = { name: "apiKey", kind: "secret" as const, label: "Agent37 API key" };
it.each<[string, string, boolean, number, BadgeState | null]>([
  ["a connected provider", "available", true, 1, "connected"],
  ["a provider with nothing to connect", "available", true, 0, "ready"],
  ["a provider a member can use", "available", false, 1, "available"],
  ["a provider not connected yet", "not-connected", true, 1, "not-connected"],
  ["a provider a member cannot use yet", "not-connected", false, 1, "not-connected"],
  ["a provider whose key stopped working", "attention-required", true, 1, "attention-required"],
  ["a provider that takes no new workspaces", "disabled-for-create", false, 0, "not-offered"],
  ["an availability this app does not know", "paused-by-policy", true, 1, null],
])("reads %s from the server's answer", (_what, availability, canManage, fields, expected) => {
  expect(providerBadge({ availability, canManage, descriptor: { credentialFields: Array.from({ length: fields }, () => field) } })).toBe(expected);
});

it("reads an agent login's state, and guesses nothing for one it does not know", () => {
  expect(credentialBadge("connected")).toBe("connected");
  expect(credentialBadge("sign-in-required")).toBe("sign-in-required");
  expect(credentialBadge("revoked")).toBe("revoked");
  expect(credentialBadge("disconnected")).toBe("not-connected");
  expect(credentialBadge("quarantined")).toBeNull();
});
