/**
 * WCAG contrast of the colours tokens.css writes, for the tests that hold its
 * palettes to AA. Reads the oklch() and #rrggbb forms the file uses.
 */
import { readFileSync } from "node:fs";

export type RGB = [number, number, number];

const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const gamma = (value: number) => value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;

/** An oklch() as [L, C, h]. */
export const oklch = (color: string) => color.match(/oklch\(([^)]+)\)/)![1].trim().split(/\s+/).map(Number) as RGB;

/** Gamma-encoded sRGB, 0–1 per channel, clipped to the gamut as a display would. */
export function rgb(color: string | RGB): RGB {
  if (typeof color === "string" && color.startsWith("#")) return [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255) as RGB;
  const [L, C, h] = typeof color === "string" ? oklch(color) : color;
  const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((channel) => Math.min(1, Math.max(0, gamma(channel)))) as RGB;
}

export const luminance = (color: RGB) => color.map(linear).reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);
export const contrast = (a: RGB, b: RGB) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

export interface Palette {
  selector: string;
  dark: boolean;
  tokens: Record<string, string>;
}

/** Every [data-theme][data-mode] block of tokens.css, with its custom properties. */
export function palettes(): Palette[] {
  const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
  return [...css.matchAll(/(\[data-theme="[\s\S]*?)\{([^}]+)\}/g)].map(([, selector, declarations]) => ({
    selector: selector.trim().replace(/\s+/g, " "),
    dark: /data-mode="dark"/.test(selector),
    tokens: Object.fromEntries([...declarations.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value])),
  }));
}
