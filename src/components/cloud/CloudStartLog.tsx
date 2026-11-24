import { cloudStartEventLabel } from "@/lib/cloudStartProgress";
import type { CloudWorkspaceOperation, CloudWorkspaceStartProgress } from "@/lib/api";

export function CloudStartLog({ logs, events, connected }: { logs?: CloudWorkspaceOperation["logs"]; events?: CloudWorkspaceStartProgress["events"]; connected: boolean }) {
  const history = events?.flatMap((event) => {
    const label = cloudStartEventLabel(event);
    return label ? [{ ...event, label }] : [];
  });
  return (
    <section aria-label="Start log" data-testid="cloud-start-log" className="shrink-0 border-t border-hairline px-4 py-2">
      <h3 className="text-xs font-medium">Start log</h3>
      {logs?.length ? (
        <ol aria-live="polite" className="mt-1 max-h-28 overflow-auto font-mono text-[11px] text-muted-foreground">
          {logs.map(({ occurredAt, content, source }, index) => (
            <li key={`${occurredAt}:${index}`} className="whitespace-pre-wrap wrap-anywhere">
              <span className="text-faint">{new Date(occurredAt).toLocaleTimeString()} {source} </span>{content}
            </li>
          ))}
        </ol>
      ) : history?.length ? (
        <ol aria-live="polite" className="mt-1 max-h-28 overflow-auto text-[11px] text-muted-foreground">
          {history.map(({ id, occurredAt, label }) => (
            <li key={id}><span className="text-faint">{new Date(occurredAt).toLocaleTimeString()} </span>{label}</li>
          ))}
        </ol>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">{connected ? "Waiting for start log output…" : "Waiting for the workspace runtime…"}</p>
      )}
    </section>
  );
}
