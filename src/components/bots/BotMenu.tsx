import { useEffect, useState } from "react";
import { Cpu, Ellipsis, Loader2, Pencil, Trash2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { errorMessage } from "@/lib/api";
import { deleteBot, updateBot } from "@/lib/bots";
import { useModels } from "@/lib/models";
import { useSessionStore } from "@/lib/sessions";
import type { Bot } from "@/types/bots";

type Open = "agent" | "rename" | "delete" | null;

/**
 * The bot header's menu (PRO-478): its agent and model, a rename and a delete. `onDeleted` is told once the bot is
 * gone, so the view showing it can leave.
 */
export function BotMenu({ bot, onDeleted }: { bot: Bot; onDeleted: () => void }) {
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`More for ${bot.name}`} data-testid="bot-menu">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setOpen("agent")} data-testid="bot-menu-agent"><Cpu /> Agent and model…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setOpen("rename")} data-testid="bot-menu-rename"><Pencil /> Rename…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => setOpen("delete")} data-testid="bot-menu-delete"><Trash2 /> Delete…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {open === "agent" && <AgentDialog bot={bot} onClose={close} />}
      {open === "rename" && <RenameDialog bot={bot} onClose={close} />}
      {open === "delete" && <DeleteDialog bot={bot} onClose={close} onDeleted={onDeleted} />}
    </>
  );
}

function useSave(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    action().then(onDone, (cause) => {
      setError(errorMessage(cause));
      setBusy(false);
    });
  };
  return { busy, error, run };
}

function SmallDialog({ title, note, children, onClose, busy }: { title: string; note: string; children: React.ReactNode; onClose: () => void; busy: boolean }) {
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent width="max-w-[26rem]" className="p-4">
        <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
        <DialogDescription className="mt-1 text-xs leading-[18px] text-muted-foreground">{note}</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}

const FIELD = "h-8 w-full min-w-0 rounded-md border border-hairline bg-transparent px-2 text-[13px] outline-none focus:border-ring disabled:opacity-60";

function AgentDialog({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const harnesses = useSessionStore().harnesses;
  const [harness, setHarness] = useState(bot.harness);
  const [model, setModel] = useState(bot.model);
  const models = useModels(harness);
  const { busy, error, run } = useSave(onClose);
  // A model belongs to the agent it was chosen for: another agent starts on its own default.
  useEffect(() => { if (harness !== bot.harness) setModel(""); }, [harness, bot.harness]);
  // The agent it has is offered even when this app does not list it (a newer app's), shown as it is.
  const agents = harnesses.some((value) => value.id === bot.harness) ? harnesses : [{ id: bot.harness, name: bot.harness, available: false }, ...harnesses];
  const modelKnown = !model || models.some((value) => value.id === model);
  const save = () => run(() => updateBot(bot.id, harness === bot.harness ? { model } : { harness, model }));
  return (
    <SmallDialog title={`${bot.name}'s agent and model`} note="Its next conversation starts on these. One already running keeps the agent it has." onClose={onClose} busy={busy}>
      <form className="mt-3 flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (!busy) save(); }}>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">Agent
          <select value={harness} disabled={busy} onChange={(event) => setHarness(event.target.value)} className={FIELD} data-testid="bot-agent-harness">
            {agents.map((value) => <option key={value.id} value={value.id}>{value.name}{value.available ? "" : " (not installed)"}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">Model
          <select value={model} disabled={busy} onChange={(event) => setModel(event.target.value)} className={FIELD} data-testid="bot-agent-model">
            <option value="">The agent's default model</option>
            {!modelKnown && <option value={model}>{model}</option>}
            {models.map((value) => <option key={value.id} value={value.id}>{value.label}</option>)}
          </select>
        </label>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={busy} data-testid="bot-agent-save">{busy && <Loader2 className="animate-spin" />} Save</Button>
        </div>
      </form>
    </SmallDialog>
  );
}

function RenameDialog({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const [name, setName] = useState(bot.name);
  const { busy, error, run } = useSave(onClose);
  const save = () => run(() => updateBot(bot.id, { name }));
  return (
    <SmallDialog title={`Rename ${bot.name}`} note="Its slug follows the name. Anything that keeps the bot keeps its id, which never changes." onClose={onClose} busy={busy}>
      <form className="mt-3 flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (!busy && name.trim()) save(); }}>
        <input autoFocus spellCheck={false} maxLength={80} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} aria-label="Name" className={FIELD} data-testid="bot-rename-input" />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={busy || !name.trim()} data-testid="bot-rename-save">{busy && <Loader2 className="animate-spin" />} Rename</Button>
        </div>
      </form>
    </SmallDialog>
  );
}

function DeleteDialog({ bot, onClose, onDeleted }: { bot: Bot; onClose: () => void; onDeleted: () => void }) {
  const { busy, error, run } = useSave(() => { onClose(); onDeleted(); });
  return (
    <ConfirmDialog
      open
      title={`Delete ${bot.name}?`}
      action="Delete"
      destructive
      busy={busy}
      error={error}
      onAction={() => run(() => deleteBot(bot.id))}
      onCancel={onClose}
    >
      {`Its home folder, with its role and memory, goes to TerminalX's trash. Its chats stay as ordinary chats. Bots that report to ${bot.name} report to you.`}
    </ConfirmDialog>
  );
}
