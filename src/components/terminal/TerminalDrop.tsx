import { useEffect, useMemo, useRef, useState, type HTMLAttributes, type RefObject } from "react";
import { files as filesApi } from "@/lib/api";
import { registerFileDropTarget } from "@/lib/fileDrop";
import { peekInstance } from "@/lib/terminal";
import { droppedPathsText } from "@/lib/terminalDrop";

/**
 * Why this terminal takes no dropped files, or no dropped text: said on the
 * drop target and again after the drop, and nothing is typed. A cloud
 * terminal refuses files (a path on this computer is not one on the
 * workspace) and, for someone who is only watching, text as well.
 */
export interface TerminalDropRefusal {
  files?: string;
  text?: string;
}

const REFUSAL_MS = 5_000;

export interface TerminalDrop {
  /** What a drop would do, while something is dragged over the terminal. */
  hint: string | null;
  /** Why the last drop typed nothing, for a few seconds after it. */
  refused: string | null;
  /** Spread onto the frame: outside the Tauri window a text drag arrives through the DOM. */
  zoneProps: Pick<HTMLAttributes<HTMLElement>, "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop">;
}

/**
 * Dropping on the terminal `id` types into it: a file's quoted path, or the
 * dragged text. Both go in as a paste, so the program's bracketed-paste mode
 * is honoured and nothing is followed by Enter.
 */
export function useTerminalDrop({
  id,
  frame,
  enabled,
  refusal,
}: {
  id: string;
  frame: RefObject<HTMLElement | null>;
  enabled: boolean;
  refusal?: TerminalDropRefusal;
}): TerminalDrop {
  const [dragging, setDragging] = useState<"files" | "text" | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const latest = useRef(refusal);
  latest.current = refusal;

  useEffect(() => {
    if (!refused) return;
    const timer = setTimeout(() => setRefused(null), REFUSAL_MS);
    return () => clearTimeout(timer);
  }, [refused]);

  // `text` is read only once the drop is known to be allowed.
  const paste = useMemo(
    () => async (kind: "files" | "text", text: () => string | Promise<string>) => {
      setDragging(null);
      const reason = latest.current?.[kind];
      if (reason) {
        setRefused(reason);
        return;
      }
      setRefused(null);
      const data = await text();
      const term = peekInstance(id)?.term;
      if (!term || !data) return;
      term.paste(data);
      term.focus();
    },
    [id],
  );

  useEffect(() => {
    if (!enabled) return;
    const off = registerFileDropTarget({
      element: () => frame.current,
      onDragChange: (over, kind) => setDragging(over ? kind : null),
      // No paths: text dragged from another app, which the window's event does not carry.
      onDrop: (paths) =>
        paths.length ? paste("files", () => droppedPathsText(paths)) : paste("text", async () => (await filesApi.droppedText().catch(() => null)) ?? ""),
    });
    return () => {
      off();
      setDragging(null);
    };
  }, [enabled, frame, paste]);

  const zoneProps = useMemo<TerminalDrop["zoneProps"]>(() => {
    const isText = (e: React.DragEvent) => {
      const types = [...e.dataTransfer.types];
      return types.includes("text/plain") && !types.includes("Files");
    };
    const over = (e: React.DragEvent) => {
      if (!isText(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDragging("text");
    };
    return {
      onDragEnter: over,
      onDragOver: over,
      onDragLeave: (e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragging(null);
      },
      onDrop: (e) => {
        if (!isText(e)) return;
        e.preventDefault();
        const text = e.dataTransfer.getData("text/plain");
        void paste("text", () => text);
      },
    };
  }, [paste]);

  const hint = dragging ? (refusal?.[dragging] ?? (dragging === "files" ? "Drop to type the file's path" : "Drop to paste the text")) : null;
  return { hint, refused, zoneProps };
}

/** The overlay that names what a drop does, like the composer's, and why one was refused. */
export function TerminalDropHint({ drop }: { drop: TerminalDrop }) {
  if (drop.hint) {
    return (
      <div className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-2xl bg-composer/80 px-6 text-center text-sm text-muted-foreground ring-2 ring-accent/60">
        {drop.hint}
      </div>
    );
  }
  if (!drop.refused) return null;
  return (
    <div role="status" className="pointer-events-none absolute inset-x-3 bottom-3 z-20 rounded-lg bg-composer px-3 py-2 text-center text-xs text-muted-foreground shadow-surface hairline">
      {drop.refused}
    </div>
  );
}
