// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const app = readFileSync(new URL("./app.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

/**
 * Glass mode (PRO-336): the desktop shows through the window's own large
 * surfaces only. Whatever floats over other content keeps an opaque ground,
 * and Reduce transparency turns glass off.
 */
describe("glass mode", () => {
  const glass = tokens.match(/html\[data-glass\] body \{([^}]+)\}/)![1];
  const veiled = [...glass.matchAll(/--([\w-]+):/g)].map(([, name]) => name);

  it("veils no surface that floats over other content", () => {
    expect(veiled).not.toContain("popover");
    expect(veiled).not.toContain("composer");
    // Both alias the opaque card colour, whatever the palette.
    expect(tokens).toMatch(/--popover: var\(--surface-card\);/);
    expect(tokens).toMatch(/--composer: var\(--surface-card\);/);
  });

  it("has no translucent floating veil or blur utility left to reach for", () => {
    expect(tokens).not.toMatch(/--veil-float/);
    expect(app).not.toMatch(/--veil-float|\.glass\s*\{/);
  });

  it("is off while macOS asks to Reduce transparency, and nothing blurs then", () => {
    expect(html).toMatch(/matchMedia\("\(prefers-reduced-transparency: reduce\)"\)/);
    expect(html).toMatch(/toggleAttribute\("data-glass", !reduce\.matches\)/);
    expect(html).toMatch(/reduce\.addEventListener\("change"/);
    const reduce = app.match(/@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n\}/)![1];
    expect(reduce).toMatch(/backdrop-filter: none !important/);
  });
});
