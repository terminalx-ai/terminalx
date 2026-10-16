/**
 * Source control, diffs, code and text: what an editor's chrome is mostly made of.
 */
import { BOX, RING, dot, type Glyph } from "./shared";

/** The page a diff or report is drawn on. */
const PAGE: Glyph[number] = ["rect", { x: 3, y: 2, width: 10, height: 12, rx: 1.5 }];
/** A seal with eight scallops, for the verified family. */
const SEAL = "M8 2.6Q10.79 1.26 11.82 4.18Q14.74 5.21 13.4 8Q14.74 10.79 11.82 11.82Q10.79 14.74 8 13.4Q5.21 14.74 4.18 11.82Q1.26 10.79 2.6 8Q1.26 5.21 4.18 4.18Q5.21 1.26 8 2.6Z";
/** A pull request's three nodes: the branch's two on the left, the target's one on the right. */
const PR_NODES: Glyph = [["circle", { cx: 4.5, cy: 3.5, r: 1.5 }], ["circle", { cx: 4.5, cy: 12.5, r: 1.5 }], ["circle", { cx: 11.5, cy: 12.5, r: 1.5 }], ["path", { d: "M4.5 5v6" }]];
/** A bug: head, body, legs and feelers. */
const BUG: Glyph = [
  ["path", { d: "M5.5 6.5a2.5 2.5 0 0 1 5 0" }],
  ["rect", { x: 4.5, y: 6.5, width: 7, height: 7, rx: 3.5 }],
  ["path", { d: "M8 6.5V13.5M2 8h2.5M11.5 8H14M2.5 12.5 4.5 11M11.5 11l2 1.5M6.5 4 5.5 2.5M9.5 4l1-1.5" }],
];

export const GLYPHS: Record<string, Glyph> = {
  // ---- git
  GitCommit: [["circle", { cx: 8, cy: 8, r: 2.5 }], ["path", { d: "M8 1.5v4M8 10.5v4" }]],
  GitCommitHorizontal: [["circle", { cx: 8, cy: 8, r: 2.5 }], ["path", { d: "M1.5 8h4M10.5 8h4" }]],
  GitCompare: [["circle", { cx: 4, cy: 4, r: 1.5 }], ["circle", { cx: 12, cy: 12, r: 1.5 }], ["path", { d: "M4 5.5v3.5a2 2 0 0 0 2 2h3.5M8 9.5l1.5 1.5L8 12.5M12 10.5V7a2 2 0 0 0-2-2H6.5M8 3.5 6.5 5 8 6.5" }]],
  GitFetch: [["circle", { cx: 8, cy: 12.5, r: 1.5 }], ["path", { d: "M8 2.5V11", strokeDasharray: "2 1.6" }], ["path", { d: "M5 8l3 3 3-3" }]],
  GitPull: [["circle", { cx: 8, cy: 12.5, r: 1.5 }], ["path", { d: "M8 2.5V11M5 8l3 3 3-3" }]],
  GitPush: [["circle", { cx: 8, cy: 12.5, r: 1.5 }], ["path", { d: "M8 11V2.5M5 5.5l3-3 3 3" }]],
  GitPullRequestClosed: [...PR_NODES, ["path", { d: "M11.5 11V8.5M9.5 3l4 4M13.5 3l-4 4" }]],
  GitPullRequestCreate: [...PR_NODES, ["path", { d: "M11.5 11V7.5M11.5 2v3.5M9.75 3.75h3.5" }]],
  GitPullRequestDone: [...PR_NODES, ["path", { d: "M11.5 11V7.5M9.5 4l1.5 1.5L13.5 3" }]],
  Merge: [["path", { d: "M4 2.5v4a3 3 0 0 0 3 3h6M10.5 7 13 9.5 10.5 12M12 2.5v3" }]],
  Fork: [["path", { d: "M8 2.5v4M4 13.5V9.5a3 3 0 0 1 3-3h2a3 3 0 0 1 3 3v4" }]],
  Split: [["path", { d: "M8 13.5V8.5M8 8.5 4 4.5M8 8.5l4-4M3.5 7.5v-3h3M12.5 7.5v-3h-3" }]],
  SplitHorizontal: [["rect", { x: 2, y: 3, width: 12, height: 10, rx: 1.5 }], ["path", { d: "M2 8h12" }]],
  SplitVertical: [["rect", { x: 2, y: 3, width: 12, height: 10, rx: 1.5 }], ["path", { d: "M8 3v10" }]],
  Versions: [["rect", { x: 6, y: 2, width: 8, height: 7, rx: 1 }], ["path", { d: "M4 4.5v6a1 1 0 0 0 1 1h7M2 7v6a1 1 0 0 0 1 1h7" }]],
  Issue: [RING, dot(8, 8, 1.6)],
  IssueDraft: [["circle", { cx: 8, cy: 8, r: 5.75, strokeDasharray: "2.2 1.8" }], dot(8, 8, 1.6)],
  Issues: [["circle", { cx: 6.5, cy: 9.5, r: 4.5 }], ["path", { d: "M6 3.5a4.5 4.5 0 0 1 6.5 6" }], dot(6.5, 9.5, 1.3)],
  StatusDraft: [["circle", { cx: 8, cy: 8, r: 5.75, strokeDasharray: "2.2 1.8" }]],
  Pass: [RING, ["path", { d: "M5.3 8.3l1.9 1.9 3.6-3.9" }]],
  Verified: [["path", { d: SEAL }], ["path", { d: "M5.5 8.2l1.8 1.8 3.4-3.6" }]],
  Unverified: [["path", { d: SEAL }], ["path", { d: "M6.4 6.6a1.6 1.6 0 1 1 2.3 1.5c-.5.2-.7.5-.7.9" }], dot(8, 10.9, 0.7)],
  Review: [["path", { d: "M2.5 4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v6a1.5 1.5 0 0 1-1.5 1.5H6l-3.5 2.5zM5.5 7l1.8 1.8L10.5 5.3" }]],
  Report: [PAGE, ["path", { d: "M8 5.5v3" }], dot(8, 10.8, 0.8)],
  Return: [["path", { d: "M13 3.5v4a2 2 0 0 1-2 2H3M5.5 7 3 9.5 5.5 12" }]],

  // ---- diffs
  Diff: [["path", { d: "M5 2.5v6M2 5.5h6M8 12.5h6" }]],
  DiffAdded: [BOX, ["path", { d: "M8 5v6M5 8h6" }]],
  DiffRemoved: [BOX, ["path", { d: "M5 8h6" }]],
  DiffModified: [BOX, dot(8, 8, 1.6)],
  DiffIgnored: [BOX, ["path", { d: "M5.5 10.5l5-5" }]],
  DiffRenamed: [BOX, ["path", { d: "M5 8h6M8.5 5.5 11 8l-2.5 2.5" }]],
  DiffMultiple: [["path", { d: "M5.5 2.5H12a1.5 1.5 0 0 1 1.5 1.5v6.5" }], ["rect", { x: 2, y: 5, width: 9, height: 9, rx: 1.5 }], ["path", { d: "M6.5 7.5v4M4.5 9.5h4" }]],
  DiffSingle: [PAGE, ["path", { d: "M6 6h4M6 9h4" }]],
  DiffSingleArrowRightUp: [PAGE, ["path", { d: "M6 10l4-4M6.5 6H10v3.5" }]],
  DiffSingleDot: [PAGE, dot(8, 8, 1.4)],

  // ---- code
  Binary: [["rect", { x: 2.5, y: 2.5, width: 3, height: 4.5, rx: 1.5 }], ["path", { d: "M9.5 2.5h1.5v4.5M9.5 7h3" }], ["rect", { x: 10, y: 9, width: 3, height: 4.5, rx: 1.5 }], ["path", { d: "M2.5 9H4v4.5M2.5 13.5h3" }]],
  BracketDot: [["path", { d: "M5.5 2.5H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h1.5M10.5 2.5H12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-1.5" }], dot(8, 8, 1)],
  BracketError: [["path", { d: "M5.5 2.5H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h1.5M10.5 2.5H12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-1.5M6.5 6.5l3 3M9.5 6.5l-3 3" }]],
  BracketsCurly: [["path", { d: "M6 2.5h-.5A1.5 1.5 0 0 0 4 4v2.5A1.5 1.5 0 0 1 2.5 8 1.5 1.5 0 0 1 4 9.5V12a1.5 1.5 0 0 0 1.5 1.5H6M10 2.5h.5A1.5 1.5 0 0 1 12 4v2.5A1.5 1.5 0 0 0 13.5 8 1.5 1.5 0 0 0 12 9.5V12a1.5 1.5 0 0 1-1.5 1.5H10" }]],
  Code: [["path", { d: "M5 5 2 8l3 3M11 5l3 3-3 3M9.5 3l-3 10" }]],
  CodeBrackets: [["path", { d: "M5 5 2 8l3 3M11 5l3 3-3 3" }]],
  CodeSimple: [["path", { d: "M6 5.5 3.5 8 6 10.5M10 5.5 12.5 8 10 10.5" }]],
  TerminalRectangle: [["rect", { x: 2, y: 3, width: 12, height: 10, rx: 1.5 }], ["path", { d: "M5 6.5l2 1.5-2 1.5M8.5 9.5h2.5" }]],
  DebugStop: [RING, ["rect", { x: 5.75, y: 5.75, width: 4.5, height: 4.5, rx: 0.8, fill: "currentColor", stroke: "none" }]],
  Bug: BUG,
  PlayBug: [...BUG.slice(0, 2), ["path", { d: "M2 8h2.5M11.5 8H14M2.5 12.5 4.5 11M11.5 11l2 1.5M6.5 4 5.5 2.5M9.5 4l1-1.5" }], ["path", { d: "M7 8.3v3.4l2.8-1.7z", fill: "currentColor" }]],
  PlaysBug: [...BUG.slice(0, 2), ["path", { d: "M2 8h2.5M11.5 8H14M2.5 12.5 4.5 11M11.5 11l2 1.5M6.5 4 5.5 2.5M9.5 4l1-1.5" }], ["path", { d: "M6 8.5v3l2-1.5zM8.8 8.5v3l2-1.5z", fill: "currentColor" }]],
  ExecutionParallel: [["path", { d: "M2.5 4.5h8M8.5 2.5l2 2-2 2M2.5 8h8M8.5 6l2 2-2 2M2.5 11.5h8M8.5 9.5l2 2-2 2" }]],
  ExecutionSequential: [["path", { d: "M2.5 4.5h5a2 2 0 0 1 0 4h-3a2 2 0 0 0 0 4h8M10.5 10.5l2 2-2 2" }]],
  ThreadsParallel: [["path", { d: "M4 2.5v11M8 2.5v11M12 2.5v11" }]],
  ThreadsSingle: [["path", { d: "M8 2.5v11" }]],
  Pipe: [["path", { d: "M8 2v12" }]],
  Hash: [["path", { d: "M6.5 2.5l-1.5 11M11 2.5 9.5 13.5M3 6h10.5M2.5 10H13" }]],
  Asterisk: [["path", { d: "M8 2.5v11M3.2 5.25l9.6 5.5M3.2 10.75l9.6-5.5" }]],
  Percent: [["path", { d: "M13 3 3 13" }], ["circle", { cx: 4.5, cy: 4.5, r: 2 }], ["circle", { cx: 11.5, cy: 11.5, r: 2 }]],
  PlusMinus: [["path", { d: "M8 2v6M5 5h6M5 12h6" }]],
  SlashCircle: [RING, ["path", { d: "M10.5 5.5l-5 5" }]],
  Markdown: [["rect", { x: 1.5, y: 4, width: 13, height: 8, rx: 1.5 }], ["path", { d: "M4 10V6l2 2 2-2v4M11 6v4M9.5 8.5l1.5 1.5 1.5-1.5" }]],
  Inspect: [["path", { d: "M6 12.5H3.5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1V6" }], ["circle", { cx: 10.5, cy: 10.5, r: 2.75 }], ["path", { d: "M12.5 12.5 14.5 14.5" }]],
  Plan: [PAGE, ["path", { d: "M5.5 6h5M5.5 8.5h5M5.5 11h3" }]],
  Run: [dot(10.5, 3, 1.1), ["path", { d: "M9.5 5.5 7 7l1.5 2.5-3 4M9.5 5.5l1.5 2.5h2.5M9.5 5.5 6.5 5l-2 2M8.5 9.5l2.5 1.5v2.5" }]],
  Sprint: [["circle", { cx: 9.5, cy: 9, r: 4 }], ["path", { d: "M9.5 7v2.5l1.5 1M8 3h3M9.5 3v2M3 6.5h2.5M2 9.5h2M3 12.5h2.5" }]],

  // ---- text and type
  Paragraph: [["path", { d: "M2.5 4h11M2.5 7h11M2.5 10h11M2.5 13h6" }]],
  Pilcrow: [["path", { d: "M13 2.5H7a3 3 0 0 0 0 6h2.5M9.5 2.5v11M12.5 2.5v11" }]],
  Quote: [["path", { d: "M2.5 9.5v-2A4.5 4.5 0 0 1 7 3M2.5 9.5h4v3h-4zM9.5 9.5v-2A4.5 4.5 0 0 1 14 3M9.5 9.5h4v3h-4z" }]],
  TextAa: [["path", { d: "M1.5 12l3-8 3 8M2.6 9.5h3.8M13.5 12V7" }], ["circle", { cx: 11.5, cy: 10, r: 2 }]],
  TextAb: [["path", { d: "M1.5 12l3-8 3 8M2.6 9.5h3.8M9.5 3.5V12" }], ["circle", { cx: 11.5, cy: 10, r: 2 }]],
  TextB: [["path", { d: "M5 3h4.5a2.25 2.25 0 0 1 0 4.5H5zM5 7.5h5a2.25 2.25 0 0 1 0 4.5H5V3" }]],
  TextC: [["path", { d: "M12 5.5A4.5 4.5 0 1 0 12 10.5" }]],
  TextD: [["path", { d: "M5 3h3.5a5 5 0 0 1 0 10H5z" }]],
  TextItalic: [["path", { d: "M7 3h4M5 13h4M9.5 3l-3 10" }]],
  TextJ: [["path", { d: "M10 3v7a3 3 0 0 1-6 0" }]],
  TextR: [["path", { d: "M5 13V3h4a2.5 2.5 0 0 1 0 5H5M8.5 8l3 5" }]],
  TextS: [["path", { d: "M11 5a3 3 0 0 0-3-2.5c-1.7 0-3 1-3 2.3s1 2 3 2.4 3 1 3 2.4-1.3 2.4-3 2.4A3 3 0 0 1 5 11" }]],
  TextStrikethrough: [["path", { d: "M11 5a3 3 0 0 0-3-2.5c-1.7 0-3 1-3 2.3M5 11a3 3 0 0 0 3 2.5c1.7 0 3-1 3-2.3M2.5 8h11" }]],
  TextT: [["path", { d: "M3.5 3h9M8 3v10" }]],
  TextTSquare: [BOX, ["path", { d: "M5 5.5h6M8 5.5v6" }]],
  TextTt: [["path", { d: "M2 4h6M5 4v9M8.5 6.5h5M11 6.5V13" }]],
  TextY: [["path", { d: "M3.5 3 8 9v4M12.5 3 8 9" }]],
};
