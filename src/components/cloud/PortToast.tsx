import { useState } from "react";
import { PlugZap, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { copyForwardUrl, dismissPortToast, forwardAddress, openForwardInBrowser, portForwardsOf, processLabel, usePortForwards, usePortToasts, type PortToast } from "@/lib/portForwards";

/**
 * "Port 5173 forwarded to 127.0.0.1:5173" (14.10): one toast for each forward
 * that opened without a click here (forwarded automatically, or back after
 * the machine reconnected), with Open (TerminalX's built-in browser) and Copy.
 * `where` ends its second line: "vite · console on Mac mini".
 */
export function PortToasts({ connectionId, where }: { connectionId: string | null; where: string }) {
  const toasts = usePortToasts(connectionId);
  // Re-read the program names as they arrive.
  usePortForwards(connectionId, false);
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none absolute right-6 bottom-6 z-(--z-menu) flex w-[350px] max-w-[calc(100%-24px)] flex-col gap-2" data-testid="port-toasts">
      {toasts.map((toast) => (
        <PortToastCard key={toast.id} toast={toast} where={where} />
      ))}
    </div>
  );
}

function PortToastCard({ toast, where }: { toast: PortToast; where: string }) {
  const { port, localPort } = toast.forward;
  const [note, setNote] = useState<string | null>(null);
  const label = processLabel(portForwardsOf(toast.connectionId).processes.get(port));
  return (
    <div role="status" className="pointer-events-auto flex gap-2.5 rounded-lg bg-popover px-3.5 py-3 shadow-surface hairline animate-fade-in" data-testid="port-toast">
      <PlugZap className="mt-px size-4 shrink-0 text-add" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground">
          Port {port} forwarded to <span className="font-mono">{forwardAddress(localPort)}</span>
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{note ?? (label ? `${label} ${where}` : `Listening ${where}`)}</div>
        <div className="mt-2.5 flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void openForwardInBrowser(localPort).then(
                () => dismissPortToast(toast.id),
                () => setNote(`TerminalX's browser could not open ${forwardAddress(localPort)}.`),
              );
            }}
          >
            Open
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-muted-foreground"
            onClick={() => {
              void copyForwardUrl(localPort).then(
                () => setNote(`Copied http://${forwardAddress(localPort)}`),
                () => undefined,
              );
            }}
          >
            Copy
          </Button>
        </div>
      </div>
      <button type="button" aria-label="Dismiss" onClick={() => dismissPortToast(toast.id)} className="self-start rounded-sm p-0.5 text-faint hover:bg-veil-strong hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </div>
  );
}
