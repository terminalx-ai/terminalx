import { cn } from "@/lib/cn";
import { usePrefs } from "@/lib/prefs";

/**
 * TerminalX's own "working" sign: three bars that rise and fall in turn,
 * like a level meter, drawn in the icon set's line. It sits at the end of
 * a row, where a time would be, so the row's own icon keeps its place.
 */
export function Working({ className, label = "Working" }: { className?: string; label?: string }) {
  const { animations } = usePrefs();
  // Each bar breathes between a short and a tall state; the three are a third of a beat apart.
  const bars = [
    { x: 4.5, begin: "0s" },
    { x: 8, begin: "0.27s" },
    { x: 11.5, begin: "0.54s" },
  ];
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 16 16"
      className={cn("size-3.5 shrink-0 text-info", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      data-testid="working-mark"
      data-animated={animations || undefined}
    >
      {bars.map((bar, index) => (
        <line key={bar.x} x1={bar.x} x2={bar.x} y1={animations ? 9.5 : [8.5, 5.5, 10][index]} y2={12}>
          {animations && <animate attributeName="y1" values="9.5;4;9.5" dur="0.8s" begin={bar.begin} repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1" />}
        </line>
      ))}
    </svg>
  );
}

/** How a conversation is doing, at the end of its row: working, waiting on the reader, or unread. */
export function StatusMark({ status, unread = false, className }: { status: "waiting" | "in_progress" | string; unread?: boolean; className?: string }) {
  if (status === "in_progress") return <Working className={className} />;
  if (status === "waiting") return <span role="img" aria-label="Needs you" className={cn("size-1.5 shrink-0 rounded-full bg-warning", className)} />;
  if (unread) return <span role="img" aria-label="Unread" className={cn("size-1.5 shrink-0 rounded-full bg-info", className)} />;
  return null;
}
