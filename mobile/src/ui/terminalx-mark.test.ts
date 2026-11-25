import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { MARK_BOX, MARK_STROKES } from "./terminalx-mark";

// PRO-578: the phone draws the mark from the app icon's own source, not by eye.
const source = readFileSync(new URL("../../../resources/icon-source/logo.svg", import.meta.url), "utf8");
const attribute = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

it("draws the paths of the app icon's source drawing", () => {
  const root = /<svg[^>]*>/.exec(source)![0];
  expect(attribute(root, "viewBox")).toBe(MARK_BOX.join(" "));
  expect(attribute(root, "fill")).toBe("none");
  const paths = [...source.matchAll(/<path[^>]*>/g)].map(([tag]) => ({
    d: attribute(tag, "d"),
    width: Number(attribute(tag, "stroke-width")),
    opacity: Number(attribute(tag, "opacity") ?? 1),
    cap: attribute(tag, "stroke-linecap"),
  }));
  expect(paths.map(({ cap }) => cap)).toEqual(["square", "square", "square"]);
  expect(paths.map(({ d, width, opacity }) => ({ d, width, opacity }))).toEqual(MARK_STROKES.map((stroke) => ({ ...stroke })));
});
