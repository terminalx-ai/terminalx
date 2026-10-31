/** One private 1×1 conversion surface per window, rather than two per palette. */
let colorContext: CanvasRenderingContext2D | undefined;

/** xterm and OSC color replies need sRGB; app tokens can be oklch. */
export function terminalColorHex(css: string, fallback: string): string {
  try {
    if (colorContext?.isContextLost?.()) colorContext = undefined;
    if (!colorContext) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      colorContext = canvas.getContext("2d") ?? undefined;
    }
    const ctx = colorContext;
    if (!ctx) return fallback;
    // Match a fresh canvas: translucent colors must not blend with the previous
    // conversion, and an invalid CSS color leaves the default black fillStyle.
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  } catch {
    // A failed surface must not make subsequent conversions permanently fail.
    colorContext = undefined;
    return fallback;
  }
}
