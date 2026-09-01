import { useState } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Segmented, SettingRow, Switch } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { THEMES, hasLightMode, setMode, setTheme, useTheme, type Mode, type ThemeId } from "@/lib/theme";
import { setPrefs, usePrefs } from "@/lib/prefs";

const TABS = ["general", "appearance", "agents", "about"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  general: "General",
  appearance: "Appearance",
  agents: "Agents",
  about: "About",
};

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [tab, setTab] = useState<Tab>("general");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width="max-w-[40rem]" className="p-0" onCloseAutoFocus={() => setTab("general")}>
        <div className="flex h-[32rem] max-h-[70vh]">
          <nav className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-hairline p-3 pt-4">
            <DialogTitle className="mb-2 px-2 text-xs font-medium uppercase tracking-wide text-faint">
              Settings
            </DialogTitle>
            <DialogDescription className="sr-only">Application settings</DialogDescription>
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  "rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
                  tab === t ? "bg-selected text-foreground" : "text-muted-foreground hover:bg-veil-raised hover:text-foreground",
                )}
              >
                {TAB_LABEL[t]}
              </button>
            ))}
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto scrollbar-thin p-5">
            {tab === "general" && <GeneralTab />}
            {tab === "appearance" && <AppearanceTab />}
            {tab === "agents" && <AgentsTab />}
            {tab === "about" && <AboutTab />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GeneralTab() {
  const prefs = usePrefs();
  return (
    <div className="flex flex-col">
      <SettingRow
        label="Sounds"
        description="A short tone when a session finishes or asks for you. Silent while another app has focus; the desktop notification makes its own noise there."
        control={<Switch checked={prefs.sounds} onCheckedChange={(v) => setPrefs({ sounds: v })} />}
      />
      <SettingRow
        label="Raccoon animation"
        description="The raccoon forages in an empty session and runs along the composer while an agent is working. Off follows your system's reduced-motion setting automatically."
        control={<Switch checked={prefs.animations} onCheckedChange={(v) => setPrefs({ animations: v })} />}
      />
      <SettingRow
        label="Fold tool calls"
        description="Once an agent starts answering, the tool calls it made collapse under one line. Off keeps every call expanded."
        control={<Switch checked={prefs.foldToolCalls} onCheckedChange={(v) => setPrefs({ foldToolCalls: v })} />}
      />
      <SettingRow
        label="New sessions use a worktree"
        description="Each session gets its own git worktree so agents never step on each other. Off runs sessions in the project's own checkout."
        control={<Switch checked={prefs.useWorktree} onCheckedChange={(v) => setPrefs({ useWorktree: v })} />}
      />
    </div>
  );
}

function AppearanceTab() {
  const { theme, mode, resolvedMode } = useTheme();
  const prefs = usePrefs();
  const light = hasLightMode(theme);
  return (
    <div className="flex flex-col">
      <SettingRow
        id="theme-label"
        label="Theme"
        stacked
        control={
          <div role="radiogroup" aria-labelledby="theme-label" className="grid grid-cols-4 gap-2">
            {THEMES.map((t) => {
              const swatchMode = hasLightMode(t.id) ? resolvedMode : "dark";
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={theme === t.id}
                  onClick={() => setTheme(t.id as ThemeId)}
                  className={cn(
                    "group flex flex-col gap-1.5 rounded-lg border p-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    theme === t.id ? "border-ring" : "border-transparent hover:border-border",
                  )}
                >
                  <div
                    data-theme={t.id}
                    data-mode={swatchMode}
                    className="relative h-14 w-full overflow-hidden rounded-md"
                    style={{ background: "var(--surface-page)" }}
                  >
                    <div
                      className="absolute left-2 top-2 h-8 w-[60%] rounded-sm"
                      style={{ background: "var(--surface-card)", boxShadow: "inset 0 0 0 1px var(--hairline-strong)" }}
                    />
                    <div className="absolute bottom-2 left-2 h-1.5 w-8 rounded-full" style={{ background: "var(--accent)" }} />
                    <div className="absolute bottom-2 left-11 h-1.5 w-4 rounded-full" style={{ background: "var(--ink-muted)" }} />
                  </div>
                  <div className="flex items-center justify-between px-0.5">
                    <span className="text-xs font-medium">{t.name}</span>
                    {t.darkOnly && <span className="text-[10px] text-faint">dark</span>}
                  </div>
                </button>
              );
            })}
          </div>
        }
      />
      <SettingRow
        label="Mode"
        description={light ? "System follows macOS and switches with it." : "This theme has no light palette, so the mode control is disabled."}
        disabled={!light}
        control={
          <Segmented<Mode>
            aria-label="Mode"
            disabled={!light}
            value={mode}
            onChange={setMode}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        }
      />
      <SettingRow
        label="Text size"
        description="Scales the transcript and composer. Chrome stays the same size."
        control={
          <Segmented
            aria-label="Text size"
            value={prefs.fontScale}
            onChange={(v) => setPrefs({ fontScale: v })}
            options={[
              { value: "sm", label: "Small" },
              { value: "md", label: "Default" },
              { value: "lg", label: "Large" },
            ]}
          />
        }
      />
      <SettingRow
        label="Transcript layout"
        description="Wide puts your prompt as a full-width card. Chat right-aligns it like a message."
        control={
          <Segmented
            aria-label="Transcript layout"
            value={prefs.transcriptLayout}
            onChange={(v) => setPrefs({ transcriptLayout: v })}
            options={[
              { value: "wide", label: "Wide" },
              { value: "chat", label: "Chat" },
            ]}
          />
        }
      />
    </div>
  );
}

function AgentsTab() {
  return (
    <div className="text-sm text-muted-foreground">
      Installed agent CLIs appear here once the agent layer lands. Raccoon installs nothing; it runs the
      commands you already have.
    </div>
  );
}

function AboutTab() {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="text-base font-semibold">Raccoon</div>
      <div className="text-muted-foreground">Version 0.1.0</div>
      <p className="text-muted-foreground">
        A workbench for coding agents. Every session is a git worktree; every tab is an agent.
      </p>
    </div>
  );
}
