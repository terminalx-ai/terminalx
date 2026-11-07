import { invoke } from "./api";
import type { Configuration, ConfigurationLayer } from "@/types/configuration";
export type { Configuration, ConfigurationLayer } from "@/types/configuration";
export const configuration = {
  resolve: (projectPath: string | null) => invoke<Configuration>("configuration_resolve", { projectPath }),
  write: (projectPath: string | null, layer: ConfigurationLayer, key: string, value: unknown) => invoke<void>("configuration_write", { projectPath, layer, key, value }),
  review: (projectPath: string) => invoke<boolean>("configuration_review", { projectPath }),
};
export const layerLabels: Record<ConfigurationLayer, string> = { defaults: "Default", user: "User", repositoryShared: "Repository shared", repositoryLocal: "Repository local", managed: "Managed" };
