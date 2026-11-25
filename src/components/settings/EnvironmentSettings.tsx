import { useEffect, useId, useState, type ReactNode } from "react";
import { isMac, thisComputer, secretStoreShort, secretStoreWord } from "@/lib/platform";
import { open } from "@tauri-apps/plugin-dialog";
import { RegisteredSetting, resolveSetting } from "./settingsRegistry";
import { RepositoryEnvironmentSettings } from "./RepositoryEnvironmentSettings";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChevronRight, ClipboardPaste, Copy, Eye, EyeOff, FileText, FolderOpen, Lock, Pencil, Plus, Trash2 } from "@/icons";
import { SettingsHeaderActions } from "./settingsHeaderActions";
import { useSessionStore } from "@/lib/sessions";
import { errorMessage } from "@/lib/api";
import { showError } from "@/lib/errorToasts";
import { TERMINALX_VARIABLES, appliesTo, environment, environmentNameError, isPrivateRow, isSecretRow, looksSecret, parseLocalEnv, withStorage, type EnvironmentInput, type EnvironmentRow } from "@/lib/localEnvironment";
import { isLocalKey } from "@/types/target";

const inputClass = "w-full rounded-md border border-hairline bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40";
/** Faint uppercase column and field labels (design 10.06). */
const kicker = "text-[10.5px] font-medium uppercase tracking-[.08em] text-faint";
const checkboxClass = "size-3.5 shrink-0 accent-accent disabled:opacity-50";

/** Local projects whose variables can be set: Git repositories on this Mac. */
export const environmentProjects = <P extends { kind?: string; path: string }>(projects: P[]) => projects.filter((p) => p.kind !== "folder" && isLocalKey(p.path));

/** Settings › Environment: Personal variables, applied to every project. */
export function EnvironmentSettings() {
  const { projects } = useSessionStore();
  const [project, setProject] = useState("");
  const repositoryId = useId();
  const local = environmentProjects(projects);
  return <RegisteredSetting setting="environment.variables"><div className="flex flex-col gap-5">
    <p className="text-sm text-muted-foreground">{resolveSetting("environment.variables").description} Secrets live in {secretStoreShort}; settings files keep only their names.</p>
    <section className="flex flex-col gap-2" aria-label="Personal variables">
      <h3 className="text-sm font-medium">Personal</h3>
      <p className="text-xs text-muted-foreground">Applied to every agent and terminal you start on {thisComputer}. Project variables override these.</p>
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

/** What TerminalX itself sets, so nobody tries to set (or wonders about) these. A quiet disclosure row, not a box. */
export function TerminalXVariables() {
  return <details className="group text-[13px]">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden className="size-[13px] shrink-0 transition-transform group-open:rotate-90" />
      <span>Variables TerminalX sets itself <span className="text-faint">({TERMINALX_VARIABLES.length})</span></span>
    </summary>
    <div className="pl-5">
      <p className="my-2 text-xs text-muted-foreground">These names are reserved. Values depend on the launch; credentials are never shown here.</p>
      <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-2 break-words text-xs">
        {TERMINALX_VARIABLES.map(({ names, description }) => <div key={names} className="contents"><dt className="font-mono">{names}</dt><dd className="text-muted-foreground">{description}</dd></div>)}
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">The workspace path is the process working directory. Each workspace keeps its own block of ports while it exists. HOME, LD_PRELOAD, DYLD_*, TERMINALX_* and RACCOON_* names are reserved.</p>
    </div>
  </details>;
}

/** `stored`: where an edited variable lives now (true: the Keychain); null when adding. */
type Sheet = { previous: string | null; name: string; value: string; stored: boolean | null };
/** The Add variables sheet: the pasted text, the names left unticked and the scope it saves to (null: Personal). */
type Paste = { text: string; unticked: string[]; scope: string | null };

/**
 * The variables of one scope (Personal when `project` is null), with what
 * each inherits or overrides. `onRows` hands the listed rows to the page;
 * `addRequest` opens Add variable with a name filled in (a documented variable's +).
 * Its Paste and Add buttons go beside the nearest title (`SettingsHeaderActions`).
 */
export function EnvironmentTable({ project, projects = [], emptyText = "No variables in this scope.", onRows, addRequest }: {
  project: string | null; projects?: { name: string; path: string; kind?: string }[]; emptyText?: string; onRows?: (rows: EnvironmentRow[]) => void; addRequest?: { name: string } | null;
}) {
  const [rows, setRows] = useState<EnvironmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [paste, setPaste] = useState<Paste | null>(null);
  // Names already set in the scope the paste sheet saves to, when that is not this table's.
  const [elsewhere, setElsewhere] = useState<string[] | null>(null);
  const [keepSecrets, setKeepSecrets] = useState(true);
  // Whether the Keychain box was used on the open sheet: until then an edit keeps the variable where it is.
  const [switched, setSwitched] = useState(false);
  const chooseKeepSecrets = (on: boolean) => { setKeepSecrets(on); setSwitched(true); };
  const secretFor = (s: Sheet) => (s.stored !== null && !switched ? s.stored : keepSecrets && looksSecret(s.name, s.value));
  const ownScope = project ? "repository" : "user";
  const page = project ? "repository" : "personal";
  const names = rows?.filter((r) => r.scope === ownScope).map((r) => r.name) ?? [];
  // A project page lists a Personal value its own one overrides once, as the project's row ("overrides Personal").
  const shown = rows?.filter((r) => !(project && r.scope === "user" && r.overridden)) ?? null;
  const install = (next: EnvironmentRow[]) => { setRows(next); onRows?.(next); };
  const refresh = () => environment.list(project).then(install);
  useEffect(() => { let live = true; environment.list(project).then((rows) => { if (live) install(rows); }).catch((e) => { if (live) { setError(errorMessage(e)); showError("Couldn't load environment variables", e); } }); return () => { live = false; }; }, [project]);
  const pasteScope = paste?.scope;
  useEffect(() => {
    setElsewhere(null);
    if (pasteScope === undefined || pasteScope === project) return;
    let live = true;
    const scope = pasteScope ? "repository" : "user";
    environment.list(pasteScope).then((rows) => { if (live) setElsewhere(rows.filter((r) => r.scope === scope).map((r) => r.name)); }).catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [pasteScope, project]);
  const action = async (run: () => Promise<void>, failure?: string) => {
    setBusy(true); setError(null); setNotice(null);
    try { await run(); } catch (e) { setError(errorMessage(e)); if (failure) showError(failure, e); } finally { setBusy(false); }
  };
  const changed = async (ready: boolean) => {
    // Clear all revealed values after any edit by replacing the table's rows.
    setNotice(ready ? "Saved. Running tabs: Restart to apply. Nothing restarts automatically." : `Saved, but environment overrides are not ready for new tabs yet. Check ${secretStoreWord} access and the local runtime before starting a new tab. Running tabs are unchanged.`);
    window.dispatchEvent(new Event("local-environment-changed"));
    await refresh();
  };
  const openSheet = (next: Sheet) => { setKeepSecrets(next.stored ?? true); setSwitched(false); setError(null); setSheet(next); };
  const openPaste = (text: string) => { setKeepSecrets(true); setSwitched(false); setError(null); setPaste({ text, unticked: [], scope: project }); };
  useEffect(() => { if (addRequest) openSheet({ previous: null, name: addRequest.name, value: "", stored: null }); }, [addRequest]);
  const nameError = sheet ? environmentNameError(sheet.name) ?? (names.includes(sheet.name) && sheet.name !== sheet.previous ? "A variable with this name already exists in this scope." : null) : null;
  const where = project ? "This project" : "All projects";
  // Inputs whose storage is already decided (the sheet), or decided by the Keychain box (the paste list).
  const saveInputs = (inputs: EnvironmentInput[], previous: string | null, close: () => void, scope = project) => void action(async () => {
    const ready = await environment.save(scope, inputs, previous);
    close();
    await changed(ready);
  });
  const buttons = <>
    {project && <Button size="sm" variant="outline" disabled={busy || !rows} onClick={() => void action(async () => {
      const path = await open({ title: "Load from .env file", defaultPath: project, multiple: false, directory: false });
      if (typeof path === "string") openPaste(await environment.readFile(project, path));
    }, "Couldn't load the .env file")}><FolderOpen aria-hidden />Load from .env file</Button>}
    <Button size="sm" variant="outline" disabled={busy || !rows} onClick={() => openPaste("")}><ClipboardPaste aria-hidden />Paste KEY=VALUE</Button>
    <Button size="sm" disabled={busy || !rows} onClick={() => openSheet({ previous: null, name: "", value: "", stored: null })}><Plus aria-hidden />Add variable</Button>
  </>;
  return <div className="flex flex-col gap-3">
    <SettingsHeaderActions>{buttons}</SettingsHeaderActions>
    {error && !sheet && paste === null && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {/* Narrow columns (a 720 px window) show Applies to under the name instead of in its own column. */}
    {shown === null || rows === null ? <p className="text-sm text-muted-foreground">Loading variables…</p> : <div className="@container overflow-x-auto rounded-lg border border-hairline">
      <table className="w-full table-fixed text-left text-[12.5px]" aria-label="Environment variables">
        <colgroup><col className="w-[40%] @xl:w-[30%]" /><col /><col className="hidden w-[26%] @xl:table-column" /><col className="w-[7.25rem]" /></colgroup>
        <thead className="border-b border-hairline"><tr><th className={`h-8 px-3 ${kicker}`}>Name</th><th className={`h-8 px-3 ${kicker}`}>Value</th><th className={`hidden h-8 px-3 @xl:table-cell ${kicker}`}>Applies to</th><th className="h-8 px-3"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{shown.map((row) => <VariableRow key={`${row.scope}:${row.name}`} row={row} label={appliesTo(row, rows, page, projects)} reset={rows} project={project} disabled={busy} editable={row.scope === ownScope} run={action}
          edit={(value) => openSheet({ previous: row.name, name: row.name, value, stored: isSecretRow(row) })}
          remove={async () => { const ready = await environment.delete(project, row.name); await changed(ready); }} />)}</tbody>
      </table>
      {!shown.length && <p className="p-4 text-sm text-muted-foreground">{emptyText}</p>}
    </div>}
    {sheet && <Dialog open onOpenChange={(open) => { if (!open && !busy) setSheet(null); }}><DialogContent>
      <DialogHeader><DialogTitle>{sheet.previous ? "Edit variable" : "Add variable"}</DialogTitle><DialogDescription>Applies to {where.toLowerCase()} · {secretFor(sheet) ? `kept in ${secretStoreShort}` : "stored in TerminalX's settings"}</DialogDescription></DialogHeader>
      <form onSubmit={(e) => { e.preventDefault(); if (!busy && !nameError) saveInputs([{ name: sheet.name, value: sheet.value, secret: secretFor(sheet) }], sheet.previous, () => setSheet(null)); }}>
        <label className="mb-3 flex flex-col gap-2 text-sm">Name<input autoFocus={!sheet.name} autoComplete="off" spellCheck={false} className={`${inputClass} font-mono`} value={sheet.name} onChange={(e) => setSheet({ ...sheet, name: e.target.value })} /></label>
        <label className="flex flex-col gap-2 text-sm">Value<input autoFocus={!!sheet.name} type="password" autoComplete="new-password" spellCheck={false} className={inputClass} value={sheet.value} onChange={(e) => setSheet({ ...sheet, value: e.target.value })} /></label>
        <p className="mt-2 text-xs text-muted-foreground">An empty value sets the variable to an empty string.</p>
        <KeychainCheckbox checked={keepSecrets} disabled={busy} onChange={chooseKeepSecrets} />
        {sheet.name && nameError && <p role="alert" className="mt-2 text-sm text-destructive">{nameError}</p>}
        {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setSheet(null)}>Cancel</Button><Button type="submit" disabled={busy || !!nameError}>Save variable</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>}
    {paste && <PasteSheet paste={paste} setPaste={setPaste} existing={paste.scope === project ? names : elsewhere} project={project} projects={projects} busy={busy} error={error}
      keepSecrets={keepSecrets} onKeepSecrets={chooseKeepSecrets} save={(inputs, scope) => saveInputs(withStorage(inputs, keepSecrets), null, () => setPaste(null), scope)} />}
  </div>;
}

/**
 * Add variables (design 10.08): a sheet at the window's right edge. Each
 * pasted line is listed in order: a valid one with a box to leave it out, a
 * skipped one in red with its line number and why. Values are never listed.
 */
function PasteSheet({ paste, setPaste, existing, project, projects, busy, error, keepSecrets, onKeepSecrets, save }: {
  paste: Paste; setPaste: (paste: Paste | null) => void; existing: string[] | null; project: string | null; projects: { name: string; path: string; kind?: string }[];
  busy: boolean; error: string | null; keepSecrets: boolean; onKeepSecrets: (on: boolean) => void; save: (inputs: EnvironmentInput[], scope: string | null) => void;
}) {
  const scopeId = useId();
  const textId = useId();
  const parsed = parseLocalEnv(paste.text, existing ?? []);
  const chosen = parsed.inputs.filter((input) => !paste.unticked.includes(input.name));
  const secret = new Set(withStorage(parsed.inputs, keepSecrets).filter((input) => input.secret).map((input) => input.name));
  const lines: { name: string; line: number; reason?: string }[] = [...parsed.inputs.map(({ name }, i) => ({ name, line: parsed.lines[i] })), ...parsed.skipped]
    .sort((a, b) => a.line - b.line);
  const scopes = environmentProjects(projects);
  if (project && !scopes.some((p) => p.path === project)) scopes.unshift({ name: project.split("/").filter(Boolean).pop() ?? project, path: project });
  const skipped = parsed.skipped.length;
  const close = () => { if (!busy) setPaste(null); };
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}><DialogContent placement="right" layout="pinned" width="max-w-[460px]" className="gap-0 p-0">
    <DialogHeader className="mb-0 border-b border-hairline px-5 py-4"><DialogTitle>Add variables</DialogTitle><DialogDescription className="sr-only">Paste NAME=value lines. Quotes and export prefixes are accepted. Values are literal, including backslash escapes; nothing is expanded or executed.</DialogDescription></DialogHeader>
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 scrollbar-thin">
      <div className="flex flex-col gap-2">
        <label htmlFor={textId} className="text-[12px] font-medium text-muted-foreground">Variables</label>
        <textarea id={textId} autoFocus autoComplete="off" spellCheck={false} placeholder="NAME=value" className={`${inputClass} h-28 resize-y font-mono text-[12px] leading-5`} value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} />
        <p className="text-xs text-muted-foreground">{lines.length ? `Detected ${parsed.inputs.length} ${parsed.inputs.length === 1 ? "variable" : "variables"} from the pasted text.` : "Paste NAME=value lines. Quotes and export prefixes are accepted; values are literal, and nothing is expanded or run."}</p>
      </div>
      {lines.length > 0 && <ul aria-label="Detected variables" className="flex flex-col rounded-lg border border-hairline py-1">
        {lines.map((line) => line.reason === undefined
          ? <li key={`ok:${line.name}`}><label className="flex h-8 cursor-pointer items-center gap-2.5 px-3">
            <input type="checkbox" aria-label={line.name} className={checkboxClass} disabled={busy} checked={!paste.unticked.includes(line.name)} onChange={(e) => setPaste({ ...paste, unticked: e.target.checked ? paste.unticked.filter((n) => n !== line.name) : [...paste.unticked, line.name] })} />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{line.name}</span>
            {secret.has(line.name) && <span className="shrink-0 text-[11px] text-faint">secret</span>}
          </label></li>
          : <li key={`skip:${line.line}`} className="flex h-8 items-center gap-2.5 px-3 text-destructive">
            <input type="checkbox" className={checkboxClass} disabled checked={false} aria-label={`Line ${line.line} skipped`} />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{line.name}</span>
            <span className="shrink-0 text-[11px]">line {line.line}: {line.reason}</span>
          </li>)}
      </ul>}
      <div className="flex flex-col gap-2">
        <label htmlFor={scopeId} className="text-[12px] font-medium text-muted-foreground">Applies to</label>
        <select id={scopeId} className={inputClass} value={paste.scope ?? ""} disabled={busy} onChange={(e) => setPaste({ ...paste, scope: e.target.value || null })}>
          <option value="">All projects</option>
          {scopes.map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}
        </select>
      </div>
      <KeychainCheckbox className="" checked={keepSecrets} disabled={busy} onChange={onKeepSecrets} />
      <p className="text-xs text-faint">An empty value sets the variable to an empty string.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
    <DialogFooter className="mt-0 items-center border-t border-hairline px-5 py-3">
      {skipped > 0 && <p role="status" className="mr-auto text-xs text-destructive">{skipped} {skipped === 1 ? "line" : "lines"} skipped</p>}
      <Button variant="outline" disabled={busy} onClick={close}>Cancel</Button>
      <Button disabled={busy || existing === null || !chosen.length} onClick={() => save(chosen, paste.scope)}>Add {chosen.length} {chosen.length === 1 ? "variable" : "variables"}</Button>
    </DialogFooter>
  </DialogContent></Dialog>;
}

/** On by default. Off stores every value of this save plainly. */
function KeychainCheckbox({ checked, disabled, onChange, className = "mt-3" }: { checked: boolean; disabled: boolean; onChange: (on: boolean) => void; className?: string }) {
  const id = useId();
  return <div className={`flex items-start gap-2.5 ${className}`}>
    <input type="checkbox" id={id} aria-describedby={`${id}-hint`} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className={`${checkboxClass} mt-[3px]`} />
    <div className="min-w-0 text-[13px]"><label htmlFor={id}>Keep values that look like secrets in {secretStoreShort}</label>
      <p id={`${id}-hint`} className="mt-0.5 text-xs text-muted-foreground">Names with KEY, TOKEN, SECRET or PASSWORD, credential shapes and long random strings. {checked ? "Other values are stored plainly in TerminalX's settings." : "Unticked: every value is stored plainly in TerminalX's settings."}</p>
    </div>
  </div>;
}

/**
 * Where a row's value comes from, and an Overridden chip when another source
 * sets the same name (settings.local.json or managed policy over a project's
 * value, the project over the shared file): editing it then changes nothing.
 */
function AppliesTo({ row, label }: { row: EnvironmentRow; label: string }): ReactNode {
  const source = <Source row={row} label={label} />;
  if (!row.overridden) return source;
  return <span className="flex min-w-0 items-center gap-1.5">{source}<span title="Another source sets this name, so this value is not used." className="shrink-0 rounded-md bg-warning/12 px-1.5 py-0.5 text-[11px] text-warning">Overridden</span></span>;
}

/** A chip for an override or a repository file, plain text otherwise. */
function Source({ row, label }: { row: EnvironmentRow; label: string }): ReactNode {
  if (row.scope === "repositoryShared" || row.scope === "repositoryLocal") return <span title={label} className="inline-flex max-w-full items-center gap-1 rounded-md bg-info/12 px-1.5 py-0.5 text-[11px] text-info"><FileText aria-hidden className="size-3 shrink-0" /><span className="truncate">{label}</span></span>;
  if (/overrid/.test(label)) return <span title={label} className="inline-flex max-w-full rounded-md border border-hairline-strong px-1.5 py-0.5 text-[11px] text-muted-foreground"><span className="truncate">{label}</span></span>;
  return <span title={label} className="block truncate">{label}</span>;
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
  const shown = !own ? "Set in file" : !secret ? row.value || "(empty)" : revealed === null ? "••••••••••••" : revealed || "(empty)";
  const icon = "text-muted-foreground";
  return <tr className="h-10 border-b border-hairline last:border-0">
    <td className="px-3 py-1.5 align-middle">
      <span className="flex min-w-0 items-center gap-1.5"><span className="truncate font-mono" title={row.name}>{row.name}</span>{own && secret && <Lock role="img" aria-label={`Kept in ${secretStoreShort}`} className="size-3 shrink-0 text-faint" />}</span>
      <span aria-hidden className="block truncate text-[11px] text-muted-foreground @xl:hidden">{label}{row.overridden && " · Overridden"}</span>
    </td>
    <td className={`truncate px-3 py-1.5 align-middle ${own ? "font-mono" : "text-muted-foreground"}`} title={own && !secret ? row.value : undefined}>{shown}</td>
    <td className="hidden px-3 py-1.5 align-middle text-muted-foreground @xl:table-cell"><AppliesTo row={row} label={label} /></td>
    <td className="px-2 py-1.5 align-middle"><div className="flex items-center justify-end gap-0.5">
      {own && secret && <Button size="icon-xs" variant="ghost" className={icon} disabled={disabled} title={revealed === null ? "Reveal for 30 seconds" : "Hide"} aria-label={`${revealed === null ? "Reveal" : "Hide"} ${row.name}`} onClick={() => { if (revealed !== null) setRevealed(null); else void run(async () => setRevealed(await environment.reveal(scope, row.name)), `Couldn't reveal ${row.name}`); }}>{revealed === null ? <Eye /> : <EyeOff />}</Button>}
      {own && <Button size="icon-xs" variant="ghost" className={icon} disabled={disabled || !isMac} title={isMac ? "Copy for 30 seconds" : "Copying a value is available on macOS only"} aria-label={`Copy ${row.name}`} onClick={() => void run(async () => environment.copy(scope, row.name), `Couldn't copy ${row.name}`)}><Copy /></Button>}
      {editable && <><Button size="icon-xs" variant="ghost" className={icon} disabled={disabled} title="Edit" aria-label={`Edit ${row.name}`} onClick={() => void run(async () => edit(secret ? await environment.reveal(scope, row.name) : row.value ?? ""), `Couldn't open ${row.name}`)}><Pencil /></Button><Button size="icon-xs" variant="ghost" className={icon} disabled={disabled} title="Delete" aria-label={`Delete ${row.name}`} onClick={() => void run(remove, `Couldn't delete ${row.name}`)}><Trash2 /></Button></>}
    </div></td>
  </tr>;
}
