import { cn } from "@/lib/cn";

/**
 * Small pixel creatures for project rows, drawn as SVG rects from 8×8 masks
 * so they tint with the project's colour and stay crisp at any size.
 */
const MASKS: Record<string, string[]> = {
  raccoon: ["#......#", "##....##", "#.####.#", "########", "#.#..#.#", "########", ".######.", "..#..#.."],
  fox: ["#......#", "##....##", "########", "#.####.#", "########", ".######.", "..####..", "...##..."],
  cat: ["#......#", "##....##", "########", "#.#..#.#", "########", "########", ".#.##.#.", "..#..#.."],
  owl: [".######.", "#.#..#.#", "########", "#.####.#", "########", ".######.", "..####..", ".#....#."],
  frog: [".#....#.", "########", "#.#..#.#", "########", "########", ".######.", "#......#", "##....##"],
  robot: ["...##...", ".######.", "#.#..#.#", "########", "#.####.#", "########", ".#....#.", ".##..##."],
  ghost: ["..####..", ".######.", "#.#..#.#", "########", "########", "########", "########", "#.##.#.#"],
  bear: ["##....##", "########", "########", "#.#..#.#", "########", "#.####.#", ".######.", "..####.."],
  rabbit: [".#....#.", ".#....#.", ".######.", "#.#..#.#", "########", ".######.", ".######.", "..#..#.."],
  penguin: ["..####..", ".#.##.#.", ".######.", "..####..", ".######.", "########", "#.####.#", "..#..#.."],
};

export const MASCOTS = Object.keys(MASKS);

/** Named accents; each maps to a token so it follows the theme. */
export const PROJECT_COLORS: { id: string; css: string }[] = [
  { id: "slate", css: "var(--ink-muted)" },
  { id: "blue", css: "#5b8def" },
  { id: "orange", css: "#e0703a" },
  { id: "yellow", css: "#e2b53b" },
  { id: "green", css: "#5cb85c" },
  { id: "pink", css: "#d85fa5" },
  { id: "purple", css: "#9b6fe0" },
  { id: "teal", css: "#3fb5a9" },
  { id: "amber", css: "#e8913a" },
];

export function colorCss(id: string | null | undefined): string {
  return PROJECT_COLORS.find((c) => c.id === id)?.css ?? "var(--ink-muted)";
}

export function PixelMascot({ id, color, size = 16, className }: { id: string; color?: string | null; size?: number; className?: string }) {
  const rows = MASKS[id] ?? MASKS.raccoon;
  return (
    <svg viewBox="0 0 8 8" width={size} height={size} className={cn("shrink-0", className)} aria-hidden style={{ shapeRendering: "crispEdges" }}>
      {rows.map((row, y) =>
        [...row].map((ch, x) => (ch === "#" ? <rect key={`${x}${y}`} x={x} y={y} width={1} height={1} fill={colorCss(color)} /> : null)),
      )}
    </svg>
  );
}
