import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "@/icons";
import { Button } from "@/components/ui/button";
import { api, type AgentRoute, type AgentRouteAgent, type AgentRouteCheckResult, type AgentRoutes, type AgentRouteSettings, type AgentRouteTemplate } from "@/lib/api";
import { credentialCarriesOver, fieldProblem, listedModels, macCheckLine, routeErrorMessage, routeStatus, routeSummary, templateSettings } from "@/lib/agentRoutes";

/**
 * A member's own model access (PRO-18): how the agents in the cloud
 * workspaces they create reach their model. By default they use the
 * organization's agent logins, which the app manages. A member may route an
 * agent through their own endpoint (a gateway or model provider, with a
 * credential they store) or through a credential helper they manage in the
 * workspace. Personal: nobody else sees it or runs on it, and any member
 * may set theirs in any organization they belong to.
 *
 * Only what the agent's CLI supports is offered: the account service's
 * template catalog, per agent, with its fields. A credential is never typed
 * here: the app asks for it in its own secure dialog, checks it from this
 * Mac and sends it once. A helper route is "user managed" until a workspace
 * has run the helper and its credential worked.
 */
const NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

const inputClass = "h-7 w-full rounded-md border border-hairline bg-background px-2 text-xs disabled:opacity-60";

interface Editing {
  agent: AgentRouteAgent;
  templateId: string;
  values: AgentRouteSettings;
  /** Enter a credential even though the stored one could stay. */
  replaceCredential: boolean;
  saveUnchecked: boolean;
}

/** The form's starting point: the stored route's template and settings, else the agent's first template. */
function startEditing(agent: AgentRouteAgent, route: AgentRoute | undefined, templates: AgentRouteTemplate[]): Editing {
  const template = templates.find((candidate) => candidate.id === route?.templateId) ?? templates[0];
  return { agent, templateId: template.id, values: route?.templateId === template.id ? { ...route.settings } : {}, replaceCredential: false, saveUnchecked: false };
}

export function OrganizationAgentRoutes({
  contextRevision,
  organizationId,
  organizationName,
}: {
  contextRevision: string;
  /** Any organization the person belongs to: routes are per organization and per person. */
  organizationId: string;
  organizationName?: string | null;
}) {
  const organization = organizationName?.trim() || "this organization";
  const [data, setData] = useState<AgentRoutes | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<AgentRouteAgent | null>(null);
  /** What the last save (or failed check) said, for one agent. */
  const [notice, setNotice] = useState<{ agent: string; text: string; warn: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.cloudAgentRoutes(organizationId));
      setError(null);
    } catch (failure) {
      setError(routeErrorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (edit: Editing, template: AgentRouteTemplate, route: AgentRoute | undefined) => {
    const settings = templateSettings(template, edit.values);
    const carries = credentialCarriesOver(route, template.id, settings.baseUrl);
    const enterCredential = !!template.credential && (!carries || edit.replaceCredential);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api.cloudAgentRouteSave({
        organizationId,
        contextRevision,
        agent: edit.agent,
        templateId: template.id,
        settings,
        expectedVersion: route?.version ?? 0,
        enterCredential,
        saveUnchecked: template.id === "claude-bedrock" ? false : edit.saveUnchecked,
      });
      const checked: AgentRouteCheckResult | null = saved.check;
      if (!saved.saved) {
        // The credential was checked from this Mac and refused: nothing was saved, and the form stays.
        setNotice({ agent: edit.agent, text: `${checked ? macCheckLine(checked, settings.model).text : "The check did not pass."} Nothing was saved.`, warn: true });
        return;
      }
      if (saved.routes) setData(saved.routes);
      setEditing(null);
      const line = checked ? macCheckLine(checked, settings.model) : null;
      setNotice({
        agent: edit.agent,
        text: line
          ? `${line.text}${line.warn ? " Saved anyway, as you chose." : ""}`
          : template.id === "claude-bedrock"
            ? "Amazon Bedrock accepted the test model. Saved for new Claude Code sessions in your own cloud workspaces."
          : template.mode === "user-managed"
            ? "Saved. It is user managed: a workspace checks it when it gets the route or starts the agent."
            : "Saved. The stored credential was kept.",
        warn: !!line?.warn,
      });
    } catch (failure) {
      setError(routeErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (agent: AgentRouteAgent) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setData(await api.cloudAgentRouteRemove(agent, contextRevision, organizationId));
      setConfirmRemove(null);
      setNotice({ agent, text: `${NAMES[agent]} uses ${organization}'s login again in new sessions.`, warn: false });
    } catch (failure) {
      setError(routeErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-hairline p-3" data-testid="agent-routes">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Your model access in {organization}</div>
        <Button variant="ghost" size="icon-xs" aria-label="Refresh your model access" disabled={loading || busy} onClick={() => void load()}>
          <RefreshCw className={loading ? "animate-spin" : undefined} />
        </Button>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        How the agents in cloud workspaces you create in {organization} reach their model. By default they use the organization's agent logins,
        managed by TerminalX. You can instead use your own endpoint with a credential you store, or a credential helper you manage in the
        workspace. Other members never see your setup. A stored credential reaches only workspaces you create that nobody else drives; a
        credential helper also runs for everyone who drives a workspace you share, and their sessions get whatever it prints.
      </p>

      {loading && !data ? (
        <p role="status" className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading your model access…
        </p>
      ) : (
        data && (
          <ul className="mt-2 flex flex-col gap-2 text-xs">
            {data.agents.map((agent) => {
              const name = NAMES[agent] ?? agent;
              const templates = data.templates.filter((template) => template.provider === agent);
              const route = data.routes.find((candidate) => candidate.provider === agent);
              const template = route && data.templates.find((candidate) => candidate.id === route.templateId);
              const status = route ? routeStatus(route) : null;
              const models = route?.lastCheck ? listedModels(route.lastCheck) : null;
              const edit = editing?.agent === agent ? editing : null;
              const routable = templates.length > 0;
              return (
                <li key={agent} className="rounded-md bg-well p-2" data-testid="agent-route" data-agent={agent}>
                  <div className="font-medium">{name}</div>
                  {!routable ? (
                    <div className="text-muted-foreground" data-testid="agent-route-status">
                      Organization login. {name}'s CLI signs in only with its own login: it supports no custom endpoint or credential helper.
                    </div>
                  ) : !route ? (
                    <div className="text-muted-foreground" data-testid="agent-route-status">
                      Organization login, managed by TerminalX.
                    </div>
                  ) : (
                    <>
                      <div className="break-words">{routeSummary(route, template)}</div>
                      <div
                        className={status!.tone === "warn" ? "text-warning" : status!.tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}
                        data-testid="agent-route-status"
                        data-status={route.status}
                      >
                        {status!.text}
                      </div>
                      {models && (
                        <div className="break-words text-muted-foreground" data-testid="agent-route-models">
                          Models the endpoint lists: {models}
                        </div>
                      )}
                      {!route.templateCurrent && (
                        <div className="text-warning">This endpoint type has a newer version. It keeps working as saved; set it up again to move to the new one.</div>
                      )}
                      {route.mode === "custom-endpoint" && (
                        <div className="text-muted-foreground">
                          Your stored credential reaches only workspaces you create that nobody else can drive. A workspace that received it can't be
                          opened to the organization or shared with Can send until it restarts.
                        </div>
                      )}
                    </>
                  )}

                  {routable && !edit && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <Button
                        size="xs"
                        variant={route ? "outline" : "default"}
                        disabled={busy}
                        onClick={() => {
                          setNotice(null);
                          setConfirmRemove(null);
                          setEditing(startEditing(agent as AgentRouteAgent, route, templates));
                        }}
                      >
                        {route ? "Change…" : "Use your own endpoint or helper…"}
                      </Button>
                      {route && (
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => setConfirmRemove(agent as AgentRouteAgent)} data-testid="agent-route-switch-back">
                          Switch back to the organization login
                        </Button>
                      )}
                    </div>
                  )}

                  {confirmRemove === agent && route && (
                    <div className="mt-2 space-y-1.5 rounded-md border border-hairline bg-background p-2" data-testid="agent-route-confirm-remove">
                      <p>
                        {route.templateId === "claude-bedrock" && <strong className="block">Disconnect Amazon Bedrock?</strong>}
                        Switch {name} back to {organization}'s login? Your route{route.credentialStored ? " and its stored credential are" : " is"} deleted.
                        New sessions in your workspaces use the organization's login; running sessions keep what they started with until restarted
                        {route.credentialStored ? ", and a workspace that received the credential stays unshareable until it restarts" : ""}.
                      </p>
                      <div className="flex gap-1.5">
                        <Button size="xs" disabled={busy} onClick={() => void remove(agent as AgentRouteAgent)}>
                          {busy && <Loader2 className="animate-spin" />}
                          Switch back
                        </Button>
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => setConfirmRemove(null)}>
                          Keep my route
                        </Button>
                      </div>
                    </div>
                  )}

                  {edit && (
                    <RouteEditor
                      edit={edit}
                      route={route}
                      templates={templates}
                      busy={busy}
                      modelsListed={route?.lastCheck?.models ?? []}
                      onChange={setEditing}
                      onCancel={() => setEditing(null)}
                      onSave={(chosen) => void save(edit, chosen, route)}
                    />
                  )}

                  {notice?.agent === agent && (
                    <p role="status" className={`mt-1.5 ${notice.warn ? "text-warning" : "text-muted-foreground"}`} data-testid="agent-route-notice">
                      {notice.text}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive" data-testid="agent-route-error">
          {error}
        </p>
      )}
    </div>
  );
}

function RouteEditor({
  edit,
  route,
  templates,
  busy,
  modelsListed,
  onChange,
  onCancel,
  onSave,
}: {
  edit: Editing;
  route: AgentRoute | undefined;
  templates: AgentRouteTemplate[];
  busy: boolean;
  modelsListed: string[];
  onChange: (edit: Editing) => void;
  onCancel: () => void;
  onSave: (template: AgentRouteTemplate) => void;
}) {
  const template = templates.find((candidate) => candidate.id === edit.templateId) ?? templates[0];
  const settings = templateSettings(template, edit.values);
  const problems = template.fields.map((field) => [field.key, fieldProblem(field, edit.values[field.key] ?? (field.kind === "choice" ? field.default : undefined))] as const);
  const invalid = problems.some(([, problem]) => problem);
  const carries = credentialCarriesOver(route, template.id, settings.baseUrl);
  const entering = !!template.credential && (!carries || edit.replaceCredential);
  const listId = `agent-route-models-${edit.agent}`;
  return (
    <div className="mt-2 space-y-2 rounded-md border border-hairline bg-background p-2" data-testid="agent-route-edit">
      {templates.length > 1 && (
        <fieldset className="space-y-1">
          <legend className="mb-1 font-medium">How {NAMES[edit.agent]} reaches its model</legend>
          {templates.map((candidate) => (
            <label key={candidate.id} className="flex items-start gap-2" data-testid="agent-route-template" data-template={candidate.id}>
              <input
                type="radio"
                name={`agent-route-template-${edit.agent}`}
                checked={candidate.id === template.id}
                disabled={busy}
                onChange={() => onChange({ ...edit, templateId: candidate.id, values: route?.templateId === candidate.id ? { ...route.settings } : {} })}
              />
              <span>
                <span className="font-medium">{candidate.label}</span>
                <span className="block text-muted-foreground">{candidate.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {template.fields.map((field) => {
        const problem = problems.find(([key]) => key === field.key)?.[1];
        const value = edit.values[field.key] ?? (field.kind === "choice" ? field.default : "") ?? "";
        const touched = edit.values[field.key] !== undefined;
        return (
          <label key={field.key} className="block space-y-0.5" data-testid="agent-route-field" data-field={field.key}>
            <span className="font-medium">
              {field.label}
              {!field.required && <span className="font-normal text-muted-foreground"> (optional)</span>}
            </span>
            {field.kind === "choice" ? (
              <select className={inputClass} value={value} disabled={busy} onChange={(event) => onChange({ ...edit, values: { ...edit.values, [field.key]: event.target.value } })}>
                {field.choices?.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={inputClass}
                value={value}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
                list={field.kind === "model" && modelsListed.length ? listId : undefined}
                placeholder={field.kind === "url" ? "https://llm.example.com" : field.kind === "path" ? "./scripts/llm-key" : undefined}
                onChange={(event) => onChange({ ...edit, values: { ...edit.values, [field.key]: event.target.value } })}
              />
            )}
            <span className="block text-muted-foreground">{field.help}</span>
            {problem && touched && (
              <span className="block text-warning" data-testid="agent-route-field-problem">
                {problem}
              </span>
            )}
          </label>
        );
      })}
      {modelsListed.length > 0 && (
        <datalist id={listId}>
          {modelsListed.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      )}
      {template.credential ? (
        <div className="space-y-1">
          {carries ? (
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={edit.replaceCredential} disabled={busy} onChange={(event) => onChange({ ...edit, replaceCredential: event.target.checked })} />
              <span>Enter a new {template.credential.label.toLowerCase()} (the stored one stays otherwise)</span>
            </label>
          ) : (
            <p className="text-muted-foreground">
              When you save, the app asks for the {template.credential.label.toLowerCase()} in its own secure dialog and checks it {template.id === "claude-bedrock" ? "from the account service" : "from this Mac"}.{" "}
              {template.credential.help}
            </p>
          )}
          {entering && template.id !== "claude-bedrock" && (
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={edit.saveUnchecked} disabled={busy} onChange={(event) => onChange({ ...edit, saveUnchecked: event.target.checked })} />
              <span>Save even if this Mac's check fails: an endpoint may answer only the cloud, or serve a model it doesn't list. The workspace checks it again.</span>
            </label>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground" data-testid="agent-route-user-managed">
          User managed: the helper must be in the workspace, and TerminalX never sees what it prints. In a workspace you share, everyone who
          drives it runs through your helper too and gets what it prints, so don't point it at a credential only you should use. It stays
          labeled user managed until a workspace runs it and the endpoint accepts its credential.
        </p>
      )}
      <div className="flex gap-1.5">
        <Button size="xs" disabled={busy || invalid} onClick={() => onSave(template)} data-testid="agent-route-save">
          {busy && <Loader2 className="animate-spin" />}
          {template.id === "claude-bedrock" ? "Test and save" : entering ? "Enter credential and save" : "Save"}
        </Button>
        <Button size="xs" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}