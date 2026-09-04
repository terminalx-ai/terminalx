import { useCallback, useEffect, useMemo, useRef, useState, type HTMLAttributes, type RefObject } from "react";
import { Paperclip, X } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { files as filesApi, type ImageInput } from "@/lib/api";

export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  data: string; // base64
  previewUrl: string;
}

/** Images larger than this are skipped rather than sent as one huge block. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ImageAttachments {
  attachments: Attachment[];
  /** A file is being dragged over the window or the composer frame. */
  dragging: boolean;
  fileRef: RefObject<HTMLInputElement | null>;
  /** Queue browser `File`s (from paste, the DOM drop path, or the hidden picker). */
  addFiles: (list: File[]) => Promise<void>;
  /** Open the native picker, or the hidden browser picker outside Tauri. */
  chooseFiles: () => Promise<void>;
  remove: (id: string) => void;
  /** Release every queued image and its preview, after a successful send. */
  clear: () => void;
  /** The queue in the shape `agent.send` takes. */
  images: ImageInput[];
  /** Spread onto the composer frame so it accepts pasted and dropped files. */
  dropZoneProps: Pick<HTMLAttributes<HTMLElement>, "onPaste" | "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop">;
}

/**
 * Everything a composer needs to carry images with a prompt: the queue, the
 * native and browser pickers, paste, and both drop paths. Dropped paths reach
 * the app through the Tauri window, not the DOM: images attach, any other
 * file becomes an `@path` mention appended to the draft.
 *
 * Shared by the in-session composer and the new-session screen so the first
 * prompt of a session can carry a screenshot like every one after it.
 */
export function useImageAttachments({
  textareaRef,
  draft,
  onDraftChange,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  onDraftChange: (v: string) => void;
}): ImageAttachments {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // The drag-drop subscription is per webview and must be registered once, so
  // it reads the draft through a ref rather than taking it as a dependency —
  // otherwise every keystroke tore the listener down and built another.
  const latest = useRef({ draft, onDraftChange });
  latest.current = { draft, onDraftChange };

  const addFiles = useCallback(async (list: File[]) => {
    const out: Attachment[] = [];
    for (const f of list) {
      if (!f.type.startsWith("image/") || f.size > MAX_IMAGE_BYTES) continue;
      const data = await new Promise<string>((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",")[1] ?? "");
        r.readAsDataURL(f);
      });
      out.push({ id: crypto.randomUUID(), name: f.name, mediaType: f.type, data, previewUrl: URL.createObjectURL(f) });
    }
    if (out.length) setAttachments((a) => [...a, ...out]);
  }, []);

  const addPaths = useCallback(
    async (paths: string[]) => {
      const mentions: string[] = [];
      for (const path of paths) {
        const img = await filesApi.readImage(path).catch(() => null);
        if (img) {
          setAttachments((current) => [
            ...current,
            { id: crypto.randomUUID(), name: img.name, mediaType: img.mediaType, data: img.data, previewUrl: `data:${img.mediaType};base64,${img.data}` },
          ]);
        } else {
          mentions.push(`@${path}`);
        }
      }
      if (mentions.length) {
        const { draft: current, onDraftChange: change } = latest.current;
        const sep = current && !/\s$/.test(current) ? " " : "";
        change(current + sep + mentions.join(" ") + " ");
      }
      textareaRef.current?.focus();
    },
    [textareaRef],
  );

  const chooseFiles = useCallback(async () => {
    try {
      const selected = await openDialog({ multiple: true, title: "Attach files" });
      if (!selected) return;
      await addPaths(Array.isArray(selected) ? selected : [selected]);
    } catch {
      // The hidden browser picker keeps the composer usable outside Tauri.
      fileRef.current?.click();
    }
  }, [addPaths]);

  const remove = useCallback((id: string) => {
    setAttachments((list) => {
      const removed = list.find((item) => item.id === id);
      if (removed?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(removed.previewUrl);
      return list.filter((item) => item.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setAttachments((list) => {
      for (const item of list) {
        if (item.previewUrl.startsWith("blob:")) URL.revokeObjectURL(item.previewUrl);
      }
      return [];
    });
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  // Dropped paths arrive from the window, not the DOM: images attach, the
  // rest become mentions the harness reads itself.
  useEffect(() => {
    let off: (() => void) | null = null;
    let disposed = false;
    // Called from two places — the cleanup and the late-resolving registration
    // — and Tauri throws if a listener is dropped twice.
    const stop = () => {
      const fn = off;
      off = null;
      try {
        fn?.();
      } catch {
        /* already gone */
      }
    };
    void (async () => {
      try {
        const fn = await getCurrentWebview().onDragDropEvent(async (e) => {
          const p = e.payload;
          if (p.type === "enter" || p.type === "over") setDragging(true);
          else if (p.type === "leave") setDragging(false);
          else if (p.type === "drop") {
            setDragging(false);
            await addPaths(p.paths);
          }
        });
        off = fn;
        if (disposed) stop();
      } catch {
        /* outside a webview */
      }
    })();
    return () => {
      disposed = true;
      stop();
    };
  }, [addPaths]);

  const images = useMemo(() => attachments.map((a) => ({ mediaType: a.mediaType, data: a.data, name: a.name })), [attachments]);

  const dropZoneProps = useMemo<ImageAttachments["dropZoneProps"]>(
    () => ({
      onPaste: (e) => {
        const list = [...e.clipboardData.files];
        if (list.length) {
          e.preventDefault();
          void addFiles(list);
        }
      },
      onDragEnter: (e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      },
      onDragOver: (e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragging(true);
      },
      onDragLeave: (e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragging(false);
      },
      onDrop: (e) => {
        const list = [...e.dataTransfer.files];
        if (!list.length) return;
        e.preventDefault();
        setDragging(false);
        void addFiles(list);
      },
    }),
    [addFiles],
  );

  // One stable object per change, so a composer's send callback can list it
  // as a dependency without being rebuilt on every render.
  return useMemo(
    () => ({ attachments, dragging, fileRef, addFiles, chooseFiles, remove, clear, images, dropZoneProps }),
    [attachments, dragging, addFiles, chooseFiles, remove, clear, images, dropZoneProps],
  );
}

/** The overlay that names what a drop does, shown while a file hovers the frame. */
export function DropHint({ dragging }: { dragging: boolean }) {
  if (!dragging) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-composer/80 text-sm text-muted-foreground">
      Drop images to attach, other files to mention
    </div>
  );
}

/** Thumbnails of the queued images, each with a remove control on hover. */
export function AttachmentThumbs({ attach }: { attach: ImageAttachments }) {
  if (!attach.attachments.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-2 px-1">
      {attach.attachments.map((a) => (
        <div key={a.id} className="group relative size-14 overflow-hidden rounded-md hairline">
          <img src={a.previewUrl} alt={a.name} className="size-full object-cover" />
          <button
            type="button"
            aria-label={`Remove ${a.name}`}
            onClick={() => attach.remove(a.id)}
            className="absolute right-0.5 top-0.5 hidden rounded-full bg-black/60 p-0.5 text-white group-hover:block"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The attach button and the hidden browser picker behind it. */
export function AttachButton({ attach }: { attach: ImageAttachments }) {
  return (
    <>
      <input
        ref={attach.fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const list = e.target.files ? [...e.target.files] : [];
          // A cleared input lets the same file be selected again after a
          // send or removal; browsers do not emit change otherwise.
          e.target.value = "";
          if (list.length) void attach.addFiles(list);
        }}
      />
      <WithTooltip label="Attach files">
        <Button variant="ghost" size="icon-sm" aria-label="Attach files" onClick={() => void attach.chooseFiles()}>
          <Paperclip />
        </Button>
      </WithTooltip>
    </>
  );
}
