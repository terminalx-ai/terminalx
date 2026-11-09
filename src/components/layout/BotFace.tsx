import { useId } from "react";
import { MORPH_STEPS, botColor, faceOf } from "@terminalx/portable/botFace";

// A chat's bot face. The face itself is made in `@terminalx/portable/botFace`,
// so a paired phone draws the same one.

export { BOT_COLORS, botColor, faceOf, seedOf, type Face } from "@terminalx/portable/botFace";

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
