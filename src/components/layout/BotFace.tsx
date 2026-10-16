import { useId } from "react";
import { PROJECT_COLORS } from "./PixelMascot";

/**
 * A bot's face, made up from a seed: a soft blob of one colour with two eye
 * slits, as a messaging app gives each bot a profile picture. The same seed
 * always draws the same face, so a chat keeps its character between launches,
 * and two chats are unlikely to share one.
 */

/** Colours a face without a project takes, by its seed. The palette's accents plus a few a palette has no use for. */
export const BOT_COLORS: string[] = [...PROJECT_COLORS.filter((c) => c.id !== "slate").map((c) => c.css), "#e05252", "#8a8a92", "#ece9e1", "#4f6fd8", "#c45fd8"];

/** A small, fast hash of a string to 32 bits. */
export function seedOf(text: string): number {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** A deterministic stream of numbers in [0, 1) from one seed (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function botColor(seed: string): string {
  return BOT_COLORS[seedOf(seed) % BOT_COLORS.length]!;
}

export interface Face {
  /** The blob's outline, on a 40×40 canvas. */
  path: string;
  /** The outlines a working face morphs through, from `path` back round to it; all share one structure, so they interpolate. */
  morph: string[];
  /** Each eye: its centre, size and tilt. */
  eyes: { x: number; y: number; w: number; h: number; tilt: number }[];
}

/** How many shapes a working face morphs through before it comes round again. */
const MORPH_STEPS = 4;

/** The blob's outline: the ring's points at the given radii, joined by a smooth curve through the midpoints, so no corner is sharp. */
function outline(spin: number, radii: number[]): string {
  const sides = radii.length;
  const points = radii.map((radius, i): [number, number] => {
    const angle = spin + (i / sides) * Math.PI * 2;
    return [20 + Math.cos(angle) * radius, 20 + Math.sin(angle) * radius];
  });
  const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const r = (n: number) => n.toFixed(1);
  let path = `M ${r(mid(points[0]!, points[1]!)[0])} ${r(mid(points[0]!, points[1]!)[1])}`;
  for (let i = 1; i <= sides; i++) {
    const control = points[i % sides]!;
    const to = mid(points[i % sides]!, points[(i + 1) % sides]!);
    path += ` Q ${r(control[0])} ${r(control[1])} ${r(to[0])} ${r(to[1])}`;
  }
  return `${path} Z`;
}

/** The face a seed draws. Exported so it can be checked without a DOM. */
export function faceOf(seed: string): Face {
  const next = random(seedOf(seed));
  const sides = 5 + Math.floor(next() * 4);
  const spin = next() * Math.PI * 2;
  const radii = Array.from({ length: sides }, () => 15 + next() * 5.5);
  const path = outline(spin, radii);
  // Two eyes, a touch above the middle; taller than wide, tilted together a little, sometimes one lower (a raised brow).
  const gap = 4.5 + next() * 2;
  const w = 3 + next() * 1.6;
  const h = w * (1.6 + next() * 0.8);
  const tilt = (next() - 0.5) * 30;
  const y = 17 + next() * 3;
  const droop = next() < 0.3 ? (next() - 0.5) * 3 : 0;
  // The shapes a working face moves through: the same ring, each point a little further in or out, back to the first.
  const morph = [path];
  for (let step = 1; step < MORPH_STEPS; step++) {
    const sway = random(seedOf(`${seed}#${step}`));
    morph.push(outline(spin, radii.map((radius) => Math.max(13, Math.min(20, radius + (sway() - 0.5) * 6)))));
  }
  morph.push(path);
  return {
    path,
    morph,
    eyes: [
      { x: 20 - gap, y: y + droop, w, h, tilt },
      { x: 20 + gap, y: y - droop, w, h, tilt },
    ],
  };
}

/**
 * `live` sets the blob morphing between its shapes without end, for a bot
 * that is busy. The outline is animated in SVG itself, so a list of them
 * costs no script time.
 */
export function BotFace({ seed, color, size = 36, className, live = false }: { seed: string; color?: string | null; size?: number; className?: string; live?: boolean }) {
  const face = faceOf(seed);
  const fill = color ?? botColor(seed);
  const shade = useId();
  const morphing = live && <animate attributeName="d" values={face.morph.join(";")} dur={`${MORPH_STEPS * 1.1}s`} repeatCount="indefinite" calcMode="spline" keySplines={Array(face.morph.length - 1).fill("0.45 0 0.55 1").join(";")} />;
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className={className} aria-hidden data-seed={seed} data-live={live || undefined} data-testid="bot-face">
      <defs>
        {/* A little light from the top left, so the blob reads as a body, not a flat shape. */}
        <radialGradient id={shade} cx="35%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.12" />
        </radialGradient>
      </defs>
      <path d={face.path} fill={fill}>{morphing}</path>
      <path d={face.path} fill={`url(#${shade})`}>{morphing}</path>
      {face.eyes.map((eye, index) => (
        <rect
          key={index}
          x={eye.x - eye.w / 2}
          y={eye.y - eye.h / 2}
          width={eye.w}
          height={eye.h}
          rx={eye.w / 2}
          fill="#17171a"
          fillOpacity="0.85"
          transform={`rotate(${eye.tilt.toFixed(1)} ${eye.x} ${eye.y})`}
        />
      ))}
    </svg>
  );
}
