import { useState, type KeyboardEvent } from "react";
import { Check, CheckCircle2, CircleDashed, CircleDot, CircleX, Contrast } from "@/icons";
import { MANUAL_STATUSES, manualStatusLabel, normalizeManualStatus, type ManualStatus } from "@terminalx/portable/manualStatus";
import { api, errorMessage } from "@/lib/api";
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, MenuKbd, useCloseMenu } from "@/components/ui/menu";

// As 02.13 draws them: In progress a half-filled amber circle, In review a blue circle with a dot, Canceled a circled x.
const ICONS = { backlog: CircleDashed, in_progress: Contrast, in_review: CircleDot, done: CheckCircle2, canceled: CircleX };

export function ManualStatusIcon({ status }: { status?: unknown }) {
  const known = normalizeManualStatus(status);
  const Icon = ICONS[known];
  return <Icon className="size-3.5 shrink-0" style={{ color: `var(--status-${known.replaceAll("_", "-")})` }} aria-hidden />;
}

export function ManualStatusMenu({ sessionId, status = "backlog", contextMenu = false, onChange }: { sessionId: string; status?: ManualStatus; contextMenu?: boolean; onChange?: (status: ManualStatus) => Promise<void> }) {
  const closeRoot = useCloseMenu();
  const current = normalizeManualStatus(status);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Sub = contextMenu ? ContextMenuSub : DropdownMenuSub;
  const Trigger = contextMenu ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
  const Content = contextMenu ? ContextMenuSubContent : DropdownMenuSubContent;
  const Item = contextMenu ? ContextMenuItem : DropdownMenuItem;
  const Separator = contextMenu ? ContextMenuSeparator : DropdownMenuSeparator;
  const choose = (value: ManualStatus) => {
    if (pending) return;
    setPending(true);
    setError(null);
    void (onChange ? onChange(value) : api.setSessionStatus(sessionId, value)).then(() => { setOpen(false); closeRoot?.(); }, (cause) => setError(errorMessage(cause))).finally(() => setPending(false));
  };
  // 1–5 pick a status while the submenu is open, in the order it lists them.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const value = MANUAL_STATUSES[Number(event.key) - 1];
    if (!/^[1-9]$/.test(event.key) || !value) return;
    event.preventDefault();
    event.stopPropagation();
    choose(value);
  };
  return <Sub open={open} onOpenChange={setOpen}>
    <Trigger><ManualStatusIcon status={status} /> Set status</Trigger>
    <Content className="w-56" onKeyDown={onKeyDown}>
      {MANUAL_STATUSES.map((value, index) => <Item key={value} role="menuitemradio" aria-checked={value === current} aria-keyshortcuts={String(index + 1)} disabled={pending} onSelect={(event) => {
        event.preventDefault();
        choose(value);
      }}>
        <ManualStatusIcon status={value} /> <span className="flex-1">{manualStatusLabel(value)}</span>{value === current && <Check className="text-foreground!" />}<MenuKbd keys={String(index + 1)} />
      </Item>)}
      {error && <p role="alert" className="max-w-52 whitespace-normal px-2 py-1 text-xs text-destructive">{error}</p>}
      <Separator />
      <p className="whitespace-normal px-2 pb-1 text-[11px] leading-4 text-faint">Your own status. The agent and PR state still show on the row.</p>
    </Content>
  </Sub>;
}
