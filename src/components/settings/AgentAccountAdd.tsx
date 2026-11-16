import { useState, type ReactNode } from "react";
import { Eye, EyeOff, KeyRound, Loader2, SquareTerminal } from "@/icons";
import { Button } from "@/components/ui/button";
import { agentAccounts, type AgentAccount, type AgentAccountAgent, type AgentAccounts } from "@/lib/agentAccounts";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { SignInProgress, signInMessage, useAccountSignIn } from "./AgentAccountSignIn";

/** What adding an account of each agent says, per kind. */
const SUBSCRIPTION: Record<AgentAccountAgent, { title: string; how: string }> = {
  claude: { title: "Claude subscription", how: "Claude Code signs in with claude.ai in your browser, into a folder of its own. This Mac's login stays as it is." },
  codex: { title: "ChatGPT", how: "Codex signs in with ChatGPT using a code you enter in your browser, into a folder of its own. This Mac's login stays as it is." },
};
const KEY_LABEL: Record<AgentAccountAgent, string> = { claude: "Anthropic API key", codex: "OpenAI API key" };
const KEY_PLACEHOLDER: Record<AgentAccountAgent, string> = { claude: "sk-ant-…", codex: "sk-proj-…" };

export const CONSOLE_NOTE = "A Claude Console sign-in without an API key cannot be a second account: Claude Code keeps it outside the account's folder. Make a key in the Console and add it as an API key instead.";
export const MCP_NOTE = "Every account gets your MCP servers, but not their OAuth sign-ins: sign in to such a server again in a tab on that account.";

/** Add account (#980): the agent's own sign-in into a new folder, or another API key. */
export function AgentAccountAdd({ harness, agentName, onAdded, onClose }: {
  harness: AgentAccountAgent;
  agentName: string;
  /** A new account is listed; `view` is the list it came back with, when the command returned one. */
  onAdded: (account: AgentAccount | null, view: AgentAccounts | null) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<"subscription" | "apiKey">("subscription");
  const [message, setMessage] = useState<{ tone: "ok" | "problem"; text: string } | null>(null);
  const signIn = useAccountSignIn();
  const subscription = SUBSCRIPTION[harness];

  const start = async () => {
    setMessage(null);
    try {
      const end = await signIn.begin(() => agentAccounts.addStart(harness));
      if (end.status === "added") { onAdded(end.account, null); return; }
      setMessage(signInMessage(end, agentName));
    } catch (e) {
      setMessage({ tone: "problem", text: errorMessage(e) });
    }
  };

  return <div role="region" aria-label={`Add a ${agentName} account`} className="mt-2 rounded-lg border border-hairline p-3">
    <div role="radiogroup" aria-label="Kind of account" className="flex gap-1.5">
      <KindButton on={kind === "subscription"} disabled={signIn.busy} onSelect={() => { setKind("subscription"); setMessage(null); }}><SquareTerminal />{subscription.title}</KindButton>
      <KindButton on={kind === "apiKey"} disabled={signIn.busy} onSelect={() => { setKind("apiKey"); setMessage(null); }}><KeyRound />API key</KindButton>
    </div>
    {kind === "subscription" ? <div className="mt-2.5">
      <p className="text-[12.5px] text-muted-foreground">{subscription.how}</p>
      {harness === "claude" && <p className="mt-1.5 text-[12px] text-faint">{CONSOLE_NOTE}</p>}
      {signIn.busy
        ? <SignInProgress started={signIn.started} agentName={agentName} onCancel={signIn.cancel} />
        : <div className="mt-2.5 flex gap-1.5">
          <Button size="sm" variant="outline" className="whitespace-nowrap" onClick={() => void start()}>Sign in</Button>
          <Button size="sm" variant="ghost" className="whitespace-nowrap" onClick={onClose}>Cancel</Button>
        </div>}
    </div> : <KeyForm harness={harness} agentName={agentName} onAdded={(view) => onAdded(null, view)} onClose={onClose} />}
    {message && <p role={message.tone === "problem" ? "alert" : "status"} className={cn("mt-2 text-[12px]", message.tone === "problem" ? "text-destructive" : "text-add")}>{message.text}</p>}
    {harness === "claude" && <p className="mt-2 text-[12px] text-faint">{MCP_NOTE}</p>}
  </div>;
}

function KindButton({ on, disabled, onSelect, children }: { on: boolean; disabled: boolean; onSelect: () => void; children: ReactNode }) {
  return <button type="button" role="radio" aria-checked={on} disabled={disabled} onClick={onSelect}
    className={cn("inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default [&_svg]:size-3.5",
      on ? "border-accent/60 bg-accent/5 text-foreground" : "border-hairline text-muted-foreground hover:bg-veil-card")}>
    {children}
  </button>;
}

/** Another API key, its own Keychain item: the key goes to the app once and never comes back. */
function KeyForm({ harness, agentName, onAdded, onClose }: { harness: AgentAccountAgent; agentName: string; onAdded: (view: AgentAccounts) => void; onClose: () => void }) {
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [shown, setShown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!key.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const view = await agentAccounts.addKey(harness, key, label.trim() || null);
      setKey("");
      onAdded(view);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return <div className="mt-2.5 grid gap-2">
    <div className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-hairline bg-card px-2.5 focus-within:ring-2 focus-within:ring-ring/40">
      <input aria-label={KEY_LABEL[harness]} type={shown ? "text" : "password"} value={key} autoComplete="off" spellCheck={false} placeholder={KEY_PLACEHOLDER[harness]}
        onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
        className="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-faint" />
      <button type="button" aria-label={shown ? "Hide the key" : "Show the key"} onClick={() => setShown(!shown)} className="text-faint hover:text-foreground">
        {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </div>
    <input aria-label="Label (optional)" value={label} maxLength={60} placeholder="Label, such as Work key" onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
      className="h-8 min-w-0 rounded-md border border-hairline bg-card px-2.5 text-[12.5px] outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/40" />
    <p className="text-[12px] text-faint">Kept in the Keychain as an account of its own. {agentName} gets it only in tabs started on this account.</p>
    <div className="flex gap-1.5">
      <Button size="sm" variant="outline" className="whitespace-nowrap" disabled={saving || !key.trim()} onClick={() => void save()}>
        {saving ? <Loader2 className="animate-spin" /> : null} Add key
      </Button>
      <Button size="sm" variant="ghost" className="whitespace-nowrap" disabled={saving} onClick={onClose}>Cancel</Button>
    </div>
    {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
  </div>;
}
