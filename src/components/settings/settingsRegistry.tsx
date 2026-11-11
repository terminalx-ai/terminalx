import { cloneElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { SettingRow } from "@/components/ui/controls";
import { SHORTCUT_ACTIONS } from "@/lib/shortcuts";

export const NATIVE_CODEX_DESCRIPTION =
  "New Codex sessions connect to Codex directly instead of running it in a terminal, so the chat reliably shows when Codex is compacting its context. The chat is the main view: opening a session's terminal view moves that session to Codex's own terminal for good. Needs Codex 0.164.0 or newer; otherwise new sessions use the terminal as usual. Existing sessions and other agents are not changed.";

export const SETTINGS_GROUPS = ["Personal", "Agents & environment", "Repositories", "Admin", "More"] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];
export const SETTINGS_SECTIONS = {
  account: { title: "Account", group: "Personal", entry: "account.identity" },
  devices: { title: "Devices", group: "Personal", entry: "devices.pairing" },
  general: { title: "General", group: "Personal", entry: "general.websiteLinks" },
  appearance: { title: "Appearance", group: "Personal", entry: "appearance.theme" },
  agents: { title: "Agents", group: "Agents & environment", entry: "agents.setup" },
  environment: { title: "Environment", group: "Agents & environment", entry: "environment.variables" },
  transcription: { title: "Transcription", group: "Agents & environment", entry: "transcription.model" },
  integrations: { title: "Integrations", group: "Agents & environment", entry: "integrations.github" },
  projects: { title: "Projects", group: "Repositories", entry: "projects.templates" },
  repositories: { title: "Repositories", group: "Repositories", entry: "repositories.rootPath" },
  organizations: { title: "Organizations", group: "Admin", entry: "organizations.sidebar" },
  storage: { title: "Storage", group: "More", entry: "storage.mergedCleanup" },
  shortcuts: { title: "Shortcuts", group: "More", entry: "shortcuts.systemWide" },
  experimental: { title: "Experimental", group: "More", entry: "experimental.nativeCodex" },
  about: { title: "About", group: "More", entry: "about.version" },
} as const satisfies Record<string, { title: string; group: SettingsGroup; entry: string }>;
export type SettingsSection = keyof typeof SETTINGS_SECTIONS;
export type SettingsScope = "user" | "repository" | "organization";
export interface SettingStorage {
  kind: "localStorage" | "file" | "system" | "service" | "action";
  /** Address of the existing store, never its contents. $TERMINALX_HOME defaults to ~/.raccoon. */
  location: string;
}
type RowProps = Omit<ComponentProps<typeof SettingRow>, "label" | "control"> & { label?: string; control?: ReactNode; instance?: string; children?: ReactElement };
interface SettingDefinition {
  id: string;
  section: SettingsSection;
  title: string;
  description: string;
  searchTerms: readonly string[];
  scope: SettingsScope;
  storage: SettingStorage;
  layout?: "row" | "content";
  /** Some existing rows have no visible help text; metadata remains searchable. */
  hideDescription?: boolean;
}
export interface SettingRegistration extends SettingDefinition {
  render: (props: RowProps) => ReactNode;
}

/** State stays with its existing owner. The registry owns row identity, copy and rendering;
 * adapters supply live controls and (only when needed) a status-dependent description.
 * Content rows retain the native structure of editors, lists and organization sections. */
function defineSetting<const T extends SettingDefinition>(definition: T): T & SettingRegistration {
  return { ...definition, render: ({ children, instance, ...props }) => {
    const anchor = { "data-setting-id": definition.id, "data-setting-instance": instance, tabIndex: -1 };
    if (definition.layout === "content") {
      return children ? cloneElement(children as ReactElement<Record<string, unknown>>, anchor) : null;
    }
    return <div {...anchor} className="min-w-0 outline-none"><SettingRow label={definition.title} description={definition.hideDescription ? undefined : definition.description} control={null} {...props} /></div>;
  } };
}

export const SETTINGS_ROWS = [
  defineSetting({
    id: "general.settingsFile", section: "general", title: "User settings file",
    description: "The user settings file reloads when edited. Create it here when absent.",
    searchTerms: ["settings", "file", "json", "config", "preferences", "reload"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json" },
  }),
  defineSetting({
    id: "general.layeredConfiguration", section: "general", title: "Layered configuration",
    description: "Resolve user, shared, local and managed settings; review repository trust and locked values.",
    searchTerms: ["configuration", "repository", "trust", "managed", "locked", "branch prefix"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json, system managed policy and .terminalx/settings*.json" }, layout: "content",
  }),
  defineSetting({
    id: "about.updates", section: "about", title: "Updates",
    description: "Beta gets builds earlier. Either way nothing installs without your say-so.",
    searchTerms: ["about", "updates"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.updateChannel" },
  }),
  defineSetting({
    id: "about.version", section: "about", title: "About TerminalX",
    description: "Installed version and third-party notices.",
    searchTerms: ["about", "about", "terminalx"], scope: "user",
    storage: { kind: "action", location: "Application bundle" }, layout: "content",
  }),
  defineSetting({
    id: "about.checkUpdates", section: "about", title: "Check for updates",
    description: "Check for a new version and choose when to install it.",
    searchTerms: ["about", "check", "for", "updates"], scope: "user",
    storage: { kind: "action", location: "Signed update feed" }, layout: "content",
  }),
  defineSetting({
    id: "about.changelog", section: "about", title: "Changelog",
    description: "Changes in each version of TerminalX.",
    searchTerms: ["about", "changelog"], scope: "user",
    storage: { kind: "action", location: "Bundled CHANGELOG.md" }, layout: "content",
  }),
  defineSetting({
    id: "account.workStatus", section: "account", title: "Show my team what I’m working on",
    description: "Teammates in an organization that connected a repository see which of its issues you have a session on: your name, the session’s title and branch, and whether an agent is working. Your other machines always see it, with this Mac’s name. Prompts, transcripts, paths and code never leave this Mac.",
    searchTerms: ["account", "show", "my", "team", "what", "i’m", "working", "on"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#workStatus.shareWithTeam" },
  }),
  defineSetting({
    id: "account.identity", section: "account", title: "TerminalX account",
    description: "Sign in or out of the optional TerminalX account.",
    searchTerms: ["account", "terminalx", "account"], scope: "user",
    storage: { kind: "system", location: "macOS Keychain" }, layout: "content",
  }),
  defineSetting({
    id: "account.machineName", section: "account", title: "This Mac’s name",
    description: "Name this computer for your paired devices.",
    searchTerms: ["account", "this", "mac’s", "name"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#machineName" }, layout: "content",
  }),
  defineSetting({
    id: "account.organizations", section: "account", title: "Organization membership",
    description: "Create, join, or open an organization.",
    searchTerms: ["account", "organization", "membership"], scope: "user",
    storage: { kind: "service", location: "TerminalX account organizations" }, layout: "content",
  }),
  defineSetting({
    id: "account.sharing", section: "account", title: "What this Mac shares",
    description: "Inspect the fields sent to the account directory.",
    searchTerms: ["account", "what", "this", "mac", "shares"], scope: "user",
    storage: { kind: "action", location: "Account binding status" }, layout: "content",
  }),
  defineSetting({
    id: "agents.skills", section: "agents", title: "Skills",
    description: "The skills your agents can use: what is installed, and what to add.",
    searchTerms: ["agents", "skills"], scope: "user",
    storage: { kind: "action", location: "Skills page" },
  }),
  defineSetting({
    id: "agents.followUps", section: "agents", title: "Follow-ups while the agent works",
    description: "For local desktop chats on this device. Held messages are not read mid-turn; they go one per finished turn. Idle messages send immediately. The “Send the other way” shortcut in Shortcuts reverses this choice: hold, or interrupt and send. Phone and cloud messages keep their current behavior.",
    searchTerms: ["queue", "hold", "follow-ups", "pause", "composer"], scope: "user",
    storage: { kind: "localStorage", location: "raccoon.prefs#followUps" },
  }),
  defineSetting({
    id: "agents.idleStop", section: "agents", title: "Stop idle agents after",
    description: "An agent sitting at its prompt still holds its memory, its MCP servers and its language server. Once it has had nothing to do for this long it is stopped; its conversation stays, and your next message starts it again where it left off. An agent at work, waiting for your answer, or waiting on something it started (a background command, monitor or agent, a wakeup or scheduled job, a process it left running) keeps running, and so does one you started yourself in a terminal. An agent in an archived session, or one whose workspace was removed, is stopped after 10 idle minutes.",
    searchTerms: ["agents", "stop", "idle", "after"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#agents.idleStopMinutes" },
  }),
  defineSetting({
    id: "agents.archiveIdle", section: "agents", title: "Archive conversations idle for",
    description: "A conversation nobody has written in for this long leaves the sidebar's list for its archive: View → Show archived lists it under its project, and the command palette still finds it. Nothing is deleted, and its next message brings it back. A conversation stays while it is pinned or open, while any of its tabs is working, waiting for you or holding a queued message, while its last reply is unread, while its worktree has uncommitted or unpushed work, and while its issue pipeline's pull request is open.",
    searchTerms: ["agents", "archive", "conversations", "idle", "for"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#conversations.archiveIdleDays" },
  }),
  defineSetting({
    id: "agents.readOnlyCommands", section: "agents", title: "Allow read-only commands in Ask mode",
    description: "Run common discovery commands without an approval card: ls, cat, rg, grep, pwd, and git status, diff and log. Every command in a chain or pipe must qualify. Redirects, shell expansions, unknown options and commands that can run helpers still ask. Turn this off to ask for every command. Commands you explicitly allow for a session keep that allowance in the approved directory until TerminalX restarts.",
    searchTerms: ["agents", "allow", "read-only", "commands", "in", "ask", "mode"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#agents.readOnlyCommands" },
  }),
  defineSetting({
    id: "agents.cliSkill", section: "agents", title: "TerminalX agent skill",
    description: "Install version-matched CLI and computer-use discovery guides.",
    searchTerms: ["agents", "terminalx", "agent", "skill"], scope: "user",
    storage: { kind: "file", location: "~/.claude/skills, ~/.codex/skills" }, layout: "content",
  }),
  defineSetting({
    id: "agents.setup", section: "agents", title: "Installed agents",
    description: "Install, sign in to, and re-check local agents.",
    searchTerms: ["agents", "installed", "agents"], scope: "user",
    storage: { kind: "system", location: "Agent CLI installations and credentials" }, layout: "content",
  }),
  defineSetting({
    id: "appearance.theme", hideDescription: true, section: "appearance", title: "Theme",
    description: "Choose the application color palette.",
    searchTerms: ["appearance", "theme"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.theme" },
  }),
  defineSetting({
    id: "appearance.mode", section: "appearance", title: "Mode",
    description: "System follows macOS and switches with it.",
    searchTerms: ["appearance", "mode"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.mode" },
  }),
  defineSetting({
    id: "appearance.textSize", section: "appearance", title: "Text size",
    description: "Scales the transcript and composer. Chrome stays the same size.",
    searchTerms: ["appearance", "text", "size"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.fontScale" },
  }),
  defineSetting({
    id: "appearance.transcriptLayout", section: "appearance", title: "Transcript layout",
    description: "Wide puts your prompt as a full-width card. Chat right-aligns it like a message.",
    searchTerms: ["appearance", "transcript", "layout"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.transcriptLayout" },
  }),
  defineSetting({
    id: "appearance.customOrder", section: "appearance", title: "Custom order",
    description: "Use your saved arrangement in this window; row order is shared across windows. Arrange sessions and projects with their drag handles. Press Space to pick up, arrows to move, Space to drop, or Escape to cancel. Pins do not change custom order. Off restores pin and recency order and keeps your arrangement.",
    searchTerms: ["appearance", "custom order", "drag", "reorder", "sidebar", "sessions", "projects"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/sessions/index.json#sidebarOrder" },
  }),
  defineSetting({
    id: "appearance.tabBar", section: "appearance", title: "Tab bar",
    description: "A session's agents, terminals and browser pages as a row of tabs under the title bar, in the same order as the sidebar. Off leaves them in the sidebar only.",
    searchTerms: ["appearance", "tab", "bar"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.tabStrip" },
  }),
  defineSetting({
    id: "appearance.branchSessions", section: "appearance", title: "Sessions on a branch",
    description: "Several sessions on one branch: as tabs beside each other in the tab bar, with one row for the branch in the sidebar; or listed under the branch in the sidebar, with the tab bar holding only the open session's tabs. Without the tab bar they are in the sidebar.",
    searchTerms: ["appearance", "sessions", "on", "a", "branch"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.branchSessions" },
  }),
  defineSetting({
    id: "appearance.colourLineCounts", section: "appearance", title: "Colour line counts on every row",
    description: "Use green and red for added and removed lines even when the sidebar row is not selected.",
    searchTerms: ["sidebar", "diff", "lines", "color", "colour"], scope: "user",
    storage: { kind: "localStorage", location: "raccoon.prefs#colourLineCounts" },
  }),
  defineSetting({
    id: "appearance.openUsage", section: "appearance", title: "Usage",
    description: "Tokens, cost and rate limits across every agent, by day and by project.",
    searchTerms: ["appearance", "usage"], scope: "user",
    storage: { kind: "action", location: "Usage page" },
  }),
  defineSetting({
    id: "appearance.statusBar", section: "appearance", title: "Status bar",
    description: "Show app-wide agent usage and the resources used by live tabs along the bottom edge.",
    searchTerms: ["appearance", "status", "bar"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#statusBar.visible" },
  }),
  defineSetting({
    id: "appearance.usage", section: "appearance", title: "Usage",
    description: "Show the tightest usage window and its reset countdown.",
    searchTerms: ["appearance", "usage"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#statusBar.usage" },
  }),
  defineSetting({
    id: "appearance.resources", section: "appearance", title: "Resources",
    description: "Show the live agent count and the most recently sampled memory total.",
    searchTerms: ["appearance", "resources"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#statusBar.resources" },
  }),
  defineSetting({
    id: "appearance.usageDisplay", section: "appearance", title: "Usage display",
    description: "Meters can show what has been used or what remains; urgency always follows usage.",
    searchTerms: ["appearance", "usage", "display"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#statusBar.percent" },
  }),
  defineSetting({
    id: "appearance.usageRefresh", section: "appearance", title: "Usage auto-refresh interval",
    description: "How often usage is fetched again while the app is on screen. Off still refreshes when you return to the app or press Refresh.",
    searchTerms: ["appearance", "usage", "auto-refresh", "interval"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#statusBar.usageRefreshMinutes" },
  }),
  defineSetting({
    id: "devices.pairing", section: "devices", title: "Pair a phone",
    description: "Choose Relay or LAN and create a one-time pairing code.",
    searchTerms: ["devices", "pair", "a", "phone"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/devices.json" }, layout: "content",
  }),
  defineSetting({
    id: "devices.paired", section: "devices", title: "Paired devices",
    description: "Inspect and revoke devices paired with this computer.",
    searchTerms: ["devices", "paired", "devices"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/devices.json" }, layout: "content",
  }),
  defineSetting({
    id: "environment.variables", section: "environment", title: "Environment variables",
    description: "Variables for new local agent and shell tabs. Repository values override user values. All values are stored in Keychain on this Mac.",
    searchTerms: ["environment", "variables", "env", "dotenv", "secrets", "keychain", "repository", "overrides", "import"], scope: "user",
    storage: { kind: "system", location: "macOS Keychain (values); $TERMINALX_HOME/environment.json (names and revisions)" }, layout: "content",
  }),
  defineSetting({
    id: "experimental.nativeCodex", section: "experimental", title: "Native Codex",
    description: NATIVE_CODEX_DESCRIPTION,
    searchTerms: ["experimental", "native", "codex"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#experimental.nativeCodex" },
  }),
  defineSetting({
    id: "general.websiteLinks", section: "general", title: "Website links",
    description: "Choose a browser for website links, or ask each time.",
    searchTerms: ["general", "website", "links"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.linkBrowser, preferences.linkBrowserChosen" },
  }),
  defineSetting({
    id: "general.linkActions", section: "general", title: "Link actions",
    description: "Show both browser destinations in the link action menu.",
    searchTerms: ["general", "link", "actions"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.linkActions" },
  }),
  defineSetting({
    id: "general.cloudControl", section: "general", title: "Let agents in local sessions control cloud workspaces",
    description: "Allow the command line to see and change cloud workspaces, with the existing native confirmation.",
    searchTerms: ["general", "let", "agents", "in", "local", "sessions", "control", "cloud", "workspaces"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/cloud-control.json" },
  }),
  defineSetting({
    id: "general.commandLine", section: "general", title: "Command line tool",
    description: "Install terminalx and its tnx alias in ~/.local/bin so shells and agents can control this app.",
    searchTerms: ["general", "command", "line", "tool"], scope: "user",
    storage: { kind: "file", location: "~/.local/bin/terminalx, ~/.local/bin/tnx" },
  }),
  defineSetting({
    id: "general.sounds", section: "general", title: "Sounds",
    description: "A short tone when a session finishes or asks for you. Silent while another app has focus; the desktop notification makes its own noise there.",
    searchTerms: ["general", "sounds"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.sounds" },
  }),
  defineSetting({
    id: "general.animations", section: "general", title: "Pixel raccoon",
    description: "The raccoon forages in an empty session and runs along the composer while an agent is working. Off follows your system's reduced-motion setting automatically.",
    searchTerms: ["general", "pixel", "raccoon"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.animations" },
  }),
  defineSetting({
    id: "general.foldToolCalls", section: "general", title: "Fold tool calls",
    description: "Once an agent starts answering, the tool calls it made collapse under one line. Off (the default) keeps every step in view.",
    searchTerms: ["general", "fold", "tool", "calls"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.foldToolCalls" },
  }),
  defineSetting({
    id: "general.turnChanges", section: "general", title: "Show files changed",
    description: "Under each finished turn, the files the agent changed with the lines it added and removed. Click a file to open it.",
    searchTerms: ["general", "show", "files", "changed"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.turnChanges" },
  }),
  defineSetting({
    id: "general.fixErrorsInstructions", section: "general", title: "Fix errors instructions",
    description: "Extra instructions sent to the agent with failed CI logs when you choose Fix errors.",
    searchTerms: ["CI", "checks", "GitHub", "fix", "errors", "prompt", "instructions"], scope: "user",
    storage: { kind: "localStorage", location: "raccoon.prefs#fixErrorsInstructions" },
  }),
  defineSetting({
    id: "general.promptMap", section: "general", title: "Prompt map",
    description: "A mark for each of your prompts down the right edge of a conversation. Hover one to read it, click to go back to it.",
    searchTerms: ["general", "prompt", "map"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.promptMap" },
  }),
  defineSetting({
    id: "general.autocorrect", section: "general", title: "Autocorrect",
    description: "Your keyboard's spelling correction, smart quotes and dashes, and text replacements apply in prompts, answers to an agent's questions, and notes. Off leaves what you type exactly as typed.",
    searchTerms: ["general", "autocorrect"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.autocorrect" },
  }),
  defineSetting({
    id: "general.useWorktree", section: "general", title: "New sessions use a worktree",
    description: "Each session gets its own git worktree so agents never step on each other. Off runs sessions in the project's own checkout.",
    searchTerms: ["general", "new", "sessions", "use", "a", "worktree"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.useWorktree" },
  }),
  defineSetting({
    id: "general.browser", section: "general", title: "Built-in browser",
    description: "Install and inspect the built-in agent-browser and Chromium runtime.",
    searchTerms: ["general", "built-in", "browser"], scope: "user",
    storage: { kind: "file", location: "agent-browser runtime and browser installation" },
  }),
  defineSetting({
    id: "general.startupDiagnostics", section: "general", title: "Local startup diagnostics",
    description: "Inspect suspected child-process startup stalls, adjust thresholds, run one health probe and preview a redacted local report.",
    searchTerms: ["startup", "stall", "diagnostics", "incident", "macos", "health", "report"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/startup/incidents.json" },
  }),
  defineSetting({
    id: "general.floatingOnTop", section: "general", title: "Keep the floating window on top",
    description: "The floating chat window stays above other apps’ windows. Off lets it go behind them like any other window; the pin in the window does the same.",
    searchTerms: ["general", "keep", "the", "floating", "window", "on", "top"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#floating.alwaysOnTop" },
  }),
  defineSetting({
    id: "general.quickChatRetention", section: "general", title: "Keep idle quick chats for",
    description: "A quick chat nobody has touched for this long is deleted with its scratch folder. Pinned and archived chats, and one with a terminal still running, are kept. You can always delete one by hand.",
    searchTerms: ["general", "keep", "idle", "quick", "chats", "for"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#floating.retentionDays" },
  }),
  defineSetting({
    id: "general.computerUse", section: "general", title: "Computer use",
    description: "Desktop requirements for agents on this platform.",
    searchTerms: ["general", "computer", "use"], scope: "user",
    storage: { kind: "system", location: "OS permissions" },
  }),
  defineSetting({
    id: "general.quitBehavior", section: "general", title: "When quitting TerminalX",
    description: "Keep agents running in the background or stop them when quitting.",
    searchTerms: ["general", "when", "quitting", "terminalx"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#quitBehavior" }, layout: "content",
  }),
  defineSetting({
    id: "integrations.github", section: "integrations", title: "GitHub",
    description: "Issues and pull requests use the GitHub CLI login.",
    searchTerms: ["integrations", "github"], scope: "user",
    storage: { kind: "system", location: "GitHub CLI credentials" }, layout: "content",
  }),
  defineSetting({
    id: "integrations.linear", section: "integrations", title: "Linear",
    description: "Connect a personal API key for Linear issues.",
    searchTerms: ["integrations", "linear"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#linearApiKey" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.sidebar", section: "organizations", title: "Organizations in sidebar",
    description: "Local is always shown. These display preferences are saved on this desktop. Showing or switching organizations never wakes a workspace.",
    searchTerms: ["organizations", "in", "sidebar"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.organizationDisplay, preferences.selectedOrganization" },
  }),
  defineSetting({
    id: "organizations.organization", section: "organizations", title: "Organization",
    description: "Open an organization’s settings and choose whether it appears in the sidebar.",
    searchTerms: ["organizations", "organization"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.hiddenOrganizations" },
  }),
  defineSetting({
    id: "organizations.members", section: "organizations", title: "Members",
    description: "Members, invitations and roles.",
    searchTerms: ["organizations", "members"], scope: "organization",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.compute", section: "organizations", title: "Compute",
    description: "Cloud providers, workspaces and usage.",
    searchTerms: ["organizations", "compute"], scope: "organization",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.agentLogins", section: "organizations", title: "Agent logins",
    description: "Sign in to agents for this organization.",
    searchTerms: ["organizations", "agent", "logins"], scope: "organization",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.agentRoutes", section: "organizations", title: "Model access",
    description: "Choose model routes and provider access.",
    searchTerms: ["organizations", "model", "access"], scope: "organization",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.console", section: "organizations", title: "Organization console",
    description: "API keys and webhooks in the organization console.",
    searchTerms: ["organizations", "organization", "console"], scope: "organization",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.github", section: "organizations", title: "GitHub",
    description: "Install and configure the organization’s GitHub App.",
    searchTerms: ["organizations", "github"], scope: "organization",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.workStatus", section: "organizations", title: "Work status",
    description: "Share and configure issue-linked work status.",
    searchTerms: ["organizations", "work", "status"], scope: "organization",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.workspace", section: "organizations", title: "Workspace settings",
    description: "Workspace defaults and repository configuration.",
    searchTerms: ["organizations", "workspace", "settings"], scope: "organization",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.environment", section: "organizations", title: "Environment",
    description: "Configure and build the cloud workspace environment.",
    searchTerms: ["organizations", "environment"], scope: "organization",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.diagnostics", section: "organizations", title: "Diagnostics",
    description: "Inspect organization cloud diagnostics.",
    searchTerms: ["organizations", "diagnostics"], scope: "organization",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.teardown", section: "organizations", title: "Remove cloud resources",
    description: "Review and remove cloud resources.",
    searchTerms: ["organizations", "remove", "cloud", "resources"], scope: "organization",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.delete", section: "organizations", title: "Delete organization",
    description: "Delete an eligible organization after confirmation.",
    searchTerms: ["organizations", "delete", "organization"], scope: "organization",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.activate", section: "organizations", title: "Active organization",
    description: "Select this organization to change its remaining settings.",
    searchTerms: ["organizations", "active", "organization"], scope: "organization",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.create", section: "organizations", title: "Create organization",
    description: "Create or join an organization.",
    searchTerms: ["organizations", "create", "organization"], scope: "user",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  defineSetting({
    id: "projects.templates", section: "projects", title: "Project templates",
    description: "Starting points for Create a project. The built-in ones ship with TerminalX; add a folder to start new projects with its files.",
    searchTerms: ["projects", "templates", "template", "quick start", "create a project", "new project", "starter", "folder"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/project-templates.json#templates" }, layout: "content",
  }),
  defineSetting({
    id: "repositories.rootPath", section: "repositories", title: "Root path",
    description: "Reveal or copy the repository's root path.",
    searchTerms: ["repositories", "general", "root", "path"], scope: "repository",
    storage: { kind: "file", location: "$TERMINALX_HOME/projects.json#projects.path" }, layout: "content",
  }),
  defineSetting({
    id: "repositories.workspacesPath", section: "repositories", title: "Workspaces path",
    description: "Reveal or copy the directory used for new workspaces.",
    searchTerms: ["repositories", "general", "workspaces", "worktrees", "path"], scope: "repository",
    storage: { kind: "action", location: "Repository worktree directory" }, layout: "content",
  }),
  defineSetting({
    id: "repositories.filesToCopy", section: "repositories", title: "Files to copy",
    description: "Copy matching ignored, untracked files into new workspaces.",
    searchTerms: ["repositories", "files", "copy", "ignored", "globs", "worktreeinclude", "env"], scope: "repository",
    storage: { kind: "file", location: "$TERMINALX_HOME/projects.json#projects.repositorySettings.filesToCopy; repository .worktreeinclude overrides" }, layout: "content",
  }),
  defineSetting({
    id: "repositories.mergedCleanup", section: "repositories", title: "Workspace cleanup",
    description: "Override automatic merged-workspace cleanup for this repository.",
    searchTerms: ["repositories", "workspace", "cleanup"], scope: "repository",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#mergedCleanup.projects" }, layout: "content",
  }),
  defineSetting({
    id: "repositories.scripts", section: "repositories", title: "Scripts",
    description: "Save setup and archive scripts for this repository on this computer.",
    searchTerms: ["repository", "setup", "archive", "scripts", "hooks"], scope: "repository",
    storage: { kind: "file", location: "$TERMINALX_HOME/projects.json#projects[].scripts" }, layout: "content",
  }),
  defineSetting({
    id: "shortcuts.systemWide", section: "shortcuts", title: "System-wide shortcut",
    description: "Show or hide the floating chat window from any app.",
    searchTerms: ["shortcuts", "system-wide", "shortcut"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#floating.shortcut" }, layout: "content",
  }),
  defineSetting({
    id: "shortcuts.reset", section: "shortcuts", title: "Reset shortcuts",
    description: "Restore every app shortcut to its default.",
    searchTerms: ["shortcuts", "reset", "shortcuts"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.shortcuts" }, layout: "content",
  }),
  defineSetting({
    id: "storage.mergedCleanup", section: "storage", title: "Delete the workspace when its pull request is merged",
    description: "For workspaces TerminalX created. Once a workspace's pull request is merged, its worktree and local branch are deleted, and its branch on the remote too while that still points at the merged commit. Nothing is forced: a workspace with uncommitted or unmerged work, ignored local files, a turn running or a terminal open stays, and its row says why.",
    searchTerms: ["storage", "delete", "the", "workspace", "when", "its", "pull", "request", "is", "merged"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#mergedCleanup.enabled" },
  }),
  defineSetting({
    id: "storage.gracePeriod", section: "storage", title: "Wait before deleting",
    description: "Counted from when the merge is first seen, and from the last thing done in the workspace's sessions if that is later. A notice offers to keep the workspace, and a removal can be undone while its commit is still in the repository.",
    searchTerms: ["storage", "wait", "before", "deleting"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#mergedCleanup.graceMinutes" },
  }),
  defineSetting({
    id: "storage.deleteConversations", section: "storage", title: "Also delete its conversations",
    description: "Whether to delete conversations when removing a merged workspace.",
    searchTerms: ["storage", "also", "delete", "its", "conversations"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#mergedCleanup.deleteConversations" },
  }),
  defineSetting({
    id: "storage.projects", section: "storage", title: "Project cleanup overrides",
    description: "Choose workspace cleanup separately for each local or cloud project.",
    searchTerms: ["storage", "project", "cleanup", "overrides"], scope: "repository",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#mergedCleanup.projects" }, layout: "content",
  }),
  defineSetting({
    id: "storage.removed", section: "storage", title: "Removed automatically",
    description: "Review and restore workspaces removed after their pull request merged.",
    searchTerms: ["storage", "removed", "automatically"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/merged-cleanup.json" }, layout: "content",
  }),
  defineSetting({
    id: "storage.leftovers", section: "storage", title: "Leftovers",
    description: "Review and remove safe leftover worktrees, branches and agent data.",
    searchTerms: ["storage", "leftovers"], scope: "user",
    storage: { kind: "action", location: "Local repositories and agent conversation stores" }, layout: "content",
  }),
  defineSetting({
    id: "storage.recoveryIncidents", section: "storage", title: "Record recovery incidents",
    description: "When a session warns that it needs attention, TerminalX notes on this Mac when the warning was raised, how long it was on screen, what you pressed and what became of the turn, so a false warning can be reported with evidence. Only labels, counts and times are kept: never a message, code, a command's output or a file path. Export it to attach to a report; sessions are named by codes that change with every export.",
    searchTerms: ["storage", "record", "recovery", "incidents", "diagnostics", "needs attention", "warnings", "privacy", "export"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#diagnostics.recoveryIncidents, $TERMINALX_HOME/diagnostics/recovery-incidents.jsonl" },
  }),
  defineSetting({
    id: "transcription.microphone", hideDescription: true, section: "transcription", title: "Microphone",
    description: "Choose the microphone used for dictation.",
    searchTerms: ["transcription", "microphone"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#transcriptionInputDevice" },
  }),
  defineSetting({
    id: "transcription.mute", section: "transcription", title: "Mute while recording",
    description: "Keeps whatever is playing out of the transcript. Unmuted automatically when recording stops.",
    searchTerms: ["transcription", "mute", "while", "recording"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#transcriptionMute" },
  }),
  defineSetting({
    id: "transcription.model", section: "transcription", title: "Model",
    description: "Select, download, or delete an on-device speech recognition model.",
    searchTerms: ["transcription", "model"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#transcriptionModel" }, layout: "content",
  }),
  defineSetting({
    id: "transcription.sensitiveTargets", section: "transcription", title: "Sensitive tabs",
    description: "Exclude tabs from context, personalisation and learning.",
    searchTerms: ["transcription", "sensitive", "tabs"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.sensitiveTargets" }, layout: "content",
  }),
  defineSetting({
    id: "transcription.entries", section: "transcription", title: "Dictionary entries",
    description: "Edit dictionary terms, replacements, snippets and learned corrections.",
    searchTerms: ["transcription", "dictionary", "entries"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#entries" }, layout: "content",
  }),
  defineSetting({
    id: "transcription.transfer", section: "transcription", title: "Import and export",
    description: "Import or export transcription settings and dictionary entries as JSON.",
    searchTerms: ["transcription", "import", "and", "export"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json" }, layout: "content",
  }),
  defineSetting({
    id: "transcription.detector", section: "transcription", title: "Speech detector",
    description: "Install, verify, or remove the noise guard’s local detector.",
    searchTerms: ["transcription", "speech", "detector"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/models" }, layout: "content",
  }),
  defineSetting({
    id: "transcription.test", section: "transcription", title: "Test dictation",
    description: "Test the selected engine and personalisation locally.",
    searchTerms: ["transcription", "test", "dictation"], scope: "user",
    storage: { kind: "action", location: "In-memory dictation diagnostics" }, layout: "content",
  }),
  defineSetting({
    id: "transcription.reset", section: "transcription", title: "Reset personalisation",
    description: "Delete entries and turn every personalisation feature off.",
    searchTerms: ["transcription", "reset", "personalisation"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json" }, layout: "content",
  }),
  defineSetting({
    id: "transcription.context", hideDescription: true, section: "transcription", title: "Use context from TerminalX",
    description: "Use bounded context to recognize project and coding terms.",
    searchTerms: ["transcription", "use", "context", "from", "terminalx"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.context" }, layout: "row",
  }),
  defineSetting({
    id: "transcription.project", hideDescription: true, section: "transcription", title: "Project file names and branch",
    description: "Include project file names and the current branch in dictation context.",
    searchTerms: ["transcription", "project", "file", "names", "and", "branch"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.project" }, layout: "row",
  }),
  defineSetting({
    id: "transcription.session", hideDescription: true, section: "transcription", title: "Session tools and file identifiers",
    description: "Include the session’s tools and file identifiers in dictation context.",
    searchTerms: ["transcription", "session", "tools", "and", "file", "identifiers"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.session" }, layout: "row",
  }),
  defineSetting({
    id: "transcription.terminal", hideDescription: true, section: "transcription", title: "Visible terminal text",
    description: "Use visible terminal text to promote known dictation terms.",
    searchTerms: ["transcription", "visible", "terminal", "text"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.terminal" }, layout: "row",
  }),
  defineSetting({
    id: "transcription.composer", hideDescription: true, section: "transcription", title: "Composer draft",
    description: "Use the composer draft to promote known dictation terms.",
    searchTerms: ["transcription", "composer", "draft"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.composer" }, layout: "row",
  }),
  defineSetting({
    id: "transcription.remoteContext", hideDescription: true, section: "transcription", title: "Allow remote workspace context on this Mac",
    description: "Allow context from a remote workspace to be used for dictation on this Mac.",
    searchTerms: ["transcription", "allow", "remote", "workspace", "context", "on", "this", "mac"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.remoteContext" }, layout: "row",
  }),
  defineSetting({
    id: "transcription.noiseGuard", hideDescription: true, section: "transcription", title: "Local-model noise guard",
    description: "Use the local speech detector to guard against noise in local-model transcription.",
    searchTerms: ["transcription", "local-model", "noise", "guard"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.noiseGuard" }, layout: "row",
  }),
  defineSetting({
    id: "transcription.guards", hideDescription: true, section: "transcription", title: "Prompt echo and repetition guards",
    description: "Guard against prompt echo and repeated text in transcription.",
    searchTerms: ["transcription", "prompt", "echo", "and", "repetition", "guards"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.guards" }, layout: "row",
  }),
  defineSetting({
    id: "transcription.retakes", hideDescription: true, section: "transcription", title: "Unambiguous spoken retakes",
    description: "Apply unambiguous corrections spoken during dictation.",
    searchTerms: ["transcription", "unambiguous", "spoken", "retakes"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.retakes" }, layout: "row",
  }),
  defineSetting({
    id: "transcription.normalize", hideDescription: true, section: "transcription", title: "Number, symbol and extension formatting",
    description: "Format spoken numbers, symbols and file extensions.",
    searchTerms: ["transcription", "number,", "symbol", "and", "extension", "formatting"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.normalize" }, layout: "row",
  }),
  defineSetting({
    id: "transcription.code", hideDescription: true, section: "transcription", title: "Code formatting",
    description: "Apply coding-oriented formatting to dictated text.",
    searchTerms: ["transcription", "code", "formatting"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.code" }, layout: "row",
  }),
  defineSetting({
    id: "transcription.fillers", hideDescription: true, section: "transcription", title: "Filler removal",
    description: "Remove spoken filler words from transcription.",
    searchTerms: ["transcription", "filler", "removal"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.fillers" }, layout: "row",
  }),
  defineSetting({
    id: "transcription.dictionary", hideDescription: true, section: "transcription", title: "Dictionary",
    description: "Use the personal dictionary to recognize chosen terms.",
    searchTerms: ["transcription", "dictionary"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.dictionary" }, layout: "row",
  }),
  defineSetting({
    id: "transcription.replacements", hideDescription: true, section: "transcription", title: "Replacements",
    description: "Replace recognized phrases using saved replacements.",
    searchTerms: ["transcription", "replacements"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.replacements" }, layout: "row",
  }),
  defineSetting({
    id: "transcription.snippets", hideDescription: true, section: "transcription", title: "Snippets",
    description: "Expand spoken triggers into saved snippets.",
    searchTerms: ["transcription", "snippets"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.snippets" }, layout: "row",
  }),
  defineSetting({
    id: "transcription.learn", hideDescription: true, section: "transcription", title: "Learn from my corrections",
    description: "Learn short word corrections from edited dictation sent to an agent.",
    searchTerms: ["transcription", "learn", "from", "my", "corrections"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.learn" }, layout: "row",
  }),
  defineSetting({
    id: "transcription.language", section: "transcription", title: "Language",
    description: "Language hint for Apple, Whisper and Canary. Parakeet and Nemotron keep their supported language.",
    searchTerms: ["transcription", "language"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.language" }, layout: "row",
  }),
  defineSetting({ id: "transcription.sensitiveTab", hideDescription: true, section: "transcription", title: "Sensitive tab", description: "Exclude this tab from transcription context, personalisation and learning.", searchTerms: ["dictation", "privacy", "context"], scope: "user", storage: { kind: "file", location: "$TERMINALX_HOME/transcription-personalization.json#options.sensitiveTargets" } }),
  defineSetting({
    id: "account.signOut", section: "account", title: "Sign out",
    description: "Sign out after confirming which account pairings will be removed.", searchTerms: ["account", "organization", "membership"], scope: "user",
    storage: { kind: "system", location: "macOS Keychain" }, layout: "content",
  }),
  defineSetting({
    id: "account.organizationSettings", section: "account", title: "Organization settings",
    description: "Open the settings of your active organization.", searchTerms: ["account", "organization", "membership"], scope: "user",
    storage: { kind: "action", location: "Organization settings page" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.overview", section: "organizations", title: "Organization",
    description: "Organization identity, membership role and active status.", searchTerms: ["account", "organization", "membership"], scope: "organization",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  ...SHORTCUT_ACTIONS.map((action) => defineSetting({
    id: `shortcuts.${action.id}`, section: "shortcuts", title: action.label,
    description: `${action.group} keyboard shortcut.`, searchTerms: [action.group, action.label, "keyboard", "keys"],
    scope: "user", storage: { kind: "file", location: `$TERMINALX_HOME/settings.json#preferences.shortcuts.${action.id}` }, layout: "content",
  } as const)),
] as const;
export type SettingId = (typeof SETTINGS_ROWS)[number]["id"];
const byId = new Map<string, SettingRegistration>(SETTINGS_ROWS.map((row) => [row.id, row]));
if (byId.size !== SETTINGS_ROWS.length) throw new Error("Duplicate settings row id");
export function settingById(id: string): SettingRegistration | undefined { return byId.get(id); }
export function settingsInSection(section: SettingsSection): readonly SettingRegistration[] { return SETTINGS_ROWS.filter((row) => row.section === section); }
type ContentSettingId = Extract<(typeof SETTINGS_ROWS)[number], { layout: "content" }>["id"];
type RegisteredProps = Omit<RowProps, "children" | "control"> & (
  | { setting: ContentSettingId; children: ReactElement; control?: never }
  | { setting: Exclude<SettingId, ContentSettingId>; control: ReactNode; children?: never }
);
export function RegisteredSetting({ setting, ...props }: RegisteredProps) {
  return byId.get(setting)!.render(props);
}
/** Accept old section entry points and new row links; reject events and unknown strings. */
export function resolveSetting(target: unknown): SettingRegistration {
  if (typeof target === "string") {
    const row = byId.get(target);
    if (row) return row;
    if (Object.hasOwn(SETTINGS_SECTIONS, target)) return byId.get(SETTINGS_SECTIONS[target as SettingsSection].entry)!;
  }
  return byId.get("account.identity")!;
}
