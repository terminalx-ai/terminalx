import { useEffect, useRef, useState } from "react";
import { FolderOpen, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { fs, type MediaFile } from "@/lib/api";
import type { EditorEntry } from "@/lib/editors";

/** A media tab never mounts CodeMirror or registers a saveable buffer. */
export function MediaPane({ entry, visible }: { entry: EditorEntry; visible: boolean }) {
  const pane = useRef<HTMLDivElement>(null);
  const [media, setMedia] = useState<MediaFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [changed, setChanged] = useState(false);
  const abs = `${entry.root}/${entry.rel}`;

  // Match the text editor: opening a file moves keyboard close/save handling into the file pane.
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => pane.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  useEffect(() => {
    let cancelled = false;
    let token: string | undefined;
    setMedia(null);
    setError(null);
    setChanged(false);
    void fs.openMedia(entry.root, entry.rel).then((file) => {
      token = file.token;
      if (cancelled) void fs.closeMedia(token).catch(() => {});
      else setMedia(file);
    }).catch((e) => { if (!cancelled) setError(String(e)); });
    return () => {
      cancelled = true;
      if (token) void fs.closeMedia(token).catch(() => {});
    };
  }, [entry.root, entry.rel, revision]);

  useEffect(() => {
    if (!visible || !media) return;
    let cancelled = false;
    const check = async () => {
      const mtime = await fs.mtime(abs).catch(() => null);
      if (cancelled) return;
      if (mtime == null) setError("This file is missing or can no longer be read.");
      else if (mtime !== media.mtimeMs) setChanged(true);
    };
    void check();
    const timer = window.setInterval(() => void check(), 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [abs, visible, media]);

  const reload = () => { setMedia(null); setRevision((n) => n + 1); };
  const reveal = () => {
    setActionError(null);
    void revealItemInDir(abs).catch((e) => setActionError(`Could not reveal ${entry.name}: ${String(e)}`));
  };
  const openExternal = () => {
    setActionError(null);
    void fs.openPath(abs).catch((e) => setActionError(`Could not open ${entry.name} with the default application: ${String(e)}`));
  };
  return (
    <div ref={pane} tabIndex={-1} className="flex h-full min-h-0 flex-col outline-none" onKeyDownCapture={(e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); }
    }}>
      <div className="flex min-h-8 shrink-0 items-center gap-2 border-b border-hairline px-3 text-xs">
        <span className="min-w-0 truncate text-muted-foreground" title={abs}>{entry.rel}</span>
        <span className="ml-auto shrink-0 text-faint">Read-only</span>
        <Button variant="ghost" size="icon-xs" aria-label="Reload media" onClick={reload}><RotateCcw /></Button>
        <Button variant="ghost" size="icon-xs" aria-label="Reveal file" onClick={reveal}><FolderOpen /></Button>
      </div>
      {changed && !error && <div className="flex items-center gap-2 bg-warning/10 px-3 py-2 text-xs">
        File changed on disk. Reload to view the latest version.
        <Button variant="outline" size="xs" onClick={reload}>Reload</Button>
      </div>}
      {actionError && <p role="alert" className="px-3 py-2 text-xs text-destructive">{actionError}</p>}
      {error ? <div role="alert" className="space-y-3 p-4 text-sm text-muted-foreground">
        <p>Cannot preview {entry.name}.</p><p>{error}</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={reload}>Retry</Button>
          <Button variant="outline" size="sm" onClick={openExternal}>Open with default application</Button>
          <Button variant="outline" size="sm" onClick={reveal}>Reveal file</Button>
        </div>
      </div> : media ? entry.kind === "image" ? (
        <ImageSurface key={media.token} src={media.url} name={entry.name} onError={() => setError("The image format is unsupported or the file is damaged.")} />
      ) : (
        <PlaybackSurface key={media.token} src={media.url} name={entry.name} video={entry.kind === "video"} visible={visible && !changed}
          onError={() => setError("The format or codec is unsupported, the file is damaged, or it could not be loaded.")} />
      ) : <p role="status" className="p-4 text-sm text-muted-foreground">Loading {entry.name}…</p>}
    </div>
  );
}

function ImageSurface({ src, name, onError }: { src: string; name: string; onError: () => void }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const changeZoom = (factor: number) => {
    const fit = size && image.current ? image.current.clientWidth / size.width : 1;
    setZoom((z) => Math.max(0.05, Math.min(8, (z ?? fit) * factor)));
  };
  return <>
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-hairline px-2 text-xs">
      <Button variant="ghost" size="xs" onClick={() => { setZoom(null); host.current?.scrollTo(0, 0); }}>Fit</Button>
      <Button variant="ghost" size="xs" onClick={() => setZoom(1)}>Actual size</Button>
      <Button variant="ghost" size="icon-xs" aria-label="Zoom out" disabled={!size} onClick={() => changeZoom(1 / 1.25)}><ZoomOut /></Button>
      <Button variant="ghost" size="icon-xs" aria-label="Zoom in" disabled={!size} onClick={() => changeZoom(1.25)}><ZoomIn /></Button>
      <span className="text-faint">{zoom === null ? "Fit" : `${Math.round(zoom * 100)}%`}</span>
      {size && <span className="ml-auto text-faint">{size.width} × {size.height}</span>}
    </div>
    <div ref={host} className="min-h-0 flex-1 overflow-auto" style={{ backgroundColor: "#e5e5e5", backgroundImage: "conic-gradient(#c4c4c4 25%, transparent 0 50%, #c4c4c4 0 75%, transparent 0)", backgroundSize: "20px 20px" }}>
      <div className="flex min-h-full min-w-full w-max items-center justify-center" style={zoom === null ? { width: "100%", height: "100%" } : undefined}>
        <img ref={image} src={src} alt={name} draggable={false} onError={onError}
          onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          style={zoom === null ? { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" } : { width: size ? size.width * zoom : undefined, maxWidth: "none", flexShrink: 0 }} />
      </div>
    </div>
  </>;
}

function PlaybackSurface({ src, name, video, visible, onError }: { src: string; name: string; video: boolean; visible: boolean; onError: () => void }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    const player = ref.current;
    if (!player) return;
    // Explicit assignment allows StrictMode's setup/cleanup/setup cycle to reload.
    player.src = src;
    return () => { player.pause(); player.removeAttribute("src"); player.load(); };
  }, [src]);
  useEffect(() => {
    const pauseIfHidden = () => { if (!visible || document.hidden) ref.current?.pause(); };
    pauseIfHidden();
    document.addEventListener("visibilitychange", pauseIfHidden);
    return () => document.removeEventListener("visibilitychange", pauseIfHidden);
  }, [visible]);
  const props = { ref, controls: true, preload: "metadata", "aria-label": name, onError,
    onPlay: () => { if (!visible || document.hidden) ref.current?.pause(); } };
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto p-4">
    {video ? <video {...props} playsInline className="max-h-full w-full bg-black" /> : <>
      <p className="break-all text-sm text-muted-foreground">{name}</p>
      <audio {...props} className="w-full" />
    </>}
  </div>;
}
