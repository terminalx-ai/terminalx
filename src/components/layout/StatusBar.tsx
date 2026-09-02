import { useEffect, useRef, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { setStatusSettings, useStatus } from "@/lib/status";

const NARROW_AT = 900;

/** The quiet, app-wide chrome beneath every column. */
export function StatusBar() {
  const { settings } = useStatus();
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW_AT));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (!settings.visible) return null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={ref}
          data-status-bar
          data-narrow={narrow || undefined}
          className="flex h-[22px] shrink-0 items-center justify-between border-t border-hairline bg-background/70 px-2 text-[11px] leading-none text-muted-foreground"
        >
          <div className="flex min-w-0 items-center">
            {settings.usage ? <div className="relative h-[18px] rounded px-1.5 leading-[18px]">Usage —</div> : null}
          </div>
          <div className="flex min-w-0 items-center">
            {settings.resources ? (
              <div className="h-[18px] rounded px-1.5 leading-[18px]">
                0 agents<span className={cn(narrow && "hidden")}> · —</span>
              </div>
            ) : null}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void setStatusSettings({ usage: !settings.usage })}>
          <span className="w-3 text-center">{settings.usage ? "✓" : ""}</span> Usage
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void setStatusSettings({ resources: !settings.resources })}>
          <span className="w-3 text-center">{settings.resources ? "✓" : ""}</span> Resources
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
