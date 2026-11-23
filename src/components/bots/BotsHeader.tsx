import { useEffect, useRef, type ReactNode } from "react";

/**
 * The page's own title row, as the dashboard draws its own. `focus` puts the keyboard focus on the title when the page
 * shows (after a hire, whose page is gone); `onFocused` says it was taken.
 */
export function BotsHeader({ title, note, focus = false, onFocused, children }: { title: ReactNode; note?: string; focus?: boolean; onFocused?: () => void; children?: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!focus) return;
    heading.current?.focus();
    onFocused?.();
  }, [focus, onFocused]);
  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline px-6 py-2" data-testid="bots-header">
      <h1 ref={heading} tabIndex={-1} className="text-[15px] font-semibold text-foreground outline-none">{title}</h1>
      {note && <p className="min-w-0 flex-1 truncate text-[12.5px] text-faint">{note}</p>}
      {children && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
    </header>
  );
}
