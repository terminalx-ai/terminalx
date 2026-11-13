// PRO-140: the contract between the native settings layer and the Settings UI.
// Native commands that return these shapes:
//   settings_file_status, update_user_preferences, create_settings_file,
//   reset_user_setting { key }            -> SettingsFileStatus (src/lib/settingsFile.ts)
//   settings_files_list { projectPath }   -> SettingsFileLayer[] (highest layer first)
//   configuration_resolve { projectPath } -> Configuration, each value with `layers`
import type { ConfigurationLayer } from "./configuration";

/** What a problem in a settings file does to the values it holds. */
export type SettingsFileEffect =
  /** User file: the last good value of each invalid entry stays in effect. */
  | "lastGood"
  /** A key this build does not know (or a repository file may not set) is ignored; the rest apply. */
  | "ignoredKey"
  /** A malformed shared repository file: none of its values apply until it is fixed. */
  | "fileIgnored"
  /** A malformed local repository file or managed policy: launches that resolve it are refused. */
  | "blocked";

/** One error in one settings file, as the file's own editor would point at it. */
export interface SettingsFileProblem {
  /** Dotted key such as "preferences.theme" or "scripts.teardown"; null when the JSON itself does not parse. */
  key: string | null;
  /** 1-based line in the file; null when unknown. */
  line: number | null;
  /** The parser's or validator's own words, e.g. "Unexpected “,” before “}”" or "isn’t a setting". */
  message: string;
  effect: SettingsFileEffect;
}

/** One layer of the settings a project resolves, for Settings files. Never carries values. */
export interface SettingsFileLayer {
  layer: ConfigurationLayer;
  /** Absolute path; null for defaults. */
  path: string | null;
  /** The path with the home directory written as "~"; null for defaults. */
  displayPath: string | null;
  exists: boolean;
  /** Number of top-level settings keys the file sets (0 when absent or unreadable). */
  keys: number;
  /** Repository files only: "committed" (tracked by Git), "ignored" (git-ignored), "untracked"; null otherwise. */
  git: "committed" | "ignored" | "untracked" | null;
  problem: SettingsFileProblem | null;
}
