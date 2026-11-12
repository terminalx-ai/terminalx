// @vitest-environment node
import { describe, expect, it } from "vitest";
import { contrast, oklch, palettes, rgb, type RGB } from "./tokenContrast";

/**
 * Secondary and tertiary text (`text-muted-foreground`, `text-faint`) meet
 * WCAG AA, 4.5:1 for normal text, on the surfaces they sit on, in every
 * palette, light and dark (PRO-336). Muted text also labels selected rows and
 * muted chips, so it is held to every surface; faint text to the grounds of
 * the page, the chat, cards and raised panels. The rungs keep their order:
 * strong over muted over faint.
 */
const AA = 4.5;

describe("text ink contrast", () => {
  const all = palettes();
  it("checks every theme and mode", () => {
    expect(all.flatMap(({ selector }) => [...selector.matchAll(/data-mode="(dark|light)"/g)]).length).toBe(8);
  });
  for (const { selector, dark, tokens } of all) {
    // In dark mode the chat is the page mixed 88% with black (tokens.css, --surface-chat).
    const page = oklch(tokens["surface-page"]);
    const grounds: Record<string, RGB> = {
      page: rgb(page),
      card: rgb(tokens["surface-card"]),
      raised: rgb(tokens["surface-raised"]),
      ...(dark ? { chat: rgb([page[0] * 0.88, page[1] * 0.88, page[2]]) } : {}),
    };
    const every: Record<string, RGB> = { ...grounds, muted: rgb(tokens["surface-muted"]), selected: rgb(tokens["surface-selected"]) };

    it(`muted text meets ${AA}:1 on every surface in ${selector}`, () => {
      const ink = rgb(tokens["ink-muted"]);
      for (const [name, ground] of Object.entries(every)) expect(contrast(ink, ground), `ink-muted on surface-${name}`).toBeGreaterThanOrEqual(AA);
    });

    it(`faint text meets ${AA}:1 on the page, chat, card and raised surfaces in ${selector}`, () => {
      const ink = rgb(tokens["ink-faint"]);
      for (const [name, ground] of Object.entries(grounds)) expect(contrast(ink, ground), `ink-faint on surface-${name}`).toBeGreaterThanOrEqual(AA);
    });

    it(`keeps strong over muted over faint in ${selector}`, () => {
      const on = rgb(tokens["surface-page"]);
      const [strong, muted, faint] = ["ink-strong", "ink-muted", "ink-faint"].map((ink) => contrast(rgb(tokens[ink]), on));
      expect(strong).toBeGreaterThan(muted);
      expect(muted).toBeGreaterThan(faint);
    });
  }
});
