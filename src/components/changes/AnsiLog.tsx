import { useMemo, type CSSProperties } from "react";

// A terminal palette on a fixed dark log surface. Text is always rendered by
// React: logs cannot create HTML, links, images, or clipboard escape actions.
const PALETTE = ["#242424", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#d7dae0", "#767676", "#ff7b86", "#b5e890", "#ffe095", "#83c7ff", "#e4a2f6", "#80d7e1", "#ffffff"];

function color(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return PALETTE[index];
  if (index >= 232) return `rgb(${Array(3).fill(8 + (index - 232) * 10).join(", ")})`;
  const n = index - 16;
  const level = (n: number) => n === 0 ? 0 : 55 + n * 40;
  return `rgb(${level(Math.floor(n / 36))}, ${level(Math.floor(n / 6) % 6)}, ${level(n % 6)})`;
}

export function ansiSpans(input: string): { text: string; style: CSSProperties }[] {
  // gh run view escapes ESC as ^[; only recognize that notation for SGR.
  const text = input.replace(/\^\[(?=\[[\d;]*m)/g, "\x1b");
  const controls = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)|\x1b[@-_]/g;
  const spans: { text: string; style: CSSProperties }[] = [];
  let style: CSSProperties = {};
  let from = 0;
  const append = (value: string) => {
    const clean = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    if (clean) spans.push({ text: clean, style: { ...style } });
  };
  for (const match of text.matchAll(controls)) {
    append(text.slice(from, match.index));
    from = match.index! + match[0].length;
    if (!/^\x1b\[[\d;]*m$/.test(match[0])) continue;
    const values = match[0].slice(2, -1).split(";").map(Number);
    for (let i = 0; i < values.length; i++) {
      const code = values[i];
      if (code === 0) style = {};
      else if (code === 1) style.fontWeight = 700;
      else if (code === 2) style.opacity = 0.7;
      else if (code === 3) style.fontStyle = "italic";
      else if (code === 4) style.textDecoration = "underline";
      else if (code === 22) { delete style.fontWeight; delete style.opacity; }
      else if (code === 23) delete style.fontStyle;
      else if (code === 24) delete style.textDecoration;
      else if (code === 39) delete style.color;
      else if (code === 49) delete style.backgroundColor;
      else if (code >= 30 && code <= 37) style.color = PALETTE[code - 30];
      else if (code >= 90 && code <= 97) style.color = PALETTE[code - 90 + 8];
      else if (code >= 40 && code <= 47) style.backgroundColor = PALETTE[code - 40];
      else if (code >= 100 && code <= 107) style.backgroundColor = PALETTE[code - 100 + 8];
      else if (code === 38 || code === 48) {
        let value: string | undefined;
        if (values[i + 1] === 5) { value = color(values[i + 2]); i += 2; }
        else if (values[i + 1] === 2) {
          const rgb = values.slice(i + 2, i + 5);
          if (rgb.length === 3 && rgb.every((n) => n >= 0 && n <= 255)) value = `rgb(${rgb.join(", ")})`;
          i += 4;
        }
        if (value) style[code === 38 ? "color" : "backgroundColor"] = value;
      }
    }
  }
  append(text.slice(from));
  return spans;
}

export function plainLog(text: string): string { return ansiSpans(text).map((span) => span.text).join(""); }

export function AnsiLog({ text }: { text: string }) {
  const spans = useMemo(() => ansiSpans(text), [text]);
  return <pre tabIndex={0} aria-label="Check log" className="max-h-80 overflow-auto whitespace-pre bg-[#181b20] p-2 font-mono text-[11px] leading-4 text-[#d7dae0] select-text">{spans.map((span, i) => <span key={i} style={span.style}>{span.text}</span>)}</pre>;
}
