import { Channel, invoke } from "@tauri-apps/api/core";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";

export interface Update {
  version: string;
  /**
   * Download, then install. `beforeInstall` runs between the two: on Windows the installer ends this process, so
   * anything for the relaunched app is said before it starts.
   */
  downloadAndInstall(progress: (event: DownloadEvent) => void, beforeInstall?: () => Promise<void>): Promise<void>;
}

/** Both native calls retain privacy admission through the plugin transport. */
export async function check({ headers }: { headers: { "X-Raccoon-Channel": string } }): Promise<Update | null> {
  const found = await invoke<{ id: string; version: string } | null>("app_update_check", { channel: headers["X-Raccoon-Channel"] });
  if (!found) return null;
  return {
    version: found.version,
    async downloadAndInstall(onmessage, beforeInstall) {
      const progress = new Channel<DownloadEvent>();
      progress.onmessage = onmessage;
      await invoke("app_update_download", { id: found.id, progress });
      await beforeInstall?.();
      await invoke("app_update_apply", { id: found.id });
    },
  };
}
