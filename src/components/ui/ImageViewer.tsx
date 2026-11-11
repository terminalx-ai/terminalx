import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ChevronLeft, ChevronRight, Copy, ExternalLink, Expand, Minus, Plus, RotateCw, X } from "@/icons";
import { fs } from "@/lib/api";
import { cn } from "@/lib/cn";
import { closeImageViewer, stepImageViewer, useImageViewer } from "@/lib/imageViewer";

const MIN = 0.05;
const MAX = 16;
const STEP = 1.25;

interface View {
  /** Zoom: 1 is the image's own pixels. */
  scale: number;
  /** Where the image's centre sits, from the stage's centre, in screen pixels. */
  x: number;
  y: number;
  /** Quarter turns. */
  turns: number;
}

/**
 * The image viewer: any image in a conversation opens here, large, on a dark ground. Mounted once (AppShell).
 *
 * Zoom with a trackpad pinch (WebKit's gesture events, and ⌘/Ctrl + scroll elsewhere), the + and − keys or the
 * toolbar; zoom keeps the point under the fingers or the pointer still. Scroll with two fingers or drag to move a
 * zoomed image. Double-click switches between fitting the window and the image's own size, at the point clicked.
 * 0 fits, 1 shows actual size, R rotates, ← and → step through the set, Escape closes. The toolbar also copies the
 * image and opens a local file in its default app.
 */
export function ImageViewerHost() {
  const viewer = useImageViewer();
  return (
    <DialogPrimitive.Root open={!!viewer} onOpenChange={(open) => !open && closeImageViewer()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-(--z-dialog-overlay) bg-black/90 backdrop-blur-md data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          data-testid="image-viewer"
          className="fixed inset-0 z-(--z-dialog) flex flex-col outline-none data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out"
        >
          {viewer ? <Viewer key={viewer.images[viewer.index].src} images={viewer.images} index={viewer.index} /> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Viewer({ images, index }: { images: { src: string; name: string; path?: string }[]; index: number }) {
  const image = images[index];
  const stage = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0, turns: 0 });
  const [fitted, setFitted] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const fittedRef = useRef(fitted);
  fittedRef.current = fitted;

  /** The scale at which the whole image, as turned, fits the stage with a margin; never above its own size. */
  const fitScale = useCallback((turns = viewRef.current.turns) => {
    const box = stage.current?.getBoundingClientRect();
    if (!box || !natural) return 1;
    const sideways = turns % 2 === 1;
    const w = sideways ? natural.h : natural.w;
    const h = sideways ? natural.w : natural.h;
    return Math.max(MIN, Math.min(1, (box.width - 96) / w, (box.height - 96) / h));
  }, [natural]);

  const fit = useCallback((turns = viewRef.current.turns) => {
    setView({ scale: fitScale(turns), x: 0, y: 0, turns });
    setFitted(true);
  }, [fitScale]);

  // Fitted until the reader zooms: the window resizing refits it.
  useLayoutEffect(() => {
    if (!natural) return;
    fit();
    // Read through the ref: the closure is the first render's, and a zoom since then must not be undone.
    const onResize = () => { if (fittedRef.current) fit(); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [natural]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Zoom to `next`, keeping the screen point (cx, cy) on the same spot of the image. */
  const zoomAt = useCallback((next: number, cx?: number, cy?: number) => {
    const box = stage.current?.getBoundingClientRect();
    setView((v) => {
      const scale = Math.min(MAX, Math.max(MIN, next));
      if (!box || cx === undefined || cy === undefined) return { ...v, scale, x: v.x * (scale / v.scale), y: v.y * (scale / v.scale) };
      const px = cx - (box.left + box.width / 2);
      const py = cy - (box.top + box.height / 2);
      const k = scale / v.scale;
      return { ...v, scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
    setFitted(false);
  }, []);

  // Trackpad and wheel: a pinch (gesture events in WebKit, ctrl + wheel elsewhere) zooms; two-finger scroll moves.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        zoomAt(viewRef.current.scale * Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
      } else {
        setView((v) => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }));
        setFitted(false);
      }
    };
    let gestureStart = 1;
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (event: Event) => { event.preventDefault(); gestureStart = viewRef.current.scale; };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as Gesture;
      zoomAt(gestureStart * gesture.scale, gesture.clientX, gesture.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  }, [zoomAt]);

  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const at = drag.current;
    if (!at || at.id !== event.pointerId) return;
    const dx = event.clientX - at.x, dy = event.clientY - at.y;
    drag.current = { ...at, x: event.clientX, y: event.clientY };
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    if (dx || dy) setFitted(false);
  };
  const onPointerUp = () => { drag.current = null; };

  const rotate = useCallback(() => fit((viewRef.current.turns + 1) % 4), [fit]);
  const actual = (cx?: number, cy?: number) => zoomAt(1, cx, cy);

  // Keys: + − zoom, 0 fit, 1 actual size, R rotate, ← → step, ⌘C (Ctrl+C off a Mac) copies. Escape is the dialog's.
  // Registered once; what changes is read through refs. The dialog is modal, so nothing else wants these keys.
  const keys = useRef({ zoomAt, fit, rotate, actual: () => actual(), copy: () => void copy(), many: images.length > 1 });
  keys.current = { zoomAt, fit, rotate, actual: () => actual(), copy: () => void copy(), many: images.length > 1 };
  useEffect(() => {
    const mac = navigator.platform.toLowerCase().includes("mac");
    const onKey = (event: KeyboardEvent) => {
      const k = keys.current;
      if ((mac ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === "c") { k.copy(); event.preventDefault(); return; }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key;
      if (key === "+" || key === "=") k.zoomAt(viewRef.current.scale * STEP);
      else if (key === "-" || key === "_") k.zoomAt(viewRef.current.scale / STEP);
      else if (key === "0") k.fit();
      else if (key === "1") k.actual();
      else if (key.toLowerCase() === "r") k.rotate();
      else if (key === "ArrowRight" && k.many) stepImageViewer(1);
      else if (key === "ArrowLeft" && k.many) stepImageViewer(-1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const say = (text: string) => {
    setNote(text);
    window.setTimeout(() => setNote((now) => (now === text ? null : now)), 1600);
  };
  /** The image as a PNG on the clipboard (the clipboard takes PNG), drawn from what is shown. */
  async function copy() {
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = image.src;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")?.drawImage(img, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("no image");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      say("Copied");
    } catch {
      say("Could not copy this image");
    }
  }
  const openOutside = image.path ? () => void fs.openPath(image.path!).catch(() => say("Could not open it")) : null;

  const percent = Math.round(view.scale * 100);
  const transform = `translate(${view.x}px, ${view.y}px) rotate(${view.turns * 90}deg) scale(${view.scale})`;
  return (
    <>
      <DialogPrimitive.Title className="sr-only">{image.name}</DialogPrimitive.Title>
      <header className="pointer-events-none relative z-10 flex items-center justify-between gap-3 px-4 py-3 text-white">
        <span className="min-w-0 truncate text-[13px] text-white/85" title={image.path ?? image.name}>
          {image.name}
          {images.length > 1 && <span className="ml-2 tabular-nums text-white/50">{index + 1} of {images.length}</span>}
        </span>
        <DialogPrimitive.Close asChild>
          <button type="button" aria-label="Close" className="pointer-events-auto flex size-8 items-center justify-center rounded-full bg-white/10 text-white/85 hover:bg-white/20 hover:text-white focus-visible:outline-2 focus-visible:outline-white/60">
            <X className="size-4" />
          </button>
        </DialogPrimitive.Close>
      </header>

      <div
        ref={stage}
        className={cn("relative min-h-0 flex-1 touch-none select-none overflow-hidden", fitted ? "cursor-zoom-in" : "cursor-grab active:cursor-grabbing")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(event) => (fitted ? actual(event.clientX, event.clientY) : fit())}
        onClick={(event) => { if (event.target === event.currentTarget && fitted) closeImageViewer(); }}
        data-testid="image-viewer-stage"
      >
        <img
          src={image.src}
          alt={image.name}
          draggable={false}
          onLoad={(event) => setNatural({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
          className={cn("absolute left-1/2 top-1/2 max-w-none origin-center shadow-2xl outline outline-1 -outline-offset-1 outline-white/10", !natural && "opacity-0")}
          style={{ width: natural?.w, height: natural?.h, marginLeft: natural ? -natural.w / 2 : 0, marginTop: natural ? -natural.h / 2 : 0, transform, imageRendering: view.scale > 4 ? "pixelated" : undefined }}
        />
        {images.length > 1 && (
          <>
            <StepButton side="left" onClick={() => stepImageViewer(-1)} />
            <StepButton side="right" onClick={() => stepImageViewer(1)} />
          </>
        )}
      </div>

      <footer className="relative z-10 flex justify-center px-4 pb-5 pt-3">
        <div role="toolbar" aria-label="Image" className="flex items-center gap-0.5 rounded-full bg-neutral-900/90 p-1 text-white/85 shadow-lg ring-1 ring-white/10 backdrop-blur">
          <Tool label="Zoom out (−)" onClick={() => zoomAt(view.scale / STEP)}><Minus /></Tool>
          <button type="button" onClick={() => fit()} title="Fit to window (0)" className="h-8 min-w-14 rounded-full px-2 text-xs tabular-nums hover:bg-white/10" data-testid="image-viewer-zoom">
            {percent}%
          </button>
          <Tool label="Zoom in (+)" onClick={() => zoomAt(view.scale * STEP)}><Plus /></Tool>
          <span aria-hidden className="mx-1 h-4 w-px bg-white/15" />
          <Tool label="Fit to window (0)" onClick={() => fit()} active={fitted}><Expand /></Tool>
          <button type="button" onClick={() => actual()} title="Actual size (1)" className={cn("h-8 rounded-full px-2.5 text-xs hover:bg-white/10", !fitted && Math.abs(view.scale - 1) < 0.001 && "bg-white/15")}>1:1</button>
          <Tool label="Rotate (R)" onClick={rotate}><RotateCw /></Tool>
          <span aria-hidden className="mx-1 h-4 w-px bg-white/15" />
          <Tool label="Copy image" onClick={() => void copy()}><Copy /></Tool>
          {openOutside && <Tool label="Open in default app" onClick={openOutside}><ExternalLink /></Tool>}
        </div>
        {note && <span role="status" className="absolute bottom-16 rounded-full bg-neutral-900/90 px-3 py-1 text-xs text-white/90 ring-1 ring-white/10">{note}</span>}
      </footer>
    </>
  );
}

function Tool({ label, onClick, active = false, children }: { label: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={cn("flex size-8 items-center justify-center rounded-full hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white/60 [&_svg]:size-4", active && "bg-white/15")}>
      {children}
    </button>
  );
}

function StepButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={side === "left" ? "Previous image (←)" : "Next image (→)"}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={onClick}
      className={cn("absolute top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-neutral-900/80 text-white/85 ring-1 ring-white/10 hover:bg-neutral-800 hover:text-white", side === "left" ? "left-4" : "right-4")}
    >
      <Icon className="size-5" />
    </button>
  );
}
