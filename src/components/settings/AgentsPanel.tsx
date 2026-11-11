import { useCallback, useEffect, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ChevronRight, CircleAlert, CircleCheck, ExternalLink, Eye, EyeOff, KeyRound, Loader2, RefreshCw, ServerCog, SquareTerminal, Terminal, Trash2 } from "@/icons";
import { AgentMark } from "@/components/AgentMark";
import { AgentSetup } from "@/components/session/AgentSetup";
import { Button } from "@/components/ui/button";
import { useAgentReadiness, type AgentReadiness } from "@/lib/agentReadiness";
import { setupActive, useAgentSetupFlow, type AgentSetupFlow } from "@/lib/agentSetupFlow";
import {
  agentLogins, keepLine, KEY_PAGES, showAgentLoginNotice, tabsKeepingOlderLogin, takesApiKey, useAgentLogin,
  type AgentLoginStatus, type ShellKeyOffer,
} from "@/lib/agentLogins";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { refreshHarnesses } from "@/lib/sessions";
import type { HarnessInfo } from "@/types/session";

const BADGES: Record<AgentReadiness["state"], string> = {
  missing: "Not installed",
  signed_out: "Sign in required",
  ready: "Signed in",
  unknown: "Login not checked",
};

/** The badge while a setup run is under way or has stopped (PRO-152). */
function runBadge(flow: AgentSetupFlow): string {
  if (flow.phase === "running") return flow.step === "install" ? "Installing…" : "Signing in…";
  if (flow.phase === "checking") return "Checking…";
  return "Setup did not finish";
}

const PLANS: Record<string, string> = {
  free: "Free", pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise", plus: "Plus", business: "Business", edu: "Edu", go: "Go", api: "API",
};

/** "Claude Max", "ChatGPT Pro": the subscription a ready login is on, as far as the CLI says. */
function subscriptionName(harness: string, readiness: AgentReadiness | null): string | null {
  if (readiness?.state !== "ready") return null;
  if (readiness.loginMethod === "API key") return "API key";
  const brand = harness === "claude" ? "Claude" : harness === "codex" ? "ChatGPT" : null;
  const plan = readiness.plan ? PLANS[readiness.plan] : null;
  if (!brand) return readiness.loginMethod ?? null;
  return plan ? `${brand} ${plan}` : `${brand} account`;
}

/** What the subscription choice is called for each agent that has one. */
const SUBSCRIPTION: Record<string, { title: string; hint: string; again: string; short: string }> = {
  claude: { title: "Claude subscription", hint: "claude /login", again: "your Claude login", short: "your Claude subscription" },
  codex: { title: "ChatGPT", hint: "codex login", again: "your ChatGPT login", short: "ChatGPT" },
};

const KEY_LABEL: Record<string, string> = { claude: "Anthropic API key", codex: "OpenAI API key" };
const KEY_PLACEHOLDER: Record<string, string> = { claude: "sk-ant-…", codex: "sk-proj-…" };

function relative(at: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `at ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function shortPath(path: string | undefined): string | undefined {
  const home = path?.match(/^\/Users\/[^/]+|^\/home\/[^/]+/)?.[0];
  return home && path ? `~${path.slice(home.length)}` : path;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** The agents TerminalX runs on this Mac, one tab each: install, sign-in, and which login new tabs use (PRO-306). */
export function AgentsPanel({ harnesses, checkRun, busy, onRecheck }: {
  harnesses: HarnessInfo[];
  checkRun: number;
  busy: boolean;
  onRecheck: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<Record<string, { value: AgentReadiness | null; checking: boolean; refresh: () => Promise<unknown> }>>({});
  const [logins, setLogins] = useState<Record<string, AgentLoginStatus | null>>({});
  const heard = useCallback((id: string, value: AgentReadiness | null, checking: boolean, refresh: () => Promise<unknown>) => {
    setReadiness((before) => before[id]?.value === value && before[id]?.checking === checking && before[id]?.refresh === refresh ? before : { ...before, [id]: { value, checking, refresh } });
  }, []);
  const loginHeard = useCallback((id: string, status: AgentLoginStatus | null) => setLogins((before) => before[id] === status ? before : { ...before, [id]: status }), []);
  const current = harnesses.find((harness) => harness.id === selected) ?? harnesses[0];
  if (!current) return <p className="text-xs text-faint">Looking for agents…</p>;
  return <div>
    {harnesses.map((harness) => <Probe key={`${harness.id}:${checkRun}`} id={harness.id} onChange={heard} />)}
    <div className="mt-3 flex items-center border-b border-hairline">
      <div role="tablist" aria-label="Agents" className="flex min-w-0 items-center overflow-x-auto">
        {harnesses.map((harness) => <AgentTabButton key={harness.id} harness={harness} selected={harness.id === current.id}
          readiness={readiness[harness.id]} login={logins[harness.id] ?? null} onSelect={() => setSelected(harness.id)} />)}
      </div>
      <div className="ml-auto shrink-0 pb-1 pl-3">
        <Button size="xs" variant="ghost" disabled={busy} onClick={onRecheck}>
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} Re-check
        </Button>
      </div>
    </div>
    <div role="tabpanel" aria-label={current.name} key={`${current.id}:${checkRun}`}>
      <AgentTab harness={current} readiness={readiness[current.id]} onLogin={loginHeard} />
    </div>
  </div>;
}

/** One readiness probe per agent, shared by its tab and its badge. */
function Probe({ id, onChange }: { id: string; onChange: (id: string, value: AgentReadiness | null, checking: boolean, refresh: () => Promise<unknown>) => void }) {
  const { value, checking, refresh } = useAgentReadiness(id, true);
  useEffect(() => { onChange(id, value, checking, refresh); }, [id, value, checking, refresh, onChange]);
  return null;
}

function AgentTabButton({ harness, selected, readiness, login, onSelect }: {
  harness: HarnessInfo;
  selected: boolean;
  readiness?: { value: AgentReadiness | null; checking: boolean };
  login: AgentLoginStatus | null;
  onSelect: () => void;
}) {
  const flow = useAgentSetupFlow(harness.id);
  const run = setupActive(flow) ? flow : null;
  const usingKey = login?.mode === "api_key" && !!login.saved;
  const ready = !run && (usingKey ? login.verified?.ok !== false && !login.problem : readiness?.value?.state === "ready");
  const busy = readiness?.checking || run?.phase === "running" || run?.phase === "checking";
  const state = run ? runBadge(run) : busy ? "Checking…" : usingKey ? "Using an API key" : BADGES[readiness?.value?.state ?? "unknown"];
  return <button type="button" role="tab" aria-selected={selected} aria-label={`${harness.name}: ${state}`} title={state} onClick={onSelect}
    className={cn("mr-5 flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
      selected ? "border-accent font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
    <AgentMark id={harness.id} className="size-3.5" decorative />
    {harness.name}
    {busy ? <Loader2 aria-hidden className="size-3 animate-spin text-faint" /> : ready ? <Check aria-hidden className="size-3 text-add" /> : <CircleAlert aria-hidden className="size-3 text-faint" />}
  </button>;
}

function AgentTab({ harness, readiness, onLogin }: {
  harness: HarnessInfo;
  readiness?: { value: AgentReadiness | null; checking: boolean; refresh: () => Promise<unknown> };
  onLogin: (id: string, status: AgentLoginStatus | null) => void;
}) {
  const value = readiness?.value ?? null;
  const checking = readiness?.checking ?? true;
  const recheck = () => { void refreshHarnesses().then(() => readiness?.refresh()).catch(() => readiness?.refresh()); };
  if (takesApiKey(harness.id)) return <KeyedAgent harness={harness} readiness={value} checking={checking} refresh={readiness?.refresh} recheck={recheck} onLogin={onLogin} />;
  return <div>
    <StatusLine dot={value?.state === "ready" ? "ok" : checking ? "busy" : "off"} onRefresh={recheck} refreshing={checking}>
      {checking ? "Checking…" : BADGES[value?.state ?? "unknown"]}
    </StatusLine>
    <Details rows={[
      ["Version", value?.version ?? null],
      ["Login", value?.state === "ready" ? (value.loginMethod ?? "Local login found") : null],
      ["Executable", harness.path ? <Mono>{shortPath(harness.path)}</Mono> : null],
    ]} />
    {value?.state !== "ready" && <div className="mt-3"><AgentSetup harness={harness} value={value} checking={checking} onRefresh={recheck} headless /></div>}
  </div>;
}

/** Claude Code and Codex: a subscription login or an API key kept in the Keychain. */
function KeyedAgent({ harness, readiness, checking, refresh, recheck, onLogin }: {
  harness: HarnessInfo;
  readiness: AgentReadiness | null;
  checking: boolean;
  refresh?: () => Promise<unknown>;
  recheck: () => void;
  onLogin: (id: string, status: AgentLoginStatus | null) => void;
}) {
  const login = useAgentLogin(harness.id);
  const status = login.status;
  const flow = useAgentSetupFlow(harness.id);
  const [choice, setChoice] = useState<"subscription" | "api_key" | null>(null);
  const [offer, setOffer] = useState<ShellKeyOffer | null>(null);
  const [busy, setBusy] = useState<"save" | "remove" | "import" | "mode" | "verify" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { onLogin(harness.id, status); }, [harness.id, status, onLogin]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  // The login shell is asked once the page knows there is no key saved here.
  const saved = status?.saved;
  useEffect(() => {
    if (!status || saved) { setOffer(null); return; }
    let live = true;
    agentLogins.shellOffer(harness.id).then((found) => live && setOffer(found)).catch(() => live && setOffer(null));
    return () => { live = false; };
  }, [harness.id, status, saved]);
  const chosen = choice ?? (status?.mode === "api_key" && saved ? "api_key" : "subscription");
  const usingKey = status?.mode === "api_key" && !!saved;
  const subscription = SUBSCRIPTION[harness.id];

  const act = async <T,>(what: NonNullable<typeof busy>, work: () => Promise<T>): Promise<T | null> => {
    setBusy(what);
    setError(null);
    try { return await work(); }
    catch (e) { setError(errorMessage(e)); return null; }
    finally { setBusy(null); }
  };
  const verify = async () => {
    const result = await act("verify", () => agentLogins.verify(harness.id));
    if (result) await login.refresh();
  };
  const saveKey = async (key: string) => {
    const next = await act("save", () => agentLogins.saveKey(harness.id, key));
    if (!next) return false;
    login.take(next);
    setChoice(null);
    const stale = await tabsKeepingOlderLogin(harness.id);
    showAgentLoginNotice({
      harness: harness.id, kind: "saved", stale,
      title: "API key saved to the Keychain",
      body: [`New ${harness.name} tabs use it.`, keepLine(stale.length)].filter(Boolean).join(" "),
    });
    void verify();
    return true;
  };
  const importKey = async () => {
    const next = await act("import", () => agentLogins.importShell(harness.id));
    if (!next) return;
    login.take(next);
    setChoice(null);
    const stale = await tabsKeepingOlderLogin(harness.id);
    showAgentLoginNotice({
      harness: harness.id, kind: "imported", stale,
      title: `Imported ${next.variable} from your shell environment`,
      body: [`${harness.name} uses it in new tabs. Switch back to ${subscription.short} any time.`, keepLine(stale.length)].filter(Boolean).join(" "),
    });
    void verify();
  };
  const removeKey = async () => {
    const next = await act("remove", () => agentLogins.removeKey(harness.id));
    if (!next) return;
    login.take(next);
    setChoice(null);
    const [after, stale] = await Promise.all([refresh?.() as Promise<AgentReadiness | null> | undefined, tabsKeepingOlderLogin(harness.id)]);
    const name = subscriptionName(harness.id, after ?? null);
    const signedIn = after?.state === "ready";
    showAgentLoginNotice({
      harness: harness.id, kind: "removed", stale,
      title: signedIn ? `API key removed · ${harness.name} uses ${subscription.again} again` : `API key removed · ${harness.name} needs a sign-in`,
      body: [
        signedIn
          ? `Deleted from the Keychain. New tabs sign in with ${[name, after?.account].filter(Boolean).length === 2 ? `${name} (${after?.account})` : name ?? subscription.again}.`
          : `Deleted from the Keychain. Sign in to ${harness.name} below to start new tabs.`,
        keepLine(stale.length),
      ].filter(Boolean).join(" "),
    });
  };
  const choose = async (mode: "subscription" | "api_key") => {
    if (mode === chosen) return;
    if (mode === "api_key" && !saved) { setChoice("api_key"); return; }
    setChoice(null);
    const next = await act("mode", () => agentLogins.setMode(harness.id, mode));
    if (next) login.take(next);
  };
  const dismissOffer = async () => {
    await act("import", () => agentLogins.dismissShell(harness.id));
    setOffer(null);
  };

  const keyField = <KeyField harness={harness} status={status} busy={busy} onSave={saveKey} onRemove={() => void removeKey()} />;
  const shellNote = saved?.fromShell ? <ShellNote>
    Found in your login shell{saved.fromShell.file ? <> (<span className="font-mono text-[11px]">{saved.fromShell.file}</span>)</> : null}. A copy is now in the Keychain, so it works without {saved.fromShell.file ? "that file" : "it"}.
  </ShellNote> : null;
  const offerNote = offer && !saved ? <div className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-faint">
    <ShellBadge />
    <span className="min-w-0">Found <span className="font-mono text-[11px]">{offer.variable}</span> in your login shell{offer.file ? <> (<span className="font-mono text-[11px]">{offer.file}</span>)</> : null}. Copy it to the Keychain so new tabs use it without that file?</span>
    <span className="flex gap-1.5">
      <Button size="xs" variant="outline" className="shrink-0 whitespace-nowrap" disabled={!!busy} onClick={() => void importKey()}>
        {busy === "import" ? <Loader2 className="animate-spin" /> : null} Import to the Keychain
      </Button>
      <Button size="xs" variant="ghost" className="shrink-0 whitespace-nowrap" disabled={!!busy} onClick={() => void dismissOffer()}>Not now</Button>
    </span>
  </div> : null;

  const statusLine = usingKey ? <KeyStatus status={status!} verifying={busy === "verify"} now={now} />
    : flow && setupActive(flow) ? runBadge(flow) : checking ? "Checking…" : BADGES[readiness?.state ?? "unknown"];
  const dot = usingKey
    ? (status?.problem || status?.verified?.ok === false ? "bad" : status?.verified?.ok ? "ok" : "busy")
    : readiness?.state === "ready" ? "ok" : checking ? "busy" : "off";
  const loginRow = usingKey
    ? <>API key · {status!.variable} <span className="text-faint">· Keychain{status?.baseUrl ? ` · ${hostOf(status.baseUrl)}` : ""}</span></>
    : readiness?.state === "ready" ? [subscriptionName(harness.id, readiness), readiness.account].filter(Boolean).join(" · ") || "Local login found"
    : readiness?.state === "signed_out" ? "None · sign in required" : null;
  const needsSetup = !usingKey && (readiness?.state === "missing" || readiness?.state === "signed_out" || readiness?.state === "unknown" || setupActive(flow));

  return <div>
    {harness.id === "codex"
      ? <CodexChoice harness={harness} status={status} readiness={readiness} chosen={chosen} onChoose={(mode) => void choose(mode)} busy={busy}
          keyArea={<>{keyField}{shellNote}</>} onBaseUrl={async (url) => { const next = await act("mode", () => agentLogins.setBaseUrl(harness.id, url)); if (next) { login.take(next); if (next.saved) void verify(); } return !!next; }} />
      : <>
        <div className="mt-4 text-[12.5px] font-medium" id={`${harness.id}-sign-in`}>Sign-in</div>
        <div role="radiogroup" aria-labelledby={`${harness.id}-sign-in`} className="mt-2 grid grid-cols-2 gap-2.5">
          <ChoiceCard selected={chosen === "subscription"} icon={<SquareTerminal />} title={subscription.title} hint={subscription.hint} disabled={!!busy} onSelect={() => void choose("subscription")} />
          <ChoiceCard selected={chosen === "api_key"} icon={<KeyRound />} title="API key" hint={status?.variable ?? "ANTHROPIC_API_KEY"} disabled={!!busy} onSelect={() => void choose("api_key")} />
        </div>
        {chosen === "api_key" && <div className="mt-3">
          <div className="mb-1.5 flex items-center text-[12px] font-medium">
            {KEY_LABEL[harness.id]}
            <GetKey harness={harness.id} label="Get a key" />
          </div>
          {keyField}
          <p className="mt-1 text-[11.5px] text-faint">Kept in the Keychain. TerminalX passes it to {harness.name} when a tab starts, in place of {status?.variable ?? "ANTHROPIC_API_KEY"}.</p>
          {shellNote}
        </div>}
      </>}
    {offerNote}
    {(error || login.error) && <p role="alert" className="mt-2 text-xs text-destructive">{error ?? login.error}</p>}
    <StatusLine dot={dot} onRefresh={() => { recheck(); if (usingKey) void verify(); }} refreshing={checking || busy === "verify"}>{statusLine}</StatusLine>
    <Details rows={[
      ["Version", readiness?.version ?? null],
      ...(harness.id === "codex" ? [] : [["Login", loginRow] as [string, ReactNode]]),
      ...(harness.id === "claude" && !usingKey && readiness?.organization ? [["Organization", readiness.organization] as [string, ReactNode]] : []),
      ...(harness.id === "codex" && status?.config ? [["Config", <Mono key="config">{status.config}</Mono>] as [string, ReactNode]] : []),
      ["Executable", harness.path ? <Mono>{shortPath(harness.path)}</Mono> : null],
    ]} />
    {needsSetup && <div className="mt-3"><AgentSetup harness={harness} value={readiness} checking={checking} onRefresh={recheck} headless /></div>}
  </div>;
}

function KeyStatus({ status, verifying, now }: { status: AgentLoginStatus; verifying: boolean; now: number }) {
  if (status.problem) return <>Using an API key · {status.problem}</>;
  if (verifying) return <>Using an API key · checking…</>;
  if (!status.verified) return <>Using an API key · not checked yet</>;
  if (status.verified.ok) return <>Using an API key · verified {relative(status.verified.checkedAt, now)}</>;
  return <>Using an API key · not verified: {status.verified.reason ?? "the provider did not accept it"}</>;
}

function KeyField({ harness, status, busy, onSave, onRemove }: {
  harness: HarnessInfo;
  status: AgentLoginStatus | null;
  busy: string | null;
  onSave: (key: string) => Promise<boolean>;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [shown, setShown] = useState(false);
  const saved = status?.saved;
  if (saved) {
    return <div className="flex gap-2">
      <div aria-label={`Saved ${KEY_LABEL[harness.id]}`} className="flex h-8 min-w-0 flex-1 items-center rounded-md border border-hairline bg-card px-2.5">
        <span className="truncate font-mono text-[12px]">{saved.masked}</span>
      </div>
      <span className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-muted px-3 text-[12.5px] text-add"><Check className="size-3.5" />Saved</span>
      <Button size="sm" variant="ghost" className="shrink-0 whitespace-nowrap text-muted-foreground" disabled={!!busy} onClick={onRemove}>
        {busy === "remove" ? <Loader2 className="animate-spin" /> : <Trash2 />} Remove
      </Button>
    </div>;
  }
  const save = async () => {
    if (!draft.trim()) return;
    if (await onSave(draft)) { setDraft(""); setShown(false); }
  };
  return <div className="flex gap-2">
    <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-hairline bg-card px-2.5 focus-within:ring-2 focus-within:ring-ring/40">
      <input aria-label={KEY_LABEL[harness.id]} type={shown ? "text" : "password"} value={draft} autoComplete="off" spellCheck={false}
        placeholder={KEY_PLACEHOLDER[harness.id]} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
        className="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-faint" />
      <button type="button" aria-label={shown ? "Hide the key" : "Show the key"} onClick={() => setShown(!shown)} className="text-faint hover:text-foreground">
        {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </div>
    <Button size="sm" variant="outline" className="shrink-0 whitespace-nowrap" disabled={!!busy || !draft.trim()} onClick={() => void save()}>
      {busy === "save" ? <Loader2 className="animate-spin" /> : null} Save
    </Button>
  </div>;
}

function ChoiceCard({ selected, icon, title, hint, disabled, onSelect }: { selected: boolean; icon: ReactNode; title: string; hint: string; disabled: boolean; onSelect: () => void }) {
  return <button type="button" role="radio" aria-checked={selected} disabled={disabled} onClick={onSelect}
    className={cn("relative grid h-[86px] place-items-center rounded-lg border text-center outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default",
      selected ? "border-accent/60 bg-accent/5" : "border-hairline hover:bg-veil-card")}>
    {selected && <CircleCheck aria-hidden className="absolute right-2 top-2 size-[15px] text-accent" />}
    <div>
      <span className={cn("inline-flex [&_svg]:size-[18px]", selected ? "text-foreground" : "text-muted-foreground")}>{icon}</span>
      <div className="mt-1 text-[12.5px] font-medium">{title}</div>
      <div className="text-[11px] text-faint">{hint}</div>
    </div>
  </button>;
}

/** Codex: ChatGPT, an API key, or an OpenAI-compatible endpoint of one's own, in one list. */
function CodexChoice({ harness, status, readiness, chosen, onChoose, busy, keyArea, onBaseUrl }: {
  harness: HarnessInfo;
  status: AgentLoginStatus | null;
  readiness: AgentReadiness | null;
  chosen: "subscription" | "api_key";
  onChoose: (mode: "subscription" | "api_key") => void;
  busy: string | null;
  keyArea: ReactNode;
  onBaseUrl: (url: string | null) => Promise<boolean>;
}) {
  const [custom, setCustom] = useState(false);
  const [url, setUrl] = useState(status?.baseUrl ?? "");
  useEffect(() => { setUrl(status?.baseUrl ?? ""); }, [status?.baseUrl]);
  const plan = readiness?.plan ? PLANS[readiness.plan] : null;
  const account = readiness?.state === "ready" ? [readiness.account, plan].filter(Boolean).join(" · ") : readiness?.state === "signed_out" ? "Not signed in" : "";
  const verified = status?.mode === "api_key" && status.saved && status.verified?.ok;
  return <div role="radiogroup" aria-label={`${harness.name} sign-in`} className="mt-4 rounded-lg border border-hairline">
    <button type="button" role="radio" aria-checked={chosen === "subscription"} disabled={!!busy} onClick={() => onChoose("subscription")}
      className="flex h-11 w-full items-center gap-2.5 border-b border-hairline px-3.5 text-left text-[13px] outline-none focus-visible:bg-veil-card">
      <Radio on={chosen === "subscription"} /><span className="font-medium">ChatGPT</span>{account && <span className="truncate text-[12px] text-muted-foreground">{account}</span>}
    </button>
    <div className={cn("flex h-11 items-center gap-2.5 px-3.5 text-[13px]", "border-b border-hairline")}>
      <button type="button" role="radio" aria-checked={chosen === "api_key"} disabled={!!busy} onClick={() => onChoose("api_key")}
        className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch text-left outline-none focus-visible:bg-veil-card">
        <Radio on={chosen === "api_key"} /><span className="font-medium">API key</span>
        <span className="font-mono text-[12px] text-faint">{status?.variable ?? "OPENAI_API_KEY"}</span>
        {verified && <Check aria-label="Verified" className="size-3.5 text-add" />}
      </button>
      <GetKey harness={harness.id} label="Get key" />
    </div>
    {chosen === "api_key" && <div className="border-b border-hairline bg-accent/[.03] px-3.5 pb-3 pt-0.5">
      <div className="ml-[26px] grid gap-1.5">
        {keyArea}
        <p className="text-[11.5px] text-faint">Kept in the Keychain. TerminalX passes it to Codex when a tab starts, in place of {status?.variable ?? "OPENAI_API_KEY"}.</p>
      </div>
    </div>}
    <button type="button" aria-expanded={custom} onClick={() => setCustom(!custom)}
      className="flex h-11 w-full items-center gap-2.5 px-3.5 text-left text-[13px] outline-none focus-visible:bg-veil-card">
      <ServerCog aria-hidden className="size-3.5 text-muted-foreground" />
      <span className="shrink-0 font-medium">Custom provider</span>
      <span className="min-w-0 truncate text-[12px] text-faint">{status?.baseUrl ? status.baseUrl : "Any OpenAI-compatible endpoint, set with OPENAI_BASE_URL"}</span>
      <ChevronRight aria-hidden className={cn("ml-auto size-3.5 shrink-0 text-faint transition-transform", custom && "rotate-90")} />
    </button>
    {custom && <div className="border-t border-hairline px-3.5 pb-3 pt-2.5">
      <div className="ml-[26px] grid gap-1.5">
        <label className="text-[12px] font-medium" htmlFor="codex-base-url">Base URL</label>
        <div className="flex gap-2">
          <input id="codex-base-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://llm.example.com/v1" spellCheck={false}
            className="h-8 min-w-0 flex-1 rounded-md border border-hairline bg-card px-2.5 font-mono text-[12px] outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/40" />
          <Button size="sm" variant="outline" className="shrink-0 whitespace-nowrap" disabled={!!busy || !url.trim() || url.trim() === status?.baseUrl} onClick={() => void onBaseUrl(url)}>Save</Button>
          {status?.baseUrl && <Button size="sm" variant="ghost" className="shrink-0 whitespace-nowrap text-muted-foreground" disabled={!!busy} onClick={() => void onBaseUrl(null)}>Use OpenAI</Button>}
        </div>
        <p className="text-[11.5px] text-faint">Codex sends the API key above to this address instead of OpenAI&apos;s, as it would with OPENAI_BASE_URL.</p>
      </div>
    </div>}
  </div>;
}

function Radio({ on }: { on: boolean }) {
  return <span aria-hidden className={cn("grid size-4 shrink-0 place-items-center rounded-full border", on ? "border-accent" : "border-hairline-strong")}>
    {on && <span className="size-2 rounded-full bg-accent" />}
  </span>;
}

function GetKey({ harness, label }: { harness: string; label: string }) {
  const url = KEY_PAGES[harness];
  if (!url) return null;
  return <button type="button" onClick={() => void openUrl(url)} className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap text-[12px] font-normal text-muted-foreground underline underline-offset-2 hover:text-foreground">
    {label}{label === "Get a key" && <ExternalLink aria-hidden className="size-[11px]" />}
  </button>;
}

function ShellBadge() {
  return <span className="inline-flex h-[18px] shrink-0 items-center gap-1 whitespace-nowrap rounded bg-info/12 px-1.5 text-[10.5px] font-medium text-info">
    <Terminal aria-hidden className="size-[11px]" />From your shell
  </span>;
}

function ShellNote({ children }: { children: ReactNode }) {
  return <div className="mt-1.5 flex items-center gap-2 text-[11.5px] text-faint"><ShellBadge /><span className="min-w-0">{children}</span></div>;
}

function StatusLine({ dot, children, onRefresh, refreshing }: { dot: "ok" | "bad" | "busy" | "off"; children: ReactNode; onRefresh: () => void; refreshing: boolean }) {
  return <div className="mt-4 flex items-center gap-2 text-[12.5px]">
    <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dot === "ok" ? "bg-add" : dot === "bad" ? "bg-warning" : dot === "busy" ? "bg-faint animate-pulse" : "bg-faint")} />
    <span role="status" className="min-w-0">{children}</span>
    <span className="ml-auto shrink-0">
      <Button size="xs" variant="ghost" disabled={refreshing} onClick={onRefresh}>{refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh</Button>
    </span>
  </div>;
}

function Details({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (!shown.length) return null;
  return <dl className="mt-2 rounded-lg border border-hairline">
    {shown.map(([label, value]) => <div key={label} className="grid h-8 grid-cols-[150px_1fr] items-center border-b border-hairline px-3 text-[12.5px] last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>)}
  </dl>;
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[12px]">{children}</span>;
}
