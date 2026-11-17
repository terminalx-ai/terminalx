import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { MediaPreview } from "@/components/editor/MediaPane";
import { FileTypeIcon } from "@/components/files/FileTypeIcon";
import { Check, Copy, FileText, FileX2 } from "@/icons";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { diffFileKey, useDiffOptions } from "@/lib/diffOptions";
import type { GitSource } from "@/lib/gitSource";
import mediaTypes from "@/lib/mediaTypes.json";
import { fileName } from "@/lib/paths";
import { DiffModeToggle, DiffViewOptionsMenu } from "./DiffOptions";
import { DiffPane } from "./DiffPane";
import { EmptyState } from "./EmptyState";

/** What a read returns in place of a file over the text preview limit. */
export const TOO_LARGE = "<file too large to show>";

/** "2.4 MB" */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The diff header's file: icon and path in a chip, the path cut from the start of its folders last. */
export function PathChip({ path, size }: { path: string; size?: number | null }) {
  return <>
    <span className="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md border border-hairline px-2 font-mono text-[12.5px]" title={path}>
      <FileTypeIcon name={fileName(path)} isDir={false} size={13} />
      <span className="min-w-0 truncate">{path}</span>
    </span>
    {size != null && <span className="shrink-0 font-mono text-xs text-faint">{formatSize(size)}</span>}
  </>;
}

export function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  if (!additions && !deletions) return null;
  return <span className="shrink-0 whitespace-nowrap font-mono text-xs tabular-nums" aria-label={`${additions} added, ${deletions} removed`}>
    {additions > 0 && <span className="text-add">+{additions}</span>}{additions > 0 && deletions > 0 && " "}
    {deletions > 0 && <span className="text-destructive">−{deletions}</span>}
  </span>;
}

/** A file over the preview limit (design 05.22): an expected state, not a failed read, so nothing here is red and nothing retries. */
export function TooLargeState({ path, size, onOpenFile }: { path: string; size?: number | null; onOpenFile?: () => void }) {
  return <EmptyState icon={<FileX2 />} title="No diff to show"
    actions={onOpenFile && <Button size="sm" onClick={onOpenFile}><FileText /> Open file</Button>}>
    <span className="font-mono">{path}</span> is {size != null ? `${formatSize(size)}, over the text preview limit` : "over the text preview limit (size unknown)"}, so the diff isn't drawn.{!onOpenFile && " Open it in the workspace to read or copy its full contents."}
  </EmptyState>;
}

type Content = { data: string; mime: string };
type Pair = { kind: "text"; before: string; after: string } | { kind: "media"; before: Content | null; after: Content | null } | { kind: "large"; size?: number | null };
export function diffMediaKind(path: string): "image" | "pdf" | "svg" | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "svg" || ext === "pdf") return ext;
  return mediaTypes[ext as keyof typeof mediaTypes]?.kind === "image" ? "image" : null;
}

/** Owns the revision read so switching files/scopes never leaves stale content or copy actions. */
type FileDiffProps = {
  source: GitSource; path: string; oldPath?: string; base: string; head: string | null; revision?: number; onDiscard?: () => void;
  /** False where the tab draws its own header (the centre diff tab). */
  chrome?: boolean;
  /** The file's +/− in this scope, for the header. */
  stats?: { additions: number; deletions: number };
  /** Opens the file itself: a file too large to diff offers it. */
  onOpenFile?: () => void;
  /** The file's size, when known, for a file too large to diff. */
  size?: number | null;
  staging?: { staged: boolean; disabled?: boolean; onHunk: (index: number) => void };
  /** A centre editor also needs this snapshot for Entire file and disk-change warnings. */
  text?: { before: string; after: string };
};
export function FileDiff(props: FileDiffProps) {
  return <FileDiffContent key={JSON.stringify([props.source.key, props.path, props.oldPath, props.base, props.head, props.revision, props.staging?.staged])} {...props} />;
}

function FileDiffContent({ source, path, oldPath, base, head, text, onDiscard, staging, chrome = true, stats, onOpenFile, size }: FileDiffProps) {
  const fileKey = diffFileKey(source.key, path);
  const options = useDiffOptions(fileKey);
  const kind = diffMediaKind(path);
  const [raw, setRaw] = useState(false);
  const [pair, setPair] = useState<Pair | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [hunks, setHunks] = useState(0);
  useEffect(() => {
    if (!staging || !source.hunkCount) { setHunks(0); return; }
    let cancelled = false;
    source.hunkCount(path, oldPath, staging.staged).then((count) => !cancelled && setHunks(count)).catch(() => !cancelled && setHunks(0));
    return () => { cancelled = true; };
  }, [source, path, oldPath, staging?.staged, head]);
  useEffect(() => {
    let cancelled = false;
    setPair(null);
    setError(null);
    const read = async (): Promise<Pair> => {
      if (kind && kind !== "svg") {
        if (!source.mediaContentAt) throw new Error("Media diffs are unavailable from this workspace. Update its runtime and reconnect.");
        const [before, after] = await Promise.all([source.mediaContentAt(oldPath ?? path, base), source.mediaContentAt(path, head)]);
        return { kind: "media", before, after };
      }
      const next: Awaited<ReturnType<GitSource["fileContentsAt"]>> = text ?? await source.fileContentsAt(path, base, head);
      const previous = !text && oldPath ? await source.fileContentsAt(oldPath, base, head) : next;
      const before = previous.before;
      if (before === TOO_LARGE || next.after === TOO_LARGE) return { kind: "large", size: next.after === TOO_LARGE ? next.afterSize : previous.beforeSize };
      return { kind: "text", before: before ?? "", after: next.after ?? "" };
    };
    void read().then((next) => { if (!cancelled) setPair(next); }).catch((e) => { if (!cancelled) setError(source.errorMessage(e)); });
    return () => { cancelled = true; };
  }, [source, path, oldPath, base, head, kind, retry, text]);

  const textView = pair?.kind === "text" && (kind !== "svg" || raw);
  const [copied, setCopied] = useState(false);
  const copy = pair?.kind === "text" ? () => {
    setCopyStatus(null);
    void copyText(pair.after).then(() => { setCopyStatus("Copied file"); setCopied(true); window.setTimeout(() => setCopied(false), 1500); })
      .catch(() => setCopyStatus("Could not copy file. Try again."));
  } : undefined;
  return <div className="flex h-full min-h-0 min-w-0 flex-col">
    {chrome && <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-hairline px-3 text-xs scrollbar-none">
      <PathChip path={path} size={pair?.kind === "large" ? pair.size ?? size : undefined} />
      {stats && <DiffStats {...stats} />}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {staging && source.applyHunk && Array.from({ length: hunks }, (_, index) => <Button key={index} size="xs" variant="ghost" disabled={staging.disabled} onClick={() => staging.onHunk(index)}>{staging.staged ? "Unstage" : "Stage"} hunk {index + 1}</Button>)}
        {kind === "svg" && pair?.kind === "text" && <Button size="xs" variant="secondary" onClick={() => setRaw(!raw)}>{raw ? "Rendered SVG" : "Raw SVG"}</Button>}
        {copy && <Button size="icon-xs" variant="ghost" aria-label="Copy file contents" title="Copy file contents" onClick={copy}>{copied ? <Check /> : <Copy />}</Button>}
        {textView && <DiffModeToggle />}
        <DiffViewOptionsMenu fileKey={fileKey} onCopy={copy} onDiscard={onDiscard} discardLabel={`Discard changes to ${path}`} />
      </div>
    </div>}
    {!chrome && kind === "svg" && pair?.kind === "text" && <div className="flex shrink-0 justify-end px-3 py-1"><Button size="xs" variant="secondary" onClick={() => setRaw(!raw)}>{raw ? "Rendered SVG" : "Raw SVG"}</Button></div>}
    {copyStatus && <p role="status" className={cn("px-3 py-1 text-xs", copyStatus === "Copied file" ? "sr-only" : "text-muted-foreground")}>{copyStatus}</p>}
    {error ? <div role="alert" className="p-3 text-xs text-destructive">{error} <Button size="xs" variant="outline" onClick={() => setRetry((n) => n + 1)}>Retry</Button></div>
      : !pair ? <div role="status" className="p-3 text-xs">Loading file diff…</div>
      : pair.kind === "large" ? <TooLargeState path={path} size={pair.size ?? size} onOpenFile={onOpenFile} />
      : pair.kind === "text" && (pair.before.includes("\0") || pair.after.includes("\0")) ? <p className="p-3 text-xs text-muted-foreground">Binary file changed.</p>
      : pair.kind === "text" && textView ? <div className="min-h-0 flex-1"><DiffPane workspace={source.key} path={path} before={pair.before} after={pair.after} base={base} originalPath={oldPath} mode={options.mode} wrap={options.wrap} hideWhitespace={options.hideWhitespace} /></div>
      : <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-hairline">
        {(["before", "after"] as const).map((side) => <section key={side} aria-label={side === "before" ? "Before" : "After"} className="flex min-h-0 min-w-0 flex-col">
          <h4 className="shrink-0 border-b border-hairline px-2 py-1 text-xs text-muted-foreground">{side === "before" ? "Before" : "After"}</h4>
          {pair.kind === "media" ? pair[side] ? <MediaPreview data={pair[side].data} mime={pair[side].mime} name={`${side}: ${path}`} /> : <p className="p-3 text-xs text-faint">File does not exist in this revision.</p>
            : pair.kind === "text" && pair[side] ? <MediaPreview svg={pair[side]} mime="image/svg+xml" name={`${side}: ${path}`} /> : <p className="p-3 text-xs text-faint">File does not exist in this revision.</p>}
        </section>)}
      </div>}
  </div>;
}
