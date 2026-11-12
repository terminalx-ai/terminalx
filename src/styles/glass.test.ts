// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const app = readFileSync(new URL("./app.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

/**
 * Glass mode (PRO-336): the desktop shows through the window's own large
 * surfaces only. Whatever floats over other content keeps an opaque ground,
 * and Reduce transparency turns glass and blur off (behaviour: src/lib/glass.test.ts,
 * scripts/webkit/readable-panels.mjs).
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

  it("drops every blur while Reduce transparency is on, from the attribute the app sets", () => {
    // WebKit has no prefers-reduced-transparency; the setting comes from AppKit (src/lib/glass.ts).
    expect(app).not.toMatch(/@media[^{]*prefers-reduced-transparency/);
    expect(app).toMatch(/:root\[data-reduce-transparency\] \*,[\s\S]*?backdrop-filter: none !important/);
    expect(html).toMatch(/window\.__TERMINALX_REDUCE_TRANSPARENCY__ === true/);
  });
});
