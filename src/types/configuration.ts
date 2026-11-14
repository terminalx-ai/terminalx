export type ConfigurationLayer = "defaults" | "user" | "repositoryShared" | "repositoryLocal" | "managed";
/** One layer's own value for a key. Environment values are always `value: null, redacted: true`. */
export interface ConfigurationLayerValue { layer: ConfigurationLayer; value: unknown; redacted: boolean }
export interface ConfigurationValue {
  value: unknown; source: ConfigurationLayer; locked: boolean; redacted: boolean;
  /** PRO-140: every layer that supplies this key, highest first (managed … defaults); the first is `source`. */
  layers: ConfigurationLayerValue[];
}
export interface Configuration {
  values: Record<string, ConfigurationValue>;
  registry: { key: string; repositoryConfigurable: boolean; managedLockable: boolean; requiresTrust: boolean }[];
  warnings: string[];
  trust: { hash: string; required: boolean; keys: string[] } | null;
}
