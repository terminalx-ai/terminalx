import Svg, { Circle, Line, Path, Rect } from "react-native-svg";

type Shape = ["path", { d: string }] | ["circle", { cx: number; cy: number; r: number }] | ["rect", { x: number; y: number; width: number; height: number; rx: number }];

/**
 * The Mac app's own glyphs, on its 16-point grid, drawn the way it draws them
 * (`src/icons/drawn.tsx`): outlined, round caps and joins. Copied from
 * `src/icons/glyphs`, so the phone shows the same marks for the same things.
 */
const GLYPHS = {
  Folder: [["path", { d: "M2 11.5v-7A1.5 1.5 0 0 1 3.5 3h2.6l1.5 1.75h4.9A1.5 1.5 0 0 1 14 6.25v5.25a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" }]],
  GitBranch: [["circle", { cx: 4.5, cy: 3.5, r: 1.5 }], ["circle", { cx: 4.5, cy: 12.5, r: 1.5 }], ["circle", { cx: 11.5, cy: 12.5, r: 1.5 }], ["path", { d: "M4.5 5v6M4.5 7h4a3 3 0 0 1 3 3v1" }]],
  FolderTree: [
    ["path", { d: "M2.5 2v9.5A1.5 1.5 0 0 0 4 13h3M2.5 6.5H7" }],
    ["path", { d: "M8.5 2.5h2l.8.8h2.2a.6.6 0 0 1 .6.6V6a.6.6 0 0 1-.6.6H9.1a.6.6 0 0 1-.6-.6zM8.5 9h2l.8.8h2.2a.6.6 0 0 1 .6.6v2.1a.6.6 0 0 1-.6.6H9.1a.6.6 0 0 1-.6-.6z" }],
  ],
  LayoutList: [["rect", { x: 2.5, y: 2.5, width: 4, height: 4, rx: 1 }], ["rect", { x: 2.5, y: 9.5, width: 4, height: 4, rx: 1 }], ["path", { d: "M9.5 4.5h4M9.5 11.5h4" }]],
} satisfies Record<string, Shape[]>;

export type MacGlyph = keyof typeof GLYPHS;

export function MacIcon({ name, size = 16, color, strokeWidth = 1.25 }: { name: MacGlyph; size?: number; color: string; strokeWidth?: number }) {
  return <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {(GLYPHS[name] as Shape[]).map(([tag, attrs], index) => tag === "path" ? <Path key={index} {...attrs} /> : tag === "circle" ? <Circle key={index} {...attrs} /> : <Rect key={index} {...attrs} />)}
  </Svg>;
}

/**
 * How a chat is doing, as the Mac shows it at the end of a row
 * (`src/components/ui/StatusMark.tsx`): three bars for working, an amber dot
 * for waiting on the reader, nothing once it is done.
 */
export function StateMark({ state, info, warning }: { state: "needs" | "working" | "done"; info: string; warning: string }) {
  if (state === "working") return <Svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke={info} strokeWidth={1.75} strokeLinecap="round" accessibilityLabel="Working">
    {[[4.5, 8.5], [8, 5.5], [11.5, 10]].map(([x, top]) => <Line key={x} x1={x} x2={x} y1={top} y2={12} />)}
  </Svg>;
  if (state === "needs") return <Svg width={8} height={8} viewBox="0 0 8 8" accessibilityLabel="Needs you"><Circle cx={4} cy={4} r={3.5} fill={warning} /></Svg>;
  return null;
}
