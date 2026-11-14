import { indexPaletteItem, rankPaletteItems } from "@/lib/commandPalette";

// Search currently navigates sections; individual row metadata lives in settingsRegistry.
export const SETTINGS_SECTIONS = [
  { id: "account", title: "Account", description: "Sign in, profile and account diagnostics", terms: ["login email subscription"] },
  { id: "devices", title: "Devices", description: "Pair a phone and manage connected devices", terms: ["mobile pairing remote revoke"] },
  { id: "general", title: "General", description: "Website links, sounds, chat and worktree defaults", terms: ["browser link actions command line cli pixel raccoon fold tool calls files changed prompt map autocorrect quick chat floating window cloud control user settings file json config preferences reload layered configuration trust managed locked branch prefix"] },
  { id: "appearance", title: "Appearance", description: "Themes, font size, transcript layout and status bar", terms: ["text size light dark mode tabs branches usage resources refresh percent custom order drag reorder sidebar sessions projects"] },
  { id: "projects", title: "Projects", description: "Starting points for new projects: built in or added from a folder", terms: ["template templates quick start create a project new project starter folder vite react agent"] },
  { id: "repositories", title: "Repositories", description: "Repository paths, files to copy, scripts and workspace cleanup", terms: ["project git root worktrees ignored glob patterns env worktreeinclude setup archive hooks terminal"] },
  { id: "organizations", title: "Organizations", description: "Members, cloud workspaces and organization settings", terms: ["team invite billing compute environment agent logins routes github setup"] },
  { id: "agents", title: "Agents", description: "Install and sign in to agents, permissions and skills", terms: ["claude codex gemini approval idle archive computer use browser runtime"] },
  { id: "environment", title: "Environment", description: "User and repository variables for local agents and shells", terms: ["env dotenv secrets keychain overrides import"] },
  { id: "localVms", title: "Local VMs", description: "Set up a local Cua VM and run selected tasks in it", terms: ["vm virtual machine cua lume sandbox guest macos linux environments"] },
  { id: "transcription", title: "Transcription", description: "Dictation, microphone and speech models", terms: ["voice recording audio mute noise personalization language download"] },
  { id: "integrations", title: "Integrations", description: "Connect GitHub and Linear for issues and pull requests", terms: ["token api key login"] },
  { id: "storage", title: "Storage", description: "Clean up merged worktrees and leftover files", terms: ["disk space remove delete cleanup"] },
  { id: "shortcuts", title: "Shortcuts", description: "Customize keyboard shortcuts", terms: ["key bindings hotkeys"] },
  { id: "experimental", title: "Experimental", description: "Try Native Codex", terms: ["app server stdio"] },
  { id: "about", title: "About", description: "Version, updates and changelog", terms: ["release channel beta"] },
] as const;

export type SettingsTab = (typeof SETTINGS_SECTIONS)[number]["id"];

const sectionIndex = SETTINGS_SECTIONS.map((section) => indexPaletteItem({
  id: `settings-section:${section.id}`,
  group: "settings",
  tab: section.id,
  primary: section.title,
  secondary: section.description,
  recentAt: 0,
}, [...section.terms]));

export function searchSettingsSections(query: string) {
  return rankPaletteItems(sectionIndex, query).slice(0, 30);
}
