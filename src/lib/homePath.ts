import { useEffect, useState } from "react";

/** The home directory written as `~`, the way the design shows paths. */
export function homeShort(path: string, home: string | null): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/** The reader's home directory, so paths under it can be written with `~`. Null until known, or outside the app. */
export function useHome(): string | null {
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void import("@tauri-apps/api/path").then((paths) => paths.homeDir()).then((dir) => live && setHome(dir.replace(/\/+$/, ""))).catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return home;
}
