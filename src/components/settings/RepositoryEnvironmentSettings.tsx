import { useState } from "react";
import { EnvironmentTable } from "./EnvironmentSettings";
import { useSessionStore } from "@/lib/sessions";
import { documentedVariables, type EnvironmentRow } from "@/lib/localEnvironment";

/**
 * Settings › Repositories › <project> › Environment (PRO-144): the variables
 * of one local repository, over the Personal ones it inherits, and the
 * variables the agents and the repository's files document.
 */
export function RepositoryEnvironmentSettings({ projectPath }: { projectPath: string }) {
  const { projects } = useSessionStore();
  const [rows, setRows] = useState<EnvironmentRow[] | null>(null);
  const name = projects.find((p) => p.path === projectPath)?.name ?? projectPath.split("/").filter(Boolean).pop() ?? projectPath;
  return <section className="flex min-w-0 flex-col gap-4" aria-label={`Environment of ${name}`}>
    <div>
      <h3 className="text-sm font-medium">Environment</h3>
      <p className="text-xs text-muted-foreground">Variables for agents and terminals in {name}. These override your personal ones. Values that look like secrets stay in the Keychain.</p>
    </div>
    <EnvironmentTable key={projectPath} project={projectPath} projects={projects} onRows={setRows}
      emptyText={`No variables set. Add a variable to make it available to agents and terminals in ${name}.`} />
    {rows && <DocumentedVariables rows={rows} />}
  </section>;
}

function DocumentedVariables({ rows }: { rows: EnvironmentRow[] }) {
  const documented = documentedVariables(rows);
  return <details className="rounded-lg border border-hairline p-3 text-sm">
    <summary className="cursor-pointer"><span className="font-medium">Documented variables ({documented.length})</span> <span className="text-muted-foreground">Variables the agents read, with what each one does</span></summary>
    <ul className="mt-3 flex flex-col divide-y divide-hairline" aria-label="Documented variables">
      {documented.map((v) => <li key={v.name} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
        <div className="min-w-0 flex-1"><p className="break-all font-mono text-xs">{v.name}</p><p className="text-xs text-muted-foreground">{v.description ?? "Named in this repository's settings file."}</p></div>
        <span className={`shrink-0 text-xs ${v.set ? "" : "text-muted-foreground"}`}>{v.status}</span>
      </li>)}
    </ul>
  </details>;
}
