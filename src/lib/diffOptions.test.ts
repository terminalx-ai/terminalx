import { afterEach, expect, it, vi } from "vitest";
import { whitespaceDiff } from "./diffOptions";

afterEach(() => { localStorage.clear(); vi.resetModules(); });

it("ignores horizontal whitespace but retains added lines and meaningful edits", () => {
  expect(whitespaceDiff("  const x = 1;\r\n\treturn x;\n", "const x=1;\nreturn  x;  \n")).toEqual([]);
  expect(whitespaceDiff("a\nb", "a\n\nb")).not.toEqual([]);
  const a = "  const x = 1;\n  return x;\n", b = "const x=2;\nreturn x;  \n";
  const changes = whitespaceDiff(a, b);
  expect(changes).toHaveLength(1);
  expect(a.slice(changes[0].fromA, changes[0].toA)).toBe("1");
  expect(b.slice(changes[0].fromB, changes[0].toB)).toBe("2");
});

it("persists view, whitespace, global wrap and independent file overrides across reloads", async () => {
  const { getPrefs, setPrefs } = await import("./prefs");
  const { diffFileKey, setFileWrap } = await import("./diffOptions");
  const a = diffFileKey("repo:a", "src/a.ts"), b = diffFileKey("repo:b", "src/a.ts");
  setPrefs({ diffMode: "split", diffHideWhitespace: true, diffWrap: false, diffWrapFiles: {} });
  setFileWrap(a, true);
  expect(getPrefs().diffWrapFiles[b]).toBeUndefined();
  vi.resetModules();
  const reloaded = await import("./prefs");
  expect(reloaded.getPrefs()).toMatchObject({ diffMode: "split", diffHideWhitespace: true, diffWrap: false, diffWrapFiles: { [a]: true } });
  (await import("./diffOptions")).setFileWrap(a, undefined);
  expect(reloaded.getPrefs().diffWrapFiles).toEqual({});
});

it("rejects malformed persisted option values", async () => {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ diffMode: "other", diffWrap: "false", diffHideWhitespace: "true", diffWrapFiles: { valid: false, invalid: "true" } }));
  vi.resetModules();
  expect((await import("./prefs")).getPrefs()).toMatchObject({ diffMode: "unified", diffWrap: true, diffHideWhitespace: false, diffWrapFiles: { valid: false } });
});
