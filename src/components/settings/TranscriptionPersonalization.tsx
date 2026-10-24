import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { SettingRow, Switch } from "@/components/ui/controls";
import { errorMessage } from "@/lib/api";
import { startDictation, stopDictation, useDictation } from "@/lib/dictation";
import { useSessionStore } from "@/lib/sessions";
import { transcriptionPersonalization as api, type TranscriptionDiagnostic, type TranscriptionEntry, type TranscriptionOptions, type TranscriptionPersonalizationData } from "@/lib/transcriptionPersonalization";

import { TranscriptionNoiseGuard } from "./TranscriptionNoiseGuard";

const TEST_TARGET = "transcription-test";
const field = "w-full rounded-md border border-hairline-strong bg-well px-2 py-1.5 text-xs";
type ToggleKey = Exclude<keyof TranscriptionOptions, "language" | "sensitiveTargets">;
const contextOptions: [ToggleKey, string][] = [["context", "Use context from TerminalX"], ["project", "Project file names and branch"], ["session", "Session tools and file identifiers"], ["terminal", "Visible terminal text"], ["composer", "Composer draft"], ["remoteContext", "Allow remote workspace context on this Mac"]];
const cleanupOptions: [ToggleKey, string][] = [["noiseGuard", "Local-model noise guard"], ["guards", "Prompt echo and repetition guards"], ["retakes", "Unambiguous spoken retakes"], ["normalize", "Number, symbol and extension formatting"], ["code", "Code formatting"], ["fillers", "Filler removal"]];
const groups: [TranscriptionEntry["kind"], ToggleKey, string][] = [["vocabulary", "dictionary", "Dictionary"], ["replacement", "replacements", "Replacements"], ["snippet", "snippets", "Snippets"], ["learned", "learn", "Learn from my corrections"]];

export function TranscriptionPersonalization() {
  const [data, setData] = useState<TranscriptionPersonalizationData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TranscriptionEntry | null>(null);
  const [diagnostic, setDiagnostic] = useState<TranscriptionDiagnostic | null>(null);
  const [diagnosticReady, setDiagnosticReady] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const store = useSessionStore();
  const [testProject, setTestProject] = useState(store.lastProject ?? "");
  const [projectTerms, setProjectTerms] = useState<string[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const dictation = useDictation();
  const ownsRecording = useRef(false);
  const acceptDiagnostics = useRef(false);
  const saving = useRef(false);
  const importInput = useRef<HTMLInputElement>(null);
  const active = dictation.target === TEST_TARGET && dictation.phase !== "idle";
  ownsRecording.current = active;

  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    void api.load().then((value) => { if (live) setData(value); }).catch((e) => { if (live) setError(errorMessage(e)); });
    void listen<TranscriptionDiagnostic>("transcription_diagnostic", ({ payload }) => {
      if (live && acceptDiagnostics.current && payload.target === TEST_TARGET) setDiagnostic(payload);
    }).then((off) => { if (live) { unlisten = off; setDiagnosticReady(true); } else off(); }).catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; unlisten?.(); if (ownsRecording.current) void stopDictation(); };
  }, []);

  useEffect(() => {
    let live = true;
    setProjectTerms([]);
    if (!testProject || !data?.options.context || !data.options.project) { setContextLoading(false); return; }
    setContextLoading(true);
    void invoke<string[]>("transcription_project_terms", { cwd: testProject }).then((terms) => { if (live) setProjectTerms(terms); }).catch((e) => { if (live) setError(errorMessage(e)); }).finally(() => { if (live) setContextLoading(false); });
    return () => { live = false; };
  }, [testProject, data?.options.context, data?.options.project]);

  async function persist(next: TranscriptionPersonalizationData) {
    if (saving.current) return false;
    saving.current = true;
    setBusy(true);
    setError(null);
    try { setData(await api.save(next)); return true; }
    catch (e) { setError(errorMessage(e)); return false; }
    finally { saving.current = false; setBusy(false); }
  }
  function toggle(key: ToggleKey, checked: boolean) {
    if (data) void persist({ ...data, options: { ...data.options, [key]: checked } });
  }
  function row(key: ToggleKey, label: string) {
    return <SettingRow key={key} label={label} control={<Switch aria-label={label} disabled={busy} checked={data?.options[key] ?? false} onCheckedChange={(v) => toggle(key, v)} />} />;
  }
  async function reload() {
    setBusy(true);
    setError(null);
    try { setData(await api.load()); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function reset() {
    setBusy(true);
    setError(null);
    try { if (ownsRecording.current) await stopDictation(); setData(await api.reset()); acceptDiagnostics.current = false; setEditing(null); setDiagnostic(null); setConfirmReset(false); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function exportData() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const path = await save({ defaultPath: "terminalx-transcription.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (path) await api.export(path);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function importData(file: File) {
    if (file.size > 5_000_000) { setError("Choose a JSON file smaller than 5 MB."); return; }
    try {
      const imported: unknown = JSON.parse(await file.text());
      if (!imported || typeof imported !== "object" || !("options" in imported) || !("entries" in imported) || !Array.isArray(imported.entries)) throw new Error("Expected a TerminalX transcription JSON export.");
      // The Rust store validates every field and rejects secrets before saving.
      if (await persist({ ...(imported as TranscriptionPersonalizationData), revision: data?.revision ?? 0 })) setEditing(null);
    } catch (e) { setError(errorMessage(e)); }
  }

  return <div className="flex flex-col gap-5 border-t border-hairline pt-5">
    <div><div className="text-sm font-medium">Personalisation</div><p className="mt-1 text-xs text-muted-foreground">Stored on this Mac. Features start off; enable only what you want. Context is rebuilt for each recording and is not saved.</p></div>
    {error && <div className="flex items-center gap-2"><p role="alert" className="text-xs text-destructive">{error}</p><Button size="xs" variant="outline" disabled={busy} onClick={() => void reload()}>Reload settings</Button></div>}
    {!data ? <p className="text-xs text-muted-foreground">Loading personalisation…</p> : <>
      <div>{contextOptions.map(([key, label]) => row(key, label))}<p className="text-xs text-muted-foreground">Whisper uses a bounded prompt; Apple uses contextual strings. Other models use dictionary repair after recognition. Context source switches require “Use context” above. Draft and terminal text can promote known file, tool and dictionary terms; arbitrary text and file contents are excluded.</p></div>
      <details><summary className="cursor-pointer text-sm font-medium">Sensitive tabs</summary><p className="my-2 text-xs text-muted-foreground">Exclude these tabs from context, personalisation and learning.</p>
        {store.sessions.filter((s) => !s.archived).flatMap((session) => session.tabs.map((tab) => <SettingRow key={tab.id} label={`${session.title} / ${tab.title || tab.harness}`} control={<Switch aria-label={`Exclude ${session.title} / ${tab.title || tab.harness}`} checked={data.options.sensitiveTargets.includes(tab.id)} disabled={busy} onCheckedChange={(value) => void persist({ ...data, options: { ...data.options, sensitiveTargets: value ? [...data.options.sensitiveTargets, tab.id] : data.options.sensitiveTargets.filter((id) => id !== tab.id) } })} />} />))}
      </details>
      {groups.map(([kind, key, label]) => <div key={kind}>
        {row(key, label)}
        {kind === "learned" && <p className="mb-2 text-xs text-muted-foreground">Short word corrections are learned locally after edited dictation is sent. Case and punctuation changes are ignored.</p>}
        <ul className="space-y-2">{data.entries.filter((entry) => entry.kind === kind).map((entry) => <li key={entry.id} className="rounded-md border border-hairline p-2 text-xs">
          <div className="whitespace-pre-wrap break-words">{kind === "vocabulary" ? entry.written : `${entry.heard} → ${entry.written}`}</div>
          <div className="mt-1 text-muted-foreground">{entry.project || "All projects"}{entry.soundsLike.length > 0 && ` · Sounds like: ${entry.soundsLike.join(", ")}`}</div>
          <div className="mt-1 flex gap-1">{kind !== "learned" && <Button size="xs" variant="ghost" disabled={busy} onClick={() => setEditing({ ...entry })}>Edit</Button>}<Button size="xs" variant="ghost" disabled={busy} onClick={() => void persist({ ...data, entries: data.entries.filter((e) => e.id !== entry.id) })}>Remove</Button></div>
        </li>)}</ul>
        <div className="mt-2">{kind !== "learned" ? <Button size="xs" variant="outline" disabled={busy} onClick={() => setEditing({ id: crypto.randomUUID(), kind, heard: "", written: "", soundsLike: [], project: null })}>Add {kind === "vocabulary" ? "term" : kind}</Button> : <Button size="xs" variant="outline" disabled={busy || !data.entries.some((e) => e.kind === "learned")} onClick={() => void persist({ ...data, entries: data.entries.filter((e) => e.kind !== "learned") })}>Forget all learned corrections</Button>}</div>
      </div>)}
      {editing && <form className="flex flex-col gap-2 rounded-lg border border-hairline-strong p-3" onSubmit={(event) => { event.preventDefault(); void persist({ ...data, entries: [...data.entries.filter((entry) => entry.id !== editing.id), { ...editing, soundsLike: editing.soundsLike.map((term) => term.trim()).filter(Boolean) }] }).then((ok) => { if (ok) setEditing(null); }); }}>
        <div className="text-sm font-medium">{editing.kind === "vocabulary" ? "Dictionary term" : editing.kind === "snippet" ? "Snippet" : "Replacement"}</div>
        {editing.kind !== "vocabulary" && <label className="text-xs">Spoken trigger<input required maxLength={120} className={field} value={editing.heard} onChange={(e) => setEditing({ ...editing, heard: e.target.value })} /></label>}
        <label className="text-xs">{editing.kind === "vocabulary" ? "Written term" : "Written text"}<textarea required maxLength={editing.kind === "snippet" ? 4096 : 120} className={field} value={editing.written} onChange={(e) => setEditing({ ...editing, written: e.target.value })} /></label>
        {editing.kind === "vocabulary" && <label className="text-xs">Sounds like (one spelling per line)<textarea className={field} value={editing.soundsLike.join("\n")} onChange={(e) => setEditing({ ...editing, soundsLike: e.target.value.split("\n") })} /></label>}
        <label className="text-xs">Scope<select className={field} value={editing.project ?? ""} onChange={(e) => setEditing({ ...editing, project: e.target.value || null })}><option value="">All projects</option>{editing.project && !store.projects.some((p) => p.path === editing.project) && <option value={editing.project}>{editing.project}</option>}{store.projects.map((project) => <option key={project.path} value={project.path}>{project.name}</option>)}</select></label>
        <div className="flex gap-2"><Button size="sm" type="submit" disabled={busy}>Save entry</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button></div>
      </form>}
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void exportData()}>Export JSON</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => importInput.current?.click()}>Import JSON</Button><input ref={importInput} hidden type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importData(file); }} /><p className="w-full text-xs text-muted-foreground">Import replaces settings and entries with the selected export.</p></div>
      <div><div className="text-sm font-medium">Clean-up</div>{cleanupOptions.map(([key, label]) => row(key, label))}<TranscriptionNoiseGuard /></div>
      <SettingRow label="Language" description="Language hint for Apple, Whisper and Canary. Parakeet and Nemotron keep their supported language." control={<select aria-label="Language" className={field} disabled={busy} value={data.options.language ?? ""} onChange={(e) => void persist({ ...data, options: { ...data.options, language: e.target.value || null } })}><option value="">Automatic</option>{[["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"], ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"], ["hi", "Hindi"], ["ar", "Arabic"], ["ru", "Russian"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>} />
      <div><div className="text-sm font-medium">Test dictation</div><p className="my-2 text-xs text-muted-foreground">Uses your microphone and selected engine. Results stay here and are not saved or sent to an agent.</p>
        <label className="mb-2 block text-xs">Test project<select className={field} disabled={active} value={testProject} onChange={(e) => setTestProject(e.target.value)}><option value="">Global dictionary only</option>{store.projects.map((project) => <option key={project.path} value={project.path}>{project.name}</option>)}</select></label>
        <p className="mb-2 text-xs text-muted-foreground">Project tests include enabled file-name context and scoped entries. Session, terminal and draft context are available when dictating into their composer.</p>
        <Button size="sm" variant="outline" disabled={busy || contextLoading || !diagnosticReady || (dictation.phase !== "idle" && !active) || dictation.phase === "finishing"} onClick={() => { if (active) void stopDictation(); else { setDiagnostic(null); acceptDiagnostics.current = true; startDictation(TEST_TARGET, { target: TEST_TARGET, project: testProject || null, coding: true, remote: false, sensitive: false, projectTerms, session: [], terminal: [], composer: "" }); } }}>{active ? (dictation.phase === "finishing" ? "Transcribing…" : "Stop test") : "Start test"}</Button>
        {dictation.error && <p role="alert" className="mt-2 text-xs text-destructive">{dictation.error}</p>}
        {diagnostic && <div className="mt-3 space-y-2 text-xs"><p className="text-muted-foreground">Engine: {diagnostic.engine}</p><div className="grid grid-cols-2 gap-2"><div><div className="font-medium">Raw transcript</div><pre className="whitespace-pre-wrap break-words rounded bg-well p-2 font-sans">{diagnostic.raw || "(empty)"}</pre></div><div><div className="font-medium">Final transcript</div><pre className="whitespace-pre-wrap break-words rounded bg-well p-2 font-sans">{diagnostic.finalText || "(empty)"}</pre></div></div><p>Noise guard: {diagnostic.noise?.status ?? "disabled"}{diagnostic.noise && diagnostic.noise.elapsedUs > 0 ? ` (${(diagnostic.noise.elapsedUs / 1000).toFixed(1)} ms)` : ""}</p><p className="break-words">Bias terms: {diagnostic.biasTerms.join(", ") || "None"}</p><Button size="xs" variant="ghost" onClick={() => { acceptDiagnostics.current = false; setDiagnostic(null); }}>Clear result</Button></div>}
      </div>
      <div>{confirmReset ? <div className="flex flex-wrap items-center gap-2 text-xs"><span>Delete all entries and turn every feature off?</span><Button size="sm" variant="destructive" disabled={busy} onClick={() => void reset()}>Reset everything</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmReset(false)}>Cancel</Button></div> : <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmReset(true)}>Reset all personalisation data</Button>}</div>
    </>}
  </div>;
}
