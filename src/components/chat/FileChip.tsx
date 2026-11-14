import type { ComponentType, MouseEvent, SVGProps } from "react";
import { File, FileCode2, FileImage, FileJson, FileText, FileX, Table, X } from "@/icons";
import { cn } from "@/lib/cn";
import { extOf } from "@/lib/paths";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const CODE = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "rb", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "sh", "zsh", "bash", "css", "scss", "html", "vue", "svelte", "sql", "toml", "yaml", "yml", "xml"]);
const TEXT = new Set(["md", "mdx", "markdown", "txt", "log", "rtf", "pdf", "rst", "adoc"]);
const TABLE = new Set(["csv", "tsv", "xls", "xlsx", "numbers"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "tif", "tiff", "ico", "avif"]);

/** The icon for an attached file, by its extension (the design's file-text, file-code, file-json, table and image glyphs). */
export function fileChipIcon(name: string): Icon {
  const ext = extOf(name).toLowerCase();
  if (ext === "json" || ext === "jsonl") return FileJson;
  if (TABLE.has(ext)) return Table;
  if (IMAGE.has(ext)) return FileImage;
  if (CODE.has(ext)) return FileCode2;
  if (TEXT.has(ext)) return FileText;
  return File;
}

/**
 * One attached file, as a chip (PRO-290, screens 03.22 and 03.23): its type's
 * icon and its name, with a remove control in the composer. A refused file is
 * drawn in the destructive colour with the reason beside its name ("reserved
 * name"). The chip is a button when `onOpen` is given (a sent message's file).
 */
export function FileChip({ name, refused, onRemove, onOpen, title, className }: {
  name: string;
  /** Why it was not attached, shown after the name: "reserved name". */
  refused?: string;
  onRemove?: () => void;
  onOpen?: () => void;
  title?: string;
  className?: string;
}) {
  const Glyph = refused ? FileX : fileChipIcon(name);
  const body = (
    <>
      <Glyph aria-hidden className={cn("size-[13px] shrink-0", refused ? "text-destructive" : "text-muted-foreground")} />
      <span className="min-w-0 max-w-[180px] truncate">{name}</span>
      {refused && <span className="shrink-0 text-[11px] text-destructive">{refused}</span>}
    </>
  );
  const frame = cn(
    "inline-flex h-7 max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border pl-2 text-[12px]",
    onRemove ? "pr-1.5" : "pr-2",
    refused ? "border-destructive/45 bg-destructive/[.07]" : "border-hairline bg-raised",
    className,
  );
  return (
    <span className={frame} data-testid="file-chip" data-refused={refused ? "" : undefined} title={title ?? name}>
      {onOpen ? (
        <button type="button" className="inline-flex min-w-0 items-center gap-1.5 hover:text-foreground focus-visible:outline-none focus-visible:underline" onClick={onOpen} aria-label={`Open ${name}`}>
          {body}
        </button>
      ) : body}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${name}`}
          className="-mr-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded text-faint hover:text-foreground"
          onClick={(event: MouseEvent) => { event.stopPropagation(); onRemove(); }}
        >
          <X className="size-[11px]" />
        </button>
      )}
    </span>
  );
}
