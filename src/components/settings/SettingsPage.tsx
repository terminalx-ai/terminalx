import { useEffect, useState } from "react";
import { ArrowLeft, Check, CircleAlert, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Button } from "@/components/ui/button";
import { Segmented, SettingRow, Switch } from "@/components/ui/controls";
import { AgentMark } from "@/components/AgentMark";
import { Markdown } from "@/components/chat/Markdown";
import { cn } from "@/lib/cn";
import { THEMES, hasLightMode, setMode, setTheme, useTheme, type Mode, type ThemeId } from "@/lib/theme";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { repoFile } from "@/lib/repo";
import { keycaps } from "@/lib/hotkeys";
import { SHORTCUTS } from "@/lib/shortcuts";
import { refreshHarnesses, useSessionStore } from "@/lib/sessions";
import { api, errorMessage, gh, issues, type CliToolStatus, type LinearStatus, type SkillInstallStatus } from "@/lib/api";
import { ComputerUseRows } from "./ComputerUseSettings";
import changelog from "../../../CHANGELOG.md?raw";
import { TranscriptionTab } from "./TranscriptionTab";
import { setStatusSettings, useStatus } from "@/lib/status";
import { AccountTab } from "./AccountTab";
import { DevicesTab } from "./DevicesTab";

const TABS = ["account", "devices", "general", "appearance", "agents", "transcription", "integrations", "shortcuts", "about"] as const;
export type SettingsTab = (typeof TABS)[number];
type Tab = SettingsTab;
const TAB_LABEL: Record<Tab, string> = {
  account: "Account",
  devices: "Devices",
  general: "General",
  appearance: "Appearance",
  agents: "Agents",
  transcription: "Transcription",
  integrations: "Integrations",
  shortcuts: "Shortcuts",
  about: "About",
};

export function SettingsPage({
  onBack,
  initialTab = "general",
}: {
  onBack: () => void;
  initialTab?: SettingsTab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-background" aria-label="Settings">
      <header data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center gap-1 border-b border-hairline pl-[78px] pr-3">
        <Button variant="ghost" size="icon-sm" aria-label="Back to previous page" onClick={onBack}>
          <ArrowLeft />
        </Button>
        <h1 className="px-1 text-sm font-medium">Settings</h1>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings sections" className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-hairline p-4">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              aria-current={tab === t ? "page" : undefined}
              onClick={() => setTab(t)}
              className={cn(
                "rounded-md px-2.5 py-2 text-left text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                tab === t ? "bg-selected text-foreground" : "text-muted-foreground hover:bg-veil-raised hover:text-foreground",
              )}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </nav>
        <section className="min-w-0 flex-1 overflow-y-auto scrollbar-thin" aria-labelledby="settings-section-title">
          <div className="mx-auto w-full max-w-[48rem] p-6 pb-12">
            <h2 id="settings-section-title" className="mb-5 text-xl font-semibold tracking-tight">
              {TAB_LABEL[tab]}
            </h2>
            {tab === "account" && <AccountTab />}
            {tab === "devices" && <DevicesTab />}
            {tab === "general" && <GeneralTab />}
            {tab === "appearance" && <AppearanceTab />}
            {tab === "agents" && <AgentsTab />}
            {tab === "transcription" && <TranscriptionTab />}
            {tab === "integrations" && <IntegrationsTab />}
            {tab === "shortcuts" && <ShortcutsTab />}
            {tab === "about" && <AboutTab />}
          </div>
        </section>
      </div>
    </main>
  );
}

function GeneralTab() {
  const prefs = usePrefs();
  const [cli, setCli] = useState<CliToolStatus | null>(null);
  const [cliBusy, setCliBusy] = useState(false);
  const [cliError, setCliError] = useState<string | null>(null);
  useEffect(() => {
    api.cliToolStatus().then(setCli).catch((error) => setCliError(errorMessage(error)));
  }, []);
  const installCli = async () => {
    setCliBusy(true);
    setCliError(null);
    try {
      setCli(await api.installCliTool());
    } catch (error) {
      setCliError(errorMessage(error));
    } finally {
      setCliBusy(false);
    }
  };
  return (
    <div className="flex flex-col">
      <SettingRow
        label="Command line tool"
        description={
          cli?.installed
            ? `terminalx and tnx are installed in ${cli.directory}.`
            : "Install terminalx and its tnx alias in ~/.local/bin so shells and agents can control this app."
        }
        control={
          <Button size="sm" variant="outline" disabled={cliBusy || cli?.installed} onClick={() => void installCli()}>
            {cliBusy ? <Loader2 className="animate-spin" /> : cli?.installed ? <Check /> : null}
            {cli?.installed ? "Installed" : "Install"}
          </Button>
        }
      />
      {cliError && <div className="-mt-2 mb-3 text-xs text-destructive">{cliError}</div>}
      <ComputerUseRows />
      <SettingRow
        label="Sounds"
        description="A short tone when a session finishes or asks for you. Silent while another app has focus; the desktop notification makes its own noise there."
        control={<Switch checked={prefs.sounds} onCheckedChange={(v) => setPrefs({ sounds: v })} />}
      />
      <SettingRow
        label="Pixel raccoon"
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
  const status = useStatus();
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
      <SettingRow
        label="Status bar"
        description="Show app-wide agent usage and the resources used by live tabs along the bottom edge."
        control={<Switch checked={status.settings.visible} onCheckedChange={(visible) => void setStatusSettings({ visible })} />}
      />
      <SettingRow
        label="Usage"
        description="Show the tightest usage window and its reset countdown."
        disabled={!status.settings.visible}
        control={<Switch checked={status.settings.usage} disabled={!status.settings.visible} onCheckedChange={(usage) => void setStatusSettings({ usage })} />}
      />
      <SettingRow
        label="Resources"
        description="Show the live agent count and the most recently sampled memory total."
        disabled={!status.settings.visible}
        control={<Switch checked={status.settings.resources} disabled={!status.settings.visible} onCheckedChange={(resources) => void setStatusSettings({ resources })} />}
      />
      <SettingRow
        label="Usage display"
        description="Meters can show what has been used or what remains; urgency always follows usage."
        disabled={!status.settings.visible || !status.settings.usage}
        control={
          <Segmented
            aria-label="Usage display"
            disabled={!status.settings.visible || !status.settings.usage}
            value={status.settings.percent}
            onChange={(percent) => void setStatusSettings({ percent })}
            options={[
              { value: "used", label: "Used" },
              { value: "remaining", label: "Remaining" },
            ]}
          />
        }
      />
    </div>
  );
}

/** What is installed, where, and how to get the rest. Nothing is installed by the app. */
function AgentsTab() {
  const store = useSessionStore();
  const [busy, setBusy] = useState(false);
  const [skill, setSkill] = useState<SkillInstallStatus | null>(null);
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);
  useEffect(() => {
    api.cliSkillStatus().then(setSkill).catch((error) => setSkillError(errorMessage(error)));
  }, []);
  const installSkill = async () => {
    setSkillBusy(true);
    setSkillError(null);
    try {
      setSkill(await api.installCliSkill());
    } catch (error) {
      setSkillError(errorMessage(error));
    } finally {
      setSkillBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 rounded-lg bg-well px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm font-medium">TerminalX agent skill</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Install the terminalx-cli and computer-use discovery stubs for Claude Code and Codex. The CLI serves the complete version-matched guides.
          </p>
          {skillError && <div className="mt-1 text-xs text-destructive">{skillError}</div>}
        </div>
        <Button size="sm" variant="outline" disabled={skillBusy || skill?.installed} onClick={() => void installSkill()}>
          {skillBusy ? <Loader2 className="animate-spin" /> : skill?.installed ? <Check /> : null}
          {skill?.installed ? "Installed" : "Install skill"}
        </Button>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">TerminalX runs the agent CLIs you already have. Log in to each one in a terminal first.</p>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await refreshHarnesses();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} Re-check
        </Button>
      </div>
      <ul className="flex flex-col divide-y divide-hairline rounded-lg bg-well">
        {store.harnesses.map((h) => (
          <li key={h.id} className="flex items-start gap-3 px-3 py-2.5">
            <AgentMark id={h.id} className="mt-0.5 size-4" decorative />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{h.name}</span>
                {h.available ? (
                  <span className="flex items-center gap-1 text-[11px] text-add">
                    <Check className="size-3" /> installed
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-[11px] text-faint">
                    <CircleAlert className="size-3" /> not found
                  </span>
                )}
              </div>
              <div className="truncate font-mono text-[11px] text-faint">{h.available ? h.path : h.installHint}</div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                {h.caps.images && <span>images</span>}
                {h.caps.permissionModes && <span>permission modes</span>}
                {h.caps.effort && <span>effort</span>}
                {h.caps.slashCommands && <span>slash commands</span>}
                {h.caps.resume && <span>resume</span>}
                {h.caps.fork && <span>fork</span>}
              </div>
            </div>
            {!h.available && (
              <Button size="xs" variant="ghost" onClick={() => void openUrl(h.installUrl)}>
                Get it <ExternalLink />
              </Button>
            )}
          </li>
        ))}
        {!store.harnesses.length && <li className="px-3 py-3 text-xs text-faint">Looking for agents…</li>}
      </ul>
    </div>
  );
}

/** Trackers the issues view can read. Keys live in the app's own settings file. */
function IntegrationsTab() {
  const [linear, setLinear] = useState<LinearStatus | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ghOk, setGhOk] = useState<boolean | null>(null);
  useEffect(() => {
    issues.linearStatus().then(setLinear).catch(() => setLinear({ connected: false }));
    gh.available().then(setGhOk).catch(() => setGhOk(false));
  }, []);
  const save = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      const s = await issues.linearSetApiKey(value);
      setLinear(s);
      setKey("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-sm font-medium">GitHub</div>
        <p className="mt-0.5 text-xs text-muted-foreground">Issues and pull requests go through the GitHub CLI, which holds its own login.</p>
        <div className="mt-2 flex items-center gap-2 text-xs">
          {ghOk == null ? (
            <Loader2 className="size-3.5 animate-spin text-faint" />
          ) : ghOk ? (
            <span className="flex items-center gap-1 text-add">
              <Check className="size-3.5" /> gh is installed and signed in
            </span>
          ) : (
            <span className="flex items-center gap-1 text-warning">
              <CircleAlert className="size-3.5" /> Install gh and run <code className="font-mono">gh auth login</code>
            </span>
          )}
        </div>
      </div>
      <div>
        <div className="text-sm font-medium">Linear</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          A personal API key from Linear → Settings → Security &amp; access. It is stored in TerminalX's settings file, readable only by you, and sent only to api.linear.app.
        </p>
        <div className="mt-2 flex items-center gap-2 text-xs">
          {linear?.connected ? (
            <span className="flex items-center gap-1 text-add">
              <Check className="size-3.5" /> Connected as {linear.viewer ?? "you"}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-faint">
              <CircleAlert className="size-3.5" /> Not connected
            </span>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && key.trim() && void save(key)}
            placeholder={linear?.connected ? "Paste a new key to replace" : "lin_api_…"}
            spellCheck={false}
            className="h-8 min-w-0 flex-1 rounded-md bg-well px-2 font-mono text-xs outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/40"
          />
          <Button size="sm" variant="outline" disabled={busy || !key.trim()} onClick={() => void save(key)}>
            {busy ? <Loader2 className="animate-spin" /> : null} Save
          </Button>
          {linear?.connected && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save("")}>
              Disconnect
            </Button>
          )}
        </div>
        {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
      </div>
    </div>
  );
}

function ShortcutsTab() {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <div key={g}>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-faint">{g}</div>
          <ul className="flex flex-col">
            {SHORTCUTS.filter((s) => s.group === g).map((s) => (
              <li key={s.chord} className="flex items-center justify-between py-1 text-[13px]">
                <span>{s.label}</span>
                <span className="flex gap-0.5">
                  {keycaps(s.chord).map((k, i) => (
                    <kbd key={i} className="rounded-md bg-veil-raised px-1.5 py-0.5 font-sans text-[11px] text-muted-foreground hairline">
                      {k}
                    </kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

type UpdateState = { kind: "idle" } | { kind: "checking" } | { kind: "none" } | { kind: "available"; update: Update } | { kind: "installing"; pct: number } | { kind: "error"; message: string };

function AboutTab() {
  const prefs = usePrefs();
  const [version, setVersion] = useState("");
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("dev"));
  }, []);

  const checkNow = async () => {
    setState({ kind: "checking" });
    try {
      const u = await check({ headers: { "X-Raccoon-Channel": prefs.updateChannel } });
      setState(u ? { kind: "available", update: u } : { kind: "none" });
    } catch (e) {
      setState({ kind: "error", message: errorMessage(e) });
    }
  };

  const install = async (u: Update) => {
    setState({ kind: "installing", pct: 0 });
    try {
      let total = 0;
      let got = 0;
      await u.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          if (total) setState({ kind: "installing", pct: Math.round((got / total) * 100) });
        }
      });
      await relaunch();
    } catch (e) {
      setState({ kind: "error", message: errorMessage(e) });
    }
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div>
        <div className="text-base font-semibold">TerminalX</div>
        <div className="text-muted-foreground">Version {version || "…"}</div>
        <p className="mt-1 text-muted-foreground">A workbench for coding agents. Every session is a git worktree; every tab is an agent.</p>
        <p className="mt-2 text-xs text-faint">
          MIT licensed.{" "}
          <button
            type="button"
            className="inline-flex items-center gap-1 underline decoration-hairline-strong underline-offset-2 hover:text-foreground"
            onClick={() => void openUrl(repoFile("THIRD-PARTY-NOTICES.md"))}
          >
            Third-party notices <ExternalLink className="size-3" />
          </button>
        </p>
      </div>

      <SettingRow
        label="Updates"
        description="Beta gets builds earlier. Either way nothing installs without your say-so."
        control={
          <Segmented
            aria-label="Update channel"
            value={prefs.updateChannel}
            onChange={(v) => setPrefs({ updateChannel: v })}
            options={[
              { value: "stable", label: "Stable" },
              { value: "beta", label: "Beta" },
            ]}
          />
        }
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void checkNow()} disabled={state.kind === "checking" || state.kind === "installing"}>
          {state.kind === "checking" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check for updates
        </Button>
        {state.kind === "none" && <span className="text-xs text-muted-foreground">You have the latest version.</span>}
        {state.kind === "error" && <span className="text-xs text-destructive">{state.message}</span>}
        {state.kind === "available" && (
          <>
            <span className="text-xs text-foreground">Version {state.update.version} is available.</span>
            <Button size="sm" onClick={() => void install(state.update)}>
              Install and relaunch
            </Button>
          </>
        )}
        {state.kind === "installing" && <span className="text-xs text-muted-foreground">Installing… {state.pct}%</span>}
      </div>

      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-faint">What's new</div>
        <div className="prose-chat rounded-lg bg-well px-3 py-2 text-[13px]">
          <Markdown text={changelog.replace(/^# TerminalX changelog\s*/m, "")} />
        </div>
      </div>
    </div>
  );
}
