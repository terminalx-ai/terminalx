import { SettingsFileRow } from "./SettingsFile";
import { useSettingsFile } from "@/lib/settingsFile";
import { saveSidebarOrder, useSidebarOrder } from "@/lib/sidebarOrder";
import { SidebarOrderError } from "@/components/layout/SidebarSort";
import { RegisteredSetting } from "./settingsRegistry";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, CircleAlert, ExternalLink, Loader2, RefreshCw } from "@/icons";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checkForUpdate, installUpdate, useUpdate } from "@/lib/updates";
import { Button } from "@/components/ui/button";
import { Segmented, Switch } from "@/components/ui/controls";
import { LocalGitHubConnection } from "@/components/changes/GitRecovery";
import { AgentSetupCard } from "./AgentSetupCard";
import { Markdown } from "@/components/chat/Markdown";
import { cn } from "@/lib/cn";
import { THEMES, hasLightMode, setMode, setTheme, useTheme, type Mode, type ThemeId } from "@/lib/theme";
import { CLOUD_CONTROL_HAS_SETTING, CLOUD_CONTROL_POLICY, CLOUD_CONTROL_SETTING, cloudControlEnabled, loadCloudControlSetting, requestCloudControlSetting, subscribeCloudControlSetting } from "@/lib/cloudControl";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { repoFile } from "@/lib/repo";
import { refreshHarnesses, useSessionStore } from "@/lib/sessions";
import { api, errorMessage, issues, USAGE_REFRESH_MINUTES, type BrowserRuntimeStatus, type CliToolStatus, type LinearStatus, type SkillInstallStatus } from "@/lib/api";
import { forgetIssueViewers } from "@/lib/issueViewer";
import { ComputerUseRows } from "./ComputerUseSettings";
import changelog from "../../../CHANGELOG.md?raw";
import { setStatusSettings, useStatus } from "@/lib/status";
import { AgentIdleSettings } from "./AgentIdleSettings";
import { CommandApprovalSettings } from "./CommandApprovalSettings";
import { ArchiveIdleSettings } from "./ArchiveIdleSettings";
import { LocalRuntimeSettings } from "./LocalRuntimeSettings";
import { openStartupDiagnostics } from "@/lib/startupDiagnostics";
import { QuickChatSettings } from "./FloatingWindowSettings";

export function GeneralTab() {
  const prefs = usePrefs();
  // PRO-40: the switch lives in native code (the control socket reads it itself); this shows what it says.
  const cloudControlOn = useSyncExternalStore(subscribeCloudControlSetting, cloudControlEnabled, cloudControlEnabled);
  const [cloudControlReason, setCloudControlReason] = useState<string | null>(null);
  useEffect(() => {
    void loadCloudControlSetting();
  }, []);
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
      <SettingsFileRow />
      <RegisteredSetting setting="general.websiteLinks" control={<Segmented aria-label="Website links" value={prefs.linkBrowser} onChange={(v) => setPrefs({ linkBrowser: v, linkBrowserChosen: true })} options={[{ value: "ask", label: "Ask every time" }, { value: "system", label: "System Browser" }, { value: "terminalx", label: "TerminalX Browser" }]} />} />
      <RegisteredSetting setting="general.linkActions" control={<Switch checked={prefs.linkActions} onCheckedChange={(v) => setPrefs({ linkActions: v })} />} />
      {/* PRO-40: unless the app ships the in-window confirmation alone. */}
      {CLOUD_CONTROL_HAS_SETTING && (
        <RegisteredSetting setting="general.cloudControl"
          label={CLOUD_CONTROL_SETTING}
          description={`Off: the terminalx command line cannot see or change cloud workspaces. On: agents in local sessions can list workspaces, read conversations, send messages, launch sessions, and resume or create workspaces within your permissions. This authorizes billed compute without another confirmation. ${CLOUD_CONTROL_POLICY === "both" ? "Stopping a workspace still asks you each time." : "Stopping is also allowed."}`}
          control={
            <Switch
              aria-label={CLOUD_CONTROL_SETTING}
              checked={cloudControlOn}
              onCheckedChange={(v) => {
                setCloudControlReason(null);
                void requestCloudControlSetting(v).then((result) => setCloudControlReason(result.reason));
              }}
            />
          }
        />
      )}
      {/* Why the switch did not turn on (refused, not answered, or asked again too soon): never a silent no. */}
      {CLOUD_CONTROL_HAS_SETTING && cloudControlReason && (
        <p role="status" data-testid="cloud-control-reason" className="pb-2 text-[11px] text-amber-600 dark:text-amber-400">
          {cloudControlReason}
        </p>
      )}
      <RegisteredSetting setting="general.commandLine"
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
      <BrowserRuntimeRow />
      <RegisteredSetting setting="general.sounds"
        control={<Switch checked={prefs.sounds} onCheckedChange={(v) => setPrefs({ sounds: v })} />}
      />
      <RegisteredSetting setting="general.animations"
        control={<Switch checked={prefs.animations} onCheckedChange={(v) => setPrefs({ animations: v })} />}
      />
      <RegisteredSetting setting="general.foldToolCalls"
        control={<Switch checked={prefs.foldToolCalls} onCheckedChange={(v) => setPrefs({ foldToolCalls: v })} />}
      />
      <RegisteredSetting setting="general.turnChanges"
        control={<Switch aria-label="Show files changed" checked={prefs.turnChanges} onCheckedChange={(v) => setPrefs({ turnChanges: v })} />}
      />
      <RegisteredSetting setting="general.promptMap"
        control={<Switch aria-label="Prompt map" checked={prefs.promptMap} onCheckedChange={(v) => setPrefs({ promptMap: v })} />}
      />
      <RegisteredSetting setting="general.fixErrorsInstructions" stacked
        control={<textarea aria-label="Fix errors instructions" value={prefs.fixErrorsInstructions} maxLength={8000} rows={3}
          onChange={(event) => setPrefs({ fixErrorsInstructions: event.target.value })}
          placeholder="For example: run the affected tests before committing."
          className="w-full resize-y rounded-md border border-border bg-well px-2 py-1.5 text-xs outline-none focus:border-ring" />}
      />
      <RegisteredSetting setting="general.autocorrect"
        control={<Switch aria-label="Autocorrect" checked={prefs.autocorrect} onCheckedChange={(v) => setPrefs({ autocorrect: v })} />}
      />
      <RegisteredSetting setting="general.useWorktree"
        control={<Switch checked={prefs.useWorktree} onCheckedChange={(v) => setPrefs({ useWorktree: v })} />}
      />
      <QuickChatSettings />
      <LocalRuntimeSettings />
      <RegisteredSetting setting="general.startupDiagnostics" control={<Button variant="outline" size="sm" onClick={openStartupDiagnostics}>Inspect startup</Button>} />
    </div>
  );
}

export function AppearanceTab({ onOpenUsage }: { onOpenUsage?: () => void }) {
  const order = useSidebarOrder();
  const { theme, mode, resolvedMode } = useTheme();
  const prefs = usePrefs();
  const light = hasLightMode(theme);
  const status = useStatus();
  return (
    <div className="flex flex-col">
      <RegisteredSetting setting="appearance.theme"
        id="theme-label"
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
      <RegisteredSetting setting="appearance.mode"
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
      <RegisteredSetting setting="appearance.textSize"
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
      <RegisteredSetting setting="appearance.transcriptLayout"
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
      <RegisteredSetting setting="appearance.customOrder"
        control={<Switch aria-label="Custom order" checked={order.custom} disabled={!order.loaded || order.pending} onCheckedChange={(custom) => void saveSidebarOrder({ custom })} />}
      />
      <SidebarOrderError />
      <RegisteredSetting setting="appearance.tabBar"
        control={<Switch aria-label="Tab bar" checked={prefs.tabStrip} onCheckedChange={(v) => setPrefs({ tabStrip: v })} />}
      />
      <RegisteredSetting setting="appearance.branchSessions"
        control={
          <Segmented<"tabs" | "sidebar">
            aria-label="Sessions on a branch"
            value={prefs.tabStrip ? prefs.branchSessions : "sidebar"}
            disabled={!prefs.tabStrip}
            onChange={(v) => setPrefs({ branchSessions: v })}
            options={[
              { value: "tabs", label: "Tabs" },
              { value: "sidebar", label: "Sidebar" },
            ]}
          />
        }
      />
      <RegisteredSetting setting="appearance.colourLineCounts"
        control={<Switch aria-label="Colour line counts on every row" checked={prefs.colourLineCounts} onCheckedChange={(colourLineCounts) => setPrefs({ colourLineCounts })} />}
      />
      {onOpenUsage && (
        <RegisteredSetting setting="appearance.openUsage"
          control={
            <Button size="sm" variant="outline" onClick={onOpenUsage}>
              Open usage <ExternalLink />
            </Button>
          }
        />
      )}
      <RegisteredSetting setting="appearance.statusBar"
        control={<Switch checked={status.settings.visible} onCheckedChange={(visible) => void setStatusSettings({ visible })} />}
      />
      <RegisteredSetting setting="appearance.usage"
        disabled={!status.settings.visible}
        control={<Switch checked={status.settings.usage} disabled={!status.settings.visible} onCheckedChange={(usage) => void setStatusSettings({ usage })} />}
      />
      <RegisteredSetting setting="appearance.resources"
        disabled={!status.settings.visible}
        control={<Switch checked={status.settings.resources} disabled={!status.settings.visible} onCheckedChange={(resources) => void setStatusSettings({ resources })} />}
      />
      <RegisteredSetting setting="appearance.usageDisplay"
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
      <RegisteredSetting setting="appearance.usageRefresh"
        disabled={!status.settings.visible || !status.settings.usage}
        control={
          <Segmented
            aria-label="Usage auto-refresh interval"
            disabled={!status.settings.visible || !status.settings.usage}
            value={String(status.settings.usageRefreshMinutes)}
            onChange={(minutes) => void setStatusSettings({ usageRefreshMinutes: Number(minutes) })}
            options={USAGE_REFRESH_MINUTES.map((minutes) => ({ value: String(minutes), label: minutes === 0 ? "Off" : `${minutes} min` }))}
          />
        }
      />
    </div>
  );
}

/**
 * The built-in browser runtime: the bundled agent-browser and the Chromium it
 * drives. A system Chrome is used when present; otherwise agent-browser can
 * download its own.
 */
function BrowserRuntimeRow() {
  const [status, setStatus] = useState<BrowserRuntimeStatus | null>(null);
  const [busy, setBusy] = useState<"check" | "install" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    setBusy("check");
    setError(null);
    try {
      setStatus(await api.browserRuntimeStatus());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const install = async () => {
    setBusy("install");
    setError(null);
    try {
      setStatus(await api.browserInstallBrowser());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const description = !status
    ? "Checking the agent-browser runtime…"
    : !status.binary
      ? "The agent-browser runtime is not bundled with this build. Agents cannot open browser tabs until it is."
      : !status.browser
        ? `agent-browser ${status.version ?? "?"} is ready, but no Chrome or Chromium was found. Install one for agents to drive.`
        : `agent-browser ${status.version ?? "?"} drives ${status.browser}. Agents open tabs with terminalx tab create.`;
  return (
    <>
      <RegisteredSetting setting="general.browser"
        description={description}
        control={
          status?.binary && !status.browser ? (
            <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void install()}>
              {busy === "install" ? <Loader2 className="animate-spin" /> : null}
              Install Chromium
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void refresh()}>
              {busy === "check" ? <Loader2 className="animate-spin" /> : status?.browser ? <Check /> : <RefreshCw />}
              {status?.browser ? "Ready" : "Re-check"}
            </Button>
          )
        }
      />
      {error && <div className="-mt-2 mb-3 text-xs text-destructive">{error}</div>}
    </>
  );
}

/** What is installed, where, and how to get the rest. Nothing is installed by the app. */
export function AgentsTab({ onOpenSkills }: { onOpenSkills?: () => void }) {
  const prefs = usePrefs();
  const store = useSessionStore();
  const [busy, setBusy] = useState(false);
  const [checkRun, setCheckRun] = useState(0);
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
      {onOpenSkills && (
        <RegisteredSetting setting="agents.skills"
          control={
            <Button size="sm" variant="outline" onClick={onOpenSkills}>
              Open skills <ExternalLink />
            </Button>
          }
        />
      )}
      <RegisteredSetting setting="agents.cliSkill"><div className="flex items-center justify-between gap-3 rounded-lg bg-well px-3 py-2.5">
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
      </div></RegisteredSetting>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Set up an agent on this computer. Local work does not require a TerminalX account.</p>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await refreshHarnesses();
              setCheckRun((run) => run + 1);
            } catch {
              setSkillError("Could not re-check installed agents. Try again.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} Re-check
        </Button>
      </div>
      <RegisteredSetting setting="agents.setup"><ul className="flex flex-col divide-y divide-hairline rounded-lg bg-well">
        {store.harnesses.map((h) => (
          <AgentSetupCard key={`${h.id}:${checkRun}`} harness={h} />
        ))}
        {!store.harnesses.length && <li className="px-3 py-3 text-xs text-faint">Looking for agents…</li>}
      </ul></RegisteredSetting>
      <RegisteredSetting setting="agents.followUps" control={
        <select aria-label="Follow-ups while the agent works" value={prefs.followUps} onChange={e => setPrefs({ followUps: e.target.value as "now" | "hold" })} className="rounded-md border border-hairline bg-background px-2 py-1 text-xs">
          <option value="now">Send to the agent now</option>
          <option value="hold">Hold until the turn ends</option>
        </select>
      } />
      <AgentIdleSettings />
      <CommandApprovalSettings />
      <ArchiveIdleSettings />
    </div>
  );
}

/** Trackers the issues view can read. Keys live in the app's own settings file. */
export function IntegrationsTab() {
  const { revision } = useSettingsFile();
  const [linear, setLinear] = useState<LinearStatus | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    issues.linearStatus().then((value) => live && setLinear(value)).catch(() => live && setLinear({ connected: false }));
    return () => { live = false; };
  }, [revision]);
  const save = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      const s = await issues.linearSetApiKey(value);
      forgetIssueViewers("linear");
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
      <RegisteredSetting setting="integrations.github"><div>
        <div className="text-sm font-medium">GitHub</div>
        <p className="mt-0.5 text-xs text-muted-foreground">Issues and pull requests go through the GitHub CLI, which holds its own login.</p>
        <LocalGitHubConnection />
      </div></RegisteredSetting>
      <RegisteredSetting setting="integrations.linear"><div>
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
      </div></RegisteredSetting>
    </div>
  );
}

export function AboutTab() {
  const prefs = usePrefs();
  const [version, setVersion] = useState("");
  const { state } = useUpdate();
  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("dev"));
  }, []);
  const checkNow = () => void checkForUpdate();

  return (
    <div className="flex flex-col gap-4 text-sm">
      <RegisteredSetting setting="about.version"><div>
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
      </div></RegisteredSetting>

      <RegisteredSetting setting="about.updates"
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
      <RegisteredSetting setting="about.checkUpdates"><div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={checkNow} disabled={state.kind === "checking" || state.kind === "installing"}>
          {state.kind === "checking" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check for updates
        </Button>
        {state.kind === "none" && <span className="text-xs text-muted-foreground">You have the latest version.</span>}
        {state.kind === "error" && <span className="text-xs text-destructive">{state.message}</span>}
        {state.kind === "available" && (
          <>
            <span className="text-xs text-foreground">Version {state.update.version} is available.</span>
            <Button size="sm" onClick={() => void installUpdate()}>
              Install and relaunch
            </Button>
          </>
        )}
        {state.kind === "choosing" && (
          <span className="text-xs text-foreground">Version {state.update.version} would stop work in progress: choose when to update in the card below.</span>
        )}
        {state.kind === "installing" && <span className="text-xs text-muted-foreground">Installing… {state.pct}%</span>}
      </div></RegisteredSetting>

      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-faint">What's new</div>
        <RegisteredSetting setting="about.changelog"><Changelog /></RegisteredSetting>
      </div>
    </div>
  );
}

/** The changelog, split at its releases (`## 0.2.25`), newest first. */
const RELEASES = changelog.replace(/^# TerminalX changelog\s*/m, "").split(/\n(?=## )/).filter((part) => part.trim());
/** Unreleased (when there is one) and the newest release open the page; the rest wait to be asked for. */
const FIRST_SHOWN = RELEASES[0]?.startsWith("## Unreleased") ? 2 : 1;

/**
 * What's new: the latest notes, then the earlier releases on request. The
 * whole file is 28 releases of Markdown, which took About two thirds of a
 * second to draw every time it opened.
 */
function Changelog() {
  const [all, setAll] = useState(false);
  const earlier = RELEASES.length - FIRST_SHOWN;
  return (
    <div className="flex flex-col gap-2">
      <div className="prose-chat rounded-lg bg-well px-3 py-2 text-[13px]">
        <Markdown text={(all ? RELEASES : RELEASES.slice(0, FIRST_SHOWN)).join("\n")} />
      </div>
      {!all && earlier > 0 && (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setAll(true)}>
          Show earlier releases ({earlier})
        </Button>
      )}
    </div>
  );
}
