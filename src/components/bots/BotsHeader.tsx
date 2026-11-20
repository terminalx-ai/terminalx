import type { ReactNode } from "react";

/** The page's own title row, as the dashboard draws its own. */
export function BotsHeader({ title, note, children }: { title: ReactNode; note?: string; children?: ReactNode }) {
  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline px-6 py-2" data-testid="bots-header">
      <h1 className="text-[15px] font-semibold text-foreground">{title}</h1>
      {note && <p className="min-w-0 flex-1 truncate text-[12.5px] text-faint">{note}</p>}
      {children && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
    </header>
  );
}
