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
  return <icons.FileIcon fileName={name} size={size} className={className} />;
}
