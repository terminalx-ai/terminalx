import { useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, ChevronsUpDown, Copy, Eye, EyeOff } from "@/icons";
import { Button } from "@/components/ui/button";
import { Checkbox, Segmented } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { AUTH_LABELS, isUrlTarget, mcp, nameError, parseHeaders, type McpAgents, type McpAuth, type McpListing, type McpServerInput, type McpServerRow, type RecommendedServer } from "@/lib/mcpServers";

export type McpDialogRequest = { kind: "add"; recommended?: RecommendedServer } | { kind: "edit"; row: McpServerRow };

const field = "h-8 w-full rounded-md border border-hairline bg-background px-2.5 font-mono text-[12.5px] outline-none placeholder:text-faint focus:ring-2 focus:ring-ring/40 disabled:opacity-60";
const label = "text-[12.5px] font-medium";
const AUTH_HINTS: Record<McpAuth, string | null> = { oauth: "Sign in with the server in your browser", bearer: "Stored in the Keychain", headers: "One header per line", none: null };
const AUTH_ORDER: McpAuth[] = ["oauth", "bearer", "headers", "none"];

/** Add MCP server (designs 10.11, 10.12), and the same form to edit one. */
export function McpServerDialog({ request, callbackUrl, organizations, orgName, onClose, onSaved }: {
  request: McpDialogRequest;
  callbackUrl: string;
  /** Organizations this person can share a server with. */
  organizations: { id: string; name: string }[];
  orgName: (id: string) => string;
  onClose: () => void;
  onSaved: (listing: McpListing, key: string | null) => void;
}) {
  const row = request.kind === "edit" ? request.row : null;
  const preset = request.kind === "add" ? request.recommended : undefined;
  const shared = row?.sharedBy ?? null;
  const [name, setName] = useState(row?.name ?? preset?.name ?? "");
  const [target, setTarget] = useState(row?.target ?? preset?.target ?? "");
  const [auth, setAuth] = useState<McpAuth>(row?.auth ?? preset?.auth ?? "oauth");
  const [token, setToken] = useState("");
  const [headers, setHeaders] = useState("");
  const [agents, setAgents] = useState<McpAgents>(row?.agents ?? { claudeCode: true, codex: true });
  const [scope, setScope] = useState<string>("me");
  const [advanced, setAdvanced] = useState(!!row?.clientId);
  const [clientId, setClientId] = useState(row?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const url = isUrlTarget(target);
  const kind: McpAuth = url ? auth : "none";
  const fixed = shared !== null;
  const keeps = row !== null && row.hasSecret && row.auth === kind;
  const parsed = kind === "headers" && headers.trim() ? parseHeaders(headers) : null;
  const problem = nameError(name.trim())
    ?? (!target.trim() ? "Enter a URL or a command." : null)
    ?? (!agents.claudeCode && !agents.codex ? "Install it for Claude Code, Codex or both." : null)
    ?? (kind === "headers" && !keeps && !parsed ? "Add one header per line, as Name: value." : null)
    ?? parsed?.error
    ?? (kind === "oauth" && advanced && !clientId.trim() && clientSecret ? "Enter the client ID." : null);

  const save = async () => {
    if (problem || saving) { setError(problem); return; }
    setSaving(true); setError(null);
    const input: McpServerInput = {
      key: row?.key,
      name: name.trim(),
      target: target.trim(),
      auth: kind,
      headerNames: kind === "headers" ? (parsed ? parsed.names : row?.headerNames ?? []) : [],
      agents,
      organization: row === null && scope !== "me" && url ? scope : null,
      clientId: kind === "oauth" && advanced && clientId.trim() ? clientId.trim() : null,
      secret: {
        token: kind === "bearer" && token.trim() ? token.trim() : undefined,
        headerValues: parsed && !parsed.error ? parsed.values : undefined,
        clientSecret: kind === "oauth" && advanced && clientSecret ? clientSecret : undefined,
      },
    };
    try {
      onSaved(await mcp.save(input), row?.key ?? null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent width="max-w-[32rem]" className="p-0" onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); } }}>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="flex flex-col gap-4 px-5 pt-5">
          <div>
            <DialogTitle className="text-[15px] font-semibold">{row ? (fixed ? row.name : "Edit MCP server") : "Add MCP server"}</DialogTitle>
            <DialogDescription className="mt-1 text-[12.5px] text-muted-foreground">
              {fixed ? `Shared by ${orgName(shared)}. Your ${kind === "headers" ? "header values stay" : "token stays"} on this Mac.` : "Remote servers by URL, or a local command such as npx or uvx."}
            </DialogDescription>
          </div>
          <Field label="Name"><input aria-label="Name" className={field} value={name} disabled={fixed} autoFocus={!row} spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="URL or command"><input aria-label="URL or command" className={field} value={target} disabled={fixed} placeholder="https://… or npx …" spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(e) => setTarget(e.target.value)} /></Field>
          {url && <Field label="Authentication"><AuthPicker value={auth} disabled={fixed} onChange={setAuth} /></Field>}
          {kind === "bearer" && <Field label="Token" hint="Stored in the Keychain, sent as Authorization: Bearer.">
            <input aria-label="Token" type="password" className={field} value={token} placeholder={keeps ? "Saved · paste to replace" : "Paste token"} spellCheck={false} autoFocus={fixed} onChange={(e) => setToken(e.target.value)} />
          </Field>}
          {kind === "headers" && <Field label="Headers">
            <textarea aria-label="Headers" rows={3} className={cn(field, "h-auto resize-none py-2 leading-5")} value={headers} spellCheck={false} autoFocus={fixed}
              placeholder={keeps ? `${(row?.headerNames ?? []).map((h) => `${h}: saved`).join("\n")}\nType all headers to replace them` : "X-Api-Key: value\nOne header per line"} onChange={(e) => setHeaders(e.target.value)} />
          </Field>}
          {kind === "oauth" && advanced && !fixed && <div className="flex flex-col gap-3 rounded-lg border border-hairline p-3">
            <button type="button" className="flex items-center gap-1 text-[12.5px] font-medium" onClick={() => setAdvanced(false)}><ChevronDown aria-hidden className="size-3.5" />Advanced client identity</button>
            <Field label="OAuth callback URL" small>
              <div className="relative"><input aria-label="OAuth callback URL" readOnly className={cn(field, "pr-8")} value={callbackUrl} /><CopyButton text={callbackUrl} /></div>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Client ID" small><input aria-label="Client ID" className={field} value={clientId} spellCheck={false} onChange={(e) => setClientId(e.target.value)} /></Field>
              <Field label="Client secret" small>
                <div className="relative">
                  <input aria-label="Client secret" type={revealed ? "text" : "password"} className={cn(field, "pr-8")} value={clientSecret} placeholder={row?.clientId ? "Saved · type to replace" : "Optional"} spellCheck={false} onChange={(e) => setClientSecret(e.target.value)} />
                  <button type="button" aria-label={revealed ? "Hide client secret" : "Show client secret"} className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-foreground" onClick={() => setRevealed(!revealed)}>{revealed ? <EyeOff aria-hidden className="size-3.5" /> : <Eye aria-hidden className="size-3.5" />}</button>
                </div>
              </Field>
            </div>
          </div>}
          {!fixed && <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px]">
            <span className="font-medium">Install for</span>
            <Checkbox label="Claude Code" checked={agents.claudeCode} onChange={(on) => setAgents({ ...agents, claudeCode: on })}><span className="text-[12.5px] text-foreground">Claude Code</span></Checkbox>
            <Checkbox label="Codex" checked={agents.codex} onChange={(on) => setAgents({ ...agents, codex: on })}><span className="text-[12.5px] text-foreground">Codex</span></Checkbox>
            {row === null && organizations.length > 0 && <Segmented aria-label="Who it is for" className="ml-auto" value={url ? scope : "me"} onChange={setScope}
              options={[{ value: "me", label: "Just me" }, ...organizations.map((org) => ({ value: org.id, label: org.name, disabled: !url, title: url ? `Installed for everyone in ${org.name}` : "Only a URL server can be shared" }))]} />}
          </div>}
          {error && <p role="alert" className="text-[12.5px] text-destructive">{error}</p>}
        </div>
        <div className="mt-4 flex items-center gap-2 border-t border-hairline px-5 py-3">
          {kind === "oauth" && !advanced && !fixed && <button type="button" className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setAdvanced(true)}><ChevronRight aria-hidden className="size-3.5" />Advanced client identity</button>}
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
            <Button size="sm" type="submit" disabled={saving}>Save<kbd aria-hidden className="ml-0.5 font-sans text-[10.5px] opacity-70">⌘↵</kbd></Button>
          </div>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

function Field({ label: text, hint, small, children }: { label: string; hint?: string; small?: boolean; children: ReactNode }) {
  return <div className="flex flex-col gap-1.5">
    <span className={small ? "text-[11.5px] text-muted-foreground" : label}>{text}</span>
    {children}
    {hint && <span className="text-[11.5px] text-muted-foreground">{hint}</span>}
  </div>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" aria-label="Copy callback URL" className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-foreground"
    onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}>
    {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
  </button>;
}

/** A select whose options say what each means (design 10.11). */
function AuthPicker({ value, disabled, onChange }: { value: McpAuth; disabled?: boolean; onChange: (auth: McpAuth) => void }) {
  return <DropdownMenu>
    <DropdownMenuTrigger asChild disabled={disabled}>
      <button type="button" aria-label="Authentication" className={cn(field, "flex items-center justify-between font-sans text-[13px] data-[state=open]:ring-2 data-[state=open]:ring-accent/50")}>
        {AUTH_LABELS[value]}<ChevronsUpDown aria-hidden className="size-3.5 text-faint" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
      {AUTH_ORDER.map((auth) => <DropdownMenuItem key={auth} onSelect={() => onChange(auth)} className="items-start py-1.5">
        <div className="min-w-0 flex-1">
          <div>{AUTH_LABELS[auth]}</div>
          {AUTH_HINTS[auth] && <div className="mt-0.5 text-[11.5px] text-faint">{AUTH_HINTS[auth]}</div>}
        </div>
        {auth === value && <Check aria-hidden className="size-3.5 self-center text-accent" />}
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}
