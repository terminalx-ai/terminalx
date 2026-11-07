import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { emptyMcpDraft, mcpError, mcpFormInput, MCP_STATUS_LABELS, organizationMcp, type McpDraft, type McpImport, type McpView, type OrganizationMcpServer } from "@/lib/organizationMcp";

const inputClass = "w-full rounded-md border border-hairline bg-background px-2 py-1 text-xs disabled:opacity-60";
const recommendations = [
  { name: "linear", label: "Linear", url: "https://mcp.linear.app/mcp", description: "Issues, projects and team context" },
];

export function OrganizationMcpServers({ contextRevision }: { contextRevision: string }) {
  const [view, setView] = useState<McpView | null>(null);
  const [tab, setTab] = useState<"installed" | "recommended">("installed");
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [editing, setEditing] = useState<OrganizationMcpServer | undefined>();
  const [imported, setImported] = useState<McpImport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const epoch = useRef(0);
  const load = useCallback(async () => {
    const current = epoch.current;
    try {
      const result = await organizationMcp.list();
      if (current === epoch.current) { setView(result); setError(null); }
    } catch (error) { if (current === epoch.current) setError(mcpError(error)); }
  }, []);
  useEffect(() => {
    epoch.current++;
    setView(null); setDraft(null); setEditing(undefined); setImported(null); setError(null); setNotice(null); setBusy(false);
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15000);
    return () => { epoch.current++; window.clearInterval(timer); };
  }, [contextRevision, load]);
  const act = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    const current = epoch.current;
    try { await operation(); }
    catch (error) { if (current === epoch.current) setError(mcpError(error)); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  const save = () => act(async () => {
    if (!draft || !view) return;
    const input = mcpFormInput(draft, editing);
    const current = epoch.current;
    const next = await organizationMcp.save(input, editing?.id ?? null, view.contextRevision);
    if (current !== epoch.current) return;
    setView(next); setDraft(null); setEditing(undefined); setImported(null); setTab("installed");
    setNotice(input.auth === "oauth" ? "Saved. Sign in to share this connection with new cloud tabs." : "Saved. New cloud tabs use this connection; running tabs keep their existing settings.");
  });
  const edit = (server?: OrganizationMcpServer) => {
    setEditing(server);
    setDraft(server ? { ...emptyMcpDraft(), name: server.name, url: server.url, auth: server.auth } : emptyMcpDraft());
    setError(null);
  };
  const signIn = (server: OrganizationMcpServer) => act(async () => {
    if (!view) return;
    const current = epoch.current;
    const url = await organizationMcp.signIn(server, view.contextRevision);
    if (current !== epoch.current) return;
    await openUrl(url);
    if (current === epoch.current) setNotice("Finish sign-in in your browser, then refresh this list. The connection is shared with your organisation.");
  });
  const remove = (server: OrganizationMcpServer) => act(async () => {
    if (!view) return;
    const current = epoch.current;
    const next = await organizationMcp.remove(server, view.contextRevision);
    if (current === epoch.current) { setView(next); setNotice("Removed. New cloud tabs no longer receive this connection."); }
  });
  const importMac = () => act(async () => {
    const current = epoch.current;
    const result = await organizationMcp.import();
    if (current === epoch.current) setImported(result);
  });
  const field = (key: keyof McpDraft, value: string | boolean) => setDraft((previous) => previous ? { ...previous, [key]: value } : previous);
  return (
    <section aria-label="Organisation MCP servers" className="mt-3 flex flex-col gap-2 border-t border-hairline pt-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium">MCP servers</h3>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>Refresh servers</Button>
      </div>
      <p className="text-[11px] text-muted-foreground">Connect once for your organisation. New Claude and Codex cloud tabs receive these servers. OAuth tokens stay on the server and are sent only to cloud runtimes.</p>
      <div role="tablist" aria-label="MCP server lists" className="flex gap-2">
        <Button role="tab" aria-selected={tab === "installed"} size="sm" variant={tab === "installed" ? "secondary" : "ghost"} onClick={() => setTab("installed")}>Installed</Button>
        <Button role="tab" aria-selected={tab === "recommended"} size="sm" variant={tab === "recommended" ? "secondary" : "ghost"} onClick={() => setTab("recommended")}>Recommended</Button>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
      {!view && !error && <p className="text-xs text-muted-foreground">Loading MCP servers…</p>}
      {view && tab === "installed" && <div role="tabpanel" aria-label="Installed MCP servers">
        {!view.servers.length && <p className="text-xs text-muted-foreground">No organisation MCP servers installed.</p>}
        <ul className="flex flex-col gap-2">{view.servers.map((server) => <li key={server.id} className="rounded-md border border-hairline p-2 text-xs">
          <div className="flex items-center gap-2"><strong>{server.name}</strong><span className={`rounded-full px-2 py-0.5 text-[10px] ${server.status === "connected" ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"}`}>{MCP_STATUS_LABELS[server.status]}</span></div>
          <p className="break-all text-muted-foreground">{server.url}</p>
          <p className="text-[11px] text-muted-foreground">{server.checkedAt ? `Last checked ${new Date(server.checkedAt).toLocaleString()}` : "Not checked yet. A running cloud workspace checks this connection."}</p>
          {view.canEdit && <div className="mt-1 flex gap-1">
            {server.auth === "oauth" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void signIn(server)}>{server.status === "needs-reauth" ? "Re-authenticate" : "Sign in"} {server.name}</Button>}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => edit(server)}>Edit {server.name}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(server)}>Remove {server.name}</Button>
          </div>}
        </li>)}</ul>
      </div>}
      {view && tab === "recommended" && <div role="tabpanel" aria-label="Recommended MCP servers">{recommendations.map((server) => <div key={server.name} className="flex items-center justify-between gap-2 rounded-md border border-hairline p-2 text-xs"><div><strong>{server.label}</strong><p className="text-muted-foreground">{server.description}</p></div>{view.canEdit && <Button size="sm" disabled={busy || view.servers.some((installed) => installed.name === server.name)} onClick={() => { setEditing(undefined); setDraft({ ...emptyMcpDraft(), name: server.name, url: server.url }); }}>Add {server.label}</Button>}</div>)}</div>}
      {view?.canEdit && <div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => edit()}>Add server</Button><Button size="sm" variant="secondary" disabled={busy} onClick={() => void importMac()}>Import from this Mac</Button></div>}
      {view && !view.canEdit && <p className="text-xs text-muted-foreground">Only organisation owners and admins can add, sign in to or remove servers.</p>}
      {imported && <div className="rounded-md border border-hairline p-2 text-xs" aria-label="Mac import preview">
        <p>Global HTTPS servers from ~/.claude.json. Local commands, URL credentials and project settings are skipped. Existing Mac credentials are never copied.</p>
        {!imported.servers.length && <p>No importable servers found.</p>}
        {imported.skipped > 0 && <p>{imported.skipped} unsupported server(s) skipped.</p>}
        {imported.servers.map((server) => <div key={server.name} className="mt-2 flex items-center justify-between gap-2"><span>{server.name}{server.requiresAuth ? " · authentication required" : ""}</span><Button size="sm" disabled={busy || view?.servers.some((row) => row.name === server.name)} onClick={() => { setEditing(undefined); setDraft({ ...emptyMcpDraft(), name: server.name, url: server.url, auth: server.requiresAuth ? "oauth" : "none" }); }}>Import {server.name}</Button></div>)}
      </div>}
      {draft && view?.canEdit && <form aria-label={editing ? "Edit MCP server" : "Add MCP server"} className="flex flex-col gap-2 rounded-md border border-hairline p-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="text-xs">Server name<input aria-label="Server name" className={inputClass} value={draft.name} maxLength={64} disabled={busy} onChange={(event) => field("name", event.target.value)} /></label>
        <label className="text-xs">Server URL<input aria-label="Server URL" className={inputClass} value={draft.url} maxLength={2048} disabled={busy} placeholder="https://example.com/mcp" onChange={(event) => field("url", event.target.value)} /></label>
        <label className="text-xs">Authentication<select aria-label="Authentication" className={inputClass} value={draft.auth} disabled={busy} onChange={(event) => { field("auth", event.target.value); field("bearer", ""); field("headers", ""); field("clientSecret", ""); }}><option value="oauth">OAuth sign-in</option><option value="bearer">Bearer token</option><option value="headers">Custom headers</option><option value="none">None</option></select></label>
        {draft.auth === "bearer" && <label className="text-xs">Bearer token<input aria-label="Bearer token" type="password" autoComplete="new-password" className={inputClass} value={draft.bearer} maxLength={8192} disabled={busy} placeholder={editing ? "Leave blank to keep stored token" : "Token"} onChange={(event) => field("bearer", event.target.value)} /></label>}
        {draft.auth === "headers" && <label className="text-xs">Custom headers<textarea aria-label="Custom headers" autoComplete="off" className={inputClass} value={draft.headers} disabled={busy} placeholder={editing ? "Leave blank to keep stored headers" : "Header-Name: value"} onChange={(event) => field("headers", event.target.value)} /></label>}
        {draft.auth === "oauth" && <details><summary className="cursor-pointer text-xs">Advanced client identity</summary><p className="text-[11px] text-muted-foreground">Leave empty to register automatically. Use a pre-registered client ID and optional secret when your provider requires it. Changing identity requires sign-in again.</p>
          {view.oauthRedirectUri && <p className="break-all text-[11px] text-muted-foreground">Register this callback URL: {view.oauthRedirectUri}</p>}
          {editing && <label className="text-xs"><input type="checkbox" checked={draft.replaceIdentity} disabled={busy} onChange={(event) => field("replaceIdentity", event.target.checked)} /> Replace stored client identity</label>}
          <label className="text-xs">Client ID<input aria-label="Client ID" className={inputClass} value={draft.clientId} disabled={busy} onChange={(event) => field("clientId", event.target.value)} /></label>
          <label className="text-xs">Client secret<input aria-label="Client secret" type="password" autoComplete="new-password" className={inputClass} value={draft.clientSecret} disabled={busy} onChange={(event) => field("clientSecret", event.target.value)} /></label>
          <label className="text-xs">Scopes<input aria-label="Scopes" className={inputClass} value={draft.scope} disabled={busy} onChange={(event) => field("scope", event.target.value)} /></label>
        </details>}
        <p className="text-[11px] text-muted-foreground">This connection is available to agents in all organisation cloud workspaces. Use credentials appropriate for shared access.</p>
        <div className="flex gap-2"><Button type="submit" size="sm" disabled={busy}>Save server</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setDraft(null); setEditing(undefined); }}>Cancel</Button></div>
      </form>}
    </section>
  );
}
