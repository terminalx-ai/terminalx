import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach } from "vitest";
import type * as Theme from "@mobile/ui/theme";

/** The phone's appearance in a component test; a test sets it before it draws. */
export const appearance = { scheme: "dark" as "dark" | "light" };

/**
 * The theme module with the palette the boards are drawn in: Ember when dark,
 * Den when light (Ember has no light palette), read from the app's own table.
 * Used as `vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()))`.
 */
export function boardTheme(actual: typeof Theme): typeof Theme {
  return { ...actual, useTheme: () => ({ name: "Ember", palette: actual.themePalette(appearance.scheme === "light" ? "Den" : "Ember", appearance.scheme), setName: () => undefined }) };
}

/**
 * Icons drawn as an element that says which icon it is, where a test needs to
 * tell one from another (the app's tests otherwise draw nothing for them).
 * Used as `vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons())`.
 */
export function namedIcons() {
  return new Proxy({}, {
    get: (_target, name) => (name === "then" || typeof name === "symbol" ? undefined : name === "__esModule" ? true : ({ color, size }: { color?: string; size?: number }) => <i data-icon={name} data-color={color} data-size={size} />),
    has: (_target, name) => name !== "then",
  });
}

/** One page to draw on, made before each test and taken down after it. */
export function stage() {
  let root: Root;
  const page = {
    container: document.createElement("div"),
    show: (node: ReactNode) => act(async () => { root.render(node); }),
    icon: (name: string) => page.container.querySelector(`[data-icon="${name}"]`) as HTMLElement | null,
    byId: (id: string) => page.container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null,
    byLabel: (label: string) => page.container.querySelector(`[aria-label="${label}"]`) as HTMLElement | null,
    /** The first element whose own text is exactly this. */
    byText: (text: string) => [...page.container.querySelectorAll<HTMLElement>("span,div")].find((element) => element.textContent === text && ![...element.children].some((child) => child.textContent === text)) ?? null,
    styleOf: (element: Element | null): Record<string, any> => JSON.parse(element?.getAttribute("data-style") ?? "{}"),
    press: (element: Element | null) => act(async () => { (element as HTMLElement).click(); }),
    type: (input: Element | null, value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    }),
  };
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    appearance.scheme = "dark";
    page.container = document.createElement("div");
    document.body.append(page.container);
    root = createRoot(page.container);
  });
  afterEach(async () => { await act(async () => root.unmount()); page.container.remove(); });
  return page;
}
