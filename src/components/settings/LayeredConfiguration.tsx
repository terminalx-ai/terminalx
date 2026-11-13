import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/lib/sessions";
import { listen } from "@tauri-apps/api/event";
import { configuration, layerLabels, type Configuration, type ConfigurationLayer } from "@/lib/configuration";
import { LAYER_TITLES } from "@/lib/settingSources";
import type { SettingsFileLayer } from "@/types/settingsSources";
import { SettingsFiles } from "./SettingsFiles";
import { ValueSource } from "./ValueSource";
import { RegisteredSetting } from "./settingsRegistry";
import { repositoryInputClass, useRepositoryMutation } from "./repositoryEditor";

export function LayeredConfiguration() {
  const { projects } = useSessionStore();
  const [project, setProject] = useState("");
  const repositoryId = useId();
  return <RegisteredSetting setting="general.layeredConfiguration"><section className="my-4 flex flex-col gap-3" aria-label="Layered configuration">
    <h3 className="text-sm font-medium">Layered configuration</h3>
    <p className="text-xs text-muted-foreground">Managed settings take priority, followed by repository local, repository shared, user settings and defaults. Changes apply to new launches.</p>
    <div className="flex flex-col gap-1 text-sm"><label htmlFor={repositoryId}>Repository</label>
      <select id={repositoryId} className={repositoryInputClass} value={project} onChange={(e) => setProject(e.target.value)}>
        <option value="">User settings</option>
        {projects.filter((p) => p.kind !== "folder" && !p.path.startsWith("cloud:") && !p.archived).map((p) => <option value={p.path} key={p.path}>{p.name}</option>)}
      </select>
    </div>
    <ConfigurationEditor key={project} project={project || null} />
  </section></RegisteredSetting>;
}
function ConfigurationEditor({ project }: { project: string | null }) {
  const layerId = useId();
  const prefixId = useId();
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
  const save = (reset: boolean) => void run(async () => {
    await configuration.write(project, layer, "branchPrefix", reset ? null : prefix);
    install(await configuration.resolve(project));
    setNotice(reset ? "Override removed." : `Saved to ${layerLabels[layer]}.`);
  });
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
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={prefixId}>Branch prefix</label>
        {value && <ValueSource value={value} label="Branch prefix" repository={!!project} files={files ?? []} onReset={resetLayer} />}
      </div>
      <input id={prefixId} className={repositoryInputClass} value={prefix} disabled={busy || !value || value.locked} onChange={(e) => { dirty.current = true; setPrefix(e.target.value); }} placeholder="team/" />
    </div>
    {value && <p className="text-xs text-muted-foreground">Source: {layerLabels[value.source]}{value.locked ? " · Locked by managed configuration" : ""}</p>}
    {project && value && (value.source === "repositoryShared" || value.source === "repositoryLocal") && <p className="text-xs text-muted-foreground">This repository overrides the user prefix. Saving to User affects repositories that inherit it.</p>}
    <div className="flex flex-col gap-1 text-sm"><label htmlFor={layerId}>Save to</label>
      <select id={layerId} className={repositoryInputClass} value={layer} disabled={busy || value?.locked} onChange={(e) => setLayer(e.target.value as ConfigurationLayer)}>
        <option value="user">User</option>
        {project && repositoryAllowed && <><option value="repositoryLocal">Save for this repository (local)</option><option value="repositoryShared">Repository shared (committed)</option></>}
      </select>
    </div>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={busy || !value || value.locked || !prefix.trim()} onClick={() => save(false)}>Save prefix</Button>
      <Button size="sm" variant="outline" disabled={busy || !value || value.locked} onClick={() => save(true)}>Reset selected layer</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => { install(await configuration.resolve(project)); setLoadError(null); })}>Refresh configuration</Button>
    </div>
    {resolved && Object.keys(resolved.values).some((key) => key.startsWith("environment.")) && <table className="w-full text-left text-xs" aria-label="Resolved environment sources">
      <thead><tr><th className="py-2">Variable</th><th>Source</th><th>Status</th></tr></thead>
      <tbody>{Object.entries(resolved.values).filter(([key]) => key.startsWith("environment.")).map(([key, entry]) => <tr key={key}><td className="break-all py-1 font-mono">{key.slice(12)}</td><td>{layerLabels[entry.source]}</td><td>{entry.locked ? "Locked" : "Value hidden"}</td></tr>)}</tbody>
    </table>}
    <SettingsFiles files={files} error={filesError} />
    <p className="text-xs text-muted-foreground">Repository files: .terminalx/settings.json and .terminalx/settings.local.json. Private variables stay in Settings → Environment. Setup and archive scripts are edited in Settings → Repositories → Scripts.</p>
  </div>;
}
