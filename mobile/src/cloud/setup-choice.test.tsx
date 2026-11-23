// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chooseSetupOrganization, resetSetupChoiceForTests, useSetupChoice } from "./setup-choice";

// PRO-527: which organization is being set up is the one thing of the setup the phone keeps (25.02).

const kept = vi.hoisted(() => ({ items: new Map<string, string>(), fail: false }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (name: string) => { if (kept.fail) throw new Error("storage"); return kept.items.get(name) ?? null; },
  setItem: async (name: string, value: string) => { kept.items.set(name, value); },
  removeItem: async (name: string) => { kept.items.delete(name); },
} }));

const KEY = "terminalx:cloud-setup-organization:v1";
let root: Root;
let container: HTMLElement;
// What the hook hands a screen, drawn so the test reads it as the screen would.
function Probe({ userId }: { userId: string | null | undefined }) {
  return <output>{JSON.stringify(useSetupChoice(userId))}</output>;
}
const seen = (): { ready: boolean; orgId: string | null } => JSON.parse(container.textContent || "null");
const mount = () => { container = document.createElement("div"); root = createRoot(container); };
const show = (userId: string | null | undefined) => act(async () => { root.render(<Probe userId={userId} />); await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  kept.items.clear();
  kept.fail = false;
  resetSetupChoiceForTests();
  mount();
});
afterEach(async () => { await act(async () => root.unmount()); });

it("has no choice until one is made, then keeps it for the next start of the app", async () => {
  await show("u-alex");
  expect(seen()).toEqual({ ready: true, orgId: null });
  await act(async () => { chooseSetupOrganization("u-alex", "org-n"); });
  expect(seen().orgId).toBe("org-n");
  expect(JSON.parse(kept.items.get(KEY)!)).toEqual({ userId: "u-alex", orgId: "org-n" });
  // The app starts again: what was kept is read back.
  resetSetupChoiceForTests();
  await act(async () => root.unmount());
  mount();
  await show("u-alex");
  expect(seen()).toEqual({ ready: true, orgId: "org-n" });
});

it("is not ready, and guesses nothing, before what was kept has been read", async () => {
  kept.items.set(KEY, JSON.stringify({ userId: "u-alex", orgId: "org-n" }));
  act(() => { root.render(<Probe userId="u-alex" />); });
  expect(seen()).toEqual({ ready: false, orgId: null });
  await show("u-alex");
  expect(seen()).toEqual({ ready: true, orgId: "org-n" });
});

it("keeps the choice while the app does not yet know who is signed in, and drops it for anyone else or nobody", async () => {
  kept.items.set(KEY, JSON.stringify({ userId: "u-alex", orgId: "org-n" }));
  await show(undefined);
  expect(seen().orgId).toBeNull();
  expect(kept.items.has(KEY)).toBe(true);
  await show("u-other");
  expect(seen().orgId).toBeNull();
  expect(kept.items.has(KEY)).toBe(false);
  await act(async () => { chooseSetupOrganization("u-other", "org-o"); });
  await show(null);
  expect(kept.items.has(KEY)).toBe(false);
});

it("reads something damaged, or storage that fails, as no choice", async () => {
  kept.items.set(KEY, "{not json");
  await show("u-alex");
  expect(seen()).toEqual({ ready: true, orgId: null });
  resetSetupChoiceForTests();
  kept.items.set(KEY, JSON.stringify({ userId: "u-alex" }));
  kept.fail = true;
  await act(async () => root.unmount());
  mount();
  await show("u-alex");
  expect(seen()).toEqual({ ready: true, orgId: null });
});
