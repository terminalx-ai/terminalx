// Real rasterization regression, headless and synthetic. Not native acceptance.
// Uses the existing Playwright WebKit installation; no browser download or GUI.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { webkit } from "playwright";

const compiled = ts.transpileModule(await readFile("src/lib/terminalColor.ts", "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
const browser = await webkit.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>synthetic color regression</title>");
  await page.addScriptTag({ content: `var ColorProbe = {}; (function(exports) {\n${compiled.outputText}\n})(ColorProbe);` });
  const result = await page.evaluate(() => {
    // Compare against the previous fresh-canvas conversion, using actual color
    // parsing/compositing. Invalid and alpha inputs reveal stale state on reuse.
    const inputs = ["#ff0000", "rgba(0,0,255,0.5)", "not-a-color", "transparent",
      "oklch(0.7 0.15 140)", "#abcdef", "rgba(255,255,0,0.25)", "#000000"];
    const reference = (css) => {
      const c = document.createElement("canvas"); c.width = c.height = 1;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("reference 2D context unavailable");
      ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1);
      return "#" + [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3)
        .map(v => v.toString(16).padStart(2, "0")).join("");
    };
    const expected = inputs.map(reference);
    const original = document.createElement;
    let canvases = 0;
    document.createElement = function (tag, ...args) {
      if (tag.toLowerCase() === "canvas") canvases++;
      return original.call(this, tag, ...args);
    };
    const mismatches = [];
    try {
      for (let round = 0; round < 200; round++) {
        inputs.forEach((css, i) => {
          const actual = ColorProbe.terminalColorHex(css, "fallback-must-not-be-used");
          if (actual !== expected[i]) mismatches.push({ round, css, actual, expected: expected[i] });
        });
      }
    } finally {
      document.createElement = original;
    }
    return { inputs, expected, conversions: 1600, canvases, mismatches };
  });
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.canvases, 1);
  console.log(JSON.stringify({ browserVersion: browser.version(), ...result }, null, 2));
} finally {
  await browser.close();
}
