/** Shared by every glyph file: the element shape, and strokes the set repeats. */
export type Glyph = [tag: "path" | "circle" | "rect" | "line" | "ellipse", attrs: Record<string, string | number>][];

/** A filled dot, the one thing in the set that is not a stroke. */
export const dot = (cx: number, cy: number, r = 0.9): Glyph[number] => ["circle", { cx, cy, r, fill: "currentColor", stroke: "none" }];

/**
 * A closed folder: one outline, a soft tab on the left, in the header icons' frame (12 wide, a 1.5 corner).
 * No lid line across it: the tab alone says folder.
 */
export const FOLDER = "M2 11.5v-7A1.5 1.5 0 0 1 3.5 3h2.6l1.5 1.75h4.9A1.5 1.5 0 0 1 14 6.25v5.25a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z";
/** A circle filling the grid, for everything "-circle". */
export const RING: Glyph[number] = ["circle", { cx: 8, cy: 8, r: 5.75 }];
/** A square filling the grid, for everything "-square". */
export const BOX: Glyph[number] = ["rect", { x: 2, y: 2, width: 12, height: 12, rx: 1.5 }];
