// PRO-157: Settings → Agents → OpenCode (screens 10.14–10.16). Its version
// with an update notice, the program it runs as, its config file, the model
// providers it can use and the models the composer offers from them.
//
// Keys go where `opencode auth login` puts them (OpenCode's auth.json) and
// the picker's models are OpenCode's own per-provider list in its config
// file, so the CLI on its own and every TerminalX tab agree.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BookOpen, Check, ChevronRight, CircleAlert, CircleCheck, Eye, EyeOff, FileText, FolderOpen, KeyRound, Loader2, Plus, RefreshCw, Search, Settings2, Trash2, X } from "@/icons";
import { AgentSetup } from "@/components/session/AgentSetup";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { compareAgentVersions } from "@/lib/agentVersion";
import type { AgentReadiness } from "@/lib/agentReadiness";
import {
  agentExecutables, errorMessage, opencode,
  type OpenCodeCatalogProvider, type OpenCodeConnected, type OpenCodeOverview,
} from "@/lib/api";
import { cn } from "@/lib/cn";
import { showError } from "@/lib/errorToasts";
import { refreshModels } from "@/lib/models";
import type { HarnessInfo } from "@/types/session";
import { AgentConfigFileRow, AgentExecutableRow, shortPath } from "./AgentExecutable";
import { RegisteredSetting } from "./settingsRegistry";

const DOCS = "https://opencode.ai/docs";

/** "Add your first provider" (10.15), in the design's order. */
const POPULAR = ["anthropic", "openai", "openrouter", "ollama"] as const;
/** The short list under "Add a provider" before "View all providers" (10.14). */
const SHORTLIST = ["groq", "google", "mistral", "deepseek", "xai", "togetherai", "fireworks-ai", "ollama"] as const;

/** A provider's line, as the screens write them; others get the general one. */
const BLURBS: Record<string, string> = {
  anthropic: "Claude models, with your Anthropic API key",
  openai: "GPT models, with your OpenAI API key",
  openrouter: "One key for models from many labs, billed by OpenRouter.",
  ollama: "Models running on this Mac · no key needed",
  groq: "Fast hosted open-weight models. Connect it, then add the models you want in the picker.",
};
const blurb = (provider: { id: string; name: string }) => BLURBS[provider.id] ?? `Models from ${provider.name}. Connect it, then add the models you want in the picker.`;

/** Where each well-known provider hands out API keys. */
const KEY_PAGES: Record<string, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  openrouter: "https://openrouter.ai/settings/keys",
  groq: "https://console.groq.com/keys",
  google: "https://aistudio.google.com/app/apikey",
  mistral: "https://console.mistral.ai/api-keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  xai: "https://console.x.ai",
  togetherai: "https://api.together.ai/settings/api-keys",
  "fireworks-ai": "https://app.fireworks.ai/settings/users/api-keys",
};

const TONES = ["text-accent", "text-add", "text-merged", "text-destructive", "text-info", "text-warning", "text-foreground", "text-muted-foreground"];
function tone(id: string): string {
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length];
}

function Mark({ provider }: { provider: { id: string; name: string } }) {
  return <span aria-hidden className={cn("grid size-6 shrink-0 place-items-center rounded-md border border-hairline bg-muted text-[11px] font-semibold", tone(provider.id))}>
    {provider.name.slice(0, 1)}
  </span>;
}

function countLabel(provider: OpenCodeConnected): { text: string; warn: boolean } {
  if (provider.models.length) return { text: `${provider.models.length} ${provider.models.length === 1 ? "model" : "models"}`, warn: false };
  return { text: "No models yet", warn: true };
}

/** OpenCode's providers and models, read again after every change made here. */
function useOpenCode() {
  const [overview, setOverview] = useState<OpenCodeOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setOverview(await opencode.overview()); setError(null); } catch (e) { setError(errorMessage(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  /** A change OpenCode tabs and the composer's picker must hear about. */
  const take = useCallback((next: OpenCodeOverview) => { setOverview(next); void refreshModels(); }, []);
  return { overview, error, load, take };
}

function useLatest(version: string | null): string | null {
  const [latest, setLatest] = useState<string | null>(null);
  useEffect(() => {
    if (!version) return;
    let live = true;
    invoke<string | null>("agent_latest_version", { harness: "opencode" })
      .then((found) => live && setLatest(found ?? null)).catch(() => live && setLatest(null));
    return () => { live = false; };
  }, [version]);
  return latest;
}

/** The OpenCode tab of Settings → Agents. */
export function OpenCodeAgent({ harness, readiness, checking, recheck }: {
  harness: HarnessInfo;
  readiness: AgentReadiness | null;
  checking: boolean;
  recheck: () => void;
}) {
  const { overview, error, load, take } = useOpenCode();
  const [configure, setConfigure] = useState<{ provider: string | null } | null>(null);
  const version = readiness?.version ?? null;
  const latest = useLatest(version);
  const update = version && latest && (compareAgentVersions(latest, version) ?? 0) > 0 ? latest : null;
  const installed = readiness?.state !== "missing" && !!harness.path;

  return <div>
    <div className="mt-4 flex items-center gap-2 text-[12.5px]">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", installed ? "bg-add" : checking ? "animate-pulse bg-faint" : "bg-faint")} />
      <span role="status" className="min-w-0">
        {checking && !readiness ? "Checking…" : installed ? <>Installed{version ? ` · ${version}` : ""}</> : "Not installed"}
      </span>
      {update && <span data-testid="opencode-update" className="inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded bg-info/12 px-1.5 text-[11px] font-medium text-info">
        Update available · {update}
      </span>}
      <span className="ml-auto flex shrink-0 gap-1">
        {installed && <Button size="xs" variant="ghost" className="text-xs" onClick={() => void agentExecutables.reveal("opencode").catch((e: unknown) => showError("Couldn’t show OpenCode in Finder", e))}>
          <FolderOpen /> Open in Finder
        </Button>}
        <Button size="xs" variant="ghost" className="text-xs" onClick={() => void opencode.openLogs().catch((e: unknown) => showError("Couldn’t open OpenCode’s logs", e))}>
          <FileText /> View logs
        </Button>
        <Button size="xs" variant="ghost" className="text-xs" onClick={() => void openUrl(DOCS)}><BookOpen /> Docs</Button>
        <Button size="xs" variant="ghost" className="text-xs" disabled={checking} onClick={() => { recheck(); void load(); }}>
          {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh
        </Button>
      </span>
    </div>
    {update && <p className="mt-1 text-[12px] text-faint">Run <span className="font-mono text-[12px]">opencode upgrade</span> in a terminal, then Refresh. Tabs already open keep the version they started with.</p>}
    <dl className="mt-2 rounded-lg border border-hairline">
      {([
        ["Executable", harness.path ? <span className="font-mono text-[12px]">{shortPath(harness.path)}</span> : null],
        ["Connection", "OpenCode server · TerminalX starts one per tab"],
        ["Config", overview ? <span className="font-mono text-[12px]">{overview.configPath}</span> : null],
      ] as [string, ReactNode][]).filter(([, value]) => value).map(([label, value]) => <div key={label} className="grid h-8 grid-cols-[150px_1fr] items-center border-b border-hairline px-3 text-[12.5px] last:border-0">
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="truncate">{value}</dd>
      </div>)}
    </dl>
    {!installed && !checking && <div className="mt-3"><AgentSetup harness={harness} value={readiness} checking={checking} onRefresh={recheck} headless /></div>}
    <div className="mt-2">
      <RegisteredSetting setting="agents.executable" instance="opencode">
        <div><AgentExecutableRow harness="opencode" agentName="OpenCode" onChanged={recheck} /></div>
      </RegisteredSetting>
      <RegisteredSetting setting="agents.settingsFile" instance="opencode">
        <div><AgentConfigFileRow harness="opencode" title="OpenCode config" last /></div>
      </RegisteredSetting>
    </div>

    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    {overview?.configProblem && <p role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-[12px] text-warning">
      <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />{overview.configProblem}
    </p>}
    {overview?.authProblem && <p role="alert" data-testid="opencode-auth-problem" className="mt-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-[12px] text-warning">
      <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />{overview.authProblem}
    </p>}

    <RegisteredSetting setting="agents.opencodeProviders"><div>
    <SectionHead title="Providers" description="Where OpenCode gets its models. Keys are saved where opencode auth login saves them."
      action={<Button size="xs" variant="outline" className="text-[12px]" disabled={!overview} onClick={() => setConfigure({ provider: null })}><Settings2 /> Configure providers</Button>} />
    {overview && (overview.connected.length
      ? <div className="mt-2 rounded-lg border border-hairline" data-testid="opencode-providers">
        {overview.connected.map((provider) => {
          const count = countLabel(provider);
          return <button key={provider.id} type="button" onClick={() => setConfigure({ provider: provider.id })}
            className="flex h-11 w-full items-center gap-3 border-b border-hairline px-3.5 text-left text-[13px] outline-none last:border-0 hover:bg-veil-card focus-visible:bg-veil-card">
            <Mark provider={provider} />
            <span className="font-medium">{provider.name}</span>
            <CircleCheck aria-label="Connected" className="size-3.5 text-add" />
            <span className={cn("ml-auto text-[12px]", count.warn ? "text-warning" : "text-muted-foreground")}>{count.text}</span>
          </button>;
        })}
      </div>
      : <div className="mt-2 grid place-items-center rounded-lg border border-dashed border-hairline px-4 py-6 text-center" data-testid="opencode-no-providers">
        <div className="text-[13px] font-medium">No providers yet</div>
        <div className="mt-0.5 text-[12.5px] text-muted-foreground">OpenCode can’t start a chat until it has a model provider.</div>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => setConfigure({ provider: null })}><Plus /> Add provider</Button>
      </div>)}

    <SectionHead title="Models in the picker" description="Only models you add from a provider appear in the composer." />
    {overview && <PickerModels overview={overview} take={take} onAdd={() => setConfigure({ provider: overview.connected[0]?.id ?? null })} />}

    </div></RegisteredSetting>

    {configure && overview && <ConfigureProviders overview={overview} take={take} initial={configure.provider} onClose={() => setConfigure(null)} />}
  </div>;
}

function SectionHead({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="mb-1 mt-6 flex items-end gap-3">
    <div className="min-w-0 flex-1">
      <h2 className="text-[14px] font-semibold">{title}</h2>
      <div className="mt-0.5 text-[12.5px] text-muted-foreground">{description}</div>
    </div>
    {action}
  </div>;
}

function FilterField({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  return <div className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-hairline bg-card px-2.5 text-[12.5px] focus-within:ring-2 focus-within:ring-ring/40">
    <Search aria-hidden className="size-3.5 shrink-0 text-faint" />
    <input aria-label={label} placeholder={label} value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false}
      className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" />
  </div>;
}

const matches = (filter: string, ...texts: string[]) => !filter.trim() || texts.some((text) => text.toLowerCase().includes(filter.trim().toLowerCase()));

/** "Models in the picker": every model added from every provider, with Remove. */
function PickerModels({ overview, take, onAdd }: { overview: OpenCodeOverview; take: (next: OpenCodeOverview) => void; onAdd: () => void }) {
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const shown = overview.models.filter((model) => matches(filter, model.name, model.id, model.providerName));
  const remove = async (provider: string, model: string, id: string) => {
    setBusy(id);
    try { take(await opencode.removeModel(provider, model)); } catch (e) { showError("Couldn’t take the model out of the picker", e); } finally { setBusy(null); }
  };
  return <div className="mt-2">
    <FilterField value={filter} onChange={setFilter} label="Filter models" />
    {overview.models.length === 0
      ? <p className="mt-2 text-[12.5px] text-muted-foreground" data-testid="opencode-no-models">
        No models yet. {overview.connected.length ? <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={onAdd}>Add one from a provider</button> : "Connect a provider, then add the models you want."} New OpenCode tabs let OpenCode choose until then.
      </p>
      : <ul aria-label="Models in the picker" className="mt-2 rounded-lg border border-hairline">
        {shown.map((model) => <li key={model.id} className="flex h-10 items-center gap-3 border-b border-hairline px-3.5 text-[12.5px] last:border-0">
          <Mark provider={{ id: model.provider, name: model.providerName }} />
          <span className="min-w-0 truncate font-medium">{model.name}</span>
          <span className="min-w-0 truncate font-mono text-[11.5px] text-faint">{model.id}</span>
          <Button size="xs" variant="ghost" aria-label={`Remove ${model.name}`} className="ml-auto shrink-0 text-muted-foreground" disabled={busy === model.id}
            onClick={() => void remove(model.provider, model.model, model.id)}>
            {busy === model.id ? <Loader2 className="animate-spin" /> : <X />}
          </Button>
        </li>)}
        {shown.length === 0 && <li className="px-3.5 py-2.5 text-[12.5px] text-faint">No model matches “{filter}”.</li>}
      </ul>}
  </div>;
}

/** The Configure providers dialog (10.14–10.16). */
function ConfigureProviders({ overview, take, initial, onClose }: {
  overview: OpenCodeOverview;
  take: (next: OpenCodeOverview) => void;
  initial: string | null;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(initial);
  const [search, setSearch] = useState("");
  const [all, setAll] = useState(false);
  const connectedIds = new Set(overview.connected.map((provider) => provider.id));
  const byId = useMemo(() => new Map(overview.catalog.map((provider) => [provider.id, provider])), [overview.catalog]);
  const others = overview.catalog.filter((provider) => !connectedIds.has(provider.id));
  const shortlist = SHORTLIST.map((id) => byId.get(id)).filter((provider): provider is OpenCodeCatalogProvider => !!provider && !connectedIds.has(provider.id));
  const searching = !!search.trim();
  const addable = searching || all ? others.filter((provider) => matches(search, provider.name, provider.id)) : shortlist;
  const connected = overview.connected.filter((provider) => matches(search, provider.name, provider.id));
  const current = selected ? overview.connected.find((provider) => provider.id === selected) ?? null : null;
  const [note, setNote] = useState<{ provider: string; text: string } | null>(null);
  const catalogEntry = selected ? byId.get(selected) ?? null : null;

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent width="max-w-[800px]" className="gap-0 p-0" showClose={false} data-testid="configure-providers">
      <div className="flex items-start gap-3 px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <DialogTitle className="text-[15px] font-semibold">Configure providers</DialogTitle>
          <DialogDescription className="mt-0.5 text-[12.5px] text-muted-foreground">
            Model providers for OpenCode on this Mac. Keys are saved in OpenCode’s <span className="font-mono text-[12px]">{overview.authPath}</span>, as <span className="font-mono text-[12px]">opencode auth login</span> saves them.
          </DialogDescription>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="ml-auto text-faint hover:text-foreground"><X className="size-4" /></button>
      </div>
      <div className="flex h-[520px] border-t border-hairline">
        <div className="flex w-[262px] shrink-0 flex-col border-r border-hairline">
          <div className="p-2.5 pb-0"><FilterField value={search} onChange={setSearch} label="Search providers" /></div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            <ListHead>Connected{overview.connected.length ? ` · ${overview.connected.length}` : ""}</ListHead>
            {connected.length
              ? connected.map((provider) => {
                const count = countLabel(provider);
                return <ProviderItem key={provider.id} provider={provider} selected={selected === provider.id} onSelect={() => setSelected(provider.id)}
                  trailing={<><CircleCheck aria-label="Connected" className="size-3.5 text-add" /><span className={cn("whitespace-nowrap text-[11px]", count.warn ? "text-warning" : "text-faint")}>{count.text}</span></>} />;
              })
              : <div className="px-2.5 py-1 text-[12px] text-faint">None yet</div>}
            <ListHead>{searching ? "Matching providers" : all ? `All providers · ${others.length}` : "Add a provider"}</ListHead>
            {addable.map((provider) => <ProviderItem key={provider.id} provider={provider} selected={selected === provider.id} onSelect={() => setSelected(provider.id)}
              trailing={provider.local ? <span className="text-[11px] text-faint">local</span> : null} />)}
            {searching && addable.length === 0 && <div className="px-2.5 py-1 text-[12px] text-faint">No provider matches “{search}”.</div>}
            {!searching && !all && <button type="button" onClick={() => setAll(true)} className="flex h-9 items-center gap-1.5 px-2.5 text-[12px] text-muted-foreground hover:text-foreground">
              View all providers ({overview.catalog.length})<ChevronRight aria-hidden className="size-3.5" />
            </button>}
            {overview.catalogProblem && <p className="px-2.5 py-1 text-[12px] text-warning">{overview.catalogProblem}</p>}
          </div>
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto p-5">
          {current
            ? <ConnectedDetail key={current.id} provider={current} entry={catalogEntry} authPath={overview.authPath} take={take} onGone={() => { setNote(null); setSelected(null); }}
              note={note?.provider === current.id ? note.text : null} onNote={(text) => setNote(text ? { provider: current.id, text } : null)} />
            : catalogEntry
              ? <ConnectForm key={catalogEntry.id} provider={catalogEntry} take={take} onCancel={() => setSelected(null)}
                onConnected={(id, text) => { setNote(text ? { provider: id, text } : null); setSelected(id); }} />
              : <FirstProvider catalog={byId} total={overview.catalog.length} onPick={setSelected} />}
        </div>
      </div>
      <div className="flex items-center gap-3 border-t border-hairline px-5 py-3">
        <span className="text-[12px] text-faint">OpenCode picks up provider changes in new tabs.</span>
        <Button size="sm" className="ml-auto" onClick={onClose}>Done</Button>
      </div>
    </DialogContent>
  </Dialog>;
}

function ListHead({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-3 text-[10.5px] font-medium uppercase tracking-[.08em] text-faint">{children}</div>;
}

function ProviderItem({ provider, selected, onSelect, trailing }: { provider: { id: string; name: string }; selected: boolean; onSelect: () => void; trailing?: ReactNode }) {
  return <button type="button" aria-pressed={selected} onClick={onSelect}
    className={cn("flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left outline-none hover:bg-veil-card focus-visible:bg-veil-card", selected && "bg-selected")}>
    <Mark provider={provider} />
    <span className="flex-1 truncate text-[12.5px]">{provider.name}</span>
    {trailing}
  </button>;
}

/** "Add your first provider" (10.15). */
function FirstProvider({ catalog, total, onPick }: { catalog: Map<string, OpenCodeCatalogProvider>; total: number; onPick: (id: string) => void }) {
  return <div>
    <div className="text-[15px] font-semibold">Add your first provider</div>
    <p className="mt-1 text-[12.5px] text-muted-foreground">OpenCode needs a model provider before it can run. Paste an API key, or point it at a server on this Mac such as Ollama.</p>
    <ListHead>Popular</ListHead>
    <div className="rounded-lg border border-hairline">
      {POPULAR.map((id) => catalog.get(id)).filter((provider): provider is OpenCodeCatalogProvider => !!provider).map((provider) =>
        <div key={provider.id} className="flex items-center gap-3 border-b border-hairline px-3.5 py-2.5 last:border-0">
          <Mark provider={provider} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">{provider.name}</div>
            <div className="truncate text-[12px] text-muted-foreground">{blurb(provider)}</div>
          </div>
          <Button size="xs" variant="outline" className="shrink-0" aria-label={`Add ${provider.name}`} onClick={() => onPick(provider.id)}>Add</Button>
        </div>)}
    </div>
    <p className="mt-2 text-[12px] text-faint">Or search all {total} providers on the left.</p>
  </div>;
}

function SecretField({ label, value, onChange, placeholder, onSubmit, autoFocus }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; onSubmit: () => void; autoFocus?: boolean }) {
  const [shown, setShown] = useState(false);
  return <div className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-hairline bg-card px-2.5 focus-within:ring-2 focus-within:ring-ring/40">
    <input aria-label={label} type={shown ? "text" : "password"} value={value} placeholder={placeholder} autoComplete="off" spellCheck={false} autoFocus={autoFocus}
      onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !event.shiftKey)) { event.preventDefault(); onSubmit(); } }}
      className="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-faint" />
    <button type="button" aria-label={shown ? "Hide the key" : "Show the key"} onClick={() => setShown(!shown)} className="text-faint hover:text-foreground">
      {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
    </button>
  </div>;
}

/** A provider not connected yet: its key and base URL (10.14), or Ollama's server. */
function ConnectForm({ provider, take, onCancel, onConnected, replacing }: {
  provider: OpenCodeCatalogProvider;
  take: (next: OpenCodeOverview) => void;
  onCancel: () => void;
  /** `note`: why the key could not be checked, when it could not. */
  onConnected: (id: string, note: string | null) => void;
  replacing?: OpenCodeConnected;
}) {
  const [key, setKey] = useState("");
  // The address in OpenCode's config, kept while disconnected: a reconnect starts from it.
  const saved = replacing?.baseUrl ?? provider.baseUrl ?? null;
  const [baseUrl, setBaseUrl] = useState(saved ?? (provider.local ? provider.api ?? "" : ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyPage = KEY_PAGES[provider.id];
  const ready = provider.local ? !!baseUrl.trim() : !!key.trim();
  const connect = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Unchanged means "leave it": the key is checked at, and kept on, the saved address. "" clears it.
      const result = await opencode.connect(provider.id, key, baseUrl.trim() === (saved ?? "") ? undefined : baseUrl.trim());
      take(result.overview);
      onConnected(provider.id, result.check.result === "notChecked" ? result.check.reason : null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return <div data-testid="connect-provider">
    {!replacing && <div className="flex items-center gap-2.5">
      <Mark provider={provider} />
      <div className="text-[15px] font-semibold">{provider.name}</div>
      <span className="inline-flex h-[18px] items-center rounded bg-veil-strong px-1.5 text-[10.5px] font-medium text-muted-foreground">Not connected</span>
      {keyPage && <button type="button" onClick={() => void openUrl(keyPage)} className="ml-auto text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground">Get a key</button>}
    </div>}
    {!replacing && <p className="mt-1 text-[12.5px] text-muted-foreground">{blurb(provider)}</p>}
    {!provider.local && <div className="mt-4 grid gap-1.5">
      <label className="text-[12px] font-medium">{replacing ? "New API key" : "API key"}</label>
      <SecretField label={`${provider.name} API key`} value={key} onChange={setKey} placeholder={provider.env[0] ?? "API key"} onSubmit={() => void connect()} autoFocus />
      <p className="text-[12px] text-faint">Paste it here; it’s checked with {provider.name} before saving.</p>
    </div>}
    <div className="mt-4 grid gap-1.5">
      <label className="text-[12px] font-medium" htmlFor={`base-url-${provider.id}`}>Base URL</label>
      <input id={`base-url-${provider.id}`} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} placeholder={provider.api ?? "https://…"}
        className="h-8 min-w-0 rounded-md border border-hairline bg-card px-2.5 font-mono text-[12px] outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/40" />
      <p className="text-[12px] text-faint">{provider.local ? "Where Ollama answers on this Mac. TerminalX checks that it does before saving." : "Leave empty unless you go through a proxy or your own gateway."}</p>
    </div>
    {error && <p role="alert" className="mt-3 text-[12px] text-destructive">{error}</p>}
    <div className="mt-4 flex justify-end gap-2">
      <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      <Button size="sm" disabled={!ready || busy} onClick={() => void connect()}>
        {busy ? <Loader2 className="animate-spin" /> : null} {replacing ? "Save key" : `Connect ${provider.name}`}
        <kbd aria-hidden className="ml-1 text-[11px] opacity-70">⌘↵</kbd>
      </Button>
    </div>
  </div>;
}

/** A connected provider: its key with Replace and Disconnect, and its models (10.16). */
function ConnectedDetail({ provider, entry, authPath, take, onGone, note, onNote }: {
  provider: OpenCodeConnected;
  entry: OpenCodeCatalogProvider | null;
  authPath: string;
  take: (next: OpenCodeOverview) => void;
  onGone: () => void;
  /** Why its key was saved without being checked. */
  note: string | null;
  onNote: (note: string | null) => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try { take(await opencode.disconnect(provider.id)); onGone(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const describe = provider.auth === "oauth" || provider.auth === "wellknown" ? "Signed in through OpenCode"
    : provider.auth === "config" ? (provider.maskedKey ? "In OpenCode’s config file" : provider.baseUrl ? `Server at ${provider.baseUrl}` : "In OpenCode’s config file")
      : `In ${authPath}`;
  return <div data-testid="connected-provider">
    <div className="flex items-center gap-2.5">
      <Mark provider={provider} />
      <div className="text-[15px] font-semibold">{provider.name}</div>
      <span className="inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded bg-add/12 px-1.5 text-[10.5px] font-medium text-add"><Check className="size-3" />Connected</span>
    </div>
    <p className="mt-1 text-[12.5px] text-muted-foreground">{blurb(provider)}</p>
    <div className="mt-4 flex items-center gap-3 rounded-lg border border-hairline px-3.5 py-2.5 text-[12.5px]">
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-md bg-muted"><KeyRound className="size-4 text-muted-foreground" /></span>
      <div className="min-w-0 flex-1">
        <div>{provider.maskedKey ? <>API key <span className="font-mono text-[12px]">{provider.maskedKey}</span></> : provider.auth === "config" && provider.baseUrl ? "No key needed" : "Sign-in"}</div>
        <div className="text-[12px] text-faint">{describe}</div>
      </div>
      {entry && !entry.local && <Button size="xs" variant="outline" disabled={busy} onClick={() => setReplacing(!replacing)}>Replace</Button>}
      <Button size="xs" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => void disconnect()}>
        {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} Disconnect
      </Button>
    </div>
    {replacing && entry && <div className="mt-2 rounded-lg border border-hairline px-3.5 pb-3 pt-1">
      <ConnectForm provider={entry} take={take} replacing={provider} onCancel={() => setReplacing(false)} onConnected={(_, text) => { onNote(text); setReplacing(false); }} />
    </div>}
    {note && <p role="note" className="mt-2 text-[12px] text-warning">Saved without a check: {note}</p>}
    {error && <p role="alert" className="mt-2 text-[12px] text-destructive">{error}</p>}
    <ProviderModels provider={provider} entry={entry} take={take} />
  </div>;
}

/** A provider's models in the picker: add by ID, or pick from the catalogue. */
function ProviderModels({ provider, entry, take }: { provider: OpenCodeConnected; entry: OpenCodeCatalogProvider | null; take: (next: OpenCodeOverview) => void }) {
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [catalogue, setCatalogue] = useState<{ id: string; name: string }[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!browsing || catalogue) return;
    opencode.catalogModels(provider.id).then(setCatalogue).catch((e) => { setError(errorMessage(e)); setCatalogue([]); });
  }, [browsing, catalogue, provider.id]);
  const change = async (model: string, add: boolean) => {
    setBusy(model);
    setError(null);
    try {
      take(await (add ? opencode.addModel(provider.id, model) : opencode.removeModel(provider.id, model)));
      if (add && model === draft.trim()) setDraft("");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  };
  const names = new Map((catalogue ?? []).map((model) => [model.id, model.name]));
  const shown = provider.models.filter((model) => matches(filter, model, names.get(model) ?? ""));
  const size = entry?.modelCount ?? provider.catalogModels;
  return <div className="mt-5">
    <div className="flex items-center gap-3">
      <div className="text-[13px] font-medium">Models</div>
      <span className="text-[12px] text-faint">{provider.models.length} in the picker</span>
      <div className="ml-auto w-[200px]"><FilterField value={filter} onChange={setFilter} label="Filter models" /></div>
    </div>
    {provider.models.length === 0
      ? <div className="mt-3 rounded-lg border border-dashed border-hairline px-4 py-4">
        <div className="text-[13px] font-medium">Add your first {provider.name} model</div>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          {size > 0 ? `${provider.name} serves ${size > 20 ? `more than ${Math.floor(size / 10) * 10}` : size} models. ` : ""}OpenCode lists only the ones you add here, so the picker stays short.
        </p>
      </div>
      : <ul aria-label={`${provider.name} models in the picker`} className="mt-3 rounded-lg border border-hairline">
        {shown.map((model) => <li key={model} className="flex h-9 items-center gap-3 border-b border-hairline px-3 text-[12.5px] last:border-0">
          <span className="min-w-0 truncate font-mono text-[12px]">{model}</span>
          {names.get(model) && <span className="min-w-0 truncate text-faint">{names.get(model)}</span>}
          <Button size="xs" variant="ghost" aria-label={`Remove ${model}`} className="ml-auto shrink-0 text-muted-foreground" disabled={busy === model} onClick={() => void change(model, false)}>
            {busy === model ? <Loader2 className="animate-spin" /> : <X />}
          </Button>
        </li>)}
      </ul>}
    <div className="mt-3 flex gap-2">
      <input ref={input} aria-label="Model ID" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false}
        placeholder={provider.id === "openrouter" ? "Model ID, such as deepseek/deepseek-v4" : "Model ID"}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (draft.trim()) void change(draft.trim(), true); } }}
        className="h-8 min-w-0 flex-1 rounded-md border border-hairline bg-card px-2.5 font-mono text-[12px] outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/40" />
      <Button size="sm" variant="outline" className="shrink-0" disabled={!draft.trim() || !!busy} onClick={() => void change(draft.trim(), true)}>
        {busy && busy === draft.trim() ? <Loader2 className="animate-spin" /> : <Plus />} Add model
      </Button>
    </div>
    {error && <p role="alert" className="mt-2 text-[12px] text-destructive">{error}</p>}
    {size > 0 && <button type="button" aria-expanded={browsing} onClick={() => setBrowsing(!browsing)} className="mt-2 text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground">
      Or browse the catalogue and pick several at once.
    </button>}
    {browsing && <div className="mt-2 max-h-[220px] overflow-y-auto rounded-lg border border-hairline" data-testid="model-catalogue">
      {catalogue === null
        ? <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-faint"><Loader2 className="size-3.5 animate-spin" />Reading the catalogue…</div>
        : catalogue.filter((model) => matches(filter, model.id, model.name)).map((model) => {
          const on = provider.models.includes(model.id);
          return <div key={model.id} className="flex h-9 items-center gap-3 border-b border-hairline px-3 text-[12.5px] last:border-0">
            <Checkbox checked={on} disabled={busy === model.id} onChange={(next) => void change(model.id, next)} label={`${model.name} (${model.id})`} className="min-w-0 flex-1 text-[12.5px] text-foreground">
              <span className="truncate">{model.name}</span><span className="ml-auto truncate font-mono text-[11.5px] text-faint">{model.id}</span>
            </Checkbox>
          </div>;
        })}
    </div>}
  </div>;
}
