import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { errorMessage, gh, pty, type GitHubConnectionStatus } from "@/lib/api";
import type { GitSource } from "@/lib/gitSource";
import { disposeInstance } from "@/lib/terminal";
import { Button } from "@/components/ui/button";
import { GitPullRequest } from "@/icons";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

const TerminalView = lazy(() => import("@/components/terminal/TerminalView").then((module) => ({ default: module.TerminalView })));

export function CommandDetails({ details }: { details?: string | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!details) return null;
  return <div className="mt-2 text-xs text-muted-foreground">
    <button type="button" className="underline underline-offset-2" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Hide details" : "Show details"}</button>
    {expanded && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-well p-2 font-mono text-[11px]">{details}</pre>}
  </div>;
}

/** Only this dialog's login process is owned here; closing it cancels that login. */
function GitHubLogin({ onClose }: { onClose: () => void }) {
  const [pane, setPane] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const id = `github-login-${crypto.randomUUID()}`;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const start = async () => {
      unlisten = await listen<{ id: string; code: number | null }>("pty_exit", ({ payload }) => {
        if (payload.id === id && !cancelled) close.current();
      });
      if (cancelled) return;
      await gh.loginStart(id);
      if (!cancelled) setPane(id);
    };
    const started = start().catch((error: unknown) => { if (!cancelled) setFailure(errorMessage(error)); });
    return () => {
      cancelled = true;
      // Await an in-flight spawn so a late answer cannot leave an orphan PTY.
      void started.finally(() => {
        unlisten?.();
        disposeInstance(id);
        void pty.kill(id).catch(() => {});
      });
    };
  }, []);
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent width="max-w-[52rem]" onInteractOutside={(event) => event.preventDefault()}>
      <DialogTitle className="text-base font-medium">Connect GitHub</DialogTitle>
      <DialogDescription className="mt-1 text-xs text-muted-foreground">Follow the GitHub prompts below and finish signing in in your browser. This panel refreshes when the command finishes.</DialogDescription>
      {failure ? <div role="alert" className="mt-4 text-xs">Could not start GitHub sign-in.<CommandDetails details={failure} /></div> : <div className="mt-4 h-80 overflow-hidden rounded-md bg-background p-2" aria-label="GitHub sign-in terminal">
        {pane ? <Suspense fallback={<p className="text-xs">Opening terminal…</p>}><TerminalView id={pane} visible /></Suspense> : <p className="text-xs">Opening terminal…</p>}
      </div>}
      <div className="mt-3 flex justify-end"><Button size="sm" variant="ghost" onClick={onClose}>Cancel sign-in</Button></div>
    </DialogContent>
  </Dialog>;
}

export function GitHubSetup({ status, onRefresh }: { status: GitHubConnectionStatus; onRefresh: () => void }) {
  const [connecting, setConnecting] = useState(false);
  const missing = status.state === "missing";
  const unavailable = status.state === "unavailable";
  return <section aria-label="GitHub connection" className="m-3 rounded-lg border border-hairline p-5 text-center text-xs">
    <div className="mx-auto mb-3 grid size-9 place-items-center rounded-md bg-well"><GitPullRequest className="size-4" /></div>
    <h3 className="text-sm font-medium">{missing ? "Install GitHub CLI" : unavailable ? "Could not check GitHub" : "Connect GitHub to see pull requests"}</h3>
    <p className="mt-1 text-muted-foreground">{missing ? "Install the GitHub CLI to connect your account and work with pull requests." : unavailable ? "Check your connection and try again." : "TerminalX uses the GitHub CLI on this computer. Connect your account to sign in through your browser."}</p>
    <div className="mt-3 flex flex-wrap justify-center gap-2">
      <Button size="sm" variant="accent" onClick={() => {
        if (missing) void openUrl("https://cli.github.com/");
        else if (unavailable) onRefresh();
        else setConnecting(true);
      }}>{missing ? "Install GitHub CLI" : unavailable ? "Try again" : "Connect GitHub"}</Button>
      {!unavailable && <Button size="sm" variant="ghost" onClick={onRefresh}>Check again</Button>}
    </div>
    <CommandDetails key={status.details} details={status.details} />
    {connecting && <GitHubLogin onClose={() => { setConnecting(false); onRefresh(); }} />}
  </section>;
}

/** The same local GitHub connection in Settings and in the PR panel. */
export function LocalGitHubConnection() {
  const [status, setStatus] = useState<GitHubConnectionStatus | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    gh.connectionStatus().then((next) => { if (!cancelled) setStatus(next); }, (error: unknown) => {
      if (!cancelled) setStatus({ state: "unavailable", details: errorMessage(error) });
    });
    return () => { cancelled = true; };
  }, [tick]);
  if (!status) return <p role="status" className="mt-2 text-xs text-faint">Checking GitHub…</p>;
  if (status.state === "connected") return <div className="mt-2 flex items-center gap-2 text-xs"><span role="status" className="text-add">GitHub connected</span><Button size="xs" variant="ghost" onClick={() => setTick((value) => value + 1)}>Check again</Button></div>;
  return <GitHubSetup status={status} onRefresh={() => setTick((value) => value + 1)} />;
}

export function AddRemote({ source, details, onDone }: { source: GitSource; details?: string; onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [privateRepo, setPrivate] = useState(true);
  const [create, setCreate] = useState(false);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(true);
  useEffect(() => {
    let cancelled = false;
    current.current = true;
    source.githubStatus?.().then((status) => { if (!cancelled) setConnected(status.state === "connected"); }).catch(() => {});
    return () => { cancelled = true; current.current = false; };
  }, [source]);
  return <section aria-label="Remote setup" className="m-3 rounded-lg border border-hairline p-4 text-xs">
    <h3 className="text-sm font-medium">{create ? "Create a GitHub repository" : "Add a remote"}</h3>
    <p className="mt-1 text-muted-foreground">{create ? "Create a repository and connect it as origin. Then push when you’re ready." : "Choose where to push this repository. Add the URL of an existing repository as origin."}</p>
    <form className="mt-3 flex flex-col gap-2" onSubmit={(event) => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      setError(null);
      const action = create ? source.createRepository?.(name.trim(), privateRepo) : source.addRemote?.(url.trim());
      void action?.then(() => { if (current.current) onDone(); }, (failure: unknown) => { if (current.current) setError(source.errorMessage(failure)); }).finally(() => { if (current.current) setBusy(false); });
    }}>
      <label className="flex flex-col gap-1">{create ? "Repository name" : "Remote URL"}
        <input autoFocus spellCheck={false} value={create ? name : url} onChange={(event) => create ? setName(event.target.value) : setUrl(event.target.value)} placeholder={create ? "owner/repository" : "https://github.com/owner/repository.git"} className="h-8 min-w-0 rounded-md border border-hairline bg-transparent px-2 text-xs outline-none focus:border-ring" />
      </label>
      {create && <label className="flex items-center gap-2">Visibility<select value={privateRepo ? "private" : "public"} onChange={(event) => setPrivate(event.target.value === "private")} className="h-8 rounded-md border border-hairline bg-background px-2"><option value="private">Private</option><option value="public">Public</option></select></label>}
      {error && <div role="alert">{create ? "Could not create the repository. Check the name and your GitHub access before trying again." : "Could not add the remote. Check the URL and try again."}<CommandDetails key={error} details={error} /></div>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="accent" disabled={busy || !(create ? name : url).trim()}>{busy ? "Saving…" : create ? "Create repository" : "Add remote"}</Button>
        {connected && source.createRepository && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setCreate(!create); setError(null); }}>{create ? "Use an existing repository" : "Create a GitHub repository"}</Button>}
      </div>
    </form>
    <CommandDetails key={details} details={details} />
  </section>;
}

export function GitError({ details, operation }: { details: string; operation?: string }) {
  const denied = /permission denied|authentication failed|access denied|write access.*not granted|denied to|error: 403|returned error: 403|could not read username/i.test(details);
  return <div role="alert" className="mx-3 my-2 rounded-md bg-destructive/10 p-2 text-xs">
    <p className="font-medium">{denied ? "Repository access denied" : operation === "push" ? "Could not push" : "Could not complete Git operation"}</p>
    <p className="mt-1 text-muted-foreground">{denied ? "Check that your Git credentials have write access to this repository, then try again." : "Check the repository and your connection, then try again."}</p>
    <CommandDetails key={details} details={details} />
  </div>;
}
