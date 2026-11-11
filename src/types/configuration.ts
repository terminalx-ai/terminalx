export type ConfigurationLayer = "defaults" | "user" | "repositoryShared" | "repositoryLocal" | "managed";
export interface ConfigurationValue { value: unknown; source: ConfigurationLayer; locked: boolean; redacted: boolean }
export interface Configuration {
  values: Record<string, ConfigurationValue>;
  registry: { key: string; repositoryConfigurable: boolean; managedLockable: boolean; requiresTrust: boolean }[];
  warnings: string[];
  trust: { hash: string; required: boolean; keys: string[] } | null;
}
