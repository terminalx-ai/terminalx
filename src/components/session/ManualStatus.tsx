import { useState } from "react";
import { Check, CheckCircle2, Circle, CircleDot, Clock, X } from "@/icons";
import { MANUAL_STATUSES, manualStatusLabel, type ManualStatus } from "@terminalx/portable/manualStatus";
import { api, errorMessage } from "@/lib/api";
import { ContextMenuItem, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@/components/ui/menu";

const ICONS = { backlog: Circle, in_progress: CircleDot, in_review: Clock, done: CheckCircle2, canceled: X };

export function ManualStatusIcon({ status = "backlog" }: { status?: ManualStatus }) {
  const Icon = ICONS[status] ?? Circle;
  return <Icon className="size-3.5 shrink-0" style={{ color: `var(--status-${status.replaceAll("_", "-")})` }} aria-hidden />;
}

export function ManualStatusMenu({ sessionId, status = "backlog", contextMenu = false, onChange }: { sessionId: string; status?: ManualStatus; contextMenu?: boolean; onChange?: (status: ManualStatus) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Sub = contextMenu ? ContextMenuSub : DropdownMenuSub;
  const Trigger = contextMenu ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
  const Content = contextMenu ? ContextMenuSubContent : DropdownMenuSubContent;
  const Item = contextMenu ? ContextMenuItem : DropdownMenuItem;
  return <Sub open={open} onOpenChange={setOpen}>
    <Trigger><ManualStatusIcon status={status} /> Set status</Trigger>
    <Content className="w-48">
      {MANUAL_STATUSES.map((value) => <Item key={value} role="menuitemradio" aria-checked={value === status} disabled={pending} onSelect={(event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        void (onChange ? onChange(value) : api.setSessionStatus(sessionId, value)).then(() => setOpen(false), (cause) => setError(errorMessage(cause))).finally(() => setPending(false));
      }}>
        <ManualStatusIcon status={value} /> {manualStatusLabel(value)}{value === status && <Check className="ml-auto" />}
      </Item>)}
      {error && <p role="alert" className="max-w-48 whitespace-normal px-2 py-1 text-xs text-destructive">{error}</p>}
    </Content>
  </Sub>;
}
