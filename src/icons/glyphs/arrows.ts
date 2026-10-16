/**
 * Arrows, chevrons and the small triangles: every direction of each family
 * drawn from one master and turned, so the family shares its proportions.
 */
import { BOX, RING, dot, type Glyph } from "./shared";

/** The same arrow, small enough to sit inside a ring or a box. */
const inner = {
  down: "M8 5v6M5.5 8.5 8 11l2.5-2.5",
  up: "M8 11V5M5.5 7.5 8 5l2.5 2.5",
  left: "M11 8H5M7.5 5.5 5 8l2.5 2.5",
  right: "M5 8h6M8.5 5.5 11 8l-2.5 2.5",
  leftDown: "M10.5 5.5l-5 5M5.5 6.5v4h4",
  leftUp: "M10.5 10.5l-5-5M5.5 9.5v-4h4",
  rightDown: "M5.5 5.5l5 5M10.5 6.5v4h-4",
  rightUp: "M5.5 10.5l5-5M6.5 5.5h4v4",
};
/** A block arrow: one filled-looking outline, as a keycap shows it. */
const block = {
  down: "M6 2.5h4v6h2.5L8 13.5 3.5 8.5H6z",
  up: "M6 13.5h4v-6h2.5L8 2.5 3.5 7.5H6z",
  left: "M13.5 6v4h-6v2.5L2.5 8l5-4.5V6z",
  right: "M2.5 6v4h6v2.5L13.5 8l-5-4.5V6z",
};
/** A shorter block arrow with a line it runs from or to. */
const blockLine = {
  down: "M6 2h4v5h2.5L8 11.5 3.5 7H6zM3 14.5h10",
  up: "M6 14h4V9h2.5L8 4.5 3.5 9H6zM3 1.5h10",
  left: "M14 6v4H9v2.5L4.5 8 9 3.5V6zM1.5 3v10",
  right: "M2 6v4h5v2.5L11.5 8 7 3.5V6zM14.5 3v10",
};
/** A bracket on one side of the grid, open towards the middle. */
const bracket = {
  bottom: "M3 10.5v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2",
  top: "M3 5.5v-2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v2",
  left: "M5.5 3h-2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2",
  right: "M10.5 3h2a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-2",
};
/** A box with a gap in the middle of one side, for an arrow to pass through. */
const gapBox = {
  bottom: "M6 13.5H3.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10",
  top: "M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H10",
  left: "M2.5 6V3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V10",
  right: "M13.5 6V3.5a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10",
};
const chevronSmall = {
  down: "M5.5 7 8 9.5 10.5 7",
  up: "M5.5 9 8 6.5 10.5 9",
  left: "M9 5.5 6.5 8 9 10.5",
  right: "M7 5.5 9.5 8 7 10.5",
};

export const GLYPHS: Record<string, Glyph> = {
  // ---- plain arrows (the four straight ones live in core)
  ArrowRightUp: [["path", { d: "M4 12 12 4M6 4h6v6" }]],
  ArrowRightDown: [["path", { d: "M4 4l8 8M12 6v6H6" }]],
  ArrowLeftUp: [["path", { d: "M12 12 4 4M4 10V4h6" }]],
  ArrowLeftDown: [["path", { d: "M12 4 4 12M4 6v6h6" }]],
  ArrowSwap: [["path", { d: "M3 5.5h9.5L10 3M13 10.5H3.5L6 13" }]],
  ArrowUUpLeft: [["path", { d: "M12 13V7a3.5 3.5 0 0 0-3.5-3.5H3M5.5 1 3 3.5 5.5 6" }]],
  ArrowUUpRight: [["path", { d: "M4 13V7a3.5 3.5 0 0 1 3.5-3.5H13M10.5 1 13 3.5 10.5 6" }]],
  ArrowCcw: [["path", { d: "M2.5 8a5.5 5.5 0 1 0 1.6-3.9L2.5 5.7M2.5 2v3.7h3.7" }]],
  ArrowsBothHorizontal: [["path", { d: "M2.5 8h11M5 5.5 2.5 8 5 10.5M11 5.5 13.5 8 11 10.5" }]],
  ArrowsBothVertical: [["path", { d: "M8 2.5v11M5.5 5 8 2.5 10.5 5M5.5 11 8 13.5l2.5-2.5" }]],
  ArrowsCcw: [["path", { d: "M13.5 8A5.5 5.5 0 0 1 4 11.9L2.5 10.5M2.5 8A5.5 5.5 0 0 1 12 4.1L13.5 5.5M2.5 13.5v-3h3M13.5 2.5v3h-3" }]],
  ArrowsCcwAngular: [["path", { d: "M3 6.5V5a1.5 1.5 0 0 1 1.5-1.5H13M10.5 1 13 3.5 10.5 6M13 9.5V11a1.5 1.5 0 0 1-1.5 1.5H3M5.5 15 3 12.5 5.5 10" }]],
  ArrowsContract: [["path", { d: "M13.5 2.5 9.5 6.5M9.5 3.5v3h3M2.5 13.5l4-4M6.5 12.5v-3h-3" }]],
  ArrowsContractSimple: [["path", { d: "M6.5 2v4.5H2M9.5 14V9.5H14" }]],
  ArrowsDownUp: [["path", { d: "M5 2.5v11M2.5 11 5 13.5 7.5 11M11 13.5v-11M8.5 5 11 2.5 13.5 5" }]],
  ArrowsExpand: [["path", { d: "M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" }]],
  ArrowsExpandSimple: [["path", { d: "M9.5 2H14v4.5M2 9.5V14h4.5" }]],
  ArrowsOutCardinal: [["path", { d: "M8 1.5v13M1.5 8h13M6 3.5 8 1.5l2 2M6 12.5l2 2 2-2M3.5 6 1.5 8l2 2M12.5 6l2 2-2 2" }]],

  // ---- block arrows
  ArrowBlockDown: [["path", { d: block.down }]],
  ArrowBlockUp: [["path", { d: block.up }]],
  ArrowBlockLeft: [["path", { d: block.left }]],
  ArrowBlockRight: [["path", { d: block.right }]],
  ArrowBlockLineDown: [["path", { d: blockLine.down }]],
  ArrowBlockLineUp: [["path", { d: blockLine.up }]],
  ArrowBlockLineLeft: [["path", { d: blockLine.left }]],
  ArrowBlockLineRight: [["path", { d: blockLine.right }]],

  // ---- arrows from and to a bracket (a tray)
  ArrowBracketFromDown: [["path", { d: bracket.bottom }], ["path", { d: "M8 10.5V2.5M4.5 6 8 2.5 11.5 6" }]],
  ArrowBracketFromUp: [["path", { d: bracket.top }], ["path", { d: "M8 5.5v8M4.5 10 8 13.5l3.5-3.5" }]],
  ArrowBracketFromUpDashed: [["path", { d: bracket.top, strokeDasharray: "2 1.6" }], ["path", { d: "M8 5.5v8M4.5 10 8 13.5l3.5-3.5" }]],
  ArrowBracketFromLeft: [["path", { d: bracket.left }], ["path", { d: "M5.5 8h8M10 4.5 13.5 8 10 11.5" }]],
  ArrowBracketFromRight: [["path", { d: bracket.right }], ["path", { d: "M10.5 8h-8M6 4.5 2.5 8 6 11.5" }]],
  ArrowBracketToDown: [["path", { d: bracket.bottom }], ["path", { d: "M8 2.5v8M4.5 7 8 10.5 11.5 7" }]],
  ArrowBracketToUp: [["path", { d: bracket.top }], ["path", { d: "M8 13.5v-8M4.5 9 8 5.5 11.5 9" }]],
  ArrowBracketToLeft: [["path", { d: bracket.left }], ["path", { d: "M13.5 8h-8M9 4.5 5.5 8 9 11.5" }]],
  ArrowBracketToRight: [["path", { d: bracket.right }], ["path", { d: "M2.5 8h8M7 4.5 10.5 8 7 11.5" }]],

  // ---- arrows in a ring
  ArrowCircleDown: [RING, ["path", { d: inner.down }]],
  ArrowCircleUp: [RING, ["path", { d: inner.up }]],
  ArrowCircleLeft: [RING, ["path", { d: inner.left }]],
  ArrowCircleRight: [RING, ["path", { d: inner.right }]],

  // ---- arrows in a box, and through its wall
  ArrowSquareDown: [BOX, ["path", { d: inner.down }]],
  ArrowSquareUp: [BOX, ["path", { d: inner.up }]],
  ArrowSquareLeft: [BOX, ["path", { d: inner.left }]],
  ArrowSquareRight: [BOX, ["path", { d: inner.right }]],
  ArrowSquareLeftDown: [BOX, ["path", { d: inner.leftDown }]],
  ArrowSquareLeftUp: [BOX, ["path", { d: inner.leftUp }]],
  ArrowSquareRightDown: [BOX, ["path", { d: inner.rightDown }]],
  ArrowSquareRightUp: [BOX, ["path", { d: inner.rightUp }]],
  ArrowSquareFromDown: [["path", { d: gapBox.bottom }], ["path", { d: "M8 14.5V6M5 9l3-3 3 3" }]],
  ArrowSquareFromUp: [["path", { d: gapBox.top }], ["path", { d: "M8 1.5V10M5 7l3 3 3-3" }]],
  ArrowSquareFromLeft: [["path", { d: gapBox.left }], ["path", { d: "M1.5 8H10M7 5l3 3-3 3" }]],
  ArrowSquareFromRight: [["path", { d: gapBox.right }], ["path", { d: "M14.5 8H6M9 5 6 8l3 3" }]],
  ArrowSquareToDown: [["path", { d: gapBox.bottom }], ["path", { d: "M8 6v8.5M5 11.5l3 3 3-3" }]],
  ArrowSquareToUp: [["path", { d: gapBox.top }], ["path", { d: "M8 10V1.5M5 4.5l3-3 3 3" }]],
  ArrowSquareToLeft: [["path", { d: gapBox.left }], ["path", { d: "M10 8H1.5M4.5 5l-3 3 3 3" }]],
  ArrowSquareToRight: [["path", { d: gapBox.right }], ["path", { d: "M6 8h8.5M11.5 5l3 3-3 3" }]],

  // ---- chevrons (the four plain ones live in core)
  ChevronDownSmall: [["path", { d: chevronSmall.down }]],
  ChevronUpSmall: [["path", { d: chevronSmall.up }]],
  ChevronLeftSmall: [["path", { d: chevronSmall.left }]],
  ChevronRightSmall: [["path", { d: chevronSmall.right }]],
  ChevronCircleDown: [RING, ["path", { d: chevronSmall.down }]],
  ChevronCircleUp: [RING, ["path", { d: chevronSmall.up }]],
  ChevronCircleLeft: [RING, ["path", { d: chevronSmall.left }]],
  ChevronCircleRight: [RING, ["path", { d: chevronSmall.right }]],
  ChevronsDown: [["path", { d: "M4 4.5l4 4 4-4M4 8.5l4 4 4-4" }]],
  ChevronsUp: [["path", { d: "M4 11.5l4-4 4 4M4 7.5l4-4 4 4" }]],
  ChevronsLeft: [["path", { d: "M11.5 4l-4 4 4 4M7.5 4l-4 4 4 4" }]],
  ChevronsRight: [["path", { d: "M4.5 4l4 4-4 4M8.5 4l4 4-4 4" }]],
  ChevronsDownUp: [["path", { d: "M4.5 3.5 8 7l3.5-3.5M4.5 12.5 8 9l3.5 3.5" }]],
  ChevronsUpDown: [["path", { d: "M4.5 6 8 2.5 11.5 6M4.5 10 8 13.5 11.5 10" }]],
  ChevronsLeftRight: [["path", { d: "M6 4.5 2.5 8 6 11.5M10 4.5 13.5 8 10 11.5" }]],
  ChevronsRightDottedLeft: [["path", { d: "M8.5 4l4 4-4 4" }], dot(3, 8, 0.8), dot(5.75, 8, 0.8)],
  TriangleSmallDown: [["path", { d: "M5 6.5h6L8 10.5z", fill: "currentColor" }]],
  TriangleSmallUp: [["path", { d: "M5 9.5h6L8 5.5z", fill: "currentColor" }]],
  TriangleSmallLeft: [["path", { d: "M9.5 5v6L5.5 8z", fill: "currentColor" }]],
  TriangleSmallRight: [["path", { d: "M6.5 5v6l4-3z", fill: "currentColor" }]],
  SortAscending: [["path", { d: "M3 4.5h4M3 8h6M3 11.5h8M12.5 11.5v-7M10.5 6.5l2-2 2 2" }]],
  SortDescending: [["path", { d: "M3 4.5h8M3 8h6M3 11.5h4M12.5 4.5v7M10.5 9.5l2 2 2-2" }]],
  TagsChevronRight: [["path", { d: "M2.5 4.5a1 1 0 0 1 1-1h6l4 4.5-4 4.5h-6a1 1 0 0 1-1-1zM6 6l2 2-2 2" }]],
  TagsChevronLeft: [["path", { d: "M13.5 4.5a1 1 0 0 0-1-1h-6L2.5 8l4 4.5h6a1 1 0 0 0 1-1zM10 6 8 8l2 2" }]],
  TagsChevronDown: [["path", { d: "M4.5 2.5a1 1 0 0 0-1 1v6l4.5 4 4.5-4v-6a1 1 0 0 0-1-1zM6 6l2 2 2-2" }]],
  TagsChevronUp: [["path", { d: "M4.5 13.5a1 1 0 0 1-1-1v-6l4.5-4 4.5 4v6a1 1 0 0 1-1 1zM6 10l2-2 2 2" }]],
};
