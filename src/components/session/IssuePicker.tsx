import { useEffect, useState } from "react";
import { Popover } from "radix-ui";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, Github, LoaderCircle, LogoLinear, Search } from "@/icons";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { IssueListItem } from "@/components/issues/IssueListItem";
import { errorMessage, issues as issuesApi, type Issue } from "@/lib/api";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/cn";

type Provider = "github" | "linear";

/**
 * Start from an issue: the project's open GitHub or Linear issues, searched
 * as you type. The pick is the parent's; it fills the session's prompt,
 * branch name and issue link.
 */
export function IssuePicker({ projectPath, picked, onPick, disabled = false }: { projectPath: string; picked: Issue | null; onPick: (issue: Issue) => void; disabled?: boolean }) {
  const prefs = usePrefs();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<Provider>(prefs.issueProvider);
  const [search, setSearch] = useState("");
  const [list, setList] = useState<Issue[]>([]);
  // Loading until the first list comes: "no issues" only once they have been read.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Whether Linear has a key; null until asked. Without one there is a way to connect instead of a list. */
  const [linearConnected, setLinearConnected] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open || provider !== "linear") return;
    let live = true;
    issuesApi
      .linearStatus()
      .then((status) => live && setLinearConnected(status.connected))
      .catch(() => live && setLinearConnected(null));
    return () => {
      live = false;
    };
  }, [open, provider]);
  const needsLinear = provider === "linear" && linearConnected === false;

  useEffect(() => {
    if (!open || needsLinear) return;
    let live = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      setError(null);
      issuesApi
        .list(projectPath, provider, { search })
        .then((found) => live && setList(found))
        .catch((e) => {
          if (!live) return;
          setList([]);
          setError(errorMessage(e));
        })
        .finally(() => live && setLoading(false));
    }, search ? 250 : 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, projectPath, provider, search, needsLinear]);

  return (
    <Popover.Root modal open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Start from an issue"
          title="Start from a GitHub or Linear issue"
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-veil-raised hover:text-foreground disabled:opacity-50",
            open && "bg-veil-raised text-foreground",
          )}
        >
          <span className="flex items-center -space-x-1" aria-hidden>
            <Github className="size-4 rounded-full bg-composer" />
            <LogoLinear className="size-4 rounded-full bg-composer" />
          </span>
          <span className="hidden sm:inline">{picked ? "Change issue" : "Issue"}</span>
          <ChevronDown className="size-3.5 text-faint" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-(--z-menu) flex w-[28rem] max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-xl bg-popover glass p-2 text-popover-foreground shadow-surface hairline animate-fade-in"
        >
          <div className="flex items-center gap-2">
            <Segmented<Provider>
              aria-label="Issue tracker"
              value={provider}
              onChange={(next) => {
                setProvider(next);
                setPrefs({ issueProvider: next });
              }}
              options={[
                { value: "github", label: "GitHub" },
                { value: "linear", label: "Linear" },
              ]}
            />
            <div className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md bg-well px-2">
              <Search className="size-3.5 shrink-0 text-faint" />
              <input
                autoFocus
                aria-label="Search issues"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search issues"
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-faint"
              />
              {loading && <LoaderCircle className="size-3.5 shrink-0 animate-spin text-faint" />}
            </div>
          </div>
          {needsLinear ? (
            <ConnectLinear onConnected={() => setLinearConnected(true)} />
          ) : (
            <>
              <ul className="max-h-80 min-h-20 overflow-y-auto scrollbar-thin" aria-label="Issues">
                {list.map((issue) => (
                  <li key={`${issue.provider}:${issue.id}`}>
                    <IssueListItem
                      issue={issue}
                      selected={picked?.provider === issue.provider && picked.id === issue.id}
                      onSelect={() => {
                        onPick(issue);
                        setOpen(false);
                      }}
                    />
                  </li>
                ))}
                {loading && list.length === 0 && (
                  <li role="status" className="flex items-center justify-center gap-1.5 px-2 py-6 text-xs text-faint">
                    <LoaderCircle className="size-3 animate-spin" /> Loading issues…
                  </li>
                )}
                {!loading && !error && list.length === 0 && <li className="px-2 py-6 text-center text-xs text-muted-foreground">No open issues match.</li>}
              </ul>
              {error && (
                <div role="alert" className="flex flex-col items-center gap-1 px-4 pb-4 text-center text-xs text-muted-foreground">
                  {provider === "github" ? <Github className="mb-1 size-5 text-faint" /> : <LogoLinear className="mb-1 size-5 text-faint" />}
                  <span className="text-foreground">Couldn't load issues</span>
                  <span className="max-w-[40ch] leading-relaxed">{error}</span>
                </div>
              )}
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const LINEAR_KEYS_URL = "https://linear.app/settings/account/security";

/** Linear has no key yet: say what it is for, and take one here. */
export function ConnectLinear({ onConnected }: { onConnected: () => void }) {
  const [entering, setEntering] = useState(false);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    if (!key.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const status = await issuesApi.linearSetApiKey(key.trim());
      if (status.connected) onConnected();
      else setError("Linear did not accept that key.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col items-center gap-2 px-6 pb-5 pt-4 text-center" data-testid="connect-linear">
      <LogoLinear className="size-7 text-foreground" aria-hidden />
      <p className="text-sm font-medium text-foreground">Connect Linear</p>
      <p className="max-w-[36ch] text-xs leading-relaxed text-muted-foreground">Start sessions from your Linear issues. TerminalX reads them with a personal API key, kept on this computer.</p>
      {entering ? (
        <form
          className="mt-1 flex w-full max-w-sm flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <input
            autoFocus
            type="password"
            aria-label="Linear API key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="lin_api_…"
            className="h-8 w-full rounded-md bg-well px-2.5 font-mono text-xs outline-none ring-1 ring-hairline placeholder:text-faint focus:ring-ring/60"
          />
          <div className="flex items-center justify-between gap-2">
            <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => void openUrl(LINEAR_KEYS_URL).catch(() => {})}>
              Create a key in Linear
            </button>
            <Button size="sm" type="submit" disabled={!key.trim() || saving}>
              {saving && <LoaderCircle className="animate-spin" />}
              Connect
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-left text-xs text-destructive">
              {error}
            </p>
          )}
        </form>
      ) : (
        <Button size="sm" className="mt-1 gap-1.5" onClick={() => setEntering(true)}>
          <LogoLinear aria-hidden /> Connect Linear
        </Button>
      )}
    </div>
  );
}
