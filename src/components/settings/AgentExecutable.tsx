// PRO-157: which program an agent runs as, and the agent's own settings file.
// Settings → Agents shows both on each agent's tab (screens 10.01, 10.02,
// 10.14); Advanced shows the executables again (09.29). One stored value,
// `agents.executables` in settings.json, backs every row.
import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, Code, Copy, ExternalLink, Folder, FolderOpen, Loader2, MousePointer2, RotateCcw, Zap } from "@/icons";
import { Button } from "@/components/ui/button";
import { SETTING_ROW_CLASS } from "@/components/ui/controls";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/menu";
import { agentConfigFiles, agentExecutables, errorMessage, type AgentConfigFile, type AgentExecutable } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { showError } from "@/lib/errorToasts";

/** `~/…` for a path in the home folder. */
export function shortPath(path: string | null | undefined): string | undefined {
  const home = path?.match(/^\/Users\/[^/]+|^\/home\/[^/]+/)?.[0];
  return home && path ? `~${path.slice(home.length)}` : path ?? undefined;
}

/** The folder a file is in, for the file chooser to open at. */
function folderOf(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : undefined;
}

/** One agent's executable, read and changed through the Rust side. */
export function useAgentExecutable(harness: string, onChanged?: () => void) {
  const [value, setValue] = useState<AgentExecutable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    agentExecutables.get(harness).then((found) => live && setValue(found)).catch((e) => live && setError(errorMessage(e)));
    return () => { live = false; };
  }, [harness]);
  const change = useCallback(async (work: () => Promise<AgentExecutable>) => {
    setBusy(true);
    setError(null);
    try {
      setValue(await work());
      onChanged?.();
      return true;
    } catch (e) {
      // The Rust side kept the earlier choice; so does the row.
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, [onChanged]);
  return {
    value, error, busy,
    choose: (path: string) => change(() => agentExecutables.set(harness, path)),
    reset: () => change(() => agentExecutables.reset(harness)),
  };
}

/**
 * The path field with Browse… inside it and Reset beside it (10.01), and under it what new tabs run and its version,
 * or why the chosen program was refused. `resetLabel` is Advanced's "Use system Claude Code" (09.29).
 */
export function AgentExecutableRow({ harness, agentName, title = "Executable", resetLabel = "Reset", description, onChanged, last }: {
  harness: string;
  agentName: string;
  title?: string;
  resetLabel?: string;
  description?: string;
  onChanged?: () => void;
  last?: boolean;
}) {
  const { value, error, busy, choose, reset } = useAgentExecutable(harness, onChanged);
  const shown = shortPath(value?.chosen) ?? "";
  const [draft, setDraft] = useState(shown);
  useEffect(() => { setDraft(shown); }, [shown]);
  const commit = async (next: string) => {
    const text = next.trim();
    if (text === shown || text === value?.chosen) { setDraft(shown); return; }
    if (!text) { if (value?.chosen) await reset(); return; }
    if (!(await choose(text))) setDraft(shown);
  };
  const browse = async () => {
    const picked = await openDialog({ multiple: false, directory: false, title: `Choose the ${agentName} program`, defaultPath: folderOf(value?.path ?? value?.system) });
    if (typeof picked === "string") { setDraft(shortPath(picked) ?? picked); await commit(picked); }
  };
  const label = `${agentName} executable`;
  return <div className={cn(SETTING_ROW_CLASS, last && "border-b-0")} data-testid={`agent-executable-${harness}`}>
    <div className="min-w-0">
      <div className="text-[13px] font-medium">{title}</div>
      <div className="mt-0.5 text-[12.5px] leading-[18px] text-muted-foreground">
        {description ?? "Leave empty to use the version TerminalX finds on your PATH. TerminalX checks it with --version."}
      </div>
    </div>
    <div className="flex gap-2">
      <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-hairline bg-card px-2.5 focus-within:ring-2 focus-within:ring-ring/40">
        <input aria-label={label} value={draft} spellCheck={false} autoComplete="off" disabled={!value || busy}
          placeholder={shortPath(value?.system) ?? `${agentName} isn’t on your PATH`}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit(draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); void commit(draft); }
            if (event.key === "Escape") { event.preventDefault(); setDraft(shown); }
          }}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-faint disabled:opacity-60" />
        {busy
          ? <Loader2 aria-label="Checking with --version" className="size-[13px] shrink-0 animate-spin text-faint" />
          : <button type="button" aria-label="Browse…" title="Browse…" disabled={!value} onClick={() => void browse()}
            className="shrink-0 text-faint outline-none hover:text-foreground focus-visible:text-foreground disabled:opacity-60">
            <FolderOpen aria-hidden className="size-[13px]" />
          </button>}
      </div>
      <Button size="sm" variant="outline" className="shrink-0 whitespace-nowrap" disabled={busy || !value?.chosen} onClick={() => void reset()}>
        <RotateCcw /> {resetLabel}
      </Button>
    </div>
    <ExecutableNote value={value} error={error} />
  </div>;
}

/** What new tabs run, or why a choice was refused; nothing while it loads. */
function ExecutableNote({ value, error }: { value: AgentExecutable | null; error: string | null }) {
  if (error) return <p role="alert" className="text-[12px] text-destructive">{error}</p>;
  if (!value) return null;
  if (value.problem) return <p role="alert" className="text-[12px] text-warning">{value.problem}</p>;
  if (!value.path) return <p className="text-[12px] text-faint">Not found on your PATH. Choose the program with Browse…, or install the agent.</p>;
  const where = value.chosen ? "Chosen" : "From your PATH";
  return <p className="text-[12px] text-faint" data-testid="executable-note">
    {where} · <span className="font-mono text-[12px]">{shortPath(value.path)}</span>{value.version ? <> · {value.version}</> : " · didn’t report a version"}
  </p>;
}

/** Open in, as the settings file button has it (11.10): Finder and the three editors. */
const OPEN_IN = [
  { label: "Finder", icon: Folder, tone: "text-info", editor: null },
  { label: "Cursor", icon: MousePointer2, tone: "text-foreground", editor: "cursor" },
  { label: "VS Code", icon: Code, tone: "text-info", editor: "vscode" },
  { label: "Zed", icon: Zap, tone: "text-accent", editor: "zed" },
] as const;

/** "Claude settings file ~/.claude/settings.json · Open in" (10.01), "Codex config" (10.02), "Config" (10.14). */
export function AgentConfigFileRow({ harness, title, last }: { harness: string; title: string; last?: boolean }) {
  const [file, setFile] = useState<AgentConfigFile | null>(null);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    let live = true;
    agentConfigFiles.get(harness).then((found) => live && setFile(found)).catch(() => live && setFile(null));
    return () => { live = false; };
  }, [harness]);
  if (!file) return null;
  const open = (editor: "cursor" | "vscode" | "zed" | null, label?: string) => void agentConfigFiles.open(harness, editor)
    .then(() => agentConfigFiles.get(harness).then(setFile), (e: unknown) => showError(label ? `Couldn’t open ${file.displayPath} in ${label}` : `Couldn’t open ${file.displayPath}`, e));
  const reveal = () => void agentConfigFiles.reveal(harness).catch((e: unknown) => showError(`Couldn’t show ${file.displayPath} in Finder`, e));
  return <div className={cn(SETTING_ROW_CLASS, last && "border-b-0")} data-testid={`agent-config-${harness}`}>
    <div className="flex items-center gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        <div className="mt-0.5 text-[12.5px] leading-[18px] text-muted-foreground">
          <span className="font-mono text-[12px]">{file.displayPath}</span>{!file.exists && <span className="text-faint"> · not made yet; opening it makes an empty one</span>}
        </div>
      </div>
      <DropdownMenu open={menu} onOpenChange={setMenu}>
        <DropdownMenuTrigger asChild>
          <Button size="xs" variant="outline" className="shrink-0 gap-1.5 whitespace-nowrap text-[12px]" aria-label={`Open ${file.displayPath} in`}>
            <ExternalLink aria-hidden /> Open in <ChevronDown aria-hidden className="opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[15rem]">
          <DropdownMenuItem onSelect={() => open(null)}><ExternalLink />Open in its default app</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Open in</DropdownMenuLabel>
          {OPEN_IN.map((app) => {
            const Icon = app.icon;
            return <DropdownMenuItem key={app.label} onSelect={() => app.editor ? open(app.editor, app.label) : reveal()}>
              <span aria-hidden className="grid size-[18px] shrink-0 place-items-center rounded-[4px] bg-veil-strong"><Icon className={cn("size-[11px]!", app.tone)} /></span>
              {app.label}
            </DropdownMenuItem>;
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void copyText(file.path).catch((e: unknown) => showError("Couldn’t copy the path", e))}><Copy />Copy path</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>;
}
