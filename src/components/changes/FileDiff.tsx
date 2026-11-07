import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { MediaPreview } from "@/components/editor/MediaPane";
import { copyText } from "@/lib/clipboard";
import { diffFileKey, setFileWrap, useDiffOptions } from "@/lib/diffOptions";
import type { GitSource } from "@/lib/gitSource";
import mediaTypes from "@/lib/mediaTypes.json";
import { DiffPane } from "./DiffPane";

type Content = { data: string; mime: string };
type Pair = { kind: "text"; before: string; after: string; deleted: boolean; originalPath?: string } | { kind: "media"; before: Content | null; after: Content | null };
export function diffMediaKind(path: string): "image" | "pdf" | "svg" | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "svg" || ext === "pdf") return ext;
  return mediaTypes[ext as keyof typeof mediaTypes]?.kind === "image" ? "image" : null;
}

/** Owns the revision read so switching files/scopes never leaves stale content or copy actions. */
type FileDiffProps = { source: GitSource; path: string; oldPath?: string; base: string; head: string | null; revision?: number; recoverRename?: boolean; onText?: (pair: { before: string; after: string; deleted: boolean; originalPath?: string }) => void };
export function FileDiff(props: FileDiffProps) {
  return <FileDiffContent key={JSON.stringify([props.source.key, props.path, props.oldPath, props.base, props.head, props.revision])} {...props} />;
}

function FileDiffContent({ source, path, oldPath, base, head, onText, recoverRename }: FileDiffProps) {
  const fileKey = diffFileKey(source.key, path);
  const options = useDiffOptions(fileKey);
  const kind = diffMediaKind(path);
  const [raw, setRaw] = useState(false);
  const [pair, setPair] = useState<Pair | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
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
      const next = await source.fileContentsAt(path, base, head);
      const originalPath = oldPath ?? (recoverRename && next.before === null && next.after !== null
        ? (await source.changesBetween(base, head)).find((file) => file.path === path)?.oldPath : undefined);
      const before = originalPath ? (await source.fileContentsAt(originalPath, base, head)).before : next.before;
      if (before === null && next.after === null) throw new Error("This file is not present in either snapshot.");
      if (!cancelled) onText?.({ before: before ?? "", after: next.after ?? "", deleted: next.after === null, originalPath });
      if (before === "<file too large to show>" || next.after === "<file too large to show>") {
        throw new Error("This file exceeds the text preview limit. Open it in the workspace to read or copy its full contents.");
      }
      return { kind: "text", before: before ?? "", after: next.after ?? "", deleted: next.after === null, originalPath };
    };
    void read().then((next) => { if (!cancelled) setPair(next); }).catch((e) => { if (!cancelled) setError(source.errorMessage(e)); });
    return () => { cancelled = true; };
  }, [source, path, oldPath, base, head, kind, retry, onText, recoverRename]);

  const textView = pair?.kind === "text" && (kind !== "svg" || raw);
  return <div className="flex h-full min-h-0 min-w-0 flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-3 py-1 text-xs">
      <span className="min-w-0 flex-1 truncate" title={path}>{path}</span>
      {kind === "svg" && <Button size="xs" variant="secondary" onClick={() => setRaw(!raw)}>{raw ? "Rendered SVG" : "Raw SVG"}</Button>}
      {textView && <label className="flex items-center gap-1">Wrap lines
        <select aria-label="Wrap lines for this file" className="rounded bg-well p-1" value={options.override === undefined ? "default" : String(options.override)} onChange={(e) => setFileWrap(fileKey, e.target.value === "default" ? undefined : e.target.value === "true")}>
          <option value="default">Default ({options.defaultWrap ? "on" : "off"})</option><option value="true">On</option><option value="false">Off</option>
        </select>
      </label>}
      {pair?.kind === "text" && <Button size="xs" variant="ghost" onClick={() => {
        setCopyStatus(null);
        void copyText(pair.after).then(() => setCopyStatus("Copied file")).catch(() => setCopyStatus("Could not copy file. Try again."));
      }}>Copy file</Button>}
    </div>
    {copyStatus && <p role="status" className="px-3 py-1 text-xs">{copyStatus}</p>}
    {error ? <div role="alert" className="p-3 text-xs text-destructive">{error} <Button size="xs" variant="outline" onClick={() => setRetry((n) => n + 1)}>Retry</Button></div>
      : !pair ? <div role="status" className="p-3 text-xs">Loading file diff…</div>
      : pair.kind === "text" && (pair.before.includes("\0") || pair.after.includes("\0")) ? <p className="p-3 text-xs text-muted-foreground">Binary file changed.</p>
      : pair.kind === "text" && textView ? <div className="min-h-0 flex-1"><DiffPane path={path} before={pair.before} after={pair.after} base={base} originalPath={pair.originalPath} mode={options.mode} wrap={options.wrap} hideWhitespace={options.hideWhitespace} /></div>
      : <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-hairline">
        {(["before", "after"] as const).map((side) => <section key={side} aria-label={side === "before" ? "Before" : "After"} className="flex min-h-0 min-w-0 flex-col">
          <h4 className="shrink-0 border-b border-hairline px-2 py-1 text-xs text-muted-foreground">{side === "before" ? "Before" : "After"}</h4>
          {pair.kind === "media" ? pair[side] ? <MediaPreview data={pair[side].data} mime={pair[side].mime} name={`${side}: ${path}`} /> : <p className="p-3 text-xs text-faint">File does not exist in this revision.</p>
            : pair[side] ? <MediaPreview svg={pair[side]} mime="image/svg+xml" name={`${side}: ${path}`} /> : <p className="p-3 text-xs text-faint">File does not exist in this revision.</p>}
        </section>)}
      </div>}
  </div>;
}
