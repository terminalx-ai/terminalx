import { useState } from "react";
import { Building, CircleAlert, Loader2, Plus } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { hasSecureDialog, SECURE_DIALOG_OFF, ThisComputer, thisComputer } from "@/lib/platform";
import { api, type AgentRouteAgent, type AgentRouteCheckResult, type AgentRouteSettings, type OrganizationRoutes } from "@/lib/api";
import { checkReason, fieldProblem, routeErrorMessage, templateSettings } from "@/lib/agentRoutes";
import { AGENT_NAMES } from "./OrganizationRoutes";

/**
 * Adding an organization route (PRO-310), built to the Amazon Bedrock form
 * of PRO-200 (designs 12.22 form and 12.23 failed test), which are drawn
 * but not yet approved. One custom provider for one agent and repository.
 * The credential is never typed here: "Test and save" asks for it in the
 * app's secure dialog, tests it from this Mac, and saves only when the
 * test passed (or the owner chose to save anyway).
 */
const inputClass = "h-8 w-full rounded-md border border-hairline bg-background px-2.5 text-xs disabled:opacity-60";
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

export function AddOrganizationRoute({ contextRevision, organizationId, organizationName, routes, onAdded }: {
  contextRevision: string;
  organizationId: string;
  organizationName: string;
  routes: OrganizationRoutes;
  onAdded: (routes: OrganizationRoutes) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!routes.templates.some((template) => template.mode === "custom-endpoint")) return null;
  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)} data-testid="organization-route-add">
        <Plus /> Add route
      </Button>
      {open && (
        <AddRouteDialog
          contextRevision={contextRevision}
          organizationId={organizationId}
          organizationName={organizationName}
          routes={routes}
          onClose={() => setOpen(false)}
          onAdded={(next) => { setOpen(false); onAdded(next); }}
        />
      )}
    </>
  );
}

function AddRouteDialog({ contextRevision, organizationId, organizationName, routes, onClose, onAdded }: {
  contextRevision: string;
  organizationId: string;
  organizationName: string;
  routes: OrganizationRoutes;
  onClose: () => void;
  onAdded: (routes: OrganizationRoutes) => void;
}) {
  // Organization routes are custom providers only: never a helper template.
  const endpoints = routes.templates.filter((candidate) => candidate.mode === "custom-endpoint");
  const agents = [...new Set(endpoints.map((template) => template.provider))];
  const [agent, setAgent] = useState<AgentRouteAgent>(agents[0]);
  const [repository, setRepository] = useState("");
  const [values, setValues] = useState<AgentRouteSettings>({});
  const [saveUnchecked, setSaveUnchecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<AgentRouteCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const template = endpoints.find((candidate) => candidate.provider === agent)!;
  const name = AGENT_NAMES[agent] ?? agent;
  const repositoryOk = REPOSITORY.test(repository.trim());
  const invalid = !repositoryOk || template.fields.some((field) => fieldProblem(field, values[field.key] ?? (field.kind === "choice" ? field.default : undefined)));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const added = await api.cloudOrganizationRouteAdd({
        organizationId,
        contextRevision,
        agent,
        repository: repository.trim(),
        templateId: template.id,
        settings: templateSettings(template, values),
        saveUnchecked,
      });
      if (added.saved && added.routes) onAdded(added.routes);
      else setFailed(added.check);
    } catch (failure) {
      setError(routeErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="max-w-xl" data-testid="organization-route-form">
        <DialogHeader>
          <DialogTitle>Custom provider for {name}</DialogTitle>
          <DialogDescription>{name} in workspaces on one repository calls its model through your endpoint.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-xs">
          {agents.length > 1 && (
            <div className="flex items-center gap-3">
              <span className="text-muted-foreground">Agent</span>
              <div role="radiogroup" aria-label="Agent" className="inline-flex rounded-md border border-hairline p-0.5">
                {agents.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    role="radio"
                    aria-checked={candidate === agent}
                    disabled={busy}
                    className={`rounded px-2.5 py-1 ${candidate === agent ? "bg-accent font-medium" : "text-muted-foreground"}`}
                    onClick={() => { setAgent(candidate); setValues({}); setFailed(null); }}
                  >
                    {AGENT_NAMES[candidate] ?? candidate}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="col-span-2 block space-y-1">
              <span>Repository</span>
              <input className={inputClass} value={repository} disabled={busy} spellCheck={false} autoComplete="off" placeholder="owner/name" onChange={(event) => { setRepository(event.target.value); setFailed(null); }} />
            </label>
            {template.fields.map((field) => {
              const value = values[field.key] ?? (field.kind === "choice" ? field.default : "") ?? "";
              const problem = values[field.key] !== undefined ? fieldProblem(field, value) : null;
              const modelFailed = field.kind === "model" && failed?.code === "model-unsupported";
              return (
                <label key={field.key} className={`block space-y-1 ${field.kind === "url" ? "col-span-2" : ""}`} data-field={field.key}>
                  <span>{field.label}{!field.required && <span className="text-muted-foreground"> (optional)</span>}</span>
                  {field.kind === "choice" ? (
                    <select className={inputClass} value={value} disabled={busy} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}>
                      {field.choices?.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                    </select>
                  ) : (
                    <input
                      className={`${inputClass} ${modelFailed ? "border-destructive" : ""}`}
                      value={value}
                      disabled={busy}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={field.kind === "url" ? "https://llm.example.com" : undefined}
                      onChange={(event) => { setValues({ ...values, [field.key]: event.target.value }); setFailed(null); }}
                    />
                  )}
                  {problem && <span className="block text-warning">{problem}</span>}
                </label>
              );
            })}
          </div>
          <p className="break-words text-muted-foreground">
            {ThisComputer} asks for the {template.credential?.label.toLowerCase() ?? "credential"} in a secure dialog and tests it before saving. It is stored encrypted for {organizationName} and never shown again.
          </p>
          {!hasSecureDialog && <p role="note" className="text-warning">{SECURE_DIALOG_OFF}</p>}
          {failed && (
            <div role="alert" className="space-y-2 rounded-md border border-destructive/50 bg-destructive/5 p-3" data-testid="organization-route-test-failed">
              <p className="flex items-center gap-1.5 font-medium"><CircleAlert className="size-3.5 text-destructive" /> Test failed · nothing was saved</p>
              <p className="text-muted-foreground">Tested from {thisComputer}: {checkReason(failed.code, values.model)}.</p>
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={saveUnchecked} disabled={busy} onChange={(event) => setSaveUnchecked(event.target.checked)} />
                <span>Save anyway: the endpoint may answer only the cloud. Workspaces test it again.</span>
              </label>
            </div>
          )}
          {error && <p role="alert" className="text-destructive" data-testid="organization-route-form-error">{error}</p>}
        </div>
        <DialogFooter className="flex-wrap items-center gap-2 border-t border-hairline pt-3 sm:justify-between">
          <p className="flex min-w-0 flex-1 basis-60 items-start gap-1.5 break-words text-xs text-muted-foreground">
            <Building className="mt-px size-3.5 shrink-0" /> <span className="min-w-0">For everyone in {organizationName} · takes precedence over members’ own {name} logins</span>
          </p>
          <div className="flex shrink-0 gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="button" disabled={busy || invalid || !hasSecureDialog} onClick={() => void submit()}>
              {busy && <Loader2 className="animate-spin" />}
              {failed ? (saveUnchecked ? "Test and save anyway" : "Test again") : "Test and save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
