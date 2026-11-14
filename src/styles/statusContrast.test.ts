// @vitest-environment node
import { describe, expect, it } from "vitest";
import { contrast, luminance, palettes, rgb, type RGB } from "./tokenContrast";

describe("manual status colours", () => {
  const all = palettes();
  it("checks every theme and mode", () => {
    expect(all.flatMap(({ selector }) => [...selector.matchAll(/data-mode="(dark|light)"/g)]).length).toBe(8);
  });
  for (const { selector, tokens } of all) {
    it(`meets AA text contrast (4.5:1) on every sidebar/menu surface in ${selector}`, () => {
      const surfaces = ["page", "card", "raised", "muted", "selected"].map((surface) => rgb(tokens[`surface-${surface}`]));
      // Menus can be highlighted with an 11.5% white veil in dark mode, or 10% black in light mode.
      const dark = luminance(surfaces[0]) < 0.5;
      const highlighted = surfaces.map((surface) => surface.map((channel) => dark ? channel * 0.885 + 0.115 : channel * 0.9) as RGB);
      for (const status of ["backlog", "in-progress", "in-review", "done", "canceled"]) {
        const ink = rgb(tokens[`status-${status}`]);
        for (const surface of [...surfaces, ...highlighted]) expect(contrast(ink, surface), status).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
