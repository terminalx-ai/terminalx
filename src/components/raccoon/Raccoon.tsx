import { useEffect, useRef, useState } from "react";
import { usePrefs } from "@/lib/prefs";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/cn";
import { PALETTE, SPRITE_H, SPRITE_W, drawSprite, drawStars, type FrameName } from "./sprite";

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

function fitCanvas(canvas: HTMLCanvasElement, w: number, h: number) {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

type IdleAct = "walk" | "sit" | "wash" | "glance" | "peek";

/**
 * The idle scene: a raccoon pottering along the bottom of an empty session.
 * It walks, sits, washes its paws, glances at the reader, and now and then
 * slips off the right edge to peek back in. Reduced motion draws it sitting
 * still; the animations preference removes it entirely.
 */
export function RaccoonScene({ className }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const prefs = usePrefs();
  const reduced = useReducedMotion();
  const { resolvedMode } = useTheme();
  const enabled = prefs.animations;

  useEffect(() => {
    const el = canvas.current;
    if (!el || !enabled) return;
    const scale = 3;
    const palette = PALETTE[resolvedMode];
    const spriteW = SPRITE_W * scale;
    const spriteH = SPRITE_H * scale;
    let raf = 0;
    let last = performance.now();
    let width = el.clientWidth || 300;
    const height = spriteH + 8;
    let x = Math.max(0, width * 0.4);
    let dir: 1 | -1 = 1;
    let act: IdleAct = "sit";
    let actLeft = 1.2;
    let clock = 0;

    const pick = () => {
      const r = Math.random();
      if (r < 0.45) {
        act = "walk";
        actLeft = 1.5 + Math.random() * 3;
        dir = Math.random() < 0.5 ? -1 : 1;
      } else if (r < 0.65) {
        act = "sit";
        actLeft = 1 + Math.random() * 2;
      } else if (r < 0.82) {
        act = "wash";
        actLeft = 1.8 + Math.random() * 1.2;
      } else if (r < 0.92) {
        act = "glance";
        actLeft = 1 + Math.random();
      } else {
        act = "peek";
        actLeft = 3;
        dir = 1;
      }
    };

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      clock += dt;
      width = el.clientWidth || width;
      const ctx = fitCanvas(el, width, height);
      ctx.clearRect(0, 0, width, height);

      if (reduced) {
        drawSprite(ctx, "sit", Math.round(width / 2 - spriteW / 2), 4, scale, palette);
        return;
      }
      actLeft -= dt;
      if (actLeft <= 0) pick();

      let frame: FrameName = "sit";
      let flip = dir < 0;
      let drawX = x;
      if (act === "walk") {
        x += dir * 28 * dt;
        if (x < 0) {
          x = 0;
          dir = 1;
        }
        if (x > width - spriteW) {
          x = width - spriteW;
          dir = -1;
        }
        frame = Math.floor(clock * 6) % 2 ? "walk1" : "walk2";
      } else if (act === "wash") {
        frame = Math.floor(clock * 3) % 2 ? "wash1" : "wash2";
      } else if (act === "glance") {
        frame = "glance";
        flip = Math.floor(clock * 2) % 2 === 0;
      } else if (act === "peek") {
        // Slide out to the right, hold with just the head showing, come back.
        const p = 1 - actLeft / 3;
        const out = p < 0.3 ? p / 0.3 : p > 0.7 ? (1 - p) / 0.3 : 1;
        drawX = x + out * (width - x - spriteW * 0.35);
        frame = "glance";
        flip = false;
      }
      drawSprite(ctx, frame, Math.round(drawX), 4, scale, palette, flip);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [enabled, reduced, resolvedMode]);

  if (!enabled) return null;
  return (
    <div className={cn("relative w-full overflow-hidden", className)} aria-hidden>
      <canvas ref={canvas} className="block h-[50px] w-full [image-rendering:pixelated]" />
      <div className="mx-4 h-px bg-hairline-strong" />
    </div>
  );
}

/**
 * The busy runner: while a turn is in flight the raccoon runs back and forth
 * along the top edge of the composer. If the "Latest" chevron is showing and
 * it runs into it, it is stunned for a moment, then turns around.
 */
export function RaccoonRunner({ active, obstacle }: { active: boolean; obstacle: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const prefs = usePrefs();
  const reduced = useReducedMotion();
  const { resolvedMode } = useTheme();
  const enabled = prefs.animations && !reduced;
  const obstacleRef = useRef(obstacle);
  obstacleRef.current = obstacle;
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (active) setShown(true);
    else {
      const t = window.setTimeout(() => setShown(false), 400);
      return () => window.clearTimeout(t);
    }
  }, [active]);

  useEffect(() => {
    const el = canvas.current;
    if (!el || !enabled || !shown) return;
    const scale = 2;
    const palette = PALETTE[resolvedMode];
    const spriteW = SPRITE_W * scale;
    const spriteH = SPRITE_H * scale;
    const height = spriteH + 8;
    let raf = 0;
    let last = performance.now();
    let width = el.clientWidth || 300;
    let x = 8;
    let dir: 1 | -1 = 1;
    let clock = 0;
    let stunnedFor = 0;

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      clock += dt;
      width = el.clientWidth || width;
      const ctx = fitCanvas(el, width, height);
      ctx.clearRect(0, 0, width, height);
      let frame: FrameName;
      if (stunnedFor > 0) {
        stunnedFor -= dt;
        frame = "stunned";
        drawStars(ctx, x + spriteW / 2, 6, clock, scale, palette.Y);
        if (stunnedFor <= 0) dir = -dir as 1 | -1;
      } else {
        x += dir * 70 * dt;
        if (x < 4) {
          x = 4;
          dir = 1;
        }
        if (x > width - spriteW - 4) {
          x = width - spriteW - 4;
          dir = -1;
        }
        // The chevron sits at the horizontal centre; a collision stuns.
        const centre = width / 2;
        const nose = dir > 0 ? x + spriteW - 6 : x + 6;
        if (obstacleRef.current && Math.abs(nose - centre) < 30 && Math.abs(nose - centre) > 22) stunnedFor = 1.1;
        frame = Math.floor(clock * 9) % 2 ? "walk1" : "walk2";
      }
      const bob = frame === "stunned" ? 0 : Math.floor(clock * 9) % 2;
      drawSprite(ctx, frame, Math.round(x), 8 - bob, scale, palette, dir < 0);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [enabled, shown, resolvedMode]);

  if (!enabled || !shown) return null;
  return (
    <canvas
      ref={canvas}
      aria-hidden
      className={cn(
        "pointer-events-none absolute -top-[34px] left-0 h-[36px] w-full transition-opacity duration-300 [image-rendering:pixelated]",
        active ? "opacity-100" : "opacity-0",
      )}
    />
  );
}
