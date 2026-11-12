// @vitest-environment node
import { describe, expect, it } from "vitest";
import { contrast, oklch, palettes, rgb, type RGB } from "./tokenContrast";

/**
 * Secondary and tertiary text (`text-muted-foreground`, `text-faint`) meet
 * WCAG AA, 4.5:1 for normal text, on every surface they sit on, in every
 * palette, light and dark (PRO-336): the page, the chat, cards, raised and
 * muted surfaces, selected rows, the glass-mode selected veil and a menu's
 * highlighted row. The rungs keep their order: strong over muted over faint.
 */
const AA = 4.5;

/** `top` (white 1 or black 0) laid at `alpha` over `ground`, as the browser composites it. */
const veil = (ground: RGB, top: number, alpha: number) => ground.map((channel) => channel * (1 - alpha) + top * alpha) as RGB;

describe("text ink contrast", () => {
  const all = palettes();
  it("checks every theme and mode", () => {
    expect(all.flatMap(({ selector }) => [...selector.matchAll(/data-mode="(dark|light)"/g)]).length).toBe(8);
  });
  for (const { selector, dark, tokens } of all) {
    // In dark mode the chat is the page mixed 88% with black (tokens.css, --surface-chat).
    const page = oklch(tokens["surface-page"]);
    const grounds: Record<string, RGB> = Object.fromEntries(["page", "card", "raised", "muted", "selected"].map((name) => [name, rgb(tokens[`surface-${name}`])]));
    if (dark) grounds.chat = rgb([page[0] * 0.88, page[1] * 0.88, page[2]]);
    for (const base of ["page", "card"]) {
      // Glass mode's --veil-selected (9% white / 7% black) and a menu row's highlight, --veil-strong (11.5% white / 10% black).
      grounds[`${base} under the glass selected veil`] = dark ? veil(grounds[base], 1, 0.09) : veil(grounds[base], 0, 0.07);
      grounds[`${base} under a menu highlight`] = dark ? veil(grounds[base], 1, 0.115) : veil(grounds[base], 0, 0.1);
    }

    for (const ink of ["ink-muted", "ink-faint"]) {
      it(`${ink} meets ${AA}:1 on every surface in ${selector}`, () => {
        const color = rgb(tokens[ink]);
        for (const [name, ground] of Object.entries(grounds)) expect(contrast(color, ground), `${ink} on ${name}`).toBeGreaterThanOrEqual(AA);
      });
    }

    it(`keeps strong over muted over faint in ${selector}`, () => {
      const on = rgb(tokens["surface-page"]);
      const [strong, muted, faint] = ["ink-strong", "ink-muted", "ink-faint"].map((ink) => contrast(rgb(tokens[ink]), on));
      expect(strong).toBeGreaterThan(muted);
      expect(muted).toBeGreaterThan(faint);
    });
  }
});
