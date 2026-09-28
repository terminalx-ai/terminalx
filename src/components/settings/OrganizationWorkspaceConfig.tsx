import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  IMPACT_LABEL,
  configErrorMessage,
  envToText,
  impactMessage,
  isEnvName,
  parseEnvText,
  parseMcpText,
  scopeLabel,
  workspaceConfig,
  type ConfigField,
  type ConfigLayer,
  type ConfigScope,
  type MemberOverrides,
  type OrganizationConfigView,
  type SecretRuntimeAccess,
  type SecretsView,
} from "@/lib/workspaceConfig";

const inputClass = "h-7 rounded-md border border-hairline bg-background px-2 text-xs disabled:opacity-60";
const areaClass = "min-h-16 rounded-md border border-hairline bg-background px-2 py-1 font-mono text-[11px] disabled:opacity-60";

interface LayerDraft {
  env: string;
  prompt: string;
  mcp: string;
}

const layerDraft = (layer: ConfigLayer): LayerDraft => ({
  env: envToText(layer.env),
  prompt: layer.prompt ?? "",
  mcp: layer.mcpServers.length ? JSON.stringify(layer.mcpServers, null, 2) : "",
});

const LOCAL = "local";

const FIELD_NAMES: Record<ConfigField, string> = { env: "Variables", prompt: "Prompts", mcpServers: "MCP servers", secrets: "Secrets" };

function LayerFields({ label, draft, disabled, onChange }: { label: string; draft: LayerDraft; disabled: boolean; onChange: (draft: LayerDraft) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Variables (NAME=value per line, no secrets)
        <textarea aria-label={`${label} variables`} className={areaClass} value={draft.env} disabled={disabled} onChange={(event) => onChange({ ...draft, env: event.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Prompt
        <textarea aria-label={`${label} prompt`} className={areaClass} value={draft.prompt} maxLength={16384} disabled={disabled} onChange={(event) => onChange({ ...draft, prompt: event.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        MCP servers (JSON array)
        <textarea aria-label={`${label} MCP servers`} className={areaClass} value={draft.mcp} disabled={disabled} onChange={(event) => onChange({ ...draft, mcp: event.target.value })} />
      </label>
    </div>
  );
}

const normalizeRepository = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");

const parseDraft = (draft: LayerDraft) => {
  const env = parseEnvText(draft.env);
  if ("error" in env) return { error: env.error };
  const mcp = parseMcpText(draft.mcp);
  if ("error" in mcp) return { error: mcp.error };
  return { edit: { env: env.env, prompt: draft.prompt.trim() ? draft.prompt : null, mcpServers: mcp.servers } };
};

export function OrganizationWorkspaceConfig({ contextRevision }: { contextRevision: string }) {
  const [view, setView] = useState<OrganizationConfigView | null>(null);
  const [secrets, setSecrets] = useState<SecretsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [orgDraft, setOrgDraft] = useState<LayerDraft>({ env: "", prompt: "", mcp: "" });
  const [overrides, setOverrides] = useState<MemberOverrides>({ env: true, prompt: true, mcpServers: false });
  const [locked, setLocked] = useState("");
  const [repository, setRepository] = useState("");
  const [repoDraft, setRepoDraft] = useState<LayerDraft>({ env: "", prompt: "", mcp: "" });
  // The configured repository the draft was loaded from, and its version.
  const [repoBase, setRepoBase] = useState<{ key: string; version: number } | null>(null);
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [secretAccess, setSecretAccess] = useState<SecretRuntimeAccess>("private-workspaces");
  const [binding, setBinding] = useState<{ name: string; scope: ConfigScope; target: string; envName: string }>({ name: "", scope: "organization", target: "", envName: "" });
  const contextEpoch = useRef(0);

  // A reload after a failed save keeps the admin's unsaved drafts.
  const load = useCallback(async (resetDrafts = true) => {
    const context = contextEpoch.current;
    setLoading(true);
    try {
      const [next, vault] = await Promise.all([workspaceConfig.organization(), workspaceConfig.secrets()]);
      if (context !== contextEpoch.current) return;
      setView(next);
      setSecrets(vault);
      if (!resetDrafts) return;
      setOrgDraft(layerDraft(next.organization));
      setOverrides(next.organization.memberOverrides ?? { env: true, prompt: true, mcpServers: false });
      setLocked(next.organization.lockedEnvKeys.join(", "));
    } catch (failure) {
      if (context === contextEpoch.current) setError(configErrorMessage(failure));
    } finally {
      if (context === contextEpoch.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setView(null);
    setSecrets(null);
    setError(null);
    setNotice(null);
    setBusy(null);
    void load();
    return () => {
      contextEpoch.current += 1;
    };
  }, [contextRevision, load]);

  const run = async (key: string, action: () => Promise<string | null>) => {
    if (busy) return;
    const context = contextEpoch.current;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const message = await action();
      if (context === contextEpoch.current) setNotice(message);
    } catch (failure) {
      if (context !== contextEpoch.current) return;
      // A draft the webview refused never left it: keep it and say why.
      const local = (failure as { code?: string; message?: string } | null)?.code === LOCAL ? (failure as { message: string }).message : null;
      setError(local ?? configErrorMessage(failure));
      if (!local) void load(false);
    } finally {
      if (context === contextEpoch.current) setBusy(null);
    }
  };

  if (!view || !secrets) {
    return (
      <div className="rounded-lg border border-hairline p-3">
        <div className="text-sm font-medium">Workspace configuration</div>
        {error ? <p className="mt-1 text-[11px] text-destructive">{error}</p> : <Loader2 className="mt-2 size-4 animate-spin" aria-label="Loading workspace configuration" />}
      </div>
    );
  }

  const revision = view.contextRevision;
  const canEdit = view.canEdit;
  const repositoryKey = normalizeRepository(repository);
  const repositoryLayer = view.repositories.find((layer) => layer.scopeKey === repositoryKey);

  const saveOrganization = () =>
    void run("organization", async () => {
      const parsed = parseDraft(orgDraft);
      if ("error" in parsed) throw { code: LOCAL, message: parsed.error };
      const lockedEnvKeys = [...new Set(locked.split(",").map((key) => key.trim()).filter(Boolean))];
      if (!lockedEnvKeys.every(isEnvName)) throw { code: "cloud_workspace_config_env_invalid" };
      const result = await workspaceConfig.updateOrganization({ expectedVersion: view.organization.version, ...parsed.edit, memberOverrides: overrides, lockedEnvKeys }, revision);
      await load();
      return impactMessage(result.impact);
    });

  const saveRepository = () =>
    void run("repository", async () => {
      const parsed = parseDraft(repoDraft);
      if ("error" in parsed) throw { code: LOCAL, message: parsed.error };
      // Saving over a configured repository needs a draft loaded from it, so
      // one repository's settings never silently replace another's.
      if (repositoryLayer && repoBase?.key !== repositoryLayer.scopeKey)
        throw { code: LOCAL, message: `${repositoryLayer.scopeKey} is already configured. Click Edit on it first so its current settings are not overwritten.` };
      const expectedVersion = repositoryLayer && repoBase ? repoBase.version : 0;
      const result = await workspaceConfig.updateRepository(repository.trim(), { expectedVersion, ...parsed.edit }, revision);
      setRepoBase({ key: result.layer.scopeKey, version: result.layer.version });
      await load();
      return impactMessage(result.impact);
    });

  const saveSecret = () =>
    void run("secret", async () => {
      const next = await workspaceConfig.putSecret(secretName.trim(), secretValue, secretAccess, revision);
      setSecrets(next);
      setSecretValue("");
      return "Secret saved. Workspaces it is bound to get it in new sessions; running sessions need a restart.";
    });

  const bind = () =>
    void run("bind", async () => {
      const next = await workspaceConfig.bindSecret(binding.name, binding.scope, binding.scope === "organization" ? "" : binding.target.trim(), binding.envName.trim(), revision);
      setSecrets(next);
      setBinding({ ...binding, target: "", envName: "" });
      return "Secret bound. New sessions of matching workspaces receive it.";
    });

  return (
    <div className="rounded-lg border border-hairline p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Workspace configuration</div>
        <Button variant="ghost" size="icon-xs" aria-label="Refresh workspace configuration" disabled={loading} onClick={() => void load(true)}>
          <RefreshCw className={loading ? "animate-spin" : undefined} />
        </Button>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground" aria-label="Configuration precedence">
        Cloud workspaces get variables, prompts and MCP servers from the organization, then the repository, then the workspace itself; a later layer wins. Configuration is
        delivered to the running workspace, never built into an image, so nothing needs a rebuild.
      </p>
      <ul className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground" aria-label="Change impact">
        {(Object.keys(FIELD_NAMES) as ConfigField[]).map((field) => (
          <li key={field}>
            {FIELD_NAMES[field]}: {IMPACT_LABEL[view.fieldImpact[field]]}
          </li>
        ))}
      </ul>
      {error && (
        <p className="mt-2 text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-2 text-[11px] text-muted-foreground" role="status">
          {notice}
        </p>
      )}

      <section className="mt-3 flex flex-col gap-2" aria-label="Organization defaults">
        <div className="text-xs font-medium text-muted-foreground">Organization defaults</div>
        {canEdit ? (
          <>
            <LayerFields label="Organization" draft={orgDraft} disabled={Boolean(busy)} onChange={setOrgDraft} />
            <fieldset className="flex flex-wrap gap-3 text-[11px]">
              <legend className="mb-1 text-muted-foreground">Workspace creators may override</legend>
              {(["env", "prompt", "mcpServers"] as const).map((field) => (
                <label key={field} className="flex items-center gap-1">
                  <input type="checkbox" aria-label={`Members may override ${FIELD_NAMES[field]}`} checked={overrides[field]} disabled={Boolean(busy)} onChange={(event) => setOverrides({ ...overrides, [field]: event.target.checked })} />
                  {FIELD_NAMES[field]}
                </label>
              ))}
            </fieldset>
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              Locked variables (comma-separated; repositories and workspaces cannot change them)
              <input aria-label="Locked variables" className={inputClass} value={locked} disabled={Boolean(busy)} onChange={(event) => setLocked(event.target.value)} />
            </label>
            <Button size="sm" className="h-7 self-start" disabled={Boolean(busy)} onClick={saveOrganization}>
              {busy === "organization" ? <Loader2 className="animate-spin" /> : "Save organization defaults"}
            </Button>
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Only owners and admins can change workspace configuration. {Object.keys(view.organization.env).length} variable(s)
            {view.organization.prompt ? ", a prompt" : ""} and {view.organization.mcpServers.length} MCP server(s) apply to every workspace.
          </p>
        )}
      </section>

      <section className="mt-3 flex flex-col gap-2" aria-label="Repository configuration">
        <div className="text-xs font-medium text-muted-foreground">Repositories</div>
        {view.repositories.length > 0 && (
          <ul className="flex flex-col gap-1 text-[11px]" aria-label="Configured repositories">
            {view.repositories.map((layer) => (
              <li key={layer.scopeKey} className="flex items-center justify-between gap-2">
                <span>
                  {layer.scopeKey} · {Object.keys(layer.env).length} variable(s){layer.prompt ? " · prompt" : ""} · {layer.mcpServers.length} MCP
                </span>
                {canEdit && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6"
                    aria-label={`Edit ${layer.scopeKey}`}
                    onClick={() => {
                      setRepository(layer.scopeKey);
                      setRepoDraft(layerDraft(layer));
                      setRepoBase({ key: layer.scopeKey, version: layer.version });
                    }}
                  >
                    Edit
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <>
            <input aria-label="Repository" placeholder="github.com/owner/name" className={inputClass} value={repository} disabled={Boolean(busy)} onChange={(event) => setRepository(event.target.value)} />
            <LayerFields label="Repository" draft={repoDraft} disabled={Boolean(busy)} onChange={setRepoDraft} />
            <Button size="sm" className="h-7 self-start" disabled={Boolean(busy) || !repository.trim()} onClick={saveRepository}>
              {busy === "repository" ? <Loader2 className="animate-spin" /> : "Save repository configuration"}
            </Button>
          </>
        )}
      </section>

      <section className="mt-3 flex flex-col gap-2" aria-label="Secrets">
        <div className="text-xs font-medium text-muted-foreground">Secrets</div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Secret values are write-only and shown only as a mask. A workspace receives a secret only through a binding, sealed to that workspace&apos;s runtime. Anything a
          runtime receives can be read by the processes and agents running in it, so bind narrowly scoped credentials. Private-workspace secrets are never sent to
          workspaces shared with the organization.
        </p>
        <ul className="flex flex-col gap-2 text-[11px]" aria-label="Stored secrets">
          {secrets.secrets.map((secret) => (
            <li key={secret.id} aria-label={secret.name} className="rounded-md border border-hairline p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono">
                  {secret.name} = {secret.value}
                </span>
                <span className="text-muted-foreground">{secret.runtimeAccess === "all-workspaces" ? "all workspaces" : "private workspaces only"}</span>
                {canEdit && (
                  <Button size="sm" variant="ghost" className="h-6" aria-label={`Delete ${secret.name}`} disabled={Boolean(busy)} onClick={() => void run("delete", async () => {
                    setSecrets(await workspaceConfig.deleteSecret(secret.name, revision));
                    return "Secret deleted.";
                  })}>
                    Delete
                  </Button>
                )}
              </div>
              {secret.bindings.length === 0 ? (
                <div className="text-muted-foreground">Not bound to any workspace.</div>
              ) : (
                <ul className="mt-1 flex flex-col gap-0.5">
                  {secret.bindings.map((item) => (
                    <li key={item.id} className="flex items-center justify-between gap-2">
                      <span>
                        {scopeLabel(item.scope, item.scopeKey)} → {item.envName}
                      </span>
                      {canEdit && (
                        <Button size="sm" variant="ghost" className="h-6" aria-label={`Unbind ${item.envName} from ${scopeLabel(item.scope, item.scopeKey)}`} disabled={Boolean(busy)} onClick={() => void run("unbind", async () => {
                          setSecrets(await workspaceConfig.unbindSecret(item.id, revision));
                          return "Binding removed. Running sessions keep the value until they are restarted.";
                        })}>
                          Unbind
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <>
            <form
              className="flex flex-wrap items-end gap-2"
              aria-label="Add or replace a secret"
              onSubmit={(event) => {
                event.preventDefault();
                saveSecret();
              }}
            >
              <input aria-label="Secret name" placeholder="NPM_TOKEN" className={inputClass} value={secretName} disabled={Boolean(busy)} onChange={(event) => setSecretName(event.target.value.toUpperCase())} />
              <input aria-label="Secret value" type="password" autoComplete="off" placeholder="Value" className={`${inputClass} min-w-0 flex-1`} value={secretValue} disabled={Boolean(busy)} onChange={(event) => setSecretValue(event.target.value)} />
              <select aria-label="Secret runtime access" className={inputClass} value={secretAccess} disabled={Boolean(busy)} onChange={(event) => setSecretAccess(event.target.value as SecretRuntimeAccess)}>
                <option value="private-workspaces">Private workspaces only</option>
                <option value="all-workspaces">All workspaces, including shared</option>
              </select>
              <Button type="submit" size="sm" className="h-7" disabled={Boolean(busy) || !isEnvName(secretName.trim()) || !secretValue}>
                {busy === "secret" ? <Loader2 className="animate-spin" /> : "Save secret"}
              </Button>
            </form>
            {secrets.secrets.length > 0 && (
              <form
                className="flex flex-wrap items-end gap-2"
                aria-label="Bind a secret"
                onSubmit={(event) => {
                  event.preventDefault();
                  bind();
                }}
              >
                <select aria-label="Secret to bind" className={inputClass} value={binding.name} disabled={Boolean(busy)} onChange={(event) => setBinding({ ...binding, name: event.target.value, envName: binding.envName || event.target.value })}>
                  <option value="">Secret…</option>
                  {secrets.secrets.map((secret) => (
                    <option key={secret.id} value={secret.name}>
                      {secret.name}
                    </option>
                  ))}
                </select>
                <select aria-label="Binding scope" className={inputClass} value={binding.scope} disabled={Boolean(busy)} onChange={(event) => setBinding({ ...binding, scope: event.target.value as ConfigScope })}>
                  <option value="organization">Every workspace</option>
                  <option value="repository">Repository</option>
                  <option value="workspace">One workspace</option>
                </select>
                {binding.scope !== "organization" && (
                  <input aria-label="Binding target" placeholder={binding.scope === "repository" ? "github.com/owner/name" : "Workspace id"} className={inputClass} value={binding.target} disabled={Boolean(busy)} onChange={(event) => setBinding({ ...binding, target: event.target.value })} />
                )}
                <input aria-label="Variable name" placeholder="Variable" className={inputClass} value={binding.envName} disabled={Boolean(busy)} onChange={(event) => setBinding({ ...binding, envName: event.target.value.toUpperCase() })} />
                <Button
                  type="submit"
                  size="sm"
                  className="h-7"
                  disabled={Boolean(busy) || !binding.name || !isEnvName(binding.envName.trim()) || (binding.scope !== "organization" && !binding.target.trim())}
                >
                  {busy === "bind" ? <Loader2 className="animate-spin" /> : "Bind"}
                </Button>
              </form>
            )}
          </>
        )}
      </section>
    </div>
  );
}
