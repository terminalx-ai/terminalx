import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CHECK_LABEL,
  checkFailed,
  checkStatusLabel,
  compareDefinitions,
  formatDuration,
  observedByLabel,
  type EnvironmentDefinition,
  type EnvironmentRecipe,
  type EnvironmentRepository,
  type RecipeCheck,
} from "@/lib/organizationEnvironment";

const scriptClass = "max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-well px-2 py-1 font-mono text-[11px]";
const failedClass = "text-destructive";

const STATE_LABEL: Record<EnvironmentRecipe["state"], string> = { proposed: "Proposed", applied: "Applied", dismissed: "Dismissed" };
const CHANGE_NOTE = { added: "New repository", changed: "Changes this repository's setup", unchanged: "Same as the current template" } as const;

const formatTime = (timestamp: number | null) => (timestamp ? new Date(timestamp).toLocaleString() : "");

function exitNote(check: Pick<RecipeCheck, "exitCode" | "durationMs">): string {
  return [check.exitCode === null ? "" : `exit ${check.exitCode}`, formatDuration(check.durationMs)].filter(Boolean).join(", ");
}

function RepositorySetup({ repository }: { repository: EnvironmentRepository }) {
  if (!repository.setup.length) return <p className="text-[11px] text-muted-foreground">No setup steps.</p>;
  return (
    <ol className="flex flex-col gap-1">
      {repository.setup.map((step, index) => (
        <li key={index} className="flex flex-col gap-0.5">
          <span className="text-[11px] text-muted-foreground">
            Step {index + 1}, in {step.workingDirectory === "." ? "the repository root" : step.workingDirectory}
          </span>
          <pre className={scriptClass}>{step.script}</pre>
        </li>
      ))}
    </ol>
  );
}

function RecipeCard({
  recipe,
  current,
  currentRevision,
  busy,
  unsavedTemplate,
  onApply,
  onDismiss,
}: {
  recipe: EnvironmentRecipe;
  current: EnvironmentDefinition | null;
  currentRevision: number;
  busy: string | null;
  unsavedTemplate: boolean;
  onApply: (recipe: EnvironmentRecipe) => void;
  onDismiss: (recipe: EnvironmentRecipe) => void;
}) {
  const [open, setOpen] = useState(recipe.state === "proposed");
  const [confirming, setConfirming] = useState(false);
  const comparison = compareDefinitions(current, recipe.definition);
  const { observations } = recipe;
  const name = `Recipe from ${formatTime(recipe.createdAt)}`;
  // The template moved on since this was proposed: applying would overwrite
  // what someone saved meanwhile, so the server refuses it.
  const stale = recipe.state === "proposed" && recipe.baseRevision !== currentRevision;
  const failures = observations.repositories.flatMap((repository) => repository.checks.filter(checkFailed)).length + (observations.machine && checkFailed(observations.machine) ? 1 : 0);

  return (
    <li className="rounded-md border border-hairline p-2" aria-label={name}>
      <div className="flex items-center justify-between gap-2">
        <button type="button" className="min-w-0 text-left text-xs font-medium" aria-expanded={open} onClick={() => setOpen(!open)}>
          {name}
        </button>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {STATE_LABEL[recipe.state]}
          {recipe.state === "applied" && recipe.appliedRevision !== null ? ` as revision ${recipe.appliedRevision}` : ""}
        </span>
      </div>
      <p className={`mt-1 text-[11px] ${failures ? failedClass : "text-muted-foreground"}`}>
        {failures ? `${failures} check${failures === 1 ? "" : "s"} failed.` : "No failed checks."} A recipe is a proposal: it changes nothing until an admin applies it, and applying builds nothing.
      </p>
      {open && (
        <div className="mt-2 flex flex-col gap-3">
          <p className="rounded-md bg-well px-2 py-1 text-[11px]" aria-label="Who observed the results">
            {observedByLabel(observations.observedBy)}
          </p>

          <section aria-label="Proposed machine setup" className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2 text-xs font-medium">
              <span>Machine install script</span>
              <span className="text-[11px] font-normal text-muted-foreground">{comparison.machineChanged ? "Changes the current script" : "Same as the current template"}</span>
            </div>
            {recipe.definition.installScript ? <pre className={scriptClass}>{recipe.definition.installScript}</pre> : <p className="text-[11px] text-muted-foreground">No machine install script.</p>}
            {observations.machine && (
              <p className={`text-[11px] ${checkFailed(observations.machine) ? failedClass : "text-muted-foreground"}`}>
                Result: {checkStatusLabel({ ...observations.machine, preexisting: false })}
                {exitNote(observations.machine) ? ` (${exitNote(observations.machine)})` : ""}
              </p>
            )}
          </section>

          {comparison.repositories.map(({ repository, change }) => {
            const results = observations.repositories.find((candidate) => candidate.owner.toLowerCase() === repository.owner.toLowerCase() && candidate.name.toLowerCase() === repository.name.toLowerCase());
            const label = `${repository.owner}/${repository.name}`;
            return (
              <section key={label} aria-label={`Proposed setup for ${label}`} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2 text-xs font-medium">
                  <span className="min-w-0 truncate">
                    {label} <span className="font-normal text-muted-foreground">on {repository.defaultBranch}</span>
                  </span>
                  <span className="shrink-0 text-[11px] font-normal text-muted-foreground">{CHANGE_NOTE[change]}</span>
                </div>
                <RepositorySetup repository={repository} />
                {results ? (
                  <table className="w-full table-fixed text-left text-[11px]" aria-label={`Results for ${label}`}>
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="w-14 py-0.5 font-normal">Check</th>
                        <th className="py-0.5 font-normal">Command</th>
                        <th className="w-40 py-0.5 font-normal">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.checks.map((check) => (
                        <tr key={check.kind} className="align-top">
                          <td className="py-0.5">{CHECK_LABEL[check.kind]}</td>
                          <td className="break-all py-0.5 pr-2 font-mono">{check.command || "none"}</td>
                          <td className={`py-0.5 ${checkFailed(check) ? failedClass : ""}`}>
                            {checkStatusLabel(check)}
                            {exitNote(check) ? ` (${exitNote(check)})` : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-[11px] text-muted-foreground">No results were recorded for this repository.</p>
                )}
              </section>
            );
          })}

          {comparison.removed.length > 0 && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              Applying removes {comparison.removed.map((repository) => `${repository.owner}/${repository.name}`).join(", ")} from the template.
            </p>
          )}

          {recipe.state === "proposed" && (
            <div className="flex flex-col gap-1.5">
              {stale && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  The template has changed since this was proposed (it was made against revision {recipe.baseRevision}; the template is at {currentRevision}), so it can no longer be applied. Dismiss it and configure again.
                </p>
              )}
              {confirming ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 text-[11px]">
                    Replace the template's machine script and repository setup with this recipe?{failures ? ` ${failures} check${failures === 1 ? "" : "s"} failed.` : ""} Nothing is built until you build a version.
                  </p>
                  <Button size="xs" disabled={Boolean(busy)} onClick={() => onApply(recipe)}>
                    {busy === `apply:${recipe.id}` ? <Loader2 className="animate-spin" /> : "Apply to template"}
                  </Button>
                  <Button size="xs" variant="ghost" disabled={Boolean(busy)} onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button size="xs" variant="outline" disabled={Boolean(busy) || stale || unsavedTemplate} onClick={() => setConfirming(true)}>
                    Apply…
                  </Button>
                  <Button size="xs" variant="ghost" disabled={Boolean(busy)} onClick={() => onDismiss(recipe)}>
                    {busy === `dismiss:${recipe.id}` ? <Loader2 className="animate-spin" /> : "Dismiss"}
                  </Button>
                  {unsavedTemplate && !stale && <span className="self-center text-[11px] text-muted-foreground">Save or discard your template changes first.</span>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Recipes as proposals: what each would change, apart from how its checks ended. */
export function EnvironmentRecipes({
  recipes,
  current,
  currentRevision,
  busy,
  unsavedTemplate,
  onApply,
  onDismiss,
}: {
  recipes: EnvironmentRecipe[];
  current: EnvironmentDefinition | null;
  currentRevision: number;
  busy: string | null;
  /** Applying replaces the template, so unsaved edits to it are settled first. */
  unsavedTemplate: boolean;
  onApply: (recipe: EnvironmentRecipe) => void;
  onDismiss: (recipe: EnvironmentRecipe) => void;
}) {
  return (
    <section className="mt-3 flex flex-col gap-1.5" aria-label="Environment recipes">
      <div className="text-xs font-medium text-muted-foreground">Recipes</div>
      {recipes.length ? (
        <ul className="flex flex-col gap-2">
          {recipes.map((recipe) => (
            <RecipeCard key={recipe.id} recipe={recipe} current={current} currentRevision={currentRevision} busy={busy} unsavedTemplate={unsavedTemplate} onApply={onApply} onDismiss={onDismiss} />
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-muted-foreground">No recipes yet. A recipe is a proposed machine script and repository setup, with how its install, lint, test, build and start checks ended.</p>
      )}
    </section>
  );
}
