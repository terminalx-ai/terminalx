import { useState } from "react";
import { EnvironmentTable } from "./EnvironmentSettings";
import { SettingsHeaderSlotProvider } from "./settingsHeaderActions";
import { Button } from "@/components/ui/button";
import { ChevronRight, FileText, KeyRound, Plus } from "@/icons";
import { useSessionStore } from "@/lib/sessions";
import { documentedVariables, type EnvironmentRow } from "@/lib/localEnvironment";

/**
 * Settings › Projects › <project> › Environment (PRO-144): the variables
 * of one local repository, over the Personal ones it inherits, and the
 * variables the agents and the repository's files document. Its buttons sit
 * beside its own title (design 11.08).
 */
export function RepositoryEnvironmentSettings({ projectPath }: { projectPath: string }) {
  const { projects } = useSessionStore();
  const [rows, setRows] = useState<EnvironmentRow[] | null>(null);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [addRequest, setAddRequest] = useState<{ name: string } | null>(null);
  const name = projects.find((p) => p.path === projectPath)?.name ?? projectPath.split("/").filter(Boolean).pop() ?? projectPath;
  return <section className="flex min-w-0 flex-col gap-4" aria-label={`Environment of ${name}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1 basis-64">
        <h3 className="text-base font-semibold">Environment</h3>
        <p className="text-xs text-muted-foreground">Variables for agents and terminals in {name}. These override your personal ones. Values that look like secrets stay in the Keychain.</p>
      </div>
      <div ref={setSlot} className="flex flex-wrap justify-end gap-2 empty:hidden" />
    </div>
    <SettingsHeaderSlotProvider value={slot}>
      <EnvironmentTable key={projectPath} project={projectPath} projects={projects} onRows={setRows} addRequest={addRequest}
        emptyText={`No variables set. Add a variable to make it available to agents and terminals in ${name}.`} />
    </SettingsHeaderSlotProvider>
    {rows && <DocumentedVariables rows={rows} onAdd={(name) => setAddRequest({ name })} />}
  </section>;
}

/** A quiet disclosure row, then a card of the variables with where each is set and a + to set one here. */
function DocumentedVariables({ rows, onAdd }: { rows: EnvironmentRow[]; onAdd: (name: string) => void }) {
  const documented = documentedVariables(rows);
  return <details className="group text-[13px]">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden className="size-[13px] shrink-0 transition-transform group-open:rotate-90" />
      <span className="shrink-0">Documented variables <span className="text-faint">({documented.length})</span></span>
      <span className="ml-auto truncate pl-3 text-xs text-faint">Variables the agents read, with what each one does</span>
    </summary>
    <ul className="mt-2 flex flex-col divide-y divide-hairline rounded-lg border border-hairline" aria-label="Documented variables">
      {documented.map((v) => {
        const here = v.status === "Set in this project";
        const Icon = v.description ? KeyRound : FileText;
        return <li key={v.name} className="flex min-h-14 items-center gap-3 px-3 py-2">
          <Icon aria-hidden className="size-3.5 shrink-0 text-faint" />
          <div className="min-w-0 flex-1"><p className="truncate font-mono text-xs" title={v.name}>{v.name}</p><p className="truncate text-xs text-muted-foreground">{v.description ?? "Named in this repository's settings file."}</p></div>
          <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] ${v.set ? "bg-add/12 text-add" : "bg-well text-muted-foreground"}`}>{v.status}</span>
          {here ? <span aria-hidden className="size-6 shrink-0" /> : <Button size="icon-xs" variant="ghost" className="text-muted-foreground" title="Add to this project" aria-label={`Add ${v.name}`} onClick={() => onAdd(v.name)}><Plus /></Button>}
        </li>;
      })}
    </ul>
  </details>;
}
