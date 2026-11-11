import { Channel, invoke } from "@tauri-apps/api/core";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";

export interface Update {
  version: string;
  downloadAndInstall(progress: (event: DownloadEvent) => void): Promise<void>;
}

/** Both native calls retain privacy admission through the plugin transport. */
export async function check({ headers }: { headers: { "X-Raccoon-Channel": string } }): Promise<Update | null> {
  const found = await invoke<{ id: string; version: string } | null>("app_update_check", { channel: headers["X-Raccoon-Channel"] });
  if (!found) return null;
  return {
    version: found.version,
    downloadAndInstall(onmessage) {
      const progress = new Channel<DownloadEvent>();
      progress.onmessage = onmessage;
      return invoke("app_update_install", { id: found.id, progress });
    },
  };
}
