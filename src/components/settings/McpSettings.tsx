import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Activity, BookOpen, Check, ChartLine, CircleDot, Bug, CreditCard, Database, DatabaseZap, Download, Drama, Ellipsis, Flame, Github, Hash, Info, NotebookText, PenTool, Plus, RefreshCw, Search, SearchX, Server, Triangle, Users, X, type LucideIcon } from "@/icons";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { AgentMark } from "@/components/AgentMark";
import { useAccount } from "@/lib/account";
import { errorMessage } from "@/lib/api";
import { showError } from "@/lib/errorToasts";
import { cn } from "@/lib/cn";
import { AUTH_LABELS, RECOMMENDED, agentsLabel, matchesServer, mcp, recommendedAdded, sharingOrganizations, type McpImportScan, type McpListing, type McpServerRow, type McpStatus, type RecommendedServer } from "@/lib/mcpServers";
import { RegisteredSetting } from "./settingsRegistry";
import { McpServerDialog, type McpDialogRequest } from "./McpServerDialog";

/** Faint uppercase column labels, as in Settings › Environment. */
const kicker = "text-[10.5px] font-medium uppercase tracking-[.08em] text-faint";
const ICONS: Record<string, LucideIcon> = { Activity, BookOpen, Bug, ChartLine, CircleDot, CreditCard, Database, DatabaseZap, Drama, Flame, Github, Hash, NotebookText, PenTool, Triangle };

type Tab = "installed" | "recommended";

/** Settings › MCP (PRO-239, designs 10.09–10.18). */
export function McpSettings() {
  return <RegisteredSetting setting="mcp.servers"><McpPage /></RegisteredSetting>;
}

export function McpPage() {
  const { status: account } = useAccount();
  const [tab, setTab] = useState<Tab>("installed");
  const [listing, setListing] = useState<McpListing | null>(null);
  const [statuses, setStatuses] = useState<Record<string, McpStatus | "checking">>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<McpDialogRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const orgName = useCallback((id: string) => (account.organizations ?? []).find((org) => org.id === id)?.name ?? "your organization", [account.organizations]);
  const manages = useCallback((id: string) => (account.organizations ?? []).some((org) => org.id === id && (org.role === "owner" || org.role === "admin")), [account.organizations]);
  const sharing = sharingOrganizations(account);

  const check = useCallback((key: string) => {
    setStatuses((now) => ({ ...now, [key]: "checking" }));
    mcp.check(key).then((status) => setStatuses((now) => ({ ...now, [key]: status })), () => setStatuses((now) => ({ ...now, [key]: { state: "unreachable", detail: "Not checked" } })));
  }, []);
  const install = useCallback((next: McpListing, recheck?: string[]) => {
    setListing(next);
    for (const server of next.servers) if (!recheck || recheck.includes(server.key)) check(server.key);
  }, [check]);
  useEffect(() => {
    let live = true;
    mcp.list().then((next) => { if (live) install(next); }, (e) => { if (live) { setError(errorMessage(e)); showError("Couldn't load MCP servers", e); } });
    return () => { live = false; };
  }, [install]);

  const run = async (work: () => Promise<McpListing | void>, failure: string, recheck?: string[]) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const next = await work();
      if (next) install(next, recheck);
    } catch (e) { setError(errorMessage(e)); showError(failure, e); } finally { setBusy(false); }
  };
  const signIn = (row: McpServerRow) => {
    if (row.auth !== "oauth") { setDialog({ kind: "edit", row }); return; }
    void run(() => mcp.signIn(row.key), `Couldn't sign in to ${row.name}`, [row.key]);
  };
  const saved = (next: McpListing, key: string | null) => {
    setDialog(null);
    const added = key ? [key] : next.servers.filter((s) => !listing?.servers.some((old) => old.key === s.key)).map((s) => s.key);
    install(next, added);
    setTab("installed");
  };

  const servers = listing?.servers ?? [];
  const sharedOrgs = [...new Set(servers.filter((s) => s.sharedBy).map((s) => s.sharedBy!))];
  return <div className="flex flex-col gap-4">
    <div role="tablist" aria-label="MCP servers" className="flex gap-1 border-b border-hairline">
      <TabButton active={tab === "installed"} onClick={() => setTab("installed")}>Installed · {servers.length}</TabButton>
      <TabButton active={tab === "recommended"} onClick={() => setTab("recommended")}>Recommended</TabButton>
    </div>
    {error && dialog === null && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {listing?.problems.map((problem) => <p key={problem} role="alert" className="text-sm text-destructive">{problem}</p>)}
    {listing === null ? (error ? null : <p className="text-sm text-muted-foreground">Loading MCP servers…</p>)
      : tab === "installed"
        ? <Installed servers={servers} statuses={statuses} busy={busy} manages={manages} orgName={orgName}
            onAdd={(recommended) => setDialog({ kind: "add", recommended })} onImport={() => setTab("recommended")} onCheck={check} onSignIn={signIn}
            onEdit={(row) => setDialog({ kind: "edit", row })}
            onSignOut={(row) => void run(() => mcp.signOut(row.key), `Couldn't sign out of ${row.name}`, [row.key])}
            onSetOff={(row, off) => void run(() => mcp.setOff(row.key, off), `Couldn't change ${row.name}`, [row.key])}
            onRemove={(row) => void run(() => mcp.remove(row.key), `Couldn't remove ${row.name}`, [])} />
        : <Recommended servers={servers} busy={busy} onAdd={(recommended) => setDialog({ kind: "add", recommended })}
            onImported={(next, text) => { install(next); setNotice(text); setTab("installed"); }} />}
    {tab === "installed" && sharedOrgs.length > 0 && <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <Info aria-hidden className="size-3.5 shrink-0" />
      A shared server is installed for everyone in {sharedOrgs.map(orgName).join(" and ")}. You can turn it off for yourself, not remove it.
    </p>}
    {dialog && listing && <McpServerDialog request={dialog} callbackUrl={listing.callbackUrl} organizations={sharing} orgName={orgName}
      onClose={() => setDialog(null)} onSaved={saved} />}
  </div>;
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick}
    className={cn("-mb-px border-b-2 px-1 pb-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40", active ? "border-accent text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
    <span className="px-1">{children}</span>
  </button>;
}

function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="flex h-8 min-w-0 shrink-0 grow items-center gap-2 rounded-md border border-hairline bg-veil-raised px-2.5 text-[13px] focus-within:ring-2 focus-within:ring-ring/40">
    <Search aria-hidden className="size-3.5 shrink-0 text-faint" />
    <input type="search" aria-label={placeholder} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint [&::-webkit-search-cancel-button]:hidden" />
    {value && <button type="button" aria-label="Clear" onClick={() => onChange("")} className="text-faint hover:text-foreground"><X aria-hidden className="size-3.5" /></button>}
  </label>;
}

function Installed({ servers, statuses, busy, manages, orgName, onAdd, onImport, onCheck, onSignIn, onEdit, onSignOut, onSetOff, onRemove }: {
  servers: McpServerRow[]; statuses: Record<string, McpStatus | "checking">; busy: boolean;
  manages: (org: string) => boolean; orgName: (org: string) => string;
  onAdd: (recommended?: RecommendedServer) => void; onImport: () => void; onCheck: (key: string) => void; onSignIn: (row: McpServerRow) => void;
  onEdit: (row: McpServerRow) => void; onSignOut: (row: McpServerRow) => void; onSetOff: (row: McpServerRow, off: boolean) => void; onRemove: (row: McpServerRow) => void;
}) {
  const [query, setQuery] = useState("");
  const shown = servers.filter((server) => matchesServer(server, query));
  const suggestion = query.trim() ? RECOMMENDED.find((r) => matchesServer({ name: r.title, target: r.target }, query) && !recommendedAdded(r, servers)) : undefined;
  return <>
    <div className="flex flex-wrap items-center gap-2">
      <SearchField value={query} onChange={setQuery} placeholder="Search installed servers" />
      <Button size="sm" variant="outline" disabled={busy} onClick={onImport}><Download aria-hidden />Import from this Mac</Button>
      <Button size="sm" disabled={busy} onClick={() => onAdd()}><Plus aria-hidden />Add MCP server</Button>
    </div>
    <div className="@container overflow-x-auto rounded-lg border border-hairline">
      <table className="w-full table-fixed text-left text-[12.5px]" aria-label="Installed MCP servers">
        <colgroup><col className="w-[36%]" /><col className="w-[14%]" /><col className="w-[18%]" /><col /><col className="w-10" /></colgroup>
        <thead className="border-b border-hairline"><tr>
          <th className={`h-8 px-3 ${kicker}`}>Server</th><th className={`h-8 px-2 ${kicker}`}>Auth</th><th className={`h-8 px-2 ${kicker}`}>Agents</th><th className={`h-8 px-2 ${kicker}`}>Status</th><th className="h-8"><span className="sr-only">Actions</span></th>
        </tr></thead>
        <tbody>
          {shown.map((row) => <ServerRow key={row.key} row={row} status={statuses[row.key]} busy={busy} canRemove={!row.sharedBy || manages(row.sharedBy)} orgName={orgName}
            onCheck={() => onCheck(row.key)} onSignIn={() => onSignIn(row)} onEdit={() => onEdit(row)} onSignOut={() => onSignOut(row)} onSetOff={(off) => onSetOff(row, off)} onRemove={() => onRemove(row)} />)}
          {shown.length === 0 && <tr><td colSpan={5} className="px-3 py-10">
            {servers.length === 0
              ? <EmptyState icon={Server} title="No MCP servers yet" text="Add one by URL or command, or bring over the ones Claude Code and Codex already use." />
              : <EmptyState icon={SearchX} title={`No installed servers match “${query.trim()}”`} text={`Searched the names, URLs and commands of your ${servers.length} ${servers.length === 1 ? "server" : "servers"}.`}>
                  <Button size="sm" variant="outline" onClick={() => setQuery("")}><X aria-hidden />Clear search</Button>
                  <Button size="sm" variant="outline" onClick={() => onAdd()}><Plus aria-hidden />Add MCP server</Button>
                </EmptyState>}
          </td></tr>}
        </tbody>
      </table>
    </div>
    {shown.length === 0 && suggestion && <div className="flex items-center gap-3 rounded-lg border border-hairline px-3 py-2.5">
      <RecommendedIcon server={suggestion} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{suggestion.title} is in Recommended</p>
        <p className="truncate text-xs text-muted-foreground">{suggestion.description} · {AUTH_LABELS[suggestion.auth]}</p>
      </div>
      <Button size="sm" variant="outline" onClick={() => onAdd(suggestion)}><Plus aria-hidden />Add</Button>
    </div>}
  </>;
}

function EmptyState({ icon: Icon, title, text, children }: { icon: LucideIcon; title: string; text: string; children?: ReactNode }) {
  return <div className="flex flex-col items-center gap-2 text-center">
    <span className="grid size-10 place-items-center rounded-lg bg-veil-strong"><Icon aria-hidden className="size-4 text-muted-foreground" /></span>
    <p className="mt-1 text-sm font-medium">{title}</p>
    <p className="text-xs text-muted-foreground">{text}</p>
    {children && <div className="mt-2 flex gap-2">{children}</div>}
  </div>;
}

function AgentsCell({ agents }: { agents: McpServerRow["agents"] }) {
  return <span className="flex items-center gap-1.5 text-muted-foreground">
    {agents.claudeCode && <AgentMark id="claude" decorative className="size-3.5" />}
    {agents.codex && <AgentMark id="codex" decorative className="size-3.5" />}
    <span className="truncate text-foreground">{agentsLabel(agents)}</span>
  </span>;
}

function StatusCell(props: { row: McpServerRow; status: McpStatus | "checking" | undefined; onCheck: () => void; onSignIn: () => void }) {
  return <div className="whitespace-nowrap">{statusContent(props)}</div>;
}

function statusContent({ row, status, onCheck, onSignIn }: { row: McpServerRow; status: McpStatus | "checking" | undefined; onCheck: () => void; onSignIn: () => void }) {
  const dot = (color: string) => <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", color)} />;
  const action = (label: string, onClick: () => void) => <button type="button" onClick={onClick} className="shrink-0 font-medium text-accent hover:underline">{label}</button>;
  if (row.shadowed) return <span className="flex items-center gap-2 text-muted-foreground" title="One of your own servers has this name.">{dot("bg-faint")}Name in use</span>;
  if (row.off) return <span className="flex items-center gap-2 text-muted-foreground">{dot("bg-faint")}Off</span>;
  if (!status || status === "checking") return <span className="flex items-center gap-2 text-muted-foreground">{dot("bg-faint")}Checking…</span>;
  switch (status.state) {
    case "connected": return <span className="flex items-center gap-2">{dot("bg-add")}Connected</span>;
    case "needsSignIn": return <span className="flex items-center gap-2">{dot("bg-warning")}Needs sign-in{action("Sign in", onSignIn)}</span>;
    case "exited": return <span className="flex items-center gap-2">{dot("bg-destructive")}{status.code === null ? "Exited" : `Exited (${status.code})`}{action("Retry", onCheck)}</span>;
    case "unreachable": return <span className="flex min-w-0 items-center gap-2">{dot("bg-destructive")}<span className="truncate">{status.detail}</span>{action("Retry", onCheck)}</span>;
    case "off": return <span className="flex items-center gap-2 text-muted-foreground">{dot("bg-faint")}Off</span>;
  }
}

function ServerRow({ row, status, busy, canRemove, orgName, onCheck, onSignIn, onEdit, onSignOut, onSetOff, onRemove }: {
  row: McpServerRow; status: McpStatus | "checking" | undefined; busy: boolean; canRemove: boolean; orgName: (org: string) => string;
  onCheck: () => void; onSignIn: () => void; onEdit: () => void; onSignOut: () => void; onSetOff: (off: boolean) => void; onRemove: () => void;
}) {
  const shared = row.sharedBy !== null;
  return <tr className="border-b border-hairline last:border-b-0">
    <td className="px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-veil-strong"><Server aria-hidden className="size-3.5 text-muted-foreground" /></span>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium">{row.name}</span>
            {shared && <span className="inline-flex shrink-0 items-center gap-1 rounded border border-accent/30 bg-accent/10 px-1 text-[10.5px] text-accent" title={`Shared by ${orgName(row.sharedBy!)}`}><Users aria-hidden className="size-2.5" />Shared</span>}
          </div>
          <p className="truncate font-mono text-[11.5px] text-muted-foreground" title={row.target}>{row.target}</p>
        </div>
      </div>
    </td>
    <td className="truncate px-2 py-2.5">{AUTH_LABELS[row.auth]}</td>
    <td className="px-2 py-2.5"><AgentsCell agents={row.agents} /></td>
    <td className="px-2 py-2.5"><StatusCell row={row} status={status} onCheck={onCheck} onSignIn={onSignIn} /></td>
    <td className="py-2.5 pr-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button size="icon-xs" variant="ghost" disabled={busy} aria-label={`${row.name} actions`}><Ellipsis aria-hidden /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {row.auth === "oauth" && !row.off && <DropdownMenuItem onSelect={onSignIn}>{row.hasSecret ? "Sign in again" : "Sign in"}</DropdownMenuItem>}
          {row.auth === "oauth" && row.hasSecret && <DropdownMenuItem onSelect={onSignOut}>Sign out</DropdownMenuItem>}
          {(!shared || row.auth === "bearer" || row.auth === "headers") && <DropdownMenuItem onSelect={onEdit}>{shared ? (row.auth === "bearer" ? "Set your token" : "Set your headers") : "Edit"}</DropdownMenuItem>}
          <DropdownMenuItem onSelect={onCheck}>Check again</DropdownMenuItem>
          {shared && <DropdownMenuItem onSelect={() => onSetOff(!row.off)}>{row.off ? "Turn on for me" : "Turn off for me"}</DropdownMenuItem>}
          {canRemove && <><DropdownMenuSeparator /><DropdownMenuItem className="text-destructive" onSelect={onRemove}>{shared ? "Remove for everyone" : "Remove"}</DropdownMenuItem></>}
        </DropdownMenuContent>
      </DropdownMenu>
    </td>
  </tr>;
}

function RecommendedIcon({ server }: { server: RecommendedServer }) {
  const Icon = ICONS[server.icon] ?? Server;
  return <span className="grid size-8 shrink-0 place-items-center rounded-md bg-veil-strong"><Icon aria-hidden className={cn("size-4", server.tint)} /></span>;
}

function Card({ icon, title, text, action }: { icon: ReactNode; title: string; text: ReactNode; action: ReactNode }) {
  return <div role="group" aria-label={title} className="flex min-h-[4.5rem] items-center gap-3 rounded-lg border border-hairline px-3 py-2.5">
    {icon}
    <div className="min-w-0 flex-1">
      <p className="line-clamp-2 text-[13px] font-medium leading-[18px]">{title}</p>
      <p className="line-clamp-2 text-xs text-muted-foreground">{text}</p>
    </div>
    <div className="shrink-0">{action}</div>
  </div>;
}

function Added() {
  return <span className="flex items-center gap-1 text-xs text-add"><Check aria-hidden className="size-3.5" />Added</span>;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function Recommended({ servers, busy, onAdd, onImported }: { servers: McpServerRow[]; busy: boolean; onAdd: (server?: RecommendedServer) => void; onImported: (listing: McpListing, notice: string) => void }) {
  const [query, setQuery] = useState("");
  const [scan, setScan] = useState<McpImportScan | null>(null);
  const [importing, setImporting] = useState(false);
  const look = useCallback(() => { mcp.importScan().then(setScan, (e) => showError("Couldn't read this Mac's agent settings", e)); }, []);
  useEffect(look, [look]);
  const shown = RECOMMENDED.filter((server) => matchesServer({ name: `${server.title} ${server.description}`, target: server.target }, query));
  const sources = scan ? ([["claudeCode", "Claude Code", scan.claudeCode], ["codex", "Codex", scan.codex]] as const) : [];
  const found = sources.filter(([, , source]) => source.files.some((file) => (file.count ?? 0) > 0));
  const importFrom = (agent: "claudeCode" | "codex") => {
    setImporting(true);
    mcp.import(agent).then((result) => {
      const left = result.skipped.map(([name, why]) => `${name} (${why})`).join(", ");
      onImported(result.listing, `${result.added.length ? `Imported ${plural(result.added.length, "server")}.` : "Nothing new to import."}${left ? ` Left where they were: ${left}.` : ""}`);
    }, (e) => showError("Couldn't import MCP servers", e)).finally(() => setImporting(false));
  };
  const allFiles = sources.flatMap(([, , source]) => source.files);
  return <>
    {scan && found.length === 0 && <div className="flex items-start gap-3 rounded-lg border border-dashed border-hairline-strong p-4">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-veil-strong"><SearchX aria-hidden className="size-4 text-muted-foreground" /></span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">No MCP servers found in {allFiles.filter((f) => !f.path.endsWith("settings.json")).map((f) => f.path).join(" or ")}</p>
        <p className="mt-1 text-xs text-muted-foreground">Claude Code and Codex on this Mac don’t use any MCP servers yet, so there is nothing to bring over. Add one below, or by URL or command.</p>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {allFiles.map((file) => <li key={file.path} className="flex items-center gap-1.5"><Check aria-hidden className="size-3" /><span className="font-mono">{file.path}</span> · no servers</li>)}
        </ul>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="ghost" onClick={look}><RefreshCw aria-hidden />Look again</Button>
        <Button size="sm" disabled={busy} onClick={() => onAdd()}><Plus aria-hidden />Add MCP server</Button>
      </div>
    </div>}
    <SearchField value={query} onChange={setQuery} placeholder="Search recommended servers" />
    <div className="grid grid-cols-1 gap-2.5 @lg:grid-cols-2 @3xl:grid-cols-3 sm:grid-cols-2 lg:grid-cols-3">
      {!query.trim() && found.map(([agent, label, source]) => {
        const total = source.files.reduce((sum, file) => sum + (file.count ?? 0), 0);
        const where = source.files.filter((file) => (file.count ?? 0) > 0).map((file) => file.path).join(" and ");
        return <Card key={agent} icon={<span className="grid size-8 shrink-0 place-items-center rounded-md bg-veil-strong"><Download aria-hidden className="size-4 text-muted-foreground" /></span>}
          title={`Import from ${label}`} text={`${plural(total, "server")} in ${where}`}
          action={source.new.length === 0 ? <Added /> : <Button size="sm" variant="outline" disabled={busy || importing} onClick={() => importFrom(agent)}>Import</Button>} />;
      })}
      {shown.map((server) => <Card key={server.name} icon={<RecommendedIcon server={server} />} title={server.title} text={server.description}
        action={recommendedAdded(server, servers) ? <Added /> : <Button size="sm" variant="outline" disabled={busy} onClick={() => onAdd(server)}><Plus aria-hidden />Add</Button>} />)}
    </div>
    {shown.length === 0 && <p className="text-sm text-muted-foreground">No recommended servers match “{query.trim()}”.</p>}
  </>;
}
