/** Every keyboard shortcut the app binds, for the Shortcuts settings tab. */
export interface Shortcut {
  chord: string;
  label: string;
  group: "App" | "Session" | "Panel" | "Files" | "Composer";
}

export const SHORTCUTS: Shortcut[] = [
  { chord: "mod+n", label: "New session", group: "App" },
  { chord: "mod+i", label: "Issues", group: "App" },
  { chord: "mod+,", label: "Settings", group: "App" },
  { chord: "mod+b", label: "Toggle sidebar", group: "App" },
  { chord: "mod+e", label: "Toggle right panel", group: "App" },
  { chord: "mod+t", label: "New agent tab", group: "Session" },
  { chord: "mod+w", label: "Close tab or file", group: "Session" },
  { chord: "mod+shift+]", label: "Next tab", group: "Session" },
  { chord: "mod+shift+[", label: "Previous tab", group: "Session" },
  { chord: "mod+j", label: "Toggle terminal dock", group: "Session" },
  { chord: "escape", label: "Stop the running turn", group: "Session" },
  { chord: "mod+alt+1", label: "Changes", group: "Panel" },
  { chord: "mod+alt+2", label: "Repository", group: "Panel" },
  { chord: "mod+alt+3", label: "Pull requests", group: "Panel" },
  { chord: "mod+alt+4", label: "Files", group: "Panel" },
  { chord: "mod+p", label: "Open file by name", group: "Files" },
  { chord: "mod+shift+f", label: "Search in project", group: "Files" },
  { chord: "mod+s", label: "Save the open file", group: "Files" },
  { chord: "enter", label: "Send", group: "Composer" },
  { chord: "shift+enter", label: "New line", group: "Composer" },
  { chord: "@", label: "Mention a file", group: "Composer" },
  { chord: "/", label: "Slash command", group: "Composer" },
];
