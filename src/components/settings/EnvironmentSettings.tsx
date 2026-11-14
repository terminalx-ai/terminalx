import { useEffect, useId, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { RegisteredSetting, resolveSetting } from "./settingsRegistry";
import { RepositoryEnvironmentSettings } from "./RepositoryEnvironmentSettings";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSessionStore } from "@/lib/sessions";
import { errorMessage } from "@/lib/api";
import { showError } from "@/lib/errorToasts";
import { TERMINALX_VARIABLES, appliesTo, environment, environmentNameError, isPrivateRow, isSecretRow, looksSecret, parseLocalEnv, withStorage, type EnvironmentInput, type EnvironmentRow } from "@/lib/localEnvironment";

const inputClass = "w-full rounded-md border border-hairline bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40";

/** Local projects whose variables can be set: Git repositories on this Mac. */
export const environmentProjects = <P extends { kind?: string; path: string }>(projects: P[]) => projects.filter((p) => p.kind !== "folder" && !p.path.startsWith("cloud:"));

/** Settings › Environment: Personal variables, applied to every project. */
export function EnvironmentSettings() {
  const { projects } = useSessionStore();
  const [project, setProject] = useState("");
  const repositoryId = useId();
  const local = environmentProjects(projects);
  return <RegisteredSetting setting="environment.variables"><div className="flex flex-col gap-5">
    <p className="text-sm text-muted-foreground">{resolveSetting("environment.variables").description} Secrets live in the Keychain; settings files keep only their names.</p>
    <section className="flex flex-col gap-2" aria-label="Personal variables">
      <h3 className="text-sm font-medium">Personal</h3>
      <p className="text-xs text-muted-foreground">Applied to every agent and terminal you start on this Mac. Project variables override these.</p>
      <EnvironmentTable project={null} projects={local} />
    </section>
    <TerminalXVariables />
    {local.length > 0 && <section className="flex flex-col gap-2" aria-label="Repository variables">
      <h3 className="text-sm font-medium">Repository variables</h3>
      <label htmlFor={repositoryId} className="text-xs text-muted-foreground">Scope</label>
      <select id={repositoryId} className={inputClass} value={project} onChange={(e) => setProject(e.target.value)}>
        <option value="">Choose a repository…</option>
        {local.map((p) => <option key={p.path} value={p.path}>{p.name} — {p.path}</option>)}
      </select>
      {project && <RepositoryEnvironmentSettings key={project} projectPath={project} />}
    </section>}
  </div></RegisteredSetting>;
}

/** What TerminalX itself sets, so nobody tries to set (or wonders about) these. */
export function TerminalXVariables() {
  return <details className="rounded-lg border border-hairline p-3 text-sm">
    <summary className="cursor-pointer font-medium">Variables TerminalX sets itself ({TERMINALX_VARIABLES.length})</summary>
    <p className="my-3 text-muted-foreground">These names are reserved. Values depend on the launch; credentials are never shown here.</p>
    <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-2 break-words text-xs">
      {TERMINALX_VARIABLES.map(({ names, description }) => <div key={names} className="contents"><dt className="font-mono">{names}</dt><dd>{description}</dd></div>)}
    </dl>
    <p className="mt-3 text-muted-foreground">The workspace path is the process working directory. Each workspace keeps its own block of ports while it exists. HOME, LD_PRELOAD, DYLD_*, TERMINALX_* and RACCOON_* names are reserved.</p>
  </details>;
}

/** `stored`: where an edited variable lives now (true: the Keychain); null when adding. */
type Sheet = { previous: string | null; name: string; value: string; stored: boolean | null };

/**
 * The variables of one scope (Personal when `project` is null), with what
 * each inherits or overrides. `onRows` hands the listed rows to the page.
 */
export function EnvironmentTable({ project, projects = [], emptyText = "No variables in this scope.", onRows }: {
  project: string | null; projects?: { name: string; path: string }[]; emptyText?: string; onRows?: (rows: EnvironmentRow[]) => void;
}) {
  const [rows, setRows] = useState<EnvironmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [paste, setPaste] = useState<string | null>(null);
  const [keepSecrets, setKeepSecrets] = useState(true);
  // Whether the Keychain switch was used on the open sheet: until then an edit keeps the variable where it is.
  const [switched, setSwitched] = useState(false);
  const chooseKeepSecrets = (on: boolean) => { setKeepSecrets(on); setSwitched(true); };
  const secretFor = (s: Sheet) => (s.stored !== null && !switched ? s.stored : keepSecrets && looksSecret(s.name, s.value));
  const ownScope = project ? "repository" : "user";
  const page = project ? "repository" : "personal";
  const names = rows?.filter((r) => r.scope === ownScope).map((r) => r.name) ?? [];
  const install = (next: EnvironmentRow[]) => { setRows(next); onRows?.(next); };
  const refresh = () => environment.list(project).then(install);
  useEffect(() => { let live = true; environment.list(project).then((rows) => { if (live) install(rows); }).catch((e) => { if (live) { setError(errorMessage(e)); showError("Couldn't load environment variables", e); } }); return () => { live = false; }; }, [project]);
  const action = async (run: () => Promise<void>, failure?: string) => {
    setBusy(true); setError(null); setNotice(null);
    try { await run(); } catch (e) { setError(errorMessage(e)); if (failure) showError(failure, e); } finally { setBusy(false); }
  };
  const changed = async (ready: boolean) => {
    // Clear all revealed values after any edit by replacing the table's rows.
    setNotice(ready ? "Saved. Running tabs: Restart to apply. Nothing restarts automatically." : "Saved, but environment overrides are not ready for new tabs yet. Check Keychain access and the local runtime before starting a new tab. Running tabs are unchanged.");
    window.dispatchEvent(new Event("local-environment-changed"));
    await refresh();
  };
  const openSheet = (next: Sheet) => { setKeepSecrets(next.stored ?? true); setSwitched(false); setError(null); setSheet(next); };
  const openPaste = (text: string) => { setKeepSecrets(true); setSwitched(false); setError(null); setPaste(text); };
  const nameError = sheet ? environmentNameError(sheet.name) ?? (names.includes(sheet.name) && sheet.name !== sheet.previous ? "A variable with this name already exists in this scope." : null) : null;
  const parsed = paste === null ? null : parseLocalEnv(paste, names);
  const where = project ? "This project" : "All projects";
  // Inputs whose storage is already decided (the sheet), or decided by the switch (the paste list).
  const saveInputs = (inputs: EnvironmentInput[], previous: string | null, close: () => void) => void action(async () => {
    const ready = await environment.save(project, inputs, previous);
    close();
    await changed(ready);
  });
  const save = (inputs: EnvironmentInput[], previous: string | null, close: () => void) => saveInputs(withStorage(inputs, keepSecrets), previous, close);
  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={busy || !rows} onClick={() => openSheet({ previous: null, name: "", value: "", stored: null })}>Add variable</Button>
      <Button size="sm" variant="outline" disabled={busy || !rows} onClick={() => openPaste("")}>Paste variables</Button>
      {project && <Button size="sm" variant="outline" disabled={busy || !rows} onClick={() => void action(async () => {
        const path = await open({ title: "Load from .env file", defaultPath: project, multiple: false, directory: false });
        if (typeof path === "string") openPaste(await environment.readFile(project, path));
      }, "Couldn't load the .env file")}>Load from .env file</Button>}
    </div>
    {error && !sheet && paste === null && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {/* Narrow columns (a 720 px window) show Applies to under the name instead of in its own column. */}
    {rows === null ? <p className="text-sm text-muted-foreground">Loading variables…</p> : <div className="@container overflow-x-auto rounded-lg border border-hairline">
      <table className="w-full table-fixed text-left text-sm" aria-label="Environment variables">
        <colgroup><col className="w-[42%] @xl:w-[30%]" /><col /><col className="hidden w-[24%] @xl:table-column" /><col className="w-[5.5rem] @xl:w-[7.5rem]" /></colgroup>
        <thead className="border-b border-hairline text-muted-foreground"><tr><th className="p-3 font-normal">Name</th><th className="p-3 font-normal">Value</th><th className="hidden p-3 font-normal @xl:table-cell">Applies to</th><th className="p-3"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{rows.map((row) => <VariableRow key={`${row.scope}:${row.name}`} row={row} label={appliesTo(row, rows, page, projects)} reset={rows} project={project} disabled={busy} editable={row.scope === ownScope} run={action}
          edit={(value) => openSheet({ previous: row.name, name: row.name, value, stored: isSecretRow(row) })}
          remove={async () => { const ready = await environment.delete(project, row.name); await changed(ready); }} />)}</tbody>
      </table>
      {!rows.length && <p className="p-4 text-sm text-muted-foreground">{emptyText}</p>}
    </div>}
    {sheet && <Dialog open onOpenChange={(open) => { if (!open && !busy) setSheet(null); }}><DialogContent>
      <DialogHeader><DialogTitle>{sheet.previous ? "Edit variable" : "Add variable"}</DialogTitle><DialogDescription>Applies to {where.toLowerCase()} · {secretFor(sheet) ? "kept in the Keychain" : "stored in TerminalX's settings"}</DialogDescription></DialogHeader>
      <form onSubmit={(e) => { e.preventDefault(); if (!busy && !nameError) saveInputs([{ name: sheet.name, value: sheet.value, secret: secretFor(sheet) }], sheet.previous, () => setSheet(null)); }}>
        <label className="mb-3 flex flex-col gap-2 text-sm">Name<input autoFocus autoComplete="off" spellCheck={false} className={inputClass} value={sheet.name} onChange={(e) => setSheet({ ...sheet, name: e.target.value })} /></label>
        <label className="flex flex-col gap-2 text-sm">Value<input type="password" autoComplete="new-password" spellCheck={false} className={inputClass} value={sheet.value} onChange={(e) => setSheet({ ...sheet, value: e.target.value })} /></label>
        <p className="mt-2 text-xs text-muted-foreground">An empty value sets the variable to an empty string.</p>
        <KeychainSwitch checked={keepSecrets} disabled={busy} onChange={chooseKeepSecrets} />
        {sheet.name && nameError && <p role="alert" className="mt-2 text-sm text-destructive">{nameError}</p>}
        {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setSheet(null)}>Cancel</Button><Button type="submit" disabled={busy || !!nameError}>Save variable</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>}
    {paste !== null && parsed && <Dialog open onOpenChange={(open) => { if (!open && !busy) setPaste(null); }}><DialogContent>
      <DialogHeader><DialogTitle>Add variables</DialogTitle><DialogDescription>Paste NAME=value lines. Quotes and export prefixes are accepted. Values are literal, including backslash escapes; nothing is expanded or executed.</DialogDescription></DialogHeader>
      <label className="flex flex-col gap-2 text-sm">Variables<textarea autoFocus autoComplete="off" spellCheck={false} className={`${inputClass} h-40 font-mono`} value={paste} onChange={(e) => setPaste(e.target.value)} /></label>
      <p className="mt-2 text-sm">{parsed.inputs.length} valid variables</p>
      {parsed.inputs.length > 0 && <ul aria-label="Detected variables" className="max-h-32 overflow-y-auto rounded-md border border-hairline text-xs">
        {withStorage(parsed.inputs, keepSecrets).map((input) => <li key={input.name} className="flex items-center justify-between gap-2 border-b border-hairline px-2 py-1 last:border-0">
          <span className="min-w-0 truncate font-mono">{input.name}</span>
          {input.secret && <span className="shrink-0 rounded bg-well px-1.5 text-muted-foreground">secret</span>}
        </li>)}
      </ul>}
      {parsed.errors.length > 0 && <ul role="alert" className="mt-2 max-h-32 overflow-y-auto text-sm text-destructive">{parsed.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      <p className="text-xs text-muted-foreground">Applies to {where.toLowerCase()}. An empty value sets the variable to an empty string.</p>
      <KeychainSwitch checked={keepSecrets} disabled={busy} onChange={chooseKeepSecrets} />
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setPaste(null)}>Cancel</Button><Button disabled={busy || !parsed.inputs.length} onClick={() => save(parsed.inputs, null, () => setPaste(null))}>Import {parsed.inputs.length} valid variables</Button></DialogFooter>
    </DialogContent></Dialog>}
  </div>;
}

/** On by default. Off stores every value of this save plainly. */
function KeychainSwitch({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  const id = useId();
  return <div className="mt-3 flex items-start gap-3 rounded-md border border-hairline p-3">
    <Switch id={id} aria-describedby={`${id}-hint`} checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
    <div className="min-w-0 text-sm"><label htmlFor={id}>Keep values that look like secrets in the Keychain</label>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">Names with KEY, TOKEN, SECRET or PASSWORD, credential shapes and long random strings. {checked ? "Other values are stored plainly in TerminalX's settings." : "Off: every value is stored plainly in TerminalX's settings."}</p>
    </div>
  </div>;
}

function VariableRow({ row, label, project, editable, disabled, reset, run, edit, remove }: {
  row: EnvironmentRow; label: string; project: string | null; editable: boolean; disabled: boolean; reset: EnvironmentRow[];
  run: (action: () => Promise<void>, failure?: string) => Promise<void>; edit: (value: string) => void; remove: () => Promise<void>;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const scope = row.scope === "user" ? null : project;
  const secret = isSecretRow(row);
  const own = isPrivateRow(row);
  useEffect(() => { setRevealed(null); }, [reset]);
  useEffect(() => { if (revealed === null) return; const timer = setTimeout(() => setRevealed(null), 30_000); return () => clearTimeout(timer); }, [revealed]);
  const shown = !own ? "Set in file" : !secret ? row.value || "(empty)" : revealed === null ? "••••••••" : revealed || "(empty)";
  return <tr className="border-b border-hairline last:border-0">
    <td className="break-all p-3 font-mono">{row.name}{row.overridden && <span className="block font-sans text-xs text-muted-foreground">Overridden</span>}<span aria-hidden className="block break-words font-sans text-xs text-muted-foreground @xl:hidden">{label}</span></td>
    <td className={`break-all p-3 ${own ? "font-mono" : "text-muted-foreground"}`}>{shown}</td>
    <td className="hidden break-words p-3 text-muted-foreground @xl:table-cell">{label}</td>
    <td className="p-2"><div className="flex flex-col items-start gap-1 @xl:flex-row @xl:flex-wrap">
      {own && secret && <Button size="sm" variant="ghost" disabled={disabled} aria-label={`${revealed === null ? "Reveal" : "Hide"} ${row.name}`} onClick={() => { if (revealed !== null) setRevealed(null); else void run(async () => setRevealed(await environment.reveal(scope, row.name)), `Couldn't reveal ${row.name}`); }}>{revealed === null ? "Reveal" : "Hide"}</Button>}
      {own && <Button size="sm" variant="ghost" disabled={disabled} title="Copy for 30 seconds" aria-label={`Copy ${row.name}`} onClick={() => void run(async () => environment.copy(scope, row.name), `Couldn't copy ${row.name}`)}>Copy</Button>}
      {editable && <><Button size="sm" variant="ghost" disabled={disabled} aria-label={`Edit ${row.name}`} onClick={() => void run(async () => edit(secret ? await environment.reveal(scope, row.name) : row.value ?? ""), `Couldn't open ${row.name}`)}>Edit</Button><Button size="sm" variant="ghost" disabled={disabled} aria-label={`Delete ${row.name}`} onClick={() => void run(remove, `Couldn't delete ${row.name}`)}>Delete</Button></>}
    </div></td>
  </tr>;
}
