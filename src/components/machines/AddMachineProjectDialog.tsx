import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { FolderPlus, Info, Loader2, X } from "@/icons";
import type { MachineClone, MachineFolder, MachineProject, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { CLONE_POLL_MS, cloneDestination, cloneEndText, cloneProgressText, folderSummary } from "@/lib/machineProjects";
import type { PairedMachine } from "@/types/machines";
import { MachineFolderBrowser, useMachineFolders } from "./MachineFolderBrowser";

type AddTab = "folder" | "clone";

/**
 * Add a project on a machine from this computer (screen 21.11, PRO-351,
 * `machine/6`): a folder already on the machine, browsed there, or a
 * repository cloned there. The Clone tab, its progress and its errors have
 * no screen of their own; they are built from 21.11's parts.
 */
export function AddMachineProjectDialog({
  machine,
  client,
  onClose,
  onAdded,
}: {
  machine: PairedMachine;
  client: WorkspaceRpcClient;
  onClose: () => void;
  onAdded?: (project: MachineProject) => void;
}) {
  const [tab, setTab] = useState<AddTab>("folder");
  const [cloning, setCloning] = useState(false);
  // The folder last listed in either tab: the other tab opens there.
  const [browsed, setBrowsed] = useState<string | undefined>(undefined);
  // A clone under way when the dialog closes is stopped: nothing would follow it here.
  const stopClone = useRef<(() => void) | null>(null);
  const tabRefs = useRef<Record<AddTab, HTMLButtonElement | null>>({ folder: null, clone: null });
  const where = machine.hasWindow === false ? "the server" : machine.name;
  const tabs: { value: AddTab; label: string }[] = [
    { value: "folder", label: `Folder on ${machine.name}` },
    { value: "clone", label: "Clone from GitHub" },
  ];
  const close = () => {
    stopClone.current?.();
    onClose();
  };
  const added = (project: MachineProject) => {
    onAdded?.(project);
    onClose();
  };
  const onTabKey = (event: KeyboardEvent) => {
    if (cloning || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
    event.preventDefault();
    const next: AddTab = tab === "folder" ? "clone" : "folder";
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent width="max-w-[600px]" showClose={false} className="gap-0 p-0" data-testid="add-machine-project">
        <header className="flex min-h-14 items-center gap-2.5 border-b border-hairline px-5 py-2.5">
          <FolderPlus className="size-[17px] shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 leading-4">
            <DialogTitle className="truncate text-sm font-semibold">Add a project on {machine.name}</DialogTitle>
            <DialogDescription className="mt-0.5 truncate text-[12px] text-faint">Pick a folder that is already on {where}, or clone a repository there</DialogDescription>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Close" className="ml-auto text-faint">
              <X />
            </Button>
          </DialogClose>
        </header>
        <div className="px-5 pt-4">
          <div role="tablist" aria-label="How to add the project" className="inline-flex max-w-full rounded-md border border-hairline bg-raised p-0.5" onKeyDown={onTabKey}>
            {tabs.map((t) => (
              <button
                key={t.value}
                ref={(el) => {
                  tabRefs.current[t.value] = el;
                }}
                type="button"
                role="tab"
                id={`add-machine-project-tab-${t.value}`}
                aria-selected={tab === t.value}
                aria-controls={`add-machine-project-panel-${t.value}`}
                tabIndex={tab === t.value ? 0 : -1}
                disabled={cloning && tab !== t.value}
                onClick={() => setTab(t.value)}
                className={cn(
                  "flex h-7 items-center whitespace-nowrap rounded-[5px] px-3 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                  tab === t.value ? "bg-selected text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div role="tabpanel" id={`add-machine-project-panel-${tab}`} aria-labelledby={`add-machine-project-tab-${tab}`}>
          {tab === "folder" ? (
            <FolderTab machine={machine} client={client} where={where} onClose={close} onAdded={added} startAt={browsed} onListed={setBrowsed} />
          ) : (
            <CloneTab machine={machine} client={client} onClose={close} onAdded={added} onCloning={setCloning} stopRef={stopClone} startAt={browsed} onListed={setBrowsed} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 21.11's own tab: browse the machine's folders and add the chosen one. */
function FolderTab({
  machine,
  client,
  where,
  onClose,
  onAdded,
  startAt,
  onListed,
}: {
  machine: PairedMachine;
  client: WorkspaceRpcClient;
  where: string;
  onClose: () => void;
  onAdded: (project: MachineProject) => void;
  startAt?: string;
  onListed?: (path: string) => void;
}) {
  const folders = useMachineFolders(client, startAt, onListed);
  const [chosen, setChosen] = useState<MachineFolder | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      onAdded(await client.addMachineProject(chosen.path));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <>
      <div className="grid gap-3 px-5 pb-4 pt-3">
        <MachineFolderBrowser
          folders={folders}
          selected={chosen?.path ?? null}
          onSelect={(folder) => {
            setChosen(folder);
            setError(null);
          }}
          mode="project"
          machineName={machine.name}
          disabled={busy}
        />
        <p className="flex items-start gap-2 text-[12px] leading-[18px] text-faint">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>Only folders are listed, and only while you browse. New sessions make their worktrees next to the project on {where}.</span>
        </p>
        {error && (
          <p role="alert" className="text-[12.5px] text-destructive">
            {error}
          </p>
        )}
      </div>
      <footer className="flex min-h-14 items-center gap-3 border-t border-hairline px-5 py-2.5">
        <div className="min-w-0 flex-1" data-testid="add-machine-project-choice" aria-live="polite">
          {chosen ? (
            <>
              <div className="truncate font-mono text-[12.5px]" title={chosen.path}>
                {chosen.path}
              </div>
              <div className="truncate text-[12px] text-faint">{folderSummary(chosen)}</div>
            </>
          ) : (
            <div className="text-[12.5px] text-muted-foreground">Choose a folder to add.</div>
          )}
        </div>
        <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={!chosen || busy} onClick={() => void add()}>
          {busy ? <Loader2 className="animate-spin" /> : null} Add project
        </Button>
      </footer>
    </>
  );
}

/**
 * Clone a repository onto the machine: a repository (`owner/name` or a
 * URL), and the folder it goes in, picked with the same path bar and list.
 * The clone answers at once; its status is asked every second until it ends.
 */
function CloneTab({
  machine,
  client,
  onClose,
  onAdded,
  onCloning,
  stopRef,
  startAt,
  onListed,
}: {
  machine: PairedMachine;
  client: WorkspaceRpcClient;
  onClose: () => void;
  onAdded: (project: MachineProject) => void;
  onCloning: (cloning: boolean) => void;
  stopRef: { current: (() => void) | null };
  startAt?: string;
  onListed?: (path: string) => void;
}) {
  const folders = useMachineFolders(client, startAt, onListed);
  const [repository, setRepository] = useState("");
  const [parentFolder, setParentFolder] = useState<MachineFolder | null>(null);
  const [starting, setStarting] = useState(false);
  const [clone, setClone] = useState<MachineClone | null>(null);
  const [error, setError] = useState<string | null>(null);
  const following = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = starting || clone?.state === "cloning";

  const parent = parentFolder?.path ?? folders.listing?.path ?? null;
  const destination = parent ? cloneDestination(parent, repository) : null;

  const stopFollowing = () => {
    following.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => onCloning(running), [running, onCloning]);

  // Closing the dialog during a clone stops it on the machine: nothing would follow it here.
  const cloningId = useRef<string | null>(null);
  useEffect(() => {
    const stop = () => {
      following.current++;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const id = cloningId.current;
      cloningId.current = null;
      if (id) void client.cancelClone(id).catch(() => undefined);
    };
    stopRef.current = stop;
    return () => {
      stop();
      stopRef.current = null;
    };
  }, [client, stopRef]);

  const follow = (next: MachineClone, mine: number) => {
    if (mine !== following.current) return;
    setClone(next);
    cloningId.current = next.state === "cloning" ? next.cloneId : null;
    if (next.state === "done") {
      stopFollowing();
      if (next.project) onAdded(next.project);
      else setError(`The clone finished, but ${machine.name} did not add it as a project.`);
      return;
    }
    if (next.state !== "cloning") {
      stopFollowing();
      setError(cloneEndText(next));
      return;
    }
    timer.current = setTimeout(() => {
      client.cloneStatus(next.cloneId).then(
        (status) => follow(status, mine),
        (e: unknown) => {
          if (mine !== following.current) return;
          stopFollowing();
          setClone(null);
          setError(errorMessage(e));
        },
      );
    }, CLONE_POLL_MS);
  };

  const start = async () => {
    if (!parent || !destination) return;
    stopFollowing();
    const mine = following.current;
    setStarting(true);
    setError(null);
    setClone(null);
    try {
      const started = await client.cloneMachineProject(repository.trim(), parent);
      setStarting(false);
      follow(started, mine);
    } catch (e) {
      setStarting(false);
      if (mine === following.current) setError(errorMessage(e));
    }
  };

  const cancel = async () => {
    if (!clone || clone.state !== "cloning") return;
    stopFollowing();
    cloningId.current = null;
    try {
      const ended = await client.cancelClone(clone.cloneId);
      setClone(ended);
      setError(cloneEndText(ended));
    } catch (e) {
      setClone(null);
      setError(errorMessage(e));
    }
  };

  return (
    <>
      <div className="grid gap-3 px-5 pb-4 pt-3">
        <div className="grid gap-1.5">
          <label htmlFor="machine-clone-repository" className="text-[13px] font-medium">
            Repository
          </label>
          <input
            id="machine-clone-repository"
            autoFocus
            value={repository}
            disabled={running}
            spellCheck={false}
            autoComplete="off"
            placeholder="owner/name or a repository URL"
            onChange={(event) => {
              setRepository(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && destination && !running) void start();
            }}
            className="h-9 w-full min-w-0 rounded-lg border border-hairline bg-well px-3 font-mono text-[12.5px] outline-none placeholder:font-sans placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          />
          <p className="text-[12px] text-faint">Cloned with {machine.name}’s own Git sign-in.</p>
        </div>
        <div className="grid gap-1.5">
          <div className="text-[13px] font-medium" id="machine-clone-destination">
            Destination folder
          </div>
          <MachineFolderBrowser folders={folders} selected={parentFolder?.path ?? null} onSelect={setParentFolder} mode="destination" machineName={machine.name} disabled={running} />
        </div>
        {clone?.state === "cloning" && (
          <div className="grid gap-1.5" data-testid="machine-clone-progress">
            <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground" role="status">
              <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
              <span className="min-w-0 truncate">{cloneProgressText(clone)}</span>
            </div>
            <div
              className="h-1 overflow-hidden rounded-full bg-well"
              role="progressbar"
              aria-label="Clone progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={typeof clone.percent === "number" ? Math.round(clone.percent) : undefined}
            >
              <div className="h-full rounded-full bg-muted-foreground/70 transition-[width]" style={{ width: `${Math.max(2, Math.min(100, clone.percent ?? 0))}%` }} />
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="break-words text-[12.5px] text-destructive" data-testid="machine-clone-error">
            {error}
          </p>
        )}
      </div>
      <footer className="flex min-h-14 items-center gap-3 border-t border-hairline px-5 py-2.5">
        <div className="min-w-0 flex-1" data-testid="add-machine-project-choice" aria-live="polite">
          {destination ? (
            <>
              <div className="truncate font-mono text-[12.5px]" title={destination}>
                {destination}
              </div>
              <div className="truncate text-[12px] text-faint">A new folder, added as a project once the clone is whole</div>
            </>
          ) : (
            <div className="text-[12.5px] text-muted-foreground">Type a repository to clone.</div>
          )}
        </div>
        <Button variant="outline" size="sm" disabled={starting} onClick={() => (clone?.state === "cloning" ? void cancel() : onClose())}>
          Cancel
        </Button>
        <Button size="sm" disabled={!destination || running} onClick={() => void start()}>
          {running ? <Loader2 className="animate-spin" /> : null} Clone
        </Button>
      </footer>
    </>
  );
}
