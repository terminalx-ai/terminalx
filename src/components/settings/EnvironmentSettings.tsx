import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { RegisteredSetting, resolveSetting } from "./settingsRegistry";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSessionStore } from "@/lib/sessions";
import { errorMessage } from "@/lib/api";
import { environment, environmentNameError, parseLocalEnv, type EnvironmentRow } from "@/lib/localEnvironment";

const inputClass = "w-full rounded-md border border-hairline bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40";

export function EnvironmentSettings() {
  const { projects } = useSessionStore();
  const [project, setProject] = useState("");
  return <RegisteredSetting setting="environment.variables"><div className="flex flex-col gap-5">
    <p className="text-sm text-muted-foreground">{resolveSetting("environment.variables").description}</p>
    <label className="flex flex-col gap-2 text-sm">Scope
      <select className={inputClass} value={project} onChange={(e) => setProject(e.target.value)}>
        <option value="">User — all repositories</option>
        {projects.filter((p) => p.kind !== "folder" && !p.path.startsWith("cloud:")).map((p) => <option key={p.path} value={p.path}>{p.name} — {p.path}</option>)}
      </select>
    </label>
    <EnvironmentTable key={project} project={project || null} />
    <details className="rounded-lg border border-hairline p-3 text-sm">
      <summary className="cursor-pointer font-medium">Variables set by TerminalX</summary>
      <p className="my-3 text-muted-foreground">These names are reserved. Values depend on the launch; credentials are never shown here.</p>
      <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-2 break-words text-xs">
        <dt className="font-mono">TERM, COLORTERM, TERM_PROGRAM</dt><dd>Terminal capabilities and application name</dd>
        <dt className="font-mono">PATH</dt><dd>Login shell executable search path</dd>
        <dt className="font-mono">RACCOON</dt><dd>TerminalX terminal marker</dd>
        <dt className="font-mono">RACCOON_SESSION_ID, RACCOON_TAB_ID</dt><dd>Agent session and tab identity</dd>
        <dt className="font-mono">TERMINALX_NEXT_SOCKET</dt><dd>Local control socket</dd>
        <dt className="font-mono">RACCOON_HOOK_SOCKET</dt><dd>Agent hook socket</dd>
        <dt className="font-mono">TERMINALX_NEXT_TOKEN, RACCOON_HOOK_TOKEN</dt><dd>Private control and hook credentials</dd>
        <dt className="font-mono">CODEX_HOME</dt><dd>Codex launch configuration directory</dd>
      </dl>
      <p className="mt-3 text-muted-foreground">The workspace path is the process working directory. Local launches do not allocate an environment variable for workspace paths or ports. HOME, LD_PRELOAD, DYLD_*, TERMINALX_* and RACCOON_* names are reserved.</p>
    </details>
  </div></RegisteredSetting>;
}

function EnvironmentTable({ project }: { project: string | null }) {
  const [rows, setRows] = useState<EnvironmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<{ previous: string | null; name: string; value: string } | null>(null);
  const [paste, setPaste] = useState<string | null>(null);
  const ownScope = project ? "repository" : "user";
  const names = rows?.filter((r) => r.scope === ownScope).map((r) => r.name) ?? [];
  const refresh = () => environment.list(project).then(setRows);
  useEffect(() => { let live = true; environment.list(project).then((rows) => { if (live) setRows(rows); }).catch((e) => { if (live) setError(errorMessage(e)); }); return () => { live = false; }; }, [project]);
  const action = async (run: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await run(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const changed = async (ready: boolean) => {
    // Clear all revealed values after any edit by replacing the table's rows.
    setNotice(ready ? "Saved. Running tabs: Restart to apply. Nothing restarts automatically." : "Saved, but environment overrides are not ready for new tabs yet. Check Keychain access and the local runtime before starting a new tab. Running tabs are unchanged.");
    window.dispatchEvent(new Event("local-environment-changed"));
    await refresh();
  };
  const nameError = sheet ? environmentNameError(sheet.name) ?? (names.includes(sheet.name) && sheet.name !== sheet.previous ? "A variable with this name already exists in this scope." : null) : null;
  const parsed = paste === null ? null : parseLocalEnv(paste, names);
  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={busy || !rows} onClick={() => setSheet({ previous: null, name: "", value: "" })}>Add variable</Button>
      <Button size="sm" variant="outline" disabled={busy || !rows} onClick={() => setPaste("")}>Paste variables</Button>
      {project && <Button size="sm" variant="outline" disabled={busy || !rows} onClick={() => void action(async () => {
        const path = await open({ title: "Load from .env file", defaultPath: project, multiple: false, directory: false });
        if (typeof path === "string") setPaste(await environment.readFile(project, path));
      })}>Load from .env file</Button>}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {rows === null ? <p className="text-sm text-muted-foreground">Loading variables…</p> : <div className="overflow-x-auto rounded-lg border border-hairline">
      <table className="w-full text-left text-sm" aria-label="Environment variables">
        <thead className="border-b border-hairline text-muted-foreground"><tr><th className="p-3">Name</th><th className="p-3">Value</th><th className="p-3">Scope</th><th className="p-3"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{rows.map((row) => <VariableRow key={`${row.scope}:${row.name}`} row={row} reset={rows} project={project} disabled={busy} editable={row.scope === ownScope} run={action} edit={(value) => setSheet({ previous: row.name, name: row.name, value })} remove={async () => { const ready = await environment.delete(project, row.name); await changed(ready); }} />)}</tbody>
      </table>
      {!rows.length && <p className="p-4 text-sm text-muted-foreground">No variables in this scope.</p>}
    </div>}
    {sheet && <Dialog open onOpenChange={(open) => { if (!open && !busy) setSheet(null); }}><DialogContent>
      <DialogHeader><DialogTitle>{sheet.previous ? "Edit variable" : "Add variable"}</DialogTitle><DialogDescription>{project ? "Repository" : "User"} scope · stored in Keychain</DialogDescription></DialogHeader>
      <form onSubmit={(e) => { e.preventDefault(); if (!busy && !nameError) void action(async () => { const ready = await environment.save(project, [{ name: sheet.name, value: sheet.value }], sheet.previous); setSheet(null); await changed(ready); }); }}>
        <label className="mb-3 flex flex-col gap-2 text-sm">Name<input autoFocus autoComplete="off" spellCheck={false} className={inputClass} value={sheet.name} onChange={(e) => setSheet({ ...sheet, name: e.target.value })} /></label>
        <label className="flex flex-col gap-2 text-sm">Value<input type="password" autoComplete="new-password" className={inputClass} value={sheet.value} onChange={(e) => setSheet({ ...sheet, value: e.target.value })} /></label>
        {sheet.name && nameError && <p role="alert" className="mt-2 text-sm text-destructive">{nameError}</p>}
        {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setSheet(null)}>Cancel</Button><Button type="submit" disabled={busy || !!nameError}>Save variable</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>}
    {paste !== null && parsed && <Dialog open onOpenChange={(open) => { if (!open && !busy) setPaste(null); }}><DialogContent>
      <DialogHeader><DialogTitle>Import variables</DialogTitle><DialogDescription>Paste NAME=value lines. Quotes and export prefixes are accepted. Values are literal, including backslash escapes; nothing is expanded or executed.</DialogDescription></DialogHeader>
      <label className="flex flex-col gap-2 text-sm">Variables<textarea autoFocus autoComplete="off" spellCheck={false} className={`${inputClass} h-48 font-mono`} value={paste} onChange={(e) => setPaste(e.target.value)} /></label>
      <p className="mt-2 text-sm">{parsed.inputs.length} valid variables</p>
      {parsed.errors.length > 0 && <ul role="alert" className="mt-2 max-h-32 overflow-y-auto text-sm text-destructive">{parsed.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setPaste(null)}>Cancel</Button><Button disabled={busy || !parsed.inputs.length} onClick={() => void action(async () => { const ready = await environment.save(project, parsed.inputs); setPaste(null); await changed(ready); })}>Import {parsed.inputs.length} valid variables</Button></DialogFooter>
    </DialogContent></Dialog>}
  </div>;
}

function VariableRow({ row, project, editable, disabled, reset, run, edit, remove }: {
  row: EnvironmentRow; project: string | null; editable: boolean; disabled: boolean; reset: EnvironmentRow[];
  run: (action: () => Promise<void>) => Promise<void>; edit: (value: string) => void; remove: () => Promise<void>;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const scope = row.scope === "user" ? null : project;
  useEffect(() => { setRevealed(null); }, [reset]);
  useEffect(() => { if (revealed === null) return; const timer = setTimeout(() => setRevealed(null), 30_000); return () => clearTimeout(timer); }, [revealed]);
  return <tr className="border-b border-hairline last:border-0">
    <td className="p-3 font-mono">{row.name}{row.overridden && <span className="block font-sans text-xs text-muted-foreground">Overridden</span>}</td>
    <td className="max-w-48 break-all p-3 font-mono">{revealed === null ? "••••••••" : revealed || "(empty)"}</td>
    <td className="p-3">{row.scope === "user" ? "User" : "Repository"}</td>
    <td className="p-2"><div className="flex flex-wrap gap-1">
      <Button size="sm" variant="ghost" disabled={disabled} aria-label={`${revealed === null ? "Reveal" : "Hide"} ${row.name}`} onClick={() => { if (revealed !== null) setRevealed(null); else void run(async () => setRevealed(await environment.reveal(scope, row.name))); }}>{revealed === null ? "Reveal" : "Hide"}</Button>
      <Button size="sm" variant="ghost" disabled={disabled} title="Copy for 30 seconds" aria-label={`Copy ${row.name}`} onClick={() => void run(async () => environment.copy(scope, row.name))}>Copy</Button>
      {editable && <><Button size="sm" variant="ghost" disabled={disabled} aria-label={`Edit ${row.name}`} onClick={() => void run(async () => edit(await environment.reveal(scope, row.name)))}>Edit</Button><Button size="sm" variant="ghost" disabled={disabled} aria-label={`Delete ${row.name}`} onClick={() => void run(remove)}>Delete</Button></>}
    </div></td>
  </tr>;
}
