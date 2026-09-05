import { AlertCircle, CheckCircle2, MessageCircleQuestion, X } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { cn } from "@/lib/cn";
import { dismissNotice, openNotice, useNotices } from "@/lib/notify";
import { useSessionStore } from "@/lib/sessions";

/** In-app notices, bottom right; clicking one goes to the session. */
export function Toasts() {
  const notices = useNotices();
  const store = useSessionStore();
  if (!notices.length) return null;
  return (
    <div className="pointer-events-none flex max-h-[50dvh] shrink-0 flex-col gap-2 overflow-y-auto">
      {notices.map((n) => {
        const tab = store.sessions.find((s) => s.id === n.sessionId)?.tabs.find((t) => t.id === n.tabId);
        const Icon = n.kind === "waiting" ? MessageCircleQuestion : n.kind === "failed" ? AlertCircle : CheckCircle2;
        return (
          <div
            key={n.id}
            role="status"
            onClick={() => openNotice(n)}
            className="pointer-events-auto flex cursor-pointer items-start gap-2.5 rounded-xl bg-popover glass p-3 text-sm shadow-surface hairline animate-fade-in"
          >
            <Icon className={cn("mt-0.5 size-4 shrink-0", n.kind === "waiting" ? "text-warning" : n.kind === "failed" ? "text-destructive" : "text-add")} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 font-medium">
                {tab && <AgentMark id={tab.harness} className="size-3.5" />}
                <span className="truncate">{n.title}</span>
              </div>
              <div className="truncate text-xs text-muted-foreground">{n.body}</div>
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={(e) => {
                e.stopPropagation();
                dismissNotice(n.id);
              }}
              className="rounded-sm p-0.5 text-faint hover:bg-veil-strong hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
