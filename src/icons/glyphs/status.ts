/**
 * Status, alerts, shapes, time, security and the small marks that say how
 * something is: on, off, waiting, verified, costly.
 */
import { BOX, RING, dot, type Glyph } from "./shared";

const SHIELD = "M8 1.5 3 3.5v4c0 3.2 2.1 5.5 5 7 2.9-1.5 5-3.8 5-7v-4z";
const BELL = "M5 6.5a3 3 0 0 1 6 0v3l1.5 1.5h-9L5 9.5zM6.5 13a1.5 1.5 0 0 0 3 0";
const MOON = "M11.5 9.5A5 5 0 0 1 6 3.5a5 5 0 1 0 5.5 6z";
const CALENDAR_PART = "M8 14H3.5A1.5 1.5 0 0 1 2 12.5V5a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 14 5v2.5M5 2v3M11 2v3M2 7.5h12";
const SPARKLE = "M8 1.5c.5 3.8 2.2 5.5 6 6-3.8.5-5.5 2.2-6 6-.5-3.8-2.2-5.5-6-6 3.8-.5 5.5-2.2 6-6z";
const FRAME_CORNERS = "M2 6V3a1 1 0 0 1 1-1h3M10 2h3a1 1 0 0 1 1 1v3M14 10v3a1 1 0 0 1-1 1h-3M6 14H3a1 1 0 0 1-1-1v-3";
const BRAIN = "M8 2.5a3 3 0 0 0-5.5 1.6A3 3 0 0 0 2 8.5a3 3 0 0 0 2 2.9A3 3 0 0 0 8 13.5a3 3 0 0 0 4-2.1 3 3 0 0 0 2-2.9 3 3 0 0 0-.5-4.4A3 3 0 0 0 8 2.5z";
/** Bars that climb to the right; the ones past the level are dashed. */
const level = (lit: number): Glyph => {
  const bars = ["M3 13.5v-3", "M8 13.5v-6", "M13 13.5v-9"];
  return bars.map((d, index): Glyph[number] => (index < lit ? ["path", { d }] : ["path", { d, strokeDasharray: "1.2 1.2" }]));
};
const coin = (cy: number): Glyph[number] => ["ellipse", { cx: 8, cy, rx: 5, ry: 1.75 }];

export const GLYPHS: Record<string, Glyph> = {
  // ---- states
  Error: [RING, ["path", { d: "M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5" }]],
  Info: [RING, ["path", { d: "M8 7.5V11" }], dot(8, 5.3, 0.8)],
  Question: [["path", { d: "M5.5 5.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5V10" }], dot(8, 13, 0.9)],
  QuestionCircle: [RING, ["path", { d: "M6.3 6.3a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1" }], dot(8, 11, 0.7)],
  CheckSquare: [BOX, ["path", { d: "M5 8.3l2 2 4-4.3" }]],
  Checks: [["path", { d: "M1.5 8.5 4 11l5-5.5M6.5 11 8 12.5 14.5 5.5" }]],
  CircleCircle: [RING, ["circle", { cx: 8, cy: 8, r: 2.5 }]],
  Circles: [["circle", { cx: 5.5, cy: 8, r: 3.75 }], ["circle", { cx: 10.5, cy: 8, r: 3.75 }]],
  CirclesCheck: [["circle", { cx: 6, cy: 9, r: 4 }], ["path", { d: "M8.5 3.5a4 4 0 0 1 4 4M4.5 9l1.2 1.2 2.3-2.5" }]],
  MinusCircle: [RING, ["path", { d: "M5 8h6" }]],
  MinusSmall: [["path", { d: "M5.5 8h5" }]],
  PlusCircle: [RING, ["path", { d: "M8 5v6M5 8h6" }]],
  OneCircle: [RING, ["path", { d: "M7 5.5 8.5 4.5v7M7 11.5h3" }]],
  SquareDashed: [["rect", { x: 2, y: 2, width: 12, height: 12, rx: 1.5, strokeDasharray: "2.2 1.8" }]],
  SquareDot: [BOX, dot(8, 8, 1.6)],
  Hexagon: [["path", { d: "M8 1.75l5.4 3.125v6.25L8 14.25l-5.4-3.125v-6.25z" }]],
  Pentagon: [["path", { d: "M8 1.75l6 4.36-2.3 7.06H4.3L2 6.11z" }]],
  ShapesSquareCircle: [["rect", { x: 2, y: 2, width: 6.5, height: 6.5, rx: 1 }], ["circle", { cx: 10.5, cy: 10.5, r: 3.5 }]],
  Sparkle: [["path", { d: SPARKLE }]],
  Stack: [["path", { d: "M8 2 1.5 5.5 8 9l6.5-3.5zM1.5 8.5 8 12l6.5-3.5" }]],
  Infinity: [["path", { d: "M4.5 5.5a2.5 2.5 0 0 0 0 5c1.5 0 2.5-1 3.5-2.5s2-2.5 3.5-2.5a2.5 2.5 0 0 1 0 5c-1.5 0-2.5-1-3.5-2.5S6 5.5 4.5 5.5z" }]],
  StarFull: [["path", { d: "M8 2l1.8 3.8 4.2.6-3 2.9.7 4.2L8 11.5l-3.7 2 .7-4.2-3-2.9 4.2-.6z", fill: "currentColor" }]],
  Seal: [["path", { d: "M8 2.6Q10.79 1.26 11.82 4.18Q14.74 5.21 13.4 8Q14.74 10.79 11.82 11.82Q10.79 14.74 8 13.4Q5.21 14.74 4.18 11.82Q1.26 10.79 2.6 8Q1.26 5.21 4.18 4.18Q5.21 1.26 8 2.6Z" }]],
  CornersIn: [["path", { d: "M6.5 2v4.5H2M9.5 2v4.5H14M6.5 14V9.5H2M9.5 14V9.5H14" }]],
  CornersOut: [["path", { d: FRAME_CORNERS }]],
  CornersOutCheck: [["path", { d: FRAME_CORNERS }], ["path", { d: "M5.5 8l1.8 1.8L10.5 6" }]],
  CornersOutSparkle: [["path", { d: FRAME_CORNERS }], ["path", { d: "M8 4.5c.3 2.3 1.2 3.2 3.5 3.5-2.3.3-3.2 1.2-3.5 3.5-.3-2.3-1.2-3.2-3.5-3.5 2.3-.3 3.2-1.2 3.5-3.5z" }]],
  ColorMode: [RING, ["path", { d: "M8 2.25a5.75 5.75 0 0 1 0 11.5z", fill: "currentColor" }]],

  // ---- security
  Shield: [["path", { d: SHIELD }]],
  ShieldCheck: [["path", { d: SHIELD }], ["path", { d: "M5.75 8l1.5 1.5 3-3.2" }]],
  ShieldQuestion: [["path", { d: SHIELD }], ["path", { d: "M6.6 6.3a1.5 1.5 0 1 1 2.1 1.4c-.4.2-.7.5-.7.9" }], dot(8, 10.5, 0.7)],
  ShieldX: [["path", { d: SHIELD }], ["path", { d: "M6.25 6.25l3.5 3.5M9.75 6.25l-3.5 3.5" }]],
  Unlock: [["rect", { x: 3, y: 7, width: 10, height: 7, rx: 1.5 }], ["path", { d: "M5.5 7V5a2.5 2.5 0 0 1 4.8-.9" }]],
  Key: [["circle", { cx: 5, cy: 11, r: 2.75 }], ["path", { d: "M7 9 13.5 2.5M11 5l2 2M9 7l1.5 1.5" }]],
  Vault: [BOX, ["circle", { cx: 8, cy: 8, r: 3 }], ["path", { d: "M8 5v1.2M8 9.8V11M5 8h1.2M9.8 8H11" }]],
  Eye: [["path", { d: "M1.5 8c1.3-2.6 3.7-4 6.5-4s5.2 1.4 6.5 4c-1.3 2.6-3.7 4-6.5 4S2.8 10.6 1.5 8z" }], ["circle", { cx: 8, cy: 8, r: 2 }]],
  EyeClosed: [["path", { d: "M2 7c1.5 2 3.7 3 6 3s4.5-1 6-3M4.5 9 3.5 11M8 10v2M11.5 9l1 2" }]],

  // ---- attention
  Bell: [["path", { d: BELL }]],
  BellDot: [["path", { d: BELL }], dot(12.5, 3.5, 1.4)],
  BellSlash: [["path", { d: BELL }], ["path", { d: "M2.5 2.5l11 11" }]],
  Flag: [["path", { d: "M3.5 14V2.5h8l-2 3 2 3h-8" }]],
  FlagHill: [["path", { d: "M6 10.5V2.5h6l-1.5 2.5L12 7.5H6M1.5 14.5c2-2 4-3 6.5-3s4.5 1 6.5 3" }]],
  Target: [RING, ["circle", { cx: 8, cy: 8, r: 3 }], dot(8, 8, 1)],
  Crosshair: [RING, ["path", { d: "M8 1.5V4M8 12v2.5M1.5 8H4M12 8h2.5" }]],
  Tag: [["path", { d: "M2.5 3.5a1 1 0 0 1 1-1h4.3a1 1 0 0 1 .7.3l5.2 5.2a1 1 0 0 1 0 1.4L10.4 12.7a1 1 0 0 1-1.4 0L3.8 7.5a1 1 0 0 1-.3-.7z" }], dot(5.5, 5.5, 0.9)],

  // ---- time
  AlarmClock: [["circle", { cx: 8, cy: 9, r: 4.5 }], ["path", { d: "M8 6.5V9l1.8 1M2.5 4.5 4.5 3M13.5 4.5 11.5 3M4.5 13l-1 1.5M11.5 13l1 1.5" }]],
  Stopwatch: [["circle", { cx: 8, cy: 9.5, r: 4.5 }], ["path", { d: "M8 7v2.5l1.5 1M6.5 2h3M8 2v3M12.5 4.5l1-1" }]],
  Hourglass: [["path", { d: "M4.5 2.5h7M4.5 13.5h7M5 2.5v2.5a3 3 0 0 0 3 3 3 3 0 0 0 3-3V2.5M5 13.5V11a3 3 0 0 1 3-3 3 3 0 0 1 3 3v2.5" }]],
  Calendar: [["rect", { x: 2, y: 3.5, width: 12, height: 10.5, rx: 1.5 }], ["path", { d: "M5 2v3M11 2v3M2 7.5h12" }]],
  CalendarHourglass: [["path", { d: CALENDAR_PART }], ["path", { d: "M10 9.5h4M10 14.5h4M10.5 9.5v1a1.5 1.5 0 0 0 3 0v-1M10.5 14.5v-1a1.5 1.5 0 0 1 3 0v1" }]],
  Zzz: [["path", { d: "M3 3.5h4L3 8h4M9 7.5h3L9 11h3M11 11.5h2.5l-2.5 2.5h2.5" }]],
  MoonZ: [["path", { d: MOON }], ["path", { d: "M10.5 2.5h3l-3 3h3" }]],
  MoonSparkle: [["path", { d: MOON }], ["path", { d: "M12 1.5c.2 1.4.8 2 2.2 2.2-1.4.2-2 .8-2.2 2.2-.2-1.4-.8-2-2.2-2.2 1.4-.2 2-.8 2.2-2.2z" }]],

  // ---- levels
  ThinkingLow: level(1),
  ThinkingMedium: level(2),
  ThinkingHigh: level(3),
  CostLow: [coin(12)],
  CostMedium: [coin(12), ["path", { d: "M3 9a5 1.75 0 0 0 10 0M3 9v3M13 9v3" }]],
  CostHigh: [coin(12), ["path", { d: "M3 9a5 1.75 0 0 0 10 0M3 9v3M13 9v3M3 6a5 1.75 0 0 0 10 0M3 6v3M13 6v3" }]],

  // ---- thought
  BrainSimple: [["path", { d: BRAIN }], ["path", { d: "M8 2.5v11" }]],
  BrainSimplest: [["path", { d: BRAIN }]],
  BrainSlash: [["path", { d: BRAIN }], ["path", { d: "M2.5 2.5l11 11" }]],
  BrainHourglass: [["path", { d: "M8 2.5a3 3 0 0 0-5.5 1.6A3 3 0 0 0 2 8.5a3 3 0 0 0 2 2.9A3 3 0 0 0 8 13.5V2.5M10 7.5h4M10 14.5h4M10.5 7.5V9a1.5 1.5 0 0 0 3 0V7.5M10.5 14.5V13a1.5 1.5 0 0 1 3 0v1.5" }]],
  Lightbulb: [["path", { d: "M5.5 10.5a4.5 4.5 0 1 1 5 0v1.5h-5zM6.5 14h3" }]],

  // ---- nature and elements
  Flame: [["path", { d: "M8 14.5c-3 0-5-2-5-4.5 0-2.5 2.5-4 2.5-6.5C7 5 8 6.5 8 6.5s.5-2 1.5-3c1.5 2 3.5 4 3.5 6.5s-2 4.5-5 4.5zM8 14.5c-1.4 0-2.5-1-2.5-2.3S8 9.5 8 9.5s2.5 1.5 2.5 2.7S9.4 14.5 8 14.5z" }]],
  Drop: [["path", { d: "M8 1.5s4.5 5 4.5 8a4.5 4.5 0 0 1-9 0c0-3 4.5-8 4.5-8z" }]],
  Snowflake: [["path", { d: "M8 1.5v13M2.4 4.75l11.2 6.5M2.4 11.25l11.2-6.5M6 3.5 8 1.5l2 2M6 12.5l2 2 2-2M2.4 7.5l.4-2.75 2.6.5M13.6 8.5l-.4 2.75-2.6-.5M2.4 8.5l.4 2.75 2.6-.5M13.6 7.5l-.4-2.75-2.6.5" }]],
  Leaf: [["path", { d: "M2.5 13.5C2.5 6 6 2.5 13.5 2.5c0 7.5-3.5 11-11 11zM2.5 13.5 9 7" }]],
  Twig: [["path", { d: "M3 13 13 3M8 8l3 .5M8 8l-.5 3M10.5 5.5l2 .3M5.5 10.5l-.3 2" }]],
  Atom: [["circle", { cx: 8, cy: 8, r: 1.3 }], ["ellipse", { cx: 8, cy: 8, rx: 6, ry: 2.5 }], ["ellipse", { cx: 8, cy: 8, rx: 6, ry: 2.5, transform: "rotate(60 8 8)" }], ["ellipse", { cx: 8, cy: 8, rx: 6, ry: 2.5, transform: "rotate(120 8 8)" }]],
};
