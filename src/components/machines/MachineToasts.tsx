import type { ReactNode } from "react";
import { CircleCheck, CircleX, ShieldAlert, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { machineConnection, useMachineConnections } from "@/lib/machineConnections";
import { dismissMachineToast, useMachineToasts, type MachineToast } from "@/lib/machineToasts";
import { dismissNotice, openNotice, type Notice } from "@/lib/notify";
import { routeText } from "./connectionStatus";
import { runningText, useRunningSessions } from "./useRunningSessions";

/**
 * The machine toasts of screen 21.09: Connected to a machine, a machine
 * session that needs the person (with Open), and a pairing that failed (with
 * Try again). Each has its icon, a title, one line, and a close button.
 */
function ToastCard({ icon, title, detail, action, onClose, testId }: { icon: ReactNode; title: string; detail: string; action?: ReactNode; onClose: () => void; testId: string }) {
  return (
    <div role="status" className="pointer-events-auto flex items-start gap-3 rounded-xl bg-popover p-4 text-sm shadow-surface hairline animate-fade-in" data-testid={testId}>
      <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon}</span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="truncate font-medium text-foreground">{title}</div>
        <div className="text-[12.5px] text-muted-foreground">{detail}</div>
        {action && <div className="mt-2.5 flex items-center gap-2">{action}</div>}
      </div>
      <button type="button" aria-label="Dismiss" onClick={onClose} className="rounded-sm p-0.5 text-faint hover:bg-veil-strong hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** "Mac mini needs you": a machine session's wait, raised by `raiseMachineAttention`. */
export function MachineNoticeCard({ notice }: { notice: Notice }) {
  return (
    <ToastCard
      testId="machine-toast-needs-you"
      icon={<ShieldAlert className="text-warning" />}
      title={notice.title}
      detail={notice.body}
      action={
        <Button size="sm" variant="outline" onClick={() => openNotice(notice)}>
          Open
        </Button>
      }
      onClose={() => dismissNotice(notice.id)}
    />
  );
}

function ConnectedToast({ toast }: { toast: Extract<MachineToast, { kind: "connected" }> }) {
  const store = useMachineConnections();
  const { connection, state } = machineConnection(store, toast.machineId);
  const linked = state.state === "direct" || state.state === "relay";
  const running = useRunningSessions(connection, linked);
  // The route as it is now: a move to a direct route while the toast shows is the one named.
  const route = linked ? state.route : toast.route;
  const detail = [routeText(route), running === null ? null : runningText(running)].filter(Boolean).join(" · ");
  return <ToastCard testId="machine-toast-connected" icon={<CircleCheck className="text-add" />} title={`Connected to ${toast.name}`} detail={detail} onClose={() => dismissMachineToast(toast.id)} />;
}

function PairFailedToast({ toast }: { toast: Extract<MachineToast, { kind: "pairFailed" }> }) {
  const retry = toast.retry;
  return (
    <ToastCard
      testId="machine-toast-pair-failed"
      icon={<CircleX className="text-destructive" />}
      title={`Couldn’t pair with ${toast.name}`}
      detail={toast.detail}
      action={
        retry ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              dismissMachineToast(toast.id);
              retry();
            }}
          >
            Try again
          </Button>
        ) : undefined
      }
      onClose={() => dismissMachineToast(toast.id)}
    />
  );
}

export function MachineToasts() {
  const toasts = useMachineToasts();
  if (!toasts.length) return null;
  return (
    <div className="contents" data-testid="machine-toasts">
      {toasts.map((toast) => (toast.kind === "connected" ? <ConnectedToast key={toast.id} toast={toast} /> : <PairFailedToast key={toast.id} toast={toast} />))}
    </div>
  );
}
