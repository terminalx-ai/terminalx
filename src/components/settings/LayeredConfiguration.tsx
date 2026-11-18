import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/lib/sessions";
import { listen } from "@tauri-apps/api/event";
import { configuration, layerLabels, type Configuration, type ConfigurationLayer } from "@/lib/configuration";
import { cn } from "@/lib/cn";
import { useGithubIdentity } from "@/lib/githubIdentity";
import { LAYER_ORDER, LAYER_TITLES, resetFor } from "@/lib/settingSources";
import type { SettingsFileLayer } from "@/types/settingsSources";
import { SettingsFiles } from "./SettingsFiles";
import { ValueSource } from "./ValueSource";
import { RegisteredSetting } from "./settingsRegistry";
import { useRepositoryMutation } from "./repositoryEditor";
import { BadgeLegend, LAYERED_BADGES } from "./SettingSources";
import { SettingRowActions } from "./SettingRowActions";
import { isLocalKey } from "@/types/target";

/** Labels and fields at the size of the setting rows around them: 13px (PRO-374). */
const fieldClass = "h-8 w-full rounded-md border border-border bg-well px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50";

export function LayeredConfiguration() {
  const { projects } = useSessionStore();
  const [project, setProject] = useState("");
  const repositoryId = useId();
  const local = projects.filter((p) => p.kind !== "folder" && isLocalKey(p.path) && !p.archived);
  return <RegisteredSetting setting="general.layeredConfiguration"><section className="flex flex-col gap-3 border-b border-hairline py-3.5" aria-label="Layered configuration">
    {/* Its one “…” sits beside Branch prefix, the value it sets (design 09.23). */}
    <h3 className="text-[13px] font-medium">Layered configuration</h3>
    <p className="-mt-2 text-xs text-muted-foreground">Managed settings take priority, followed by repository local, repository shared, user settings and defaults. Changes apply to new launches.</p>
    <div className="flex flex-col gap-1"><label htmlFor={repositoryId} className="text-[13px] font-medium">Repository</label>
      <select id={repositoryId} className={fieldClass} value={project} onChange={(e) => setProject(e.target.value)}>
        <option value="">User settings</option>
        {local.map((p) => <option value={p.path} key={p.path}>{p.name}</option>)}
      </select>
    </div>
    {/* The GitHub username choice asks GitHub about the chosen repository, else the first one added. */}
    <ConfigurationEditor key={project} project={project || null} identityPath={project || local[0]?.path || null} />
  </section></RegisteredSetting>;
}

type PrefixChoice = "default" | "github" | "custom" | "none";

function ConfigurationEditor({ project, identityPath }: { project: string | null; identityPath: string | null }) {
  const layerId = useId();
  const prefixId = useId();
  const groupId = useId();
  const login = useGithubIdentity(identityPath)?.login;
  const [picked, setPicked] = useState<PrefixChoice | null>(null);
  const [resolved, setResolved] = useState<Configuration | null>(null);
  const [files, setFiles] = useState<SettingsFileLayer[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const dirty = useRef(false);
  const generation = useRef(0);
  const [prefix, setPrefix] = useState("");
  const [layer, setLayer] = useState<ConfigurationLayer>("user");
  const [notice, setNotice] = useState<string | null>(null);
  const { busy: saving, error, run } = useRepositoryMutation();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const busy = loading || saving;
  const install = (next: Configuration, preserveDraft = false) => {
    if (!preserveDraft) { generation.current++; setLoading(false); }
    setResolved(next);
    if (!preserveDraft || !dirty.current || next.values.branchPrefix?.locked) {
      dirty.current = false;
      setPrefix(String(next.values.branchPrefix?.value ?? ""));
    }
  };
  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Settings files are read beside the values; an older runtime without the list keeps its values.
    const reloadFiles = async () => {
      try {
        const next = await configuration.files(project);
        if (live) { setFiles(next); setFilesError(null); }
      } catch (cause) {
        if (live) setFilesError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    const reload = async () => {
      void reloadFiles();
      const request = ++generation.current;
      try {
        const next = await configuration.resolve(project);
        if (live && request === generation.current) { install(next, true); setLoadError(null); }
      } catch (cause) {
        if (live && request === generation.current) {
          setLoadError(cause instanceof Error ? cause.message : String(cause));
          setResolved(null); // An unreadable policy must not leave stale writable controls.
        }
      } finally { if (live && request === generation.current) setLoading(false); }
    };
    const changed = () => { if (!live) return; clearTimeout(timer); timer = setTimeout(() => { void reload(); }, 150); };
    // The user file's own event (an edit in an editor) refreshes values and Settings files too.
    let stopUserFile: (() => void) | undefined;
    void listen("settings_file_changed", changed).then((unlisten) => { if (live) stopUserFile = unlisten; else unlisten(); }).catch(() => {});
    // Subscribe before resolving so edits during the initial read are observed.
    void configuration.watch(project, changed).then((unsubscribe) => {
      if (!live) { unsubscribe(); return; }
      stop = unsubscribe;
      void reload();
    }).catch(() => {
      if (live) { setNotice("Automatic refresh is unavailable. Use Refresh configuration to reload changes."); void reload(); }
    });
    return () => { live = false; clearTimeout(timer); stop?.(); stopUserFile?.(); };
  }, [project]);
  const value = resolved?.values.branchPrefix;
  const repositoryAllowed = resolved?.registry.find((r) => r.key === "branchPrefix")?.repositoryConfigurable;
  const resetLayer = async (from: ConfigurationLayer) => {
    await run(async () => {
      await configuration.write(project, from, "branchPrefix", null);
      install(await configuration.resolve(project));
      setNotice(`Removed the ${LAYER_TITLES[from]} value.`);
    });
  };
  const save = (next: string | null) => void run(async () => {
    await configuration.write(project, layer, "branchPrefix", next);
    install(await configuration.resolve(project));
    setNotice(next === null ? `Removed the ${LAYER_TITLES[layer]} value.` : `Saved to ${layerLabels[layer]}.`);
  });
  // PRO-374 (design 09.23): the prefix is a choice. TerminalX default, GitHub username and None save at once;
  // Custom saves its field on Enter or when it loses focus.
  const locked = busy || !value || value.locked;
  const current = String(value?.value ?? "");
  const defaultPrefix = String(value?.layers?.find((entry) => entry.layer === "defaults")?.value ?? "");
  const derived: PrefixChoice = current === defaultPrefix ? "default" : current === "" ? "none" : login && current === `${login}/` ? "github" : "custom";
  const choice = picked ?? derived;
  const resettable = value ? resetFor(value) : null;
  // TerminalX default removes the chosen layer's value, so a later change to the built-in default still reaches
  // the person. Only when a layer below would then win (your own prefix under a repository's) is the default
  // written, as the one way to put it back over that layer.
  const lowerValue = value?.layers?.some((entry) => entry.layer !== "defaults" && LAYER_ORDER.indexOf(entry.layer) > LAYER_ORDER.indexOf(layer));
  const choose = (option: PrefixChoice) => {
    setPicked(option === "custom" ? "custom" : null);
    if (option === "custom") { if (derived !== "custom") { dirty.current = true; setPrefix(""); } return; }
    if (option === "default") {
      const layerHasValue = value?.layers?.some((entry) => entry.layer === layer);
      if (lowerValue) save(defaultPrefix);
      else if (layerHasValue) save(null);
      return;
    }
    const next = option === "github" ? `${login}/` : "";
    if (next !== current || value?.source !== layer) save(next);
  };
  const saveCustom = () => {
    const next = prefix.trim();
    if (!next || locked || (next === current && value?.source === layer)) return;
    save(next);
  };
  return <div className="flex flex-col gap-3">
    {(error || loadError) && <p role="alert" className="text-sm text-destructive">{error || loadError}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {resolved?.warnings.map((warning) => <p key={warning} role="status" className="text-xs text-muted-foreground">{warning}</p>)}
    {project && resolved?.trust?.required && <div className="rounded-md border border-hairline p-3">
      <p className="text-sm">This repository has shared settings that need your trust before work can start.</p>
      <p className="my-2 break-words font-mono text-xs">{resolved.trust.keys.join(", ")}</p>
      <Button size="sm" disabled={busy} onClick={() => void run(async () => {
        const trusted = await configuration.review(project);
        install(await configuration.resolve(project));
        setNotice(trusted ? "Shared configuration trusted." : "Not trusted. Nothing was started.");
      })}>Review repository trust</Button>
    </div>}
    <div role="radiogroup" aria-labelledby={groupId} className="group/setting flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span id={groupId} className="text-[13px] font-medium">Branch prefix</span>
        {value && <ValueSource value={value} label="Branch prefix" repository={!!project} files={files ?? []} onReset={resetLayer} />}
        <SettingRowActions id="general.layeredConfiguration" title="Layered configuration" label="Branch prefix"
          reset={{ value: defaultPrefix ? defaultPrefix : "none", disabled: busy || !value || !resettable, onReset: () => { if (resettable) void resetLayer(resettable.layer); } }} />
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">Put in front of every new workspace branch.</p>
      {([
        ["default", "TerminalX default", defaultPrefix],
        ["github", "GitHub username", login ? `${login}/` : null],
        ["custom", "Custom", null],
        ["none", "None", null],
      ] as const).map(([option, title, shown]) => <div key={option} className="flex flex-col gap-1.5">
        <label className={cn("flex w-fit items-center gap-2.5 text-[13px]", (locked || (option === "github" && !login)) && "opacity-60")}>
          <input type="radio" name={groupId} value={option} checked={choice === option} disabled={locked || (option === "github" && !login)}
            className="size-3.5 accent-accent" onChange={() => choose(option)} />
          <span>{title}</span>
          {shown && <span className="font-mono text-xs text-faint">{shown}</span>}
          {option === "github" && !login && <span className="text-xs text-faint">not signed in</span>}
        </label>
        {option === "custom" && choice === "custom" && <div className="ml-6 flex flex-wrap items-center gap-3">
          <input id={prefixId} aria-label="Custom prefix" className={cn(fieldClass, "w-48 font-mono")} value={prefix} disabled={locked}
            onChange={(e) => { dirty.current = true; setPrefix(e.target.value); }}
            onBlur={() => saveCustom()} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveCustom(); } }} placeholder="team/" />
        </div>}
      </div>)}
      {/* What the next branch gets: the saved prefix, not an unsaved draft in the Custom field. */}
      <p className="font-mono text-xs text-faint" aria-live="polite">Next branch: {current}fix-login-bug</p>
    </div>
    {value?.locked && <p className="text-xs text-muted-foreground">Locked by managed configuration</p>}
    {project && value && (value.source === "repositoryShared" || value.source === "repositoryLocal") && <p className="text-xs text-muted-foreground">This repository overrides the user prefix. Saving to User affects repositories that inherit it.</p>}
    {project && repositoryAllowed && <div className="flex flex-col gap-1"><label htmlFor={layerId} className="text-[13px] font-medium">Save to</label>
      <select id={layerId} className={fieldClass} value={layer} disabled={busy || value?.locked} onChange={(e) => setLayer(e.target.value as ConfigurationLayer)}>
        <option value="user">User</option>
        <option value="repositoryLocal">Save for this repository (local)</option><option value="repositoryShared">Repository shared (committed)</option>
      </select>
    </div>}
    {notice?.startsWith("Automatic refresh") && <div><Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => { install(await configuration.resolve(project)); setLoadError(null); })}>Refresh configuration</Button></div>}
    <BadgeLegend kinds={LAYERED_BADGES} />
    {resolved && Object.keys(resolved.values).some((key) => key.startsWith("environment.")) && <table className="w-full text-left text-xs" aria-label="Resolved environment sources">
      <thead><tr><th className="py-2">Variable</th><th>Source</th><th>Status</th></tr></thead>
      <tbody>{Object.entries(resolved.values).filter(([key]) => key.startsWith("environment.")).map(([key, entry]) => <tr key={key}><td className="break-all py-1 font-mono">{key.slice(12)}</td><td>{layerLabels[entry.source]}</td><td>{entry.locked ? "Locked" : "Value hidden"}</td></tr>)}</tbody>
    </table>}
    <SettingsFiles files={files} error={filesError} />
    <p className="text-xs text-muted-foreground">Repository files: .terminalx/settings.json and .terminalx/settings.local.json. Private variables stay in Settings → Environment. Setup and archive scripts are edited in Settings → Projects → Scripts.</p>
  </div>;
}
