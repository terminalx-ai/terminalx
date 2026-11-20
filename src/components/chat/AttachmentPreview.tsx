import { useEffect, useState, type MouseEvent } from "react";
import { X } from "@/icons";
import { PrivacyImage } from "@/components/ui/privacy-image";
import { fs } from "@/lib/api";
import { cn } from "@/lib/cn";
import { extOf } from "@/lib/paths";
import { formatSize } from "@/lib/workspaceSizes";
import { fileChipIcon } from "./FileChip";

/** Files whose first lines are worth showing as their preview (PRO-461). */
const TEXT_PREVIEW = new Set([
  "md", "mdx", "markdown", "txt", "log", "rst", "adoc", "csv", "tsv", "json", "jsonl",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "rb", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs",
  "sh", "zsh", "bash", "css", "scss", "html", "vue", "svelte", "sql", "toml", "yaml", "yml", "xml", "ini", "env", "diff", "patch",
]);
/** Images the web view draws, for a thumbnail of a file that goes as a file rather than as an image block. */
const DRAWABLE_IMAGE = new Set(["png", "jpg", "jpeg", "jfif", "gif", "webp", "avif", "bmp", "ico", "apng", "svg", "tif", "tiff", "heic", "heif"]);

/** At most this much of a file is read for its text preview. */
export const TEXT_PREVIEW_BYTES = 8 * 1024;
const PREVIEW_LINES = 3;
const PREVIEW_LINE_CHARS = 120;

export const hasTextPreview = (name: string) => TEXT_PREVIEW.has(extOf(name).toLowerCase());
export const isDrawableImage = (name: string) => DRAWABLE_IMAGE.has(extOf(name).toLowerCase());

/** The first few non-blank lines of a text file, each cut short; null when there is nothing to show (or it is binary). */
export function textSnippet(content: string | null | undefined): string | null {
  if (!content || content.slice(0, 2048).includes("\0")) return null;
  const lines = content.split(/\r?\n/).map((line) => line.replace(/\s+$/, "").replace(/\t/g, "  "));
  const start = lines.findIndex((line) => line.trim());
  if (start < 0) return null;
  return lines
    .slice(start, start + PREVIEW_LINES)
    .map((line) => (line.length > PREVIEW_LINE_CHARS ? `${line.slice(0, PREVIEW_LINE_CHARS)}…` : line))
    .join("\n");
}

/** What a card says under the name: its size and its type, "240 KB · PDF". */
export function attachmentMeta(name: string, size?: number): string {
  const ext = extOf(name).toUpperCase();
  return [size != null ? formatSize(size) : null, ext || null].filter(Boolean).join(" · ");
}

/**
 * One attached file with its preview (PRO-461), in the composer and on the
 * sent message alike. An image is its thumbnail, and clicking it opens the
 * image viewer; any other file is a card with its type's icon, its name, its
 * size and type and, for a text file, its first lines. A thumbnail that does
 * not load falls back to the card. `onRemove` puts the × on it (the
 * composer); `onOpen` makes a card a button (a sent file opens in a tab).
 */
export function AttachmentPreview({ name, size, thumbnail, text, onView, onOpen, onRemove, title }: {
  name: string;
  size?: number;
  /** A URL the web view can draw: a `blob:`, `data:`, media-server or asset URL. */
  thumbnail?: string;
  /** The first lines of a text file. */
  text?: string | null;
  /** Open the larger preview of an image. */
  onView?: () => void;
  onOpen?: () => void;
  onRemove?: () => void;
  title?: string;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [thumbnail]);
  const meta = attachmentMeta(name, size);
  const tip = title ?? name;
  const remove = onRemove && (
    <button
      type="button"
      aria-label={`Remove ${name}`}
      className="absolute -top-1.5 -right-1.5 z-10 inline-flex size-[18px] items-center justify-center rounded-full border border-hairline bg-raised text-muted-foreground shadow-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={(event: MouseEvent) => { event.stopPropagation(); onRemove(); }}
    >
      <X className="size-[10px]" />
    </button>
  );

  if (thumbnail && !broken) {
    const image = <PrivacyImage src={thumbnail} alt={name} draggable={false} className="size-full object-cover" onError={() => setBroken(true)} />;
    const open = onView ?? onOpen;
    return (
      <span className="relative inline-flex shrink-0" data-testid="attachment-preview" data-kind="image" title={tip}>
        {open ? (
          <button
            type="button"
            aria-label={onView ? `View ${name}` : `Open ${name}`}
            className="block size-16 cursor-zoom-in overflow-hidden rounded-lg border border-hairline bg-raised outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={open}
          >
            {image}
          </button>
        ) : (
          <span className="block size-16 overflow-hidden rounded-lg border border-hairline bg-raised">{image}</span>
        )}
        <span className="sr-only" data-testid="attachment-name">{name}</span>
        {remove}
      </span>
    );
  }

  const Glyph = fileChipIcon(name);
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-veil-raised">
          <Glyph aria-hidden className="size-4 text-muted-foreground" />
        </span>
        <span className="flex min-w-0 flex-col text-left">
          <span className="truncate text-[12px] text-foreground" data-testid="attachment-name">{name}</span>
          {meta && <span className="truncate text-[11px] text-faint" data-testid="attachment-meta">{meta}</span>}
        </span>
      </span>
      {text && (
        <pre className="mt-1.5 max-h-[3.5em] overflow-hidden whitespace-pre font-mono text-[10px] leading-[1.15] text-muted-foreground" data-testid="attachment-text" aria-hidden>
          {text}
        </pre>
      )}
    </>
  );
  const frame = cn(
    "flex w-[220px] max-w-full min-w-0 flex-col rounded-lg border border-hairline bg-raised p-1.5 text-left",
    onOpen && "hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
  );
  return (
    <span className="relative inline-flex min-w-0 max-w-full shrink-0" data-testid="attachment-preview" data-kind={text ? "text" : "file"} title={tip}>
      {onOpen ? (
        <button type="button" className={frame} onClick={onOpen} aria-label={`Open ${name}`}>{body}</button>
      ) : (
        <span className={frame}>{body}</span>
      )}
      {remove}
    </span>
  );
}

/** The first lines of a stored text file, read once for its card; null until read, or when it is not text. */
export function useTextSnippet(path: string | undefined, enabled: boolean): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    if (!enabled || !path) return;
    let live = true;
    let read: Promise<{ content: string; binary: boolean } | undefined> | undefined;
    try {
      read = Promise.resolve(fs.readText(path));
    } catch {
      return;
    }
    read
      .then((file) => { if (live && file && !file.binary) setText(textSnippet(file.content.slice(0, TEXT_PREVIEW_BYTES))); })
      .catch(() => {});
    return () => { live = false; };
  }, [path, enabled]);
  return text;
}
