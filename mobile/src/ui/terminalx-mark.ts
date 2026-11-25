/**
 * The TerminalX mark's own drawing: prompt arrow, underscore and cross, on
 * the grid of `resources/icon-source/logo.svg` (the one layer of the Icon
 * Composer project the app icon is compiled from). Square caps, mitred joins.
 * `terminalx-mark.test.ts` holds these to that file. They are in a module of
 * their own, with nothing native in it, so that test runs anywhere.
 */
export const MARK_STROKES = [
  { d: "M25 30 L45 50 L25 70", width: 8, opacity: 1 },
  { d: "M55 70 L80 70", width: 8, opacity: 1 },
  { d: "M60 30 L80 50 M80 30 L60 50", width: 6, opacity: 0.8 },
] as const;

/** The source drawing's `viewBox`: x, y, width, height. */
export const MARK_BOX = [18, 23, 68, 54] as const;
