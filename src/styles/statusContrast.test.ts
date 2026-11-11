// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
type RGB = [number, number, number];
const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const gamma = (value: number) => value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
function rgb(color: string): RGB {
  if (color.startsWith("#")) return [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255) as RGB;
  const [L, C, h] = color.match(/oklch\(([^)]+)\)/)![1].split(/\s+/).map(Number);
  const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((channel) => Math.min(1, Math.max(0, gamma(channel)))) as RGB;
}
const luminance = (color: RGB) => color.map(linear).reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: RGB, b: RGB) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

describe("manual status colours", () => {
  const palettes = [...css.matchAll(/(\[data-theme="[\s\S]*?)\{([^}]+)\}/g)];
  it("checks every theme and mode", () => {
    expect(palettes.flatMap(([_, selector]) => [...selector.matchAll(/data-mode="(dark|light)"/g)]).length).toBe(8);
  });
  for (const [, selector, declarations] of palettes) {
    const tokens = Object.fromEntries([...declarations.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value]));
    it(`meets AA text contrast (4.5:1) on every sidebar/menu surface in ${selector.trim()}`, () => {
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
