/** Shared by every glyph file: the element shape, and strokes the set repeats. */
export type Glyph = [tag: "path" | "circle" | "rect" | "line" | "ellipse", attrs: Record<string, string | number>][];

/** A filled dot, the one thing in the set that is not a stroke. */
export const dot = (cx: number, cy: number, r = 0.9): Glyph[number] => ["circle", { cx, cy, r, fill: "currentColor", stroke: "none" }];

/** A closed folder: wider than tall, a small tab on the left, the body below it. */
export const FOLDER = "M1.5 12V4.5A1.25 1.25 0 0 1 2.75 3.25h3.1l1.4 1.5h6A1.25 1.25 0 0 1 14.5 6v6a1.25 1.25 0 0 1-1.25 1.25H2.75A1.25 1.25 0 0 1 1.5 12z";
/** The fold where the folder's lid meets its body. */
export const FOLDER_FOLD = "M1.5 6.75h13";
/** A circle filling the grid, for everything "-circle". */
export const RING: Glyph[number] = ["circle", { cx: 8, cy: 8, r: 5.75 }];
/** A square filling the grid, for everything "-square". */
export const BOX: Glyph[number] = ["rect", { x: 2, y: 2, width: 12, height: 12, rx: 1.5 }];
