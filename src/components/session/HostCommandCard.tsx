import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** Immutable display data supplied by future lead integration, never identity authority. */
export interface HostCommandPresentation {
  readonly requestId: string;
  readonly executable: string;
  /** Exact argv entries, excluding argv[0]. Shell use must include its flags and script here. */
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly agent: string;
  readonly turn: string;
  readonly originAccount: string;
  readonly originDevice: string;
  readonly timeoutMs: number;
}

export type HostCommandCardState = "pending" | "running" | "cancelling" | "cancelled" | "denied" | "expired" | "completed" | "failed";
export type HostCommandPresentationIntent = Readonly<{
  kind: "run-once" | "deny" | "cancel";
  request: HostCommandPresentation;
}>;

export interface HostCommandCardProps {
  readonly request: HostCommandPresentation;
  /** Missing/unknown state is unavailable, never implicitly pending. */
  readonly state?: HostCommandCardState;
  /** Optional, presentation-only notification. Not consent, a capability, or native authorization. */
  readonly onIntent?: (intent: HostCommandPresentationIntent) => void;
}

/**
 * Isolated PRO-220 foundation: no transport, executor, settings or registration.
 * Any caller (including automation) can invoke these callbacks. Future native
 * integration must independently validate trusted origin and physical-human
 * consent; neither these types nor display labels establish either.
 *
 * Design 14.17/09.29 deliberately differ: owner per-command approval supersedes
 * “Always allow here”, its persistent setting, and the Enter-to-approve hint.
 * The design's “Only you see this card” is not an established runtime guarantee.
 */
export function HostCommandCard({ request, state, onIntent }: HostCommandCardProps) {
  const id = useId();
  // UI deduplication only, including synchronous re-entry. Remounts and callers
  // can bypass it; the future native boundary must enforce its own one-shot gate.
  const sent = useRef(new Set<string>());
  const [, refresh] = useState(0);
  const actionKey = JSON.stringify([request.requestId, state === "running" ? "cancel" : "decision"]);
  const busy = sent.current.has(actionKey);
  const args = Array.isArray(request.arguments) ? Array.from(request.arguments) : null;
  const complete = [request.requestId, request.executable, request.cwd, request.agent, request.turn, request.originAccount, request.originDevice]
    .every((value) => typeof value === "string" && value.trim().length > 0)
    && args !== null && args.every((value) => typeof value === "string")
    && Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0;
  const labels: Record<HostCommandCardState, string> = {
    pending: "Waiting for a decision", running: "Running", cancelling: "Cancellation requested",
    cancelled: "Cancelled", denied: "Denied", expired: "Expired", completed: "Completed", failed: "Failed",
  };
  function notify(kind: HostCommandPresentationIntent["kind"]) {
    if (!onIntent || sent.current.has(actionKey) || (kind === "cancel" ? state !== "running" : state !== "pending") || (kind === "run-once" && !complete)) return;
    const intent = { kind, request };
    sent.current.add(actionKey);
    refresh((revision) => revision + 1);
    onIntent(intent);
  }
  const status = state && Object.hasOwn(labels, state) ? labels[state] : "Unavailable";
  return (
    <section aria-labelledby={`${id}-title`} aria-describedby={`${id}-disclosure ${id}-escaping`} className="overflow-hidden rounded-xl border border-hairline-strong bg-card">
      <div className="px-4 pb-3.5 pt-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-warning">On your Mac</p>
        <h3 id={`${id}-title`} className="mt-1 text-sm font-medium text-foreground">Run this command on your Mac?</h3>
        <p role="status" aria-live="polite" className="mt-1 text-xs text-muted-foreground">{status}</p>
        <dl className="mt-3 space-y-2 text-xs">
          <Detail label="Request" value={request.requestId} />
          <Detail label="Executable" value={request.executable} />
          <div>
            <dt className="font-medium text-muted-foreground">Arguments (in order)</dt>
            <dd>{args === null ? "Unavailable" : args.length === 0 ? <span>No arguments</span> : <ol className="list-inside list-decimal space-y-1">{args.map((argument, index) => <li key={index}><Value value={argument} /></li>)}</ol>}</dd>
          </div>
          <Detail label="Working directory on this Mac" value={request.cwd} />
          <Detail label="Requesting agent" value={request.agent} />
          <Detail label="Turn" value={request.turn} />
          <Detail label="Origin account (display only)" value={request.originAccount} />
          <Detail label="Origin device (display only)" value={request.originDevice} />
          <div><dt className="font-medium text-muted-foreground">Timeout</dt><dd>{Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 ? `${request.timeoutMs} ms` : "Unavailable"}</dd></div>
        </dl>
        <p id={`${id}-disclosure`} className="mt-3 text-xs text-muted-foreground">If executed, standard output and standard error go back to the requesting agent and may contain sensitive information. Cancellation may not undo side effects.</p>
        <p id={`${id}-escaping`} className="mt-2 text-xs text-muted-foreground">Values are quoted; backslashes, control characters and text direction controls are escaped. Each argument is shown separately.</p>
        {state === "pending" && !complete && <p className="mt-2 text-xs text-warning">Request details are incomplete. Run once is unavailable.</p>}
      </div>
      <div className="flex flex-wrap justify-end gap-1.5 border-t border-hairline bg-veil-card px-3 py-2">
        {state === "pending" && <>
          <Button size="sm" variant="outline" disabled={!onIntent || busy} onClick={() => notify("deny")}>Deny</Button>
          <Button size="sm" variant="accent" disabled={!onIntent || busy || !complete} onClick={() => notify("run-once")}>Run once</Button>
        </>}
        {state === "running" && <Button size="sm" variant="outline" disabled={!onIntent || busy} onClick={() => notify("cancel")}>Cancel</Button>}
      </div>
    </section>
  );
}

/** JSON quoting is unambiguous even for literal escape sequences and empty argv. */
function displayValue(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function Value({ value }: { value: string }) {
  return <code dir="ltr" className="block whitespace-pre-wrap rounded-md bg-well px-2.5 py-1.5 font-mono text-xs text-foreground [overflow-wrap:anywhere] [unicode-bidi:isolate]">{typeof value === "string" ? displayValue(value) : "Unavailable"}</code>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt className="font-medium text-muted-foreground">{label}</dt><dd><Value value={value} /></dd></div>;
}
