import { cn } from "@/lib/cn";

/**
 * A small mark per agent, drawn on currentColor so it sits quietly in chrome.
 * These are Raccoon's own glyphs, not vendor logos.
 */
export function AgentMark({ id, className }: { id: string; className?: string }) {
  const common = { className: cn("inline-block", className), viewBox: "0 0 16 16", "aria-hidden": true };
  switch (id) {
    case "claude":
      // A starburst: eight short rays.
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          {Array.from({ length: 8 }, (_, i) => {
            const a = (i * Math.PI) / 4;
            const x1 = 8 + Math.cos(a) * 2.6;
            const y1 = 8 + Math.sin(a) * 2.6;
            const x2 = 8 + Math.cos(a) * 6.2;
            const y2 = 8 + Math.sin(a) * 6.2;
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
          })}
        </svg>
      );
    case "codex":
      // A hexagon with a dot.
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
          <path d="M8 1.8 13.4 4.9v6.2L8 14.2 2.6 11.1V4.9z" />
          <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
        </svg>
      );
    case "cursor":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
          <path d="M3 2.5v10l3-2.4 2 3.9 2-1-2-3.8 3.4-.6z" />
        </svg>
      );
    case "opencode":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 4 2.5 8 6 12M10 4l3.5 4L10 12" />
        </svg>
      );
    default:
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="8" cy="8" r="5.5" />
        </svg>
      );
  }
}
