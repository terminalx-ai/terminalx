/**
 * The raccoon, as rows of palette letters. Everything is drawn from these
 * strings at draw time, so there is no image to ship and the palette can
 * follow the theme. Frames are the base body with a few rows swapped.
 *
 *   .  transparent   G  fur   D  shade   K  mask/stripe   W  white   N  nose   Y  star
 */
export const PALETTE = {
  dark: { G: "#a3a8b1", D: "#5d626b", K: "#1f2126", W: "#f4f4f2", N: "#141414", Y: "#f0c674" },
  light: { G: "#8d929b", D: "#4f545c", K: "#23252b", W: "#ffffff", N: "#141414", Y: "#d9a400" },
};

export const SPRITE_W = 24;
export const SPRITE_H = 14;

const BASE = [
  "...KK..........KK.......",
  "..KDDK........KDDK......",
  "..KDGGGGGGGGGGGGDK......",
  "...GGGGGGGGGGGGGG.......",
  "..GGKKKKGGGGKKKKGG......",
  "..GKKWWKKGGKKWWKKG......",
  "..GKKWKKKGGKKKWKKG......",
  "...GKKKKGGGGKKKKG...KKK.",
  "...GGGGGGNNGGGGGG..KDDDK",
  "....GGGGGWWGGGGG...KKKKK",
  "...GGGGGGGGGGGGGGG.GDDDK",
  "..GGGGGGGGGGGGGGGGGGKKK.",
  "..DGGGGGGGGGGGGGGGDDGG..",
  "..DD..DD......DD..DD....",
];

function withRows(rows: Record<number, string>): string[] {
  return BASE.map((r, i) => rows[i] ?? r);
}

export const FRAMES = {
  sit: BASE,
  walk1: withRows({ 13: "..DD..DD......DD..DD...." }),
  walk2: withRows({ 13: "...DD..DD....DD..DD....." }),
  // Paws come up to the muzzle, alternating sides.
  wash1: withRows({ 7: "...GKKKKGDDGKKKKG...KKK.", 8: "...GGGGGDNNDGGGGG..KDDDK" }),
  wash2: withRows({ 7: "...GKKKKGGDDKKKKG...KKK.", 8: "...GGGGGGNNDDGGGG..KDDDK" }),
  // Eyes go to crosses.
  stunned: withRows({ 5: "..GKKKWKKGGKKWKKKG......", 6: "..GKKWKWKGGKWKWKKG......" }),
  // Looking sideways: pupils shift.
  glance: withRows({ 6: "..GKKKWKKGGKKKWKKG......", 5: "..GKKWWKKGGKKWWKKG......" }),
} as const;

export type FrameName = keyof typeof FRAMES;

export function drawSprite(
  ctx: CanvasRenderingContext2D,
  frame: FrameName,
  x: number,
  y: number,
  scale: number,
  palette: Record<string, string>,
  flip = false,
) {
  const rows = FRAMES[frame];
  ctx.save();
  if (flip) {
    ctx.translate(x + SPRITE_W * scale, y);
    ctx.scale(-1, 1);
  } else {
    ctx.translate(x, y);
  }
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (ch === ".") continue;
      ctx.fillStyle = palette[ch] ?? "#f0f";
      ctx.fillRect(c * scale, r * scale, scale, scale);
    }
  }
  ctx.restore();
}

/** Three little stars orbiting above a stunned head. */
export function drawStars(ctx: CanvasRenderingContext2D, cx: number, cy: number, t: number, scale: number, colour: string) {
  ctx.fillStyle = colour;
  for (let i = 0; i < 3; i++) {
    const a = t * 4 + (i * Math.PI * 2) / 3;
    const px = cx + Math.cos(a) * 9 * scale;
    const py = cy + Math.sin(a) * 2.5 * scale;
    ctx.fillRect(Math.round(px), Math.round(py), scale, scale);
    ctx.fillRect(Math.round(px) - scale, Math.round(py), scale, scale);
    ctx.fillRect(Math.round(px) + scale, Math.round(py), scale, scale);
    ctx.fillRect(Math.round(px), Math.round(py) - scale, scale, scale);
    ctx.fillRect(Math.round(px), Math.round(py) + scale, scale, scale);
  }
}
