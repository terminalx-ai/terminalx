// PRO-140 (11.10): every settings file a repository resolves, highest first. PRO-387: a project's own Settings files
// page, where a file's contents open read-only beneath its row.
import { useEffect, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { AlertCircle, ChevronRight, FolderGit2, Lock, RotateCcw, UserRound, UserRoundPen } from "@/icons";
import { Button } from "@/components/ui/button";
import { fs } from "@/lib/api";
import { cn } from "@/lib/cn";
import { configuration } from "@/lib/configuration";
import { fileChips, LAYER_TITLES } from "@/lib/settingSources";
import type { ConfigurationLayer } from "@/types/configuration";
import type { SettingsFileLayer } from "@/types/settingsSources";
import { openSettingsPath, ProblemSentence, shortFileName } from "./SettingSources";

export const LAYER_ICONS: Record<ConfigurationLayer, typeof Lock> = {
  managed: Lock,
  repositoryLocal: UserRoundPen,
  repositoryShared: FolderGit2,
  user: UserRound,
  defaults: RotateCcw,
};

/** The settings files a project (or, with null, the user alone) resolves, read again whenever one changes on disk. */
export function useSettingsFiles(projectPath: string | null): { files: SettingsFileLayer[] | null; error: string | null } {
  const [files, setFiles] = useState<SettingsFileLayer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request = 0;
    setFiles(null);
    setError(null);
    const reload = () => {
      const current = ++request;
      return configuration.files(projectPath).then(
        (next) => { if (live && current === request) { setFiles(next); setError(null); } },
        (cause: unknown) => { if (live && current === request) setError(cause instanceof Error ? cause.message : String(cause)); },
      );
    };
    const changed = () => { if (!live) return; clearTimeout(timer); timer = setTimeout(() => void reload(), 150); };
    let stopUser: (() => void) | undefined;
    let stopProject: (() => void) | undefined;
    void Promise.resolve().then(() => listen("settings_file_changed", changed)).then((unlisten) => { if (live) stopUser = unlisten; else unlisten(); }, () => {});
    void Promise.resolve().then(() => configuration.watch(projectPath, changed)).then((unwatch) => { if (live) stopProject = unwatch; else unwatch(); }, () => {});
    void reload();
    return () => { live = false; clearTimeout(timer); stopUser?.(); stopProject?.(); };
  }, [projectPath]);
  return { files, error };
}

/** A project's Settings files page (design 11.10): the page title and its description come from Settings. */
export function ProjectSettingsFiles({ projectPath }: { projectPath: string }) {
  const { files, error } = useSettingsFiles(projectPath);
  return <SettingsFiles files={files} error={error} heading={false} expandable />;
}

export function SettingsFiles({ files, error, heading = true, expandable = false }: {
  files: readonly SettingsFileLayer[] | null;
  error: string | null;
  /** The section's own title and description; a page that is only this list has them as its title instead. */
  heading?: boolean;
  /** An existing file's row opens its contents, read-only, beneath it. */
  expandable?: boolean;
}) {
  return <section aria-labelledby={heading ? "settings-files-title" : undefined} aria-label={heading ? undefined : "Settings files"} className="flex flex-col gap-2">
    {heading && <div>
      <h4 id="settings-files-title" className="text-[13px] font-medium">Settings files</h4>
      <p className="text-xs text-muted-foreground">Where these values come from, highest first. Edits made in an editor show up here within a second.</p>
    </div>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {files && <ol className="flex flex-col gap-2">
      {files.map((file, index) => <SettingsFileRow key={`${file.layer}:${file.path ?? ""}`} file={file} index={index} expandable={expandable && file.exists && !!file.path} />)}
    </ol>}
  </section>;
}

function SettingsFileRow({ file, index, expandable }: { file: SettingsFileLayer; index: number; expandable: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = LAYER_ICONS[file.layer];
  const chips = fileChips(file);
  const summary = <>
    <span className="w-3 shrink-0 text-xs text-faint tabular-nums">{index + 1}</span>
    <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    <span className="shrink-0 text-[13px] font-medium">{LAYER_TITLES[file.layer]}</span>
    {file.displayPath
      ? <span className="min-w-0 truncate font-mono text-xs text-faint" title={file.displayPath}>{file.displayPath}</span>
      : <span className="min-w-0 truncate text-xs text-faint">built into TerminalX</span>}
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {chips.map((chip) => <span key={chip} className={cn("whitespace-nowrap rounded px-1.5 py-0.5 text-xs", chipTone(file, chip))}>{chip}</span>)}
      {expandable && <ChevronRight aria-hidden className={cn("size-3.5 text-faint transition-transform", open && "rotate-90")} />}
    </span>
  </>;
  return <li data-settings-file={file.layer} className="flex flex-col gap-2 rounded-lg px-3 py-2.5 hairline">
    {expandable
      ? <button type="button" aria-expanded={open} aria-label={`${LAYER_TITLES[file.layer]}, ${file.displayPath}`} onClick={() => setOpen((value) => !value)}
          className="-mx-3 -my-2.5 flex min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40">{summary}</button>
      : <div className="flex min-w-0 items-center gap-3">{summary}</div>}
    {file.problem && file.displayPath && <div role="alert" className="flex items-start gap-2.5 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs">
      <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <p className="min-w-0 flex-1 break-words leading-relaxed"><ProblemSentence file={file.displayPath} problem={file.problem} /></p>
      {file.path && <Button size="sm" variant="outline" className="shrink-0" onClick={() => void openSettingsPath(file.path!, file.displayPath!)}>Open file</Button>}
    </div>}
    {open && file.path && <SettingsFileView file={file} />}
  </li>;
}

const chipTone = (file: SettingsFileLayer, chip: string) =>
  file.layer === "repositoryShared" && /key/.test(chip) ? "bg-info/10 text-info" : "bg-veil-strong text-muted-foreground";

const GIT_STATE: Record<NonNullable<SettingsFileLayer["git"]>, string> = { committed: "committed", ignored: "ignored by git", untracked: "not committed" };

/** A file's contents, read-only, line-numbered and coloured as JSON, under its name and Git state. */
function SettingsFileView({ file }: { file: SettingsFileLayer }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    fs.readText(file.path!).then(
      (read) => { if (live) setText(read.binary ? null : read.content); if (live && read.binary) setError("This file isn’t text."); },
      (cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); },
    );
    return () => { live = false; };
    // Each list reload supplies a fresh snapshot, even for value-only edits.
  }, [file]);
  const meta = [file.git && GIT_STATE[file.git], `${file.keys} ${file.keys === 1 ? "key" : "keys"}`].filter(Boolean).join(" · ");
  const rows = text?.replace(/\n$/, "").split("\n") ?? [];
  return <div aria-label={`Contents of ${file.displayPath}`} className="overflow-hidden rounded-lg bg-raised hairline">
    <div className="flex h-8 items-center gap-2 border-b border-hairline px-3 text-[11.5px] text-muted-foreground">
      <span className="truncate font-mono">{shortFileName(file.displayPath ?? file.path!)}</span>
      <span className="ml-auto shrink-0 text-faint">{meta}</span>
    </div>
    {error ? <p role="alert" className="px-3 py-2 text-xs text-destructive">{error}</p>
      : text === null ? <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Reading…</p>
      : <pre className="max-h-96 overflow-auto py-2 font-mono text-[12px] leading-[19px] scrollbar-thin">
          {rows.map((line, index) => <div key={index} className="flex">
            <span aria-hidden className="w-9 shrink-0 select-none pr-3 text-right text-faint">{index + 1}</span>
            <code className="whitespace-pre pr-3">{highlightJson(line)}</code>
          </div>)}
        </pre>}
  </div>;
}

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|[{}[\]]/g;

/** One line of JSON as spans: keys in info, strings in add, literals and brackets in merged. */
export function highlightJson(line: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of line.matchAll(JSON_TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(line.slice(last, at));
    const tone = match[1] ? (match[2] ? "text-info" : "text-add") : "text-merged";
    parts.push(<span key={at} className={tone}>{match[1] ?? match[0]}</span>);
    if (match[2]) parts.push(match[2]);
    last = at + match[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}
