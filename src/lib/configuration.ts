import { Channel, Resource } from "@tauri-apps/api/core";
import { invoke } from "./api";
import type { Configuration, ConfigurationLayer } from "@/types/configuration";
import type { SettingsFileLayer } from "@/types/settingsSources";
export type { Configuration, ConfigurationLayer } from "@/types/configuration";
export const configuration = {
  watch: async (projectPath: string | null, changed: () => void): Promise<() => void> => {
    const channel = new Channel<null>();
    channel.onmessage = changed;
    const resource = new Resource(await invoke<number>("configuration_watch", { projectPath, onChange: channel }));
    return () => { channel.onmessage = () => {}; void resource.close().catch(() => {}); };
  },
  resolve: (projectPath: string | null) => invoke<Configuration>("configuration_resolve", { projectPath }),
  write: (projectPath: string | null, layer: ConfigurationLayer, key: string, value: unknown) => invoke<void>("configuration_write", { projectPath, layer, key, value }),
  review: (projectPath: string) => invoke<boolean>("configuration_review", { projectPath }),
  /** PRO-140: every settings file the project resolves, highest first (user and defaults without a project). */
  files: (projectPath: string | null) => invoke<SettingsFileLayer[]>("settings_files_list", { projectPath }),
};
export const layerLabels: Record<ConfigurationLayer, string> = { defaults: "Default", user: "User", repositoryShared: "Repository shared", repositoryLocal: "Repository local", managed: "Managed" };
