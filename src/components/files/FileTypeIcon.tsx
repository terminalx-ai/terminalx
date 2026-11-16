import { useSyncExternalStore } from "react";

type Pack = typeof import("react-material-icon-theme");

/**
 * File and folder glyphs from the Material icon set, matched on file name
 * the way an editor's explorer does. The pack inlines every icon (about a
 * megabyte), which would be the largest thing on the boot path for a row of
 * 16px decorations, so it is fetched after first paint; until it lands each
 * icon is a same-sized blank, so nothing reflows when the glyphs arrive.
 */
let pack: Pack | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function ensureLoaded() {
  if (pack || loading) return;
  loading = import("react-material-icon-theme").then((mod) => {
    pack = mod;
    for (const l of listeners) l();
  });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  ensureLoaded();
  return () => {
    listeners.delete(cb);
  };
}

const snapshot = () => pack;

export function FileTypeIcon({
  name,
  isDir,
  isOpen = false,
  isRoot = false,
  size = 16,
  className,
}: {
  name: string;
  isDir: boolean;
  isOpen?: boolean;
  isRoot?: boolean;
  size?: number;
  className?: string;
}) {
  const icons = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!icons) {
    return <span aria-hidden className={className} style={{ display: "inline-block", width: size, height: size, flexShrink: 0 }} />;
  }
  if (isDir) {
    return <icons.FolderIcon folderName={name} isOpen={isOpen} isRoot={isRoot} size={size} className={className} />;
  }
  const lower = name.toLowerCase();
  return <icons.FileIcon fileName={lower} fileExtension={knownExtension(lower, (ext) => icons.getFileIcon({ fileExtension: ext }) !== "file")} size={size} className={className} />;
}

/**
 * The extension the pack has an icon for: the longest one the name ends
 * with, so `scripts.test.ts` is a test file and `scripts.ts` TypeScript. The
 * pack matches a whole file name on its own (`bun.lock`), in lower case, but
 * an extension only when it is handed one, and it never takes it from the
 * name; without this every `.tsx`, `.json` or `.md` drew the same blank page.
 */
export function knownExtension(name: string, known: (ext: string) => boolean): string | undefined {
  const parts = name.toLowerCase().split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    if (ext && known(ext)) return ext;
  }
  return undefined;
}
