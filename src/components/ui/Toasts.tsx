import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AlertCircle, Check, CheckCircle2, CircleX, Copy, GitBranch, GitBranchPlus, MessageCircleQuestion, Play, RotateCw, X } from "@/icons";
import { AgentMark } from "@/components/AgentMark";
import { cn } from "@/lib/cn";
import { dismissNotice, openNotice, useNotices } from "@/lib/notify";
import { useSessionStore } from "@/lib/sessions";
import { WorkspaceSetupToasts } from "@/components/terminal/WorkspaceSetupNotice";
import { AgentLoginToasts } from "@/components/settings/AgentLoginToasts";
import { SettingsLinkToasts } from "@/components/settings/SettingsLinkToasts";
import { copyText } from "@/lib/clipboard";
import { dismissError, errorToastText, runErrorAction, useErrorToasts, type ErrorToast, type ErrorToastAction } from "@/lib/errorToasts";

/** In-app notices, bottom right; clicking one goes to the session. */
export function Toasts() {
  const notices = useNotices();
  const errors = useErrorToasts();
  const store = useSessionStore();
  return (
    <div className="pointer-events-none flex max-h-[50dvh] shrink-0 flex-col gap-2 overflow-y-auto">
      <WorkspaceSetupToasts />
      <AgentLoginToasts />
      <SettingsLinkToasts />
      {notices.map((n) => {
        const tab = store.sessions.find((s) => s.id === n.sessionId)?.tabs.find((t) => t.id === n.tabId);
        const Icon = n.kind === "started" ? Play : n.kind === "waiting" ? MessageCircleQuestion : n.kind === "failed" ? AlertCircle : CheckCircle2;
        return (
          <div
            key={n.id}
            role="status"
            onClick={() => openNotice(n)}
            className="pointer-events-auto flex cursor-pointer items-start gap-2.5 rounded-xl bg-popover p-3 text-sm shadow-surface hairline animate-fade-in"
          >
            <Icon className={cn("mt-0.5 size-4 shrink-0", n.kind === "waiting" ? "text-warning" : n.kind === "failed" ? "text-destructive" : "text-add")} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 font-medium">
                {(tab?.harness ?? n.harness) && <AgentMark id={(tab?.harness ?? n.harness)!} className="size-3.5" />}
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
      {errors.map((toast) => <ErrorToastCard key={toast.id} toast={toast} />)}
    </div>
  );
}

/**
 * A failed action (PRO-326): it stays until closed, since a failure the
 * reader did not see is the one they repeat, and its text copies whole for
 * a bug report. Escape on it closes it, as its close button does.
 */
function ErrorToastCard({ toast }: { toast: ErrorToast }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [running, setRunning] = useState<string | null>(null);
  const reset = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(reset.current), []);
  const onCopy = () => {
    window.clearTimeout(reset.current);
    copyText(errorToastText(toast)).then(() => setCopy("copied"), () => setCopy("failed"));
    reset.current = window.setTimeout(() => setCopy("idle"), 2000);
  };
  const onAction = (action: ErrorToastAction) => {
    if (running) return;
    setRunning(action.label);
    void runErrorAction(toast.id, action).finally(() => setRunning(null));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    dismissError(toast.id);
  };
  return (
    <div
      role="alert"
      aria-labelledby={`${toast.id}-title`}
      aria-describedby={`${toast.id}-body`}
      data-error-toast=""
      onKeyDown={onKeyDown}
      data-tone={toast.tone}
      className={cn(
        "pointer-events-auto flex items-start gap-2.5 bg-popover text-sm text-card-foreground shadow-surface animate-fade-in",
        // The branch toasts (PRO-295) have an edge in their colour, as their screens draw them.
        toast.tone ? "rounded-lg border px-3.5 py-3" : "rounded-xl p-3 hairline",
        toast.tone === "warning" && "border-warning/40",
        toast.tone === "error" && "border-destructive/40",
      )}
    >
      {toast.icon === "branch" ? (
        <GitBranch aria-hidden className={cn("mt-0.5 size-4 shrink-0", toast.tone === "warning" ? "text-warning" : "text-destructive")} />
      ) : (
        <CircleX aria-hidden className={cn("mt-0.5 size-4 shrink-0", toast.tone === "warning" ? "text-warning" : "text-destructive")} />
      )}
      <div className="min-w-0 flex-1">
        <div id={`${toast.id}-title`} className="flex items-center gap-1.5 font-medium">
          <span className={toast.title ? "min-w-0 break-words" : "truncate"}>{toast.title ?? "Something went wrong"}</span>
          {toast.count > 1 && <span className="shrink-0 text-xs font-normal text-faint" aria-label={`${toast.count} times`}>×{toast.count}</span>}
        </div>
        <div id={`${toast.id}-body`} className="mt-0.5 max-h-40 overflow-y-auto break-words text-xs text-muted-foreground">
          {toast.title ? (
            <>
              {toast.action ? <div>{toast.action}.</div> : null}
              {toast.cause && toast.detail === "line" ? (
                <div className="mt-1.5 truncate rounded-md bg-raised px-2 py-1 font-mono text-[11.5px] hairline" title={toast.cause} data-error-detail="">{toast.cause}</div>
              ) : toast.cause ? <div className="font-mono text-foreground" data-error-detail="">{toast.cause}</div> : null}
            </>
          ) : toast.cause ? <>{toast.action}: <span className="font-mono text-foreground">{toast.cause}</span></> : `${toast.action}.`}
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {toast.actions?.map((action) => (
          <button
            key={action.label}
            type="button"
            disabled={!!running}
            aria-busy={running === action.label || undefined}
            onClick={() => onAction(action)}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs disabled:opacity-60",
              action.primary ? "bg-foreground font-medium text-background hover:opacity-90" : "text-muted-foreground hover:bg-veil-strong hover:text-foreground",
              !action.primary && (action.icon || toast.tone) && "hairline",
            )}
          >
            {action.icon === "retry" ? <RotateCw className={cn("size-3.5", running === action.label && "animate-spin")} /> : null}
            {action.icon === "branch" ? <GitBranch className="size-3.5" /> : null}
            {action.icon === "branch-plus" ? <GitBranchPlus className="size-3.5" /> : null}
            {action.label}
          </button>
        ))}
        {toast.copy !== false && <button
          type="button"
          onClick={onCopy}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs text-muted-foreground hairline hover:bg-veil-strong hover:text-foreground"
        >
          {copy === "copied" ? <Check className="size-3.5 text-add" /> : <Copy className="size-3.5" />}
          {copy === "copied" ? "Copied" : copy === "failed" ? "Couldn't copy" : "Copy error"}
        </button>}
        </div>
        <span className="sr-only" aria-live="polite">{copy === "copied" ? "Error copied to the clipboard" : ""}</span>
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={() => dismissError(toast.id)}
        className="rounded-sm p-0.5 text-faint hover:bg-veil-strong hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
