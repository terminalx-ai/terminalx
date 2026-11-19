import { getExperimentalSettings } from "@/lib/experimentalSettings";
import type { SettingRegistration } from "@/components/settings/settingsRegistry";

// The pages ⌘K lists; searching goes by row (settingsSearch.ts), whose metadata lives in settingsRegistry.
// In the order design 07.05 draws the pages it has (General first, then Account, Appearance, Shortcuts,
// Integrations, Devices, Agents, Environment), each page the design does not draw after the one it sits with
// in Settings. The names are the ones Settings gives its pages, so a row here and the page it opens read the same.
export const SETTINGS_SECTIONS = [
  { id: "general", title: "General", description: "Data privacy, website links, text size, tab bar, status bar, sounds, chat and worktree defaults", terms: ["text size font transcript layout tab bar branches usage resources refresh percent custom order drag reorder sidebar sessions projects status bar browser link actions command line cli pixel raccoon fold tool calls files changed prompt map autocorrect quick chat floating window cloud control user settings file json config preferences reload layered configuration trust managed locked branch prefix"] },
  { id: "account", title: "Account", description: "Sign in, profile and account diagnostics", terms: ["login email subscription"] },
  { id: "appearance", title: "Appearance", description: "Theme, light or dark mode and colored sidebar diffs", terms: ["light dark mode theme colors colours sidebar diffs line counts"] },
  { id: "shortcuts", title: "Shortcuts", description: "Customize keyboard shortcuts", terms: ["key bindings hotkeys"] },
  { id: "integrations", title: "Integrations", description: "Connect GitHub and Linear for issues and pull requests", terms: ["token api key login"] },
  { id: "devices", title: "Devices", description: "Pair a phone and manage connected devices", terms: ["mobile pairing remote revoke"] },
  { id: "machines", title: "Machines", description: "Let other computers operate this Mac, and add machines to operate", terms: ["operate remote computer pairing code fingerprint revoke mac mini server"] },
  { id: "agents", title: "Agents", description: "Install and sign in to agents, permissions and skills", terms: ["claude codex gemini approval idle archive computer use browser runtime"] },
  { id: "orchestrator", title: "Orchestrator", description: "Runs a lead session splits across workers: approval, limits, budget and worker permissions", terms: ["orchestration run plan pieces lead workers approve bypass deny rules", "queue concurrent budget points dollars window stall"] },
  { id: "environment", title: "Environment", description: "User and repository variables for local agents and shells", terms: ["env dotenv secrets keychain overrides import"] },
  { id: "localVms", title: "Local VMs", description: "Set up a local Cua VM and run selected tasks in it", terms: ["vm virtual machine cua lume sandbox guest macos linux environments"] },
  { id: "transcription", title: "Transcription", description: "Dictation, microphone and speech models", terms: ["voice recording audio mute noise personalization language download"] },
  { id: "projects", title: "Project templates", description: "Starting points for new projects: built in or added from a folder", terms: ["template templates quick start create a project new project starter folder vite react agent"] },
  { id: "repositories", title: "Projects", description: "Project paths, preview URLs, files to copy, scripts, actions and workspace cleanup", terms: ["repositories repository project git root worktrees ignored glob patterns env worktreeinclude setup archive hooks terminal"] },
  { id: "organizations", title: "Organizations", description: "Members, cloud workspaces and organization settings", terms: ["team invite billing compute environment agent logins routes github setup"] },
  { id: "storage", title: "Storage", description: "Clean up merged worktrees and leftover files", terms: ["disk space remove delete cleanup"] },
  { id: "experimental", title: "Experimental", description: "Try Native Codex, session cost, orchestration runs, Local VM tasks and OpenCode", terms: ["app server stdio", "session cost", "tokens", "orchestrator lead workers", "local vm tasks computer", "opencode providers models"] },
  { id: "advanced", title: "Advanced", description: "Which Claude Code and Codex programs TerminalX runs", terms: ["executable binary path program use system claude code codex homebrew npm"] },
  { id: "about", title: "About", description: "Version, updates and changelog", terms: ["release channel beta"] },
] as const;

export type SettingsTab = (typeof SETTINGS_SECTIONS)[number]["id"];

/** A section behind a switch in Settings → Experimental is found only while the switch is on. Shared with the row search. */
export function settingsSectionOffered(tab: SettingsTab): boolean {
  if (tab === "orchestrator") return getExperimentalSettings()?.orchestratorRuns === true;
  if (tab === "localVms") return getExperimentalSettings()?.localVmTasks === true;
  return true;
}

/**
 * Whether a row is shown, and so findable: its section is offered and, when the
 * row names an Experimental switch (`requires`), that switch is on. Off until
 * the switches are read, as everywhere else.
 */
export function settingOffered(row: Pick<SettingRegistration, "section" | "requires">): boolean {
  return settingsSectionOffered(row.section) && (!row.requires || getExperimentalSettings()?.[row.requires] === true);
}
