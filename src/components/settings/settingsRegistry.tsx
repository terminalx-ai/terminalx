import { cloneElement, createContext, useContext, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { ThisComputer, thisComputer, profile, secretStore, secretStoreShort, secretStoreThe, secretStoreWord } from "@/lib/platform";
import { createPortal } from "react-dom";
import { SETTING_ROW_CLASS, type SettingRow } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { SHORTCUT_ACTIONS } from "@/lib/shortcuts";
import { setPrefs } from "@/lib/prefs";
import { SettingRowActions } from "./SettingRowActions";
import { userFileKeys } from "@/lib/settingSources";
import { UserFileRowAccessory } from "./SettingSources";

export const NATIVE_CODEX_DESCRIPTION =
  "New Codex sessions connect to Codex directly, so the chat shows when it compacts. Needs Codex 0.164.0 or newer; opening the terminal view moves a session to Codex’s own terminal.";

export const LOCAL_VM_TASKS_DESCRIPTION =
  "Settings → Local VMs, picking the computer a tab’s agent uses, and Local VM task cards in a conversation.";

export const BOTS_DESCRIPTION =
  "AI employees with standing roles: each has a name, a role, its own memory and a home folder. Also turns on the terminalx bots commands.";

export const ORCHESTRATOR_RUNS_DESCRIPTION =
  "A session can lead a run, splitting one goal into pieces for worker sessions. Shows the Run view and Settings → Orchestrator.";

// PRO-131: the group of a person's projects is "Projects"; its templates page is "Project templates". Ids stay as they were.
// PRO-464: projects and organizations share one heading, each one collapsible row in the menu.
export const SETTINGS_GROUPS = ["Personal", "Agents & environment", "Projects & organizations", "More"] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];
// PRO-374: Personal is ordered as designed (General first, Settings opens there); each page has one introductory description.
export const SETTINGS_SECTIONS = {
  general: { title: "General", group: "Personal", entry: "general.websiteLinks", subtitle: "How TerminalX opens links, shows its work, and where your settings live." },
  account: { title: "Account", group: "Personal", entry: "account.identity", subtitle: `Your TerminalX account, ${thisComputer}’s name and what it shares.` },
  appearance: { title: "Appearance", group: "Personal", entry: "appearance.theme", subtitle: "Theme, text size, the sidebar and the status bar." },
  shortcuts: { title: "Keyboard shortcuts", group: "Personal", entry: "shortcuts.systemWide", subtitle: "Keys for every action. Change one by recording a new key." },
  devices: { title: "Devices", group: "Personal", entry: "devices.pairing", subtitle: `Phones paired with ${thisComputer}.` },
  machines: { title: "Machines", group: "Personal", entry: "machines.allowOperating", subtitle: `Operate TerminalX on your other computers from ${thisComputer}, and let them operate it. Sessions, terminals and files stay on the machine that runs them.` },
  // PRO-463, design 09.44: reference information, looked at now and then, so a page of Settings rather than a view of the main window.
  stats: { title: "Stats & usage", group: "Personal", entry: "stats.activity", subtitle: "TerminalX activity plus local Claude and Codex token analytics. Cloud histories are not scanned here." },
  agents: { title: "Agents", group: "Agents & environment", entry: "agents.setup", subtitle: `The agent CLIs TerminalX runs on ${thisComputer}, their sign-ins, and how they work while you wait. Each keeps its own login; local work needs no TerminalX account.` },
  orchestrator: { title: "Orchestrator", group: "Agents & environment", entry: "orchestrator.requireApproval", subtitle: "How a lead session splits a goal across workers." },
  environment: { title: "Environment", group: "Agents & environment", entry: "environment.variables", subtitle: `Variables for new agent and shell tabs, kept in ${secretStoreShort}.` },
  localVms: { title: "Local VMs", group: "Agents & environment", entry: "localVms.tasks", subtitle: "Virtual machines an agent can use as its computer." },
  transcription: { title: "Transcription", group: "Agents & environment", entry: "transcription.model", subtitle: "Dictation: the model, your microphone and your words." },
  integrations: { title: "Integrations", group: "Agents & environment", entry: "integrations.github", subtitle: "GitHub and Linear, for issues and pull requests." },
  projects: { title: "Project templates", group: "Projects & organizations", entry: "projects.templates", subtitle: "Starting points for new projects." },
  repositories: { title: "Projects", group: "Projects & organizations", entry: "repositories.rootPath", subtitle: "Where this project’s workspaces live and what runs in them." },
  organizations: { title: "Organizations", group: "Projects & organizations", entry: "organizations.sidebar", subtitle: "Organizations you belong to: members, compute and logins." },
  storage: { title: "Storage", group: "More", entry: "storage.mergedCleanup", subtitle: "When finished workspaces are deleted, and what is left behind." },
  experimental: { title: "Experimental", group: "More", entry: "experimental.nativeCodex", subtitle: "Early features. They may change or go away." },
  // PRO-157, design 09.29: the executables again, for whoever looks for them among the folders and limits.
  advanced: { title: "Advanced", group: "More", entry: "advanced.claudeExecutable", subtitle: "Executables and folders. Most people never need these." },
  about: { title: "About", group: "More", entry: "about.version", subtitle: "Version, updates and changes." },
} as const satisfies Record<string, { title: string; group: SettingsGroup; entry: string; subtitle: string }>;
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
  /** No “…” menus beside the title: the theme cards are the whole row (design 09.08, PRO-377). */
  hideRowMenu?: boolean;
  /**
   * A setting link with `?enable=1` may turn this row on from outside the app
   * (PRO-127). `enable` calls the row's existing setter. Only reversible,
   * local, non-secret on/off switches belong here: never one that widens
   * permissions or approvals, a bypass or auto mode, computer use, cloud or
   * network sharing, the account, or an Experimental switch.
   */
  linkable?: { enable: () => Promise<void> };
  /**
   * The Experimental switch this row is behind. While it is off the row is
   * not shown on its page, so Settings search and ⌘K must not offer it either
   * (lib/settingsSections.ts `settingOffered`). A whole section behind a
   * switch is `settingsSectionOffered`'s.
   */
  requires?: "orchestratorRuns" | "localVmTasks" | "opencode" | "bots" | "intro";
  /** Only a Mac has it, so elsewhere neither its page nor Settings search offers it. */
  macOnly?: boolean;
}
export interface SettingRegistration extends SettingDefinition {
  render: (props: RowProps) => ReactNode;
}

/** State stays with its existing owner. The registry owns row identity, copy and rendering;
 * adapters supply live controls and (only when needed) a status-dependent description.
 * Content rows retain the native structure of editors, lists and organization sections. */
function defineSetting<const T extends SettingDefinition>(definition: T): T & SettingRegistration {
  // A row kept in the user file shows "Your value" and its row menu beside its title (PRO-140).
  const keys = userFileKeys(definition.storage.location);
  const accessory = keys.length ? <UserFileRowAccessory keys={keys} /> : undefined;
  return { ...definition, render: ({ children, instance, ...props }) => {
    const anchor = { "data-setting-id": definition.id, "data-setting-instance": instance, tabIndex: -1 };
    if (definition.layout === "content") {
      return children ? cloneElement(children as ReactElement<Record<string, unknown>>, anchor) : null;
    }
    // SettingRow's own structure and classes (controls.tsx), with the row's “…” actions beside the title (design 09.04, 09.23).
    const { label = definition.title, description = definition.hideDescription ? undefined : definition.description, control = null, stacked, disabled, id, titleAccessory } = props;
    return <div {...anchor} className="group/setting min-w-0 outline-none">
      <div className={cn(SETTING_ROW_CLASS, disabled && "opacity-60")}>
        <div className={cn("flex gap-4", stacked ? "flex-col" : "items-center justify-between")}>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-medium">
              <span id={id} className="min-w-0">{label}</span>
              {accessory}
              {titleAccessory}
              {!definition.hideRowMenu && <SettingRowActions id={definition.id as SettingId} title={definition.title} label={label} userKeys={keys.length ? keys : undefined} />}
            </div>
            {description && <div className="text-xs leading-relaxed text-muted-foreground">{description}</div>}
          </div>
          <div className={cn(stacked ? "" : "shrink-0")}>{control}</div>
        </div>
      </div>
    </div>;
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
    id: "advanced.claudeExecutable", section: "advanced", title: "Claude Code executable",
    description: "Leave empty to use the one on your PATH. TerminalX checks it with --version.",
    searchTerms: ["advanced", "claude", "executable", "binary", "path", "use system claude code"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#agents.executables" }, layout: "content",
  }),
  defineSetting({
    id: "advanced.codexExecutable", section: "advanced", title: "Codex executable",
    description: "Leave empty to use the one on your PATH. TerminalX checks it with --version.",
    searchTerms: ["advanced", "codex", "executable", "binary", "path", "use system codex"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#agents.executables" }, layout: "content",
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
    id: "about.supportReport", section: "about", title: "Support report",
    description: "Review selected diagnostics before sending them to TerminalX Support.",
    searchTerms: ["about", "support", "feedback", "diagnostics", "report", "help"], scope: "user",
    storage: { kind: "action", location: "TerminalX Support" },
  }),
  defineSetting({
    id: "about.changelog", section: "about", title: "Changelog",
    description: "Changes in each version of TerminalX.",
    searchTerms: ["about", "changelog"], scope: "user",
    storage: { kind: "action", location: "Bundled CHANGELOG.md" }, layout: "content",
  }),
  defineSetting({
    id: "account.workStatus", section: "account", title: "Show my team what I’m working on",
    description: `Teammates in an organization that connected a repository see which of its issues you have a session on: your name, the session’s title and branch, and whether an agent is working. Your other machines always see it, with ${thisComputer}’s name. Prompts, transcripts, paths and code never leave ${thisComputer}.`,
    searchTerms: ["account", "show", "my", "team", "what", "i’m", "working", "on"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#workStatus.shareWithTeam" },
  }),
  defineSetting({
    id: "account.identity", section: "account", title: "TerminalX account",
    description: "Sign in or out of the optional TerminalX account.",
    searchTerms: ["account", "terminalx", "account"], scope: "user",
    storage: { kind: "system", location: secretStore }, layout: "content",
  }),
  defineSetting({
    id: "account.machineName", section: "account", title: `${ThisComputer}’s name`,
    description: "Name this computer for your paired devices.",
    searchTerms: ["account", "this", "mac’s", "name"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#machineName" }, layout: "content",
  }),
  defineSetting({
    id: "account.sharing", section: "account", title: `What ${thisComputer} shares`,
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
    description: "For desktop chats on this device, local and on cloud workspaces or machines whose runtime holds follow-ups. Held messages are not read mid-turn; they go one per finished turn. Idle messages send immediately. The “Send the other way” shortcut in Shortcuts reverses this choice: hold, or interrupt and send. Phone messages keep their current behavior.",
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
    id: "agents.executable", section: "agents", title: "Executable",
    description: "Leave empty to use the version TerminalX finds on your PATH. TerminalX checks it with --version.",
    searchTerms: ["agents", "executable", "binary", "path", "program", "homebrew", "npm", "dev build", "which", "browse", "use system default", "version"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#agents.executables" }, layout: "content",
  }),
  defineSetting({
    id: "agents.settingsFile", section: "agents", title: "Agent settings file",
    description: "Open an agent’s own settings file in your editor: Claude Code’s settings.json, Codex’s config.toml or OpenCode’s opencode.json.",
    searchTerms: ["agents", "settings file", "config", "settings.json", "config.toml", "opencode.json", "open in", "editor"], scope: "user",
    storage: { kind: "file", location: "~/.claude/settings.json, ~/.codex/config.toml, ~/.config/opencode/opencode.json" }, layout: "content",
  }),
  defineSetting({
    id: "agents.opencodeProviders", section: "agents", title: "OpenCode providers",
    description: "Where OpenCode gets its models: providers with their keys, and the models the composer offers from them.",
    searchTerms: ["opencode", "providers", "models", "api key", "openrouter", "ollama", "groq", "picker", "logs", "update"], scope: "user",
    storage: { kind: "file", location: "~/.local/share/opencode/auth.json, ~/.config/opencode/opencode.json" }, layout: "content",
    requires: "opencode",
  }),
  defineSetting({
    id: "agents.setup", section: "agents", title: "Installed agents",
    description: `Install, sign in to, and re-check local agents, and choose between an agent's subscription login and an API key kept in ${secretStoreShort}.`,
    searchTerms: ["agents", "installed", "sign in", "login", "api key", "keychain", "anthropic_api_key", "openai_api_key", "custom provider"], scope: "user",
    storage: { kind: "system", location: `Agent CLI installations and credentials; API keys in ${secretStoreThe}, $TERMINALX_HOME/agent-logins.json names which login each agent uses` }, layout: "content",
  }),
  defineSetting({
    id: "appearance.theme", hideDescription: true, hideRowMenu: true, section: "appearance", title: "Theme",
    description: "Choose the application color palette.",
    searchTerms: ["appearance", "theme"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.theme" },
  }),
  defineSetting({
    id: "appearance.mode", section: "appearance", title: "Mode",
    description: `System follows ${profile.osName} and switches with it.`,
    searchTerms: ["appearance", "mode", "dark", "light", "dark mode", "light mode", "system"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.mode" },
  }),
  defineSetting({
    id: "general.textSize", section: "general", title: "Text size",
    description: "Scales the transcript and composer. Chrome stays the same size.",
    searchTerms: ["text", "size", "font", "font size", "zoom", "bigger", "smaller"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.fontScale" },
  }),
  defineSetting({
    id: "general.transcriptLayout", section: "general", title: "Transcript layout",
    description: "Wide puts your prompt as a full-width card. Chat right-aligns it like a message.",
    searchTerms: ["transcript", "layout"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.transcriptLayout" },
  }),
  defineSetting({
    id: "general.customOrder", section: "general", title: "Custom order",
    description: "Use your saved arrangement in this window; row order is shared across windows. Arrange sessions and projects with their drag handles. Press Space to pick up, arrows to move, Space to drop, or Escape to cancel. Pins do not change custom order. Off restores pin and recency order and keeps your arrangement.",
    searchTerms: ["custom order", "drag", "reorder", "sidebar", "sessions", "projects"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/sessions/index.json#sidebarOrder" },
  }),
  defineSetting({
    id: "general.tabBar", section: "general", title: "Tab bar",
    description: "A session's agents, terminals and browser pages as a row of tabs under the title bar, in the same order as the sidebar. Off leaves them in the sidebar only.",
    searchTerms: ["tab", "bar"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.tabStrip" },
  }),
  defineSetting({
    id: "general.branchSessions", section: "general", title: "Sessions on a branch",
    description: "Several sessions on one branch: as tabs beside each other in the tab bar, with one row for the branch in the sidebar; or listed under the branch in the sidebar, with the tab bar holding only the open session's tabs. Without the tab bar they are in the sidebar.",
    searchTerms: ["sessions", "on", "a", "branch"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.branchSessions" },
  }),
  defineSetting({
    id: "appearance.colourLineCounts", section: "appearance", title: "Colored sidebar diffs",
    description: "Line counts in the sidebar stay green and red on every row, not only the selected one.",
    searchTerms: ["sidebar", "diff", "lines", "line counts", "color", "colour", "colored", "coloured"], scope: "user",
    storage: { kind: "localStorage", location: "raccoon.prefs#colourLineCounts" },
  }),
  defineSetting({
    id: "general.statusBar", section: "general", title: "Status bar",
    description: "Show app-wide agent usage and the resources used by live tabs along the bottom edge.",
    searchTerms: ["status", "bar"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#statusBar.visible" },
  }),
  defineSetting({
    id: "general.usage", section: "general", title: "Usage",
    description: "Show the tightest usage window and its reset countdown.",
    searchTerms: ["usage"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#statusBar.usage" },
  }),
  defineSetting({
    id: "general.resources", section: "general", title: "Resources",
    description: "Show the live agent count and the most recently sampled memory total.",
    searchTerms: ["resources"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#statusBar.resources" },
  }),
  defineSetting({
    id: "general.usageDisplay", section: "general", title: "Usage display",
    description: "Meters can show what has been used or what remains; urgency always follows usage.",
    searchTerms: ["usage", "display"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#statusBar.percent" },
  }),
  defineSetting({
    id: "general.usageRefresh", section: "general", title: "Usage auto-refresh interval",
    description: "How often usage is fetched again while the app is on screen. Off still refreshes when you return to the app or press Refresh.",
    searchTerms: ["usage", "auto-refresh", "interval"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#statusBar.usageRefreshMinutes" },
  }),
  defineSetting({
    id: "machines.allowOperating", section: "machines", title: `Let other computers operate ${thisComputer}`,
    description: "Computers you approve can start sessions, open terminals and change files here. Connections are end-to-end encrypted; the relay only passes sealed messages.",
    searchTerms: ["machines", "operate", "remote", "allow", "computers", "host"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#machines.allowOperating" },
  }),
  defineSetting({
    id: "machines.listen", section: "machines", title: `Where ${thisComputer} listens`,
    description: "Relay only opens no port. Tailscale, Local network and All interfaces open TCP 6768 on those addresses for paired computers and phones. Callers from public addresses are refused unless you allow them.",
    searchTerms: ["machines", "listen", "listening", "port", "6768", "relay", "tailscale", "local network", "lan", "all interfaces", "public", "address", "bind", "firewall", "root", "sudo"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#machines.listen, machines.allowPublic" }, layout: "content",
  }),
  defineSetting({
    id: "machines.thisMac", section: "machines", title: ThisComputer,
    description: `The name other computers see for ${thisComputer} (the same as Account → ${ThisComputer}’s name), and the label of its key.`,
    searchTerms: ["machines", "this", "mac", "name", "rename", "fingerprint", "key"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#machineName" },
  }),
  defineSetting({
    id: "machines.pairingCode", section: "machines", title: "Create pairing code",
    description: "A one-time code another computer pastes in Add a machine. It works once and lasts five minutes.",
    searchTerms: ["machines", "pairing", "code", "pair", "create", "one-time"], scope: "user",
    storage: { kind: "service", location: "TerminalX runtime (in memory; never saved)" }, layout: "content",
  }),
  defineSetting({
    id: "machines.yours", section: "machines", title: "Your machines",
    description: `Computers ${thisComputer} can operate, each a section in the sidebar: add one from your account, by pairing code or as a headless server, open it, update it, or remove it. Agents in ${thisComputer}'s sessions can operate the paired machines with the terminalx command line.`,
    searchTerms: ["machines", "add", "a", "machine", "pair", "operate", "mac mini", "server", "headless", "account", "route", "relay", "remove", "connected", "offline", "update", "needs update", "version", "guide", "help", "cli", "terminalx"], scope: "user",
    storage: { kind: "file", location: `$TERMINALX_HOME/machines.json; ${secretStoreWord} (device tokens)` }, layout: "content",
  }),
  defineSetting({
    id: "machines.computers", section: "machines", title: `Computers that can operate ${thisComputer}`,
    description: "Each has its own credential. Revoking one closes its connection at once.",
    searchTerms: ["machines", "computers", "revoke", "operate", "paired", "credential"], scope: "user",
    storage: { kind: "service", location: "TerminalX runtime: paired computers" }, layout: "content",
  }),
  defineSetting({
    id: "stats.activity", section: "stats", title: "Activity",
    description: "Agents spawned, time agents worked and pull requests created on this installation.",
    searchTerms: ["stats", "statistics", "activity", "agents spawned", "time agents worked", "working time", "prs created", "pull requests", "lifetime", "tracking"], scope: "user",
    storage: { kind: "service", location: "TerminalX runtime: activity totals" }, layout: "content",
  }),
  defineSetting({
    id: "stats.accountLimits", section: "stats", title: "Usage limits by account",
    description: "Each signed-in account’s current usage windows and when they reset, read with that account’s own login.",
    searchTerms: ["usage", "limits", "rate limits", "account", "accounts", "window", "windows", "5-hour", "weekly", "reset", "subscription", "quota"], scope: "user",
    storage: { kind: "service", location: "Agent providers (each account’s own login)" }, layout: "content",
  }),
  defineSetting({
    id: "stats.analytics", section: "stats", title: "Usage analytics",
    description: "Tokens, estimated cost, token mix, providers and daily intensity from local Claude and Codex transcripts.",
    searchTerms: ["usage", "analytics", "usage overview", "tokens", "cost", "spend", "token mix", "cache", "providers", "daily intensity", "heatmap", "claude", "codex", "transcripts"], scope: "user",
    storage: { kind: "service", location: "TerminalX runtime: local transcript scan" }, layout: "content",
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
    description: `Variables for new local agent and shell tabs. Repository values override user values. All values are stored in ${secretStoreShort} on ${thisComputer}.`,
    searchTerms: ["environment", "variables", "env", "dotenv", "secrets", "keychain", "repository", "overrides", "import"], scope: "user",
    storage: { kind: "system", location: `${secretStore} (values); $TERMINALX_HOME/environment.json (names and revisions)` }, layout: "content",
  }),
  defineSetting({
    id: "experimental.nativeCodex", section: "experimental", title: "Native Codex",
    description: NATIVE_CODEX_DESCRIPTION,
    searchTerms: ["experimental", "native", "codex"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#experimental.nativeCodex" },
  }),
  defineSetting({
    id: "experimental.sessionCost", section: "experimental", title: "Session cost",
    description: "Show each session's estimated cost in its header, with its tokens by model. On a subscription it is what the tokens would cost at API prices, not what you are billed.",
    searchTerms: ["experimental", "session", "cost", "tokens", "usage", "spend", "price"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#experimental.sessionCost" },
  }),
  defineSetting({
    id: "experimental.orchestratorRuns", section: "experimental", title: "Orchestration runs",
    description: ORCHESTRATOR_RUNS_DESCRIPTION,
    searchTerms: ["experimental", "orchestrator", "orchestration", "runs", "lead", "workers", "plan"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#experimental.orchestratorRuns" },
  }),
  defineSetting({
    id: "experimental.opencode", section: "experimental", title: "OpenCode",
    description: "Offer OpenCode in Settings → Agents, with its providers and models, and in the agent and model pickers. Tabs already on OpenCode run either way.",
    searchTerms: ["experimental", "opencode", "open code", "providers", "models", "agent"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#experimental.opencode" },
  }),
  defineSetting({
    id: "experimental.localVmTasks", section: "experimental", title: "Local VM tasks",
    description: LOCAL_VM_TASKS_DESCRIPTION,
    searchTerms: ["experimental", "local vm", "vm", "virtual machine", "computer", "desktop", "tasks", "guest", "linux", "macos"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#experimental.localVmTasks" },
  }),
  defineSetting({
    id: "experimental.bots", section: "experimental", title: "Bots",
    description: BOTS_DESCRIPTION,
    searchTerms: ["experimental", "bots", "bot", "employees", "roles", "cto", "watcher", "hire"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#experimental.bots" },
  }),
  defineSetting({
    id: "experimental.intro", section: "experimental", title: "Intro",
    description: "A short tour beside sign-in on a first run, and Help › Show intro.",
    searchTerms: ["experimental", "intro", "tour", "slides", "welcome", "first run", "onboarding"], scope: "user",
    storage: { kind: "localStorage", location: "raccoon.prefs#introSlides" },
  }),
  defineSetting({
    id: "orchestrator.requireApproval", section: "orchestrator", title: "Ask before a run starts",
    description: "Show the plan and wait for Approve. Off, the workers start at once.",
    searchTerms: ["orchestrator", "run", "approve", "approval", "plan", "ask", "lead", "workers"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.requireApproval" },
  }),
  defineSetting({
    id: "orchestrator.workersPerRun", section: "orchestrator", title: "Workers at once, per run",
    description: "The rest wait in a queue and start as workers finish.",
    searchTerms: ["orchestrator", "workers", "limit", "queue", "concurrent", "parallel", "at once", "run"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.workersPerRun" },
  }),
  defineSetting({
    id: "orchestrator.workersAtOnce", section: "orchestrator", title: "Workers at once, whole app",
    description: "Across every run. Sessions you start by hand are not counted.",
    searchTerms: ["orchestrator", "workers", "limit", "queue", "concurrent", "app", "machine", "at once"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.workersAtOnce" },
  }),
  defineSetting({
    id: "orchestrator.pieceLimit", section: "orchestrator", title: "Pieces per run, at most",
    description: "A larger plan is refused, and the lead is told the limit.",
    searchTerms: ["orchestrator", "pieces", "limit", "plan", "workers", "most"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.pieceLimit" },
  }),
  defineSetting({
    id: "orchestrator.workerMode", section: "orchestrator", title: "Workers run in",
    description: "Push, merge and deploy stay blocked by deny rules in every mode.",
    searchTerms: ["orchestrator", "workers", "permissions", "mode", "bypass", "deny", "rules"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.workerMode" },
  }),
  defineSetting({
    id: "orchestrator.triesPerPiece", section: "orchestrator", title: "Tries per piece",
    description: "Retry, raise effort, then move up a model. From 1 to 6.",
    searchTerms: ["orchestrator", "tries", "attempts", "retry", "retries", "escalate", "ladder", "piece", "effort", "model"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.triesPerPiece" },
  }),
  defineSetting({
    id: "orchestrator.leadTakesOver", section: "orchestrator", title: "Let the lead take over blocked pieces",
    description: "The run's lead may finish a blocked piece in its own checkout without asking, also in a plan you approved. Leaving a piece out and widening its files stay yours. Off, it asks you.",
    searchTerms: ["orchestrator", "lead", "take over", "takeover", "blocked", "piece", "finish", "approval", "approved", "person", "ask"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.leadTakesOver" },
  }),
  defineSetting({
    id: "orchestrator.budgetDollars", section: "orchestrator", title: "Budget per run, API key",
    description: "Dollars spent on an API key; then the run pauses and asks you.",
    searchTerms: ["orchestrator", "budget", "dollars", "cost", "spend", "api key", "money", "no limit", "unlimited"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.budgetDollars" },
  }),
  defineSetting({
    id: "orchestrator.budgetPoints", section: "orchestrator", title: "Budget per run, subscription",
    description: "Points of a usage window one run may use.",
    searchTerms: ["orchestrator", "budget", "points", "subscription", "usage", "window", "plan", "limit", "no limit", "unlimited", "tokens"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.budgetPoints" },
  }),
  defineSetting({
    id: "orchestrator.windowCeiling", section: "orchestrator", title: "Pause when a window passes",
    description: "Whoever used it; the run goes on after the reset.",
    searchTerms: ["orchestrator", "window", "usage", "ceiling", "pause", "percent", "subscription", "reset", "off", "no limit"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.windowCeiling" },
  }),
  defineSetting({
    id: "orchestrator.stallMinutes", section: "orchestrator", title: "Mark a worker stalled after",
    description: "No tool call, file change or command. A long build is not a stall.",
    searchTerms: ["orchestrator", "stall", "stalled", "idle", "stuck", "worker", "minutes", "timeout"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.stallMinutes" },
  }),
  defineSetting({
    id: "orchestrator.effortCeiling", section: "orchestrator", title: "Raise effort no higher than",
    description: "Past this, the next model up is tried.",
    searchTerms: ["orchestrator", "effort", "ceiling", "maximum", "raise", "escalate", "ladder", "retry", "model", "tokens"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.effortCeiling" },
  }),
  defineSetting({
    id: "orchestrator.reviewDiffLines", section: "orchestrator", title: "A verifier reads a diff over",
    description: "Changed lines. A result this size or smaller whose commands pass is accepted without a model; a larger one is read by a verifier session first. From 1 to 100000.",
    searchTerms: ["orchestrator", "verify", "verifier", "review", "diff", "lines", "threshold", "check", "tokens"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.reviewDiffLines" },
  }),
  defineSetting({
    id: "orchestrator.reaskVerifier", section: "orchestrator", title: "Ask the reviewer again when it gives no verdict",
    description: "Up to 2 more times, in its own conversation. If there is still none, the lead reviews the diff itself. Off, the piece waits for you.",
    searchTerms: ["orchestrator", "verifier", "reviewer", "verdict", "ask again", "retry", "review", "lead", "automatic", "decide"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.reaskVerifier" },
  }),
  defineSetting({
    id: "orchestrator.acceptBaseFailures", section: "orchestrator", title: "Accept a piece whose only failing check also fails on the base",
    description: "A failing check is run again on the commit the piece started from. If it fails there the same way, it is not the piece's: no try is used, and a verifier reads the result for what the check did not get to run. Off, it counts against the piece's tries.",
    searchTerms: ["orchestrator", "base", "flaky", "failing", "test", "check", "done check", "main", "accept", "automatic", "decide"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.acceptBaseFailures" },
  }),
  defineSetting({
    id: "orchestrator.leadWhenLadderEnds", section: "orchestrator", title: "Hand a piece to the lead when no higher model is left",
    description: "The lead finishes it in its own checkout, with the last worker's report. Off, the piece waits for you.",
    searchTerms: ["orchestrator", "ladder", "model", "tier", "escalate", "take over", "lead", "blocked", "automatic", "decide"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.leadWhenLadderEnds" },
  }),
  defineSetting({
    id: "orchestrator.resumeAfterReset", section: "orchestrator", title: "Go on when the usage window resets",
    description: "A run that used its points of a window goes on by itself once the window resets. Pause when a window passes still stops every run. Off, it waits for you.",
    searchTerms: ["orchestrator", "budget", "points", "window", "reset", "resume", "subscription", "pause", "automatic", "decide"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.resumeAfterReset" },
  }),
  defineSetting({
    id: "orchestrator.routing", section: "orchestrator", title: "Starting model by kind of piece",
    description: "The model tier and effort each kind of piece starts on, for Claude Code workers and for Codex workers. A piece that falls short is retried on more effort, then on the next model up.",
    searchTerms: ["orchestrator", "routing", "table", "model", "effort", "tier", "kind", "haiku", "sonnet", "opus", "fable", "luna", "terra", "sol", "astra", "escalate", "retry"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.routing" }, layout: "content",
  }),
  // PRO-375: data privacy mode moved from General to Account; links to its old id still open it (MOVED_ROWS).
  defineSetting({
    id: "account.dataPrivacy", section: "account", title: "Data privacy mode",
    description: `Keep TerminalX cloud and remote features off on ${thisComputer}. Your agents still use their own network connections. Your sign-in stays saved.`,
    searchTerms: ["privacy", "cloud", "remote", "organisations", "organizations", "pairing", "MCP", "logging", "managed"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/data-privacy.json#enabled; macOS managed DataPrivacyMode preference" },
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
    id: "general.mentionNotifications", section: "general", title: "Mention notifications",
    description: "When a teammate @mentions you in a shared session.",
    searchTerms: ["general", "mention", "notifications", "@"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.mentionNotifications" },
  }),
  defineSetting({
    id: "general.sounds", section: "general", title: "Sounds",
    description: "A short tone when a session finishes or asks for you. Silent while another app has focus; the desktop notification makes its own noise there.",
    searchTerms: ["general", "sounds"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.sounds" },
    // Linkable: an in-app tone on this Mac; off again with the same switch.
    linkable: { enable: async () => setPrefs({ sounds: true }) },
  }),
  defineSetting({
    id: "general.animations", section: "general", title: "Pixel raccoon",
    description: "The raccoon forages in an empty session and runs along the composer while an agent is working. Off hides the raccoon only; working marks keep moving unless your system's Reduce motion is on.",
    searchTerms: ["general", "pixel", "raccoon"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.animations" },
  }),
  defineSetting({
    id: "general.foldToolCalls", section: "general", title: "Fold tool calls",
    description: "Once an agent has answered, the tool calls it made fold under one line; opened, they read in the order it made them. On by default. Off keeps every step in view.",
    searchTerms: ["general", "fold", "tool", "calls"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.foldToolCalls" },
  }),
  defineSetting({
    id: "general.turnChanges", section: "general", title: "Show files changed",
    description: "Under each finished turn, the files the agent changed with the lines it added and removed. Click a file to open it.",
    searchTerms: ["general", "show", "files", "changed"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.turnChanges" },
    // Linkable: shows local diff stats under a turn; display only, off again with the same switch.
    linkable: { enable: async () => setPrefs({ turnChanges: true }) },
  }),
  defineSetting({
    id: "general.secondOpinionButton", section: "general", title: "Second opinion button",
    description: "Show a Second opinion button under each finished turn to ask another agent to review it. Off by default. You can also ask for a second opinion from the turn’s … menu.",
    searchTerms: ["chat", "footer", "review"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.secondOpinionButton" },
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
    // Linkable: marks for your own prompts in the conversation; display only, off again with the same switch.
    linkable: { enable: async () => setPrefs({ promptMap: true }) },
  }),
  defineSetting({
    id: "general.autocorrect", section: "general", title: "Autocorrect",
    description: "Your keyboard's spelling correction, smart quotes and dashes, and text replacements apply in prompts, answers to an agent's questions, and notes. Off leaves what you type exactly as typed.",
    searchTerms: ["general", "autocorrect"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.autocorrect" },
  }),
  defineSetting({
    id: "general.optionAsMeta", section: "general", title: "Option key is Meta in terminals", macOnly: true,
    description: "On a Mac, Option in a terminal works as Meta, for the shell's Option-B and Option-F. Off, Option types the characters your keyboard layout puts on it, such as @, [ or | on many European layouts.",
    searchTerms: ["general", "terminal", "option", "alt", "meta", "keyboard", "layout"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.optionAsMeta" },
  }),
  defineSetting({
    id: "general.aiEditor", section: "general", title: "AI Editor",
    description: "A button in the composer that fixes, restyles or translates your draft with your Claude Code login. Your text is sent only when you ask, and nothing changes until you apply it.",
    searchTerms: ["general", "ai", "editor", "grammar", "spelling", "fix", "rewrite", "style", "translate", "prompt"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.aiEditor" },
  }),
  defineSetting({
    id: "general.snippets", section: "general", title: "Prompt snippets",
    description: "Saved prompts offered under / in the composer, with {{name}} values to fill in.",
    searchTerms: ["general", "snippets", "prompts", "templates", "saved", "variables"], scope: "user",
    storage: { kind: "localStorage", location: "raccoon.prefs#promptSnippets" }, layout: "content",
  }),
  defineSetting({
    id: "general.useWorktree", section: "general", title: "New sessions use a worktree",
    description: "Each session gets its own git worktree so agents never step on each other. Off runs sessions in the project's own checkout.",
    searchTerms: ["general", "new", "sessions", "use", "a", "worktree"], scope: "user",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#preferences.useWorktree" },
  }),
  defineSetting({
    id: "general.copyAgentConfigs", section: "general", title: "Copy agent configs",
    description: "Compare MCP servers, slash commands and skills between Claude Code and Codex, and copy what's missing.",
    searchTerms: ["copy", "agent", "configs", "mcp", "servers", "slash", "commands", "prompts", "skills", "claude", "codex", "compare", "sync"], scope: "user",
    storage: { kind: "file", location: "~/.claude.json, ~/.claude/commands, ~/.claude/skills, ~/.codex/config.toml, ~/.codex/prompts, ~/.codex/skills" },
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
    id: "localVms.tasks", section: "localVms", title: "Local VM tasks",
    description: "Set up a local Cua VM and run selected tasks in it.",
    searchTerms: ["local", "vms", "vm", "virtual", "machine", "cua", "lume", "macos", "linux", "guest", "tasks"], scope: "user",
    storage: { kind: "service", location: "TerminalX runtime: $TERMINALX_HOME/local-vm/journal.json" }, layout: "content",
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
    id: "organizations.providers", section: "organizations", title: "Cloud providers",
    description: "Connect the cloud providers this organization's workspaces run on.",
    searchTerms: ["organizations", "cloud", "compute", "providers", "hetzner", "connect", "key"], scope: "organization",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.compute", section: "organizations", title: "Compute limits",
    description: "Cloud workspace limits, pausing new workspaces, and usage.",
    searchTerms: ["organizations", "cloud", "compute", "limits"], scope: "organization",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.agentLogins", section: "organizations", title: "Agent logins",
    description: "Sign in to agents for this organization.",
    searchTerms: ["organizations", "agent", "logins"], scope: "organization",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.organizationRoutes", section: "organizations", title: "Organization routes",
    description: "Custom providers owners and admins set for everyone, per repository.",
    searchTerms: ["organizations", "organization", "routes", "custom", "provider", "gateway", "endpoint", "repository"], scope: "organization",
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
    searchTerms: ["organizations", "cloud", "compute", "environment", "build", "versions"], scope: "organization",
    storage: { kind: "service", location: "TerminalX organization service" }, layout: "content",
  }),
  defineSetting({
    id: "organizations.billing", section: "organizations", title: "Billing",
    description: "Plan, seats and next charge.",
    searchTerms: ["organizations", "billing", "plan", "seats", "payment", "invoice"], scope: "organization",
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
    description: "Reveal or copy the project's root path.",
    searchTerms: ["repositories", "projects", "general", "root", "path"], scope: "repository",
    storage: { kind: "file", location: "$TERMINALX_HOME/projects.json#projects.path" }, layout: "content",
  }),
  defineSetting({
    id: "repositories.workspacesPath", section: "repositories", title: "Worktree folder",
    description: "Reveal or copy the folder new workspaces are created in.",
    searchTerms: ["repositories", "projects", "general", "workspaces path", "workspaces", "worktrees", "folder", "path"], scope: "repository",
    storage: { kind: "action", location: "Repository worktree directory" }, layout: "content",
  }),
  defineSetting({
    id: "repositories.sparseCheckout", section: "repositories", title: "Check out only some folders",
    description: "New workspaces check out only the folders you pick. Useful in a large repository. Existing workspaces are unaffected.",
    searchTerms: ["repositories", "general", "sparse", "checkout", "folders", "cone", "large", "monorepo", "partial"], scope: "repository",
    storage: { kind: "file", location: ".terminalx/settings.json#sparseCheckout" }, layout: "content",
  }),
  defineSetting({
    id: "repositories.filesToCopy", section: "repositories", title: "Files to copy",
    description: "Copy matching ignored, untracked files into new workspaces. On the project's General page.",
    searchTerms: ["repositories", "projects", "general", "files", "copy", "ignored", "globs", "worktreeinclude", "env"], scope: "repository",
    storage: { kind: "file", location: "$TERMINALX_HOME/projects.json#projects.repositorySettings.filesToCopy; repository .worktreeinclude overrides" }, layout: "content",
  }),
  defineSetting({
    id: "repositories.mergedCleanup", section: "repositories", title: "Workspace cleanup",
    description: "Override automatic merged-workspace cleanup for this repository.",
    searchTerms: ["repositories", "workspace", "cleanup"], scope: "repository",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#mergedCleanup.projects" }, layout: "content",
  }),
  defineSetting({
    id: "repositories.orchestrator", section: "repositories", title: "Orchestrator",
    description: "Override for this repository whether a run asks first, how many pieces it may have, the mode its workers run in, the model each kind of piece starts on, and its budget.",
    searchTerms: ["repositories", "orchestrator", "runs", "approval", "pieces", "workers", "permissions", "routing", "model", "effort", "tier", "budget", "points", "dollars", "window"], scope: "repository",
    storage: { kind: "file", location: "$TERMINALX_HOME/settings.json#orchestrator.projects" }, layout: "content",
    requires: "orchestratorRuns",
  }),
  defineSetting({
    id: "repositories.scripts", section: "repositories", title: "Scripts",
    description: "Setup and archive scripts for this repository, saved on this computer or read from its trusted .terminalx/settings.json.",
    searchTerms: ["repository", "setup", "archive", "scripts", "hooks", "timeout", "trust", "override"], scope: "repository",
    storage: { kind: "file", location: "$TERMINALX_HOME/projects.json#projects[].scripts; .terminalx/settings*.json#setupScript,archiveScript,archiveTimeoutMinutes" }, layout: "content",
  }),
  defineSetting({
    id: "repositories.actions", section: "repositories", title: "Actions",
    description: "Commands this project's sessions can run, in order: name, command, run after setup.",
    searchTerms: ["repository", "actions", "run", "commands", "dev server", "tests"], scope: "repository",
    storage: { kind: "file", location: "$TERMINALX_HOME/projects.json#projects[].actions" }, layout: "content",
  }),
  defineSetting({
    id: "repositories.previewUrls", section: "repositories", title: "Preview URLs",
    description: "Addresses to open for this project's sessions; $PORT and $PORT_n use the session's ports. On the project's General page.",
    searchTerms: ["repository", "projects", "general", "preview", "urls", "localhost", "port", "browser"], scope: "repository",
    storage: { kind: "file", location: "$TERMINALX_HOME/projects.json#projects[].previewUrls" }, layout: "content",
  }),
  defineSetting({
    id: "repositories.environment", section: "repositories", title: "Environment",
    description: "Environment variables for this repository's agents and shells, and the ones its settings file documents.",
    searchTerms: ["repository", "environment", "variables", "env", "secrets", "keychain", "dotenv"], scope: "repository",
    storage: { kind: "system", location: `${secretStore} (values); $TERMINALX_HOME/environment.json (names, repository scope)` }, layout: "content",
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
    description: `When a session warns that it needs attention, TerminalX notes on ${thisComputer} when the warning was raised, how long it was on screen, what you pressed and what became of the turn, so a false warning can be reported with evidence. Only labels, counts and times are kept: never a message, code, a command's output or a file path. Export it to attach to a report; sessions are named by codes that change with every export.`,
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
    id: "transcription.remoteContext", hideDescription: true, section: "transcription", title: `Allow remote workspace context on ${thisComputer}`,
    description: `Allow context from a remote workspace to be used for dictation on ${thisComputer}.`,
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
    storage: { kind: "system", location: secretStore }, layout: "content",
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
    description: `${action.group} keyboard shortcut.`, searchTerms: [action.group, action.label, "keyboard", "keys", "hotkeys", "key bindings", "shortcut"],
    scope: "user", storage: { kind: "file", location: `$TERMINALX_HOME/settings.json#preferences.shortcuts.${action.id}` }, layout: "content",
    ...(action.requires ? { requires: action.requires } : {}),
  } as const)),
] as const;
export type SettingId = (typeof SETTINGS_ROWS)[number]["id"];
const byId = new Map<string, SettingRegistration>(SETTINGS_ROWS.map((row) => [row.id, row]));
if (byId.size !== SETTINGS_ROWS.length) throw new Error("Duplicate settings row id");
/** Rows that moved to another section, by their old id, so links copied before still open them. */
const MOVED_ROWS: Readonly<Record<string, SettingId>> = {
  "general.dataPrivacy": "account.dataPrivacy",
  // PRO-377: Appearance keeps the design's rows; these moved to General.
  ...Object.fromEntries(
    (["textSize", "transcriptLayout", "customOrder", "tabBar", "branchSessions", "statusBar", "usage", "resources", "usageDisplay", "usageRefresh"] as const)
      .map((key) => [`appearance.${key}`, `general.${key}` satisfies SettingId]),
  ),
  // PRO-463: the row that left Settings for the usage view; the usage is a page of Settings now.
  "general.openUsage": "stats.activity",
  "appearance.openUsage": "stats.activity",
};
export function settingById(id: string): SettingRegistration | undefined { return byId.get(id) ?? (Object.hasOwn(MOVED_ROWS, id) ? byId.get(MOVED_ROWS[id]) : undefined); }
export function settingsInSection(section: SettingsSection): readonly SettingRegistration[] { return SETTINGS_ROWS.filter((row) => row.section === section); }
/** Whether a section has rows that show "Your value" (rows kept in the user file, drawn as rows). */
export function sectionShowsUserValues(section: SettingsSection): boolean {
  return settingsInSection(section).some((row) => row.layout !== "content" && userFileKeys(row.storage.location).length > 0);
}
type ContentSettingId = Extract<(typeof SETTINGS_ROWS)[number], { layout: "content" }>["id"];
type RegisteredProps = Omit<RowProps, "children" | "control"> & (
  | { setting: ContentSettingId; children: ReactElement; control?: never }
  | { setting: Exclude<SettingId, ContentSettingId>; control: ReactNode; children?: never }
);
/**
 * Settings search (PRO-374, design 09.01): each result row carries its live control. The result's page is
 * rendered (hidden) inside this context, so its state adapters run as on the page itself: a row drawn as a row
 * draws itself as usual and also puts a copy of its control in the slot of its result. Both read and write the
 * same state. The row stays in one shape (a fragment) with or without slots, so the page and its editors keep
 * their state when a search starts or ends.
 */
export const SettingControlSlots = createContext<ReadonlyMap<string, HTMLElement> | null>(null);
export function RegisteredSetting({ setting, ...props }: RegisteredProps) {
  const slots = useContext(SettingControlSlots);
  const slot = slots && byId.get(setting)!.layout !== "content" && !props.instance ? slots.get(setting) : undefined;
  return <>{byId.get(setting)!.render(props)}{slot && props.control ? createPortal(props.control, slot) : null}</>;
}
/** Whether a link names one row (by its id, or a moved row's old id) rather than a section or nothing known. */
export function isRowLink(target: unknown): boolean {
  return typeof target === "string" && settingById(target) !== undefined;
}
/** Accept old section entry points, moved rows' old ids and new row links; reject events and unknown strings. */
export function resolveSetting(target: unknown): SettingRegistration {
  if (typeof target === "string") {
    const row = settingById(target);
    if (row) return row;
    if (Object.hasOwn(SETTINGS_SECTIONS, target)) return byId.get(SETTINGS_SECTIONS[target as SettingsSection].entry)!;
  }
  return byId.get(SETTINGS_SECTIONS.general.entry)!;
}
