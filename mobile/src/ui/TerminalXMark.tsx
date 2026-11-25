import Svg, { Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";

/**
 * The TerminalX mark's own drawing: prompt arrow, underscore and cross, on
 * the grid of `resources/icon-source/logo.svg` (the one layer of the Icon
 * Composer project the app icon is compiled from). Square caps, mitred joins.
 * `TerminalXMark.test.ts` holds these to that file.
 */
export const MARK_STROKES = [
  { d: "M25 30 L45 50 L25 70", width: 8, opacity: 1 },
  { d: "M55 70 L80 70", width: 8, opacity: 1 },
  { d: "M60 30 L80 50 M80 30 L60 50", width: 6, opacity: 0.8 },
] as const;

/** The source drawing's `viewBox`: x, y, width, height. */
export const MARK_BOX = [18, 23, 68, 54] as const;

// How `mobile/assets/icon.png` places that drawing: its box is centred on the
// 1024 px tile at 10.3 px a unit (the paths laid over the icon cover the same
// pixels, 99.5 %), so the tile is 1024 / 10.3 units across.
const TILE = 1024 / 10.3;
const LEFT = MARK_BOX[0] + MARK_BOX[2] / 2 - TILE / 2;
const TOP = MARK_BOX[1] + MARK_BOX[3] / 2 - TILE / 2;
// The icon's colours, read from the same file: the tile runs from #1d1d1d at
// its top to black 78 % of the way down, the mark from white at its top edge
// to #cbcbcb at its foot.
const TILE_FADE_END = TOP + TILE * 0.78;
const MARK_TOP = 30 - 4 * Math.SQRT2;
const MARK_FOOT = 70 + 4 * Math.SQRT2;
/** iOS rounds an app icon's corners by this share of its width. */
const CORNER = 0.2237;

/**
 * The TerminalX logo as the app icon draws it: the light mark on its black
 * tile, in every theme. It is a drawing of a fixed size, so it is sharp at
 * every screen density and does not grow with the text size (PRO-563). The
 * tile has a hairline of light around it, which is what shows its edge on a
 * dark page.
 */
export function TerminalXMark({ size = 72, testID }: { size?: number; testID?: string }) {
  const unit = TILE / size;
  return <Svg testID={testID} width={size} height={size} viewBox={`${LEFT} ${TOP} ${TILE} ${TILE}`} fill="none" accessible accessibilityRole="image" accessibilityLabel="TerminalX">
    <Defs>
      <LinearGradient id="terminalx-mark-tile" gradientUnits="userSpaceOnUse" x1={0} y1={TOP} x2={0} y2={TILE_FADE_END}>
        <Stop offset={0} stopColor="#1d1d1d" />
        <Stop offset={1} stopColor="#000000" />
      </LinearGradient>
      {/* In the drawing's own units: the underscore is a level line, whose own box has no height to fade over. */}
      <LinearGradient id="terminalx-mark-ink" gradientUnits="userSpaceOnUse" x1={0} y1={MARK_TOP} x2={0} y2={MARK_FOOT}>
        <Stop offset={0} stopColor="#ffffff" />
        <Stop offset={1} stopColor="#cbcbcb" />
      </LinearGradient>
    </Defs>
    <Rect x={LEFT} y={TOP} width={TILE} height={TILE} rx={TILE * CORNER} fill="url(#terminalx-mark-tile)" />
    <Rect x={LEFT + unit / 2} y={TOP + unit / 2} width={TILE - unit} height={TILE - unit} rx={TILE * CORNER - unit / 2} stroke="#ffffff" strokeOpacity={0.14} strokeWidth={unit} />
    {MARK_STROKES.map((stroke) => <Path key={stroke.d} d={stroke.d} stroke="url(#terminalx-mark-ink)" strokeWidth={stroke.width} strokeOpacity={stroke.opacity} strokeLinecap="square" strokeLinejoin="miter" />)}
  </Svg>;
}
