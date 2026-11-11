import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import { Copy, Cpu, MessageSquareWarning, RotateCw, ScrollText } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { errorMessage, localRuntime, type LocalRuntimeStartFailed } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { shortPath } from "@/lib/paths";
import { REPO_URL } from "@/lib/repo";

/** How long a failed start ran: "0.4 s", "12.0 s", "2 min 5 s". */
export function ranFor(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** How the runtime ended, as the details block's first line says it. */
export function endedLine(failed: LocalRuntimeStartFailed): string {
  const ran = ranFor(failed.ranMs);
  if (failed.code !== null) return `${failed.process} exited with code ${failed.code} after ${ran}`;
  if (failed.signal !== null) return `${failed.process} was ended by signal ${failed.signal} after ${ran}`;
  return `${failed.process} could not be started`;
}

/** When, which app and which OS: "09:41:12 · TerminalX 0.2.30 · macOS 26.1 (25B78)". */
export function contextLine(failed: LocalRuntimeStartFailed): string {
  const time = new Date(failed.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  return [time, `TerminalX ${failed.app}`, failed.os].filter(Boolean).join(" · ");
}

/**
 * Where Report… goes: a new issue on the app's public repository, with the
 * version and what failed filled in. The log is not attached: the reader
 * pastes it, having seen what it holds (Copy logs).
 */
export function reportUrl(failed: LocalRuntimeStartFailed): string {
  const body = [
    "TerminalX couldn't start its agent runtime.",
    "",
    "```",
    endedLine(failed),
    ...(failed.error ? [failed.error] : []),
    `${new Date(failed.at).toISOString()} · TerminalX ${failed.app}${failed.os ? ` · ${failed.os}` : ""}`,
    "```",
    "",
    "**What I was doing**",
    "",
    "",
    "**Logs**",
    "",
    "<!-- Copy logs in the dialog puts the runtime's log on the clipboard: paste it here. Logs can include file paths and branch names. -->",
  ].join("\n");
  const query = new URLSearchParams({ title: `Agent runtime failed to start (TerminalX ${failed.app})`, body });
  return `${REPO_URL}/issues/new?${query.toString()}`;
}

/**
 * The runtime that runs the agents exited, or could not be started, before
 * this app could attach to it (PRO-287). No session can run without it, so
 * this holds the window: what failed, and the ways on. The desktop goes on
 * trying by itself, slowly; once a runtime attaches this goes away.
 */
export function RuntimeStartFailedDialog({ failed }: { failed: LocalRuntimeStartFailed }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<"restart" | "quit" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const act = async (what: () => Promise<unknown>) => {
    setProblem(null);
    try { await what(); } catch (error) { setProblem(errorMessage(error)); }
  };
  const copyLogs = () => act(async () => {
    setCopied(false);
    await copyText(await localRuntime.log());
    setCopied(true);
  });
  const leave = (how: "restart" | "quit") => act(async () => {
    setBusy(how);
    try { await (how === "restart" ? relaunch() : exit(0)); } finally { setBusy(null); }
  });
  return (
    <Dialog open>
      <DialogContent
        width="max-w-[600px]"
        showClose={false}
        className="p-6"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <div className="flex gap-3.5">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-destructive/15 text-destructive [&_svg]:size-[19px]" aria-hidden><Cpu /></span>
          <div className="min-w-0">
            <DialogTitle className="text-[17px] font-semibold">TerminalX couldn't start its agent runtime</DialogTitle>
            <DialogDescription className="mt-1 text-[13px] leading-5 text-muted-foreground">
              The process that runs Claude Code and Codex in their terminals stopped while starting, so no session can run. Your sessions, worktrees and drafts are safe on disk.
            </DialogDescription>
          </div>
        </div>
        <div aria-label="What failed" role="group" className="mt-4 rounded-md border border-border bg-well px-3 py-2.5 font-mono text-[11.5px] leading-[18px] select-text">
          <div className="text-destructive">{endedLine(failed)}</div>
          {failed.error && <div className="truncate text-foreground/80" title={failed.error}>{failed.error}</div>}
          <div className="text-faint">{contextLine(failed)}</div>
        </div>
        <p className="mt-3 text-[12.5px] text-muted-foreground">Restarting fixes this most of the time. If it comes back, send a report with the logs so we can look.</p>
        {problem && <p role="alert" className="mt-2 text-[12.5px] text-destructive">{problem}</p>}
        <div className="mt-5 flex items-center gap-2">
          <Button variant="ghost" className="shrink-0 whitespace-nowrap text-[12.5px]" disabled={busy !== null} onClick={() => void leave("quit")}>Quit</Button>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" className="shrink-0 whitespace-nowrap text-[12.5px] text-muted-foreground [&_svg]:size-3.5" onClick={() => void copyLogs()}>
              <Copy />{copied ? "Copied" : "Copy logs"}
            </Button>
            <Button variant="outline" className="shrink-0 whitespace-nowrap text-[12.5px] text-muted-foreground [&_svg]:size-3.5" onClick={() => void act(() => openUrl(reportUrl(failed)))}>
              <MessageSquareWarning />Report…
            </Button>
            <Button className="shrink-0 whitespace-nowrap text-[12.5px] font-medium [&_svg]:size-3.5" disabled={busy !== null} onClick={() => void leave("restart")}>
              <RotateCw />{busy === "restart" ? "Restarting…" : "Restart TerminalX"}
            </Button>
          </div>
        </div>
        {failed.log && (
          <div className="mt-5 flex items-center gap-1.5 border-t border-hairline pt-3 text-[11.5px] text-faint">
            <ScrollText className="size-3 shrink-0" aria-hidden />
            <span className="truncate font-mono" title={failed.log}>{shortPath(failed.log)}</span>
            <span className="shrink-0">· logs can include file paths and branch names</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
