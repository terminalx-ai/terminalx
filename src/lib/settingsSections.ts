import { getExperimentalSettings } from "@/lib/experimentalSettings";
import type { SettingRegistration } from "@/components/settings/settingsRegistry";

// The pages ⌘K lists; searching goes by row (settingsSearch.ts), whose metadata lives in settingsRegistry.
export const SETTINGS_SECTIONS = [
  { id: "account", title: "Account", description: "Sign in, profile and account diagnostics", terms: ["login email subscription"] },
  { id: "devices", title: "Devices", description: "Pair a phone and manage connected devices", terms: ["mobile pairing remote revoke"] },
  { id: "general", title: "General", description: "Data privacy, website links, sounds, chat and worktree defaults", terms: ["browser link actions command line cli pixel raccoon fold tool calls files changed prompt map autocorrect quick chat floating window cloud control user settings file json config preferences reload layered configuration trust managed locked branch prefix"] },
  { id: "appearance", title: "Appearance", description: "Themes, font size, transcript layout and status bar", terms: ["text size light dark mode tabs branches usage resources refresh percent custom order drag reorder sidebar sessions projects"] },
  { id: "projects", title: "Project templates", description: "Starting points for new projects: built in or added from a folder", terms: ["template templates quick start create a project new project starter folder vite react agent"] },
  { id: "repositories", title: "Projects", description: "Project paths, preview URLs, files to copy, scripts, actions and workspace cleanup", terms: ["repositories repository project git root worktrees ignored glob patterns env worktreeinclude setup archive hooks terminal"] },
  { id: "organizations", title: "Organizations", description: "Members, cloud workspaces and organization settings", terms: ["team invite billing compute environment agent logins routes github setup"] },
  { id: "agents", title: "Agents", description: "Install and sign in to agents, permissions and skills", terms: ["claude codex gemini approval idle archive computer use browser runtime"] },
  { id: "orchestrator", title: "Orchestrator", description: "Runs a lead session splits across workers: approval, limits, budget and worker permissions", terms: ["orchestration run plan pieces lead workers approve bypass deny rules", "queue concurrent budget points dollars window stall"] },
  { id: "environment", title: "Environment", description: "User and repository variables for local agents and shells", terms: ["env dotenv secrets keychain overrides import"] },
  { id: "transcription", title: "Transcription", description: "Dictation, microphone and speech models", terms: ["voice recording audio mute noise personalization language download"] },
  { id: "integrations", title: "Integrations", description: "Connect GitHub and Linear for issues and pull requests", terms: ["token api key login"] },
  { id: "storage", title: "Storage", description: "Clean up merged worktrees and leftover files", terms: ["disk space remove delete cleanup"] },
  { id: "shortcuts", title: "Shortcuts", description: "Customize keyboard shortcuts", terms: ["key bindings hotkeys"] },
  { id: "experimental", title: "Experimental", description: "Try Native Codex, session cost and orchestration runs", terms: ["app server stdio", "session cost", "tokens", "orchestrator lead workers"] },
  { id: "about", title: "About", description: "Version, updates and changelog", terms: ["release channel beta"] },
] as const;

export type SettingsTab = (typeof SETTINGS_SECTIONS)[number]["id"];

/** A section behind a switch in Settings → Experimental is found only while the switch is on. Shared with the row search. */
export function settingsSectionOffered(tab: SettingsTab): boolean {
  return tab !== "orchestrator" || getExperimentalSettings()?.orchestratorRuns === true;
}

/**
 * Whether a row is shown, and so findable: its section is offered and, when the
 * row names an Experimental switch (`requires`), that switch is on. Off until
 * the switches are read, as everywhere else.
 */
export function settingOffered(row: Pick<SettingRegistration, "section" | "requires">): boolean {
  return settingsSectionOffered(row.section) && (!row.requires || getExperimentalSettings()?.[row.requires] === true);
}
