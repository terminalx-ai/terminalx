import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut } from "@/icons";

GlobalWorkerOptions.workerSrc = workerUrl;

/** Rasterize one page at a time. Never embed a PDF document or execute its
 * actions, JavaScript, attachments or links in the application origin. */
export default function PdfSurface({ data, name }: { data: string; name: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [rendering, setRendering] = useState(true);
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderedScale = useRef(1);
  useEffect(() => {
    setDocument(null); setError(null); setPage(1); setZoom(null);
    let disposed = false;
    let task: ReturnType<typeof getDocument> | undefined;
    try {
      const assets = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.location.href).href;
      task = getDocument({
        data: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
        cMapUrl: `${assets}cmaps/`, standardFontDataUrl: `${assets}standard_fonts/`,
        wasmUrl: `${assets}wasm/`, iccUrl: `${assets}iccs/`,
        maxImageSize: 32_000_000, canvasMaxAreaInBytes: 32_000_000,
      });
      task.onPassword = () => { if (!disposed) setError("This PDF requires a password."); void task?.destroy().catch(() => {}); };
      void task.promise.then((doc) => { if (!disposed) setDocument(doc); }).catch((e) => { if (!disposed) setError(String(e)); });
    } catch (e) { setError(String(e)); }
    return () => { disposed = true; void task?.destroy().catch(() => {}); };
  }, [data]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!document || !canvas.current || !width) return;
    let cancelled = false;
    let render: RenderTask | undefined;
    setRendering(true);
    void document.getPage(page).then(async (pdfPage) => {
      if (cancelled || !canvas.current) return;
      const natural = pdfPage.getViewport({ scale: 1 });
      const scale = zoom ?? Math.max(0.05, Math.min(4, (width - 16) / natural.width));
      renderedScale.current = scale;
      const viewport = pdfPage.getViewport({ scale });
      // Bound raster memory even for enormous page dimensions and high zoom.
      const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(8_000_000 / (viewport.width * viewport.height)), 8192 / Math.max(viewport.width, viewport.height));
      const element = canvas.current;
      element.width = Math.max(1, Math.floor(viewport.width * ratio));
      element.height = Math.max(1, Math.floor(viewport.height * ratio));
      element.style.width = `${viewport.width}px`;
      element.style.height = `${viewport.height}px`;
      render = pdfPage.render({ canvas: element, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await render.promise;
      if (!cancelled) setRendering(false);
    }).catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; render?.cancel(); };
  }, [document, page, zoom, width]);
  return <>
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-hairline px-2 py-1 text-xs">
      <Button size="xs" variant="ghost" disabled={!document} onClick={() => setZoom(null)}>Fit</Button>
      <Button size="xs" variant="ghost" disabled={!document} onClick={() => setZoom(1)}>Actual size</Button>
      <Button size="icon-xs" variant="ghost" aria-label="Zoom out" disabled={!document} onClick={() => setZoom((z) => Math.max(0.05, (z ?? renderedScale.current) / 1.25))}><ZoomOut /></Button>
      <Button size="icon-xs" variant="ghost" aria-label="Zoom in" disabled={!document} onClick={() => setZoom((z) => Math.min(4, (z ?? renderedScale.current) * 1.25))}><ZoomIn /></Button>
      <span>{zoom === null ? "Fit" : `${Math.round(zoom * 100)}%`}</span>
      <Button size="xs" variant="ghost" aria-label="Previous page" disabled={!document || page <= 1} onClick={() => setPage((p) => p - 1)}>‹</Button>
      <span>Page {page} / {document?.numPages ?? "…"}</span>
      <Button size="xs" variant="ghost" aria-label="Next page" disabled={!document || page >= document.numPages} onClick={() => setPage((p) => p + 1)}>›</Button>
    </div>
    {error && <p role="alert" className="p-3 text-xs text-destructive">Cannot preview {name}: {error}</p>}
    <div ref={host} className="min-h-0 flex-1 overflow-auto bg-well p-2" aria-busy={rendering && !error}>
      {!error && <canvas ref={canvas} role="img" aria-label={`${name}, page ${page}`} className="mx-auto block bg-white" style={{ visibility: rendering ? "hidden" : "visible" }} />}
    </div>
  </>;
}
