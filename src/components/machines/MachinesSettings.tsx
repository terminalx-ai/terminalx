import { useEffect, useState } from "react";
import { ThisComputer, thisComputer } from "@/lib/platform";
import { Check, ChevronRight, Copy, Ellipsis, Info, LoaderCircle, Plus, Trash2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { RegisteredSetting } from "@/components/settings/settingsRegistry";
import { minutesSeconds, useSecondsLeft } from "@/components/pairing/pairingText";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { PRIVACY_MESSAGE, useDataPrivacy } from "@/lib/dataPrivacy";
import { MachineHostError } from "./MachineHostError";
import { clearMachineHostError, setMachineHostError, openMachineHost, createMachineCode, refreshMachineHost, disconnectComputer, letComputerBack, machinesApi, revokeComputer, setAllowOperating, setMachineListen, useMachineHost } from "@/lib/machines";
import { MachineHosting } from "./MachineHosting";
import { machineConnection, refreshPairedMachines, useMachineConnections } from "@/lib/machineConnections";
import { useMachineVersion } from "@/lib/machineUpdate";
import { useSettingsFile } from "@/lib/settingsFile";
import { openCloudWorkspace } from "@/lib/sessions";
import { MachinesGuideLink as GuideLink, SettingsDescription } from "@/components/settings/SettingsDescription";
export { MACHINES_GUIDE_URL } from "@/components/settings/SettingsDescription";
import { machineSectionKey } from "@/types/target";
import type { MachineActivityEntry, MachineConnectionState, MachineHostView, MachineListenStatus, MachinePairingCode, PairedComputer, PairedMachine } from "@/types/machines";
import type { MachineName } from "@/types/pairing";
import { AddMachineDialog } from "./AddMachineDialog";
import { StepRow } from "./HeadlessServerTab";
import { MachineIcon, MachineStateMark, machineTone, toneText } from "./connectionStatus";
import { PlatformIcon, keyLabel, osLabel, routeLabel, seenText, shortDate, soft } from "./machineText";
import { runningText, useRunningSessions } from "./useRunningSessions";
import { MachinePage } from "./MachinePage";
import { UpdateButton, useUpdateAction } from "./MachineUpdate";
import { RemoveMachineDialog } from "./RemoveMachineDialog";
import { takeMachinePageRequest, useMachinePageRequest } from "@/lib/machinePage";

const heading = "text-[14px] font-semibold";
const card = "flex min-h-14 items-center gap-3 rounded-lg border border-hairline px-3 py-2.5";
const iconBox = "grid size-8 shrink-0 place-items-center rounded-md bg-muted";

/**
 * Settings → Machines (PRO-349, screen 21.02): the switch that lets other
 * computers operate this Mac, this Mac's name and key label, the machines
 * this Mac operates, and the computers that operate it. With no machine
 * paired it opens with how to start, and the guide (PRO-360). Data privacy mode turns off
 * both operating and being operated (PRO-357), and the page says so.
 */
export function MachinesSettings({ showIntroduction = true }: { showIntroduction?: boolean }) {
  return useDataPrivacy().enabled ? <MachinesPrivacyState /> : <MachinesSettingsContent showIntroduction={showIntroduction} />;
}

/** What data privacy mode turns off here: the runtime opens no listener, and no machine connection is made. */
function MachinesPrivacyState() {
  return (
    <div role="status" className="grid gap-1 px-2 py-4 text-[12.5px] text-muted-foreground" data-testid="machines-privacy">
      <p className="text-foreground">{PRIVACY_MESSAGE}</p>
      <p>{ThisComputer} neither operates other computers nor lets them operate it. Nothing listens for them, and no connection to a machine is made. Paired machines and computers stay paired for when it is off.</p>
    </div>
  );
}

function MachinesSettingsContent({ showIntroduction }: { showIntroduction: boolean }) {
  // A machine's page (21.10) in place of the list; Machines in its breadcrumb comes back.
  const [page, setPage] = useState<string | null>(null);
  // Asked for from elsewhere (the new-session form's "Open its machine page").
  const requested = useMachinePageRequest();
  useEffect(() => {
    if (!requested) return;
    setPage(requested);
    takeMachinePageRequest(requested);
  }, [requested]);
  if (page) return <MachinePage machineId={page} onBack={() => setPage(null)} />;
  return <MachinesList onOpen={setPage} showIntroduction={showIntroduction} />;
}

/**
 * Where this Mac listens: the runtime's reading, with the addresses the
 * window's phone listener holds added (it holds the port while the runtime
 * does not). Without a runtime, from the settings the view carries.
 */
function thisMacListening(view: MachineHostView): MachineListenStatus {
  const phones = view.phoneListening ?? [];
  const runtime = view.status?.listen;
  if (runtime) return { ...runtime, addresses: [...new Set([...runtime.addresses, ...phones])] };
  return { choice: view.listen ?? "all", chosen: view.listen != null, addresses: phones, allowPublic: view.allowPublic ?? false, askPublic: false, refusedPublicAt: null };
}

function MachinesList({ onOpen, showIntroduction }: { onOpen: (machineId: string) => void; showIntroduction: boolean }) {
  const host = useMachineHost();
  useEffect(() => {
    void openMachineHost();
  }, []);
  const view = host.view;
  // A command's failure, or a restart a pairing grant could not make by itself (PRO-486).
  const hostError = host.error ?? view?.restartRequired ?? null;
  const allow = view?.allowOperating ?? false;
  const listenStatus = view ? thisMacListening(view) : null;

  return (
    <div className="flex flex-col" data-testid="machines-settings">
      {showIntroduction && <SettingsDescription section="machines" className="mb-2" />}
      <div className="border-b border-hairline py-1.5">
        <RegisteredSetting
          setting="machines.allowOperating"
          control={
            <Switch
              aria-label={`Let other computers operate ${thisComputer}`}
              checked={allow}
              disabled={!host.ready || host.busy || !view}
              onCheckedChange={(on) => void setAllowOperating(on)}
            />
          }
        />
        {hostError && (
          <MachineHostError
            className="pb-2"
            error={hostError}
            onRestarted={() => {
              clearMachineHostError();
              void refreshMachineHost();
            }}
            onFailed={setMachineHostError}
          />
        )}
        {host.ready && view && !view.status && <p className="pb-2 text-[12.5px] text-muted-foreground">The TerminalX runtime cannot be reached, so {thisComputer} cannot be operated right now.</p>}
        {view?.status?.error && <p role="alert" className="pb-2 text-[12.5px] text-destructive">{view.status.error}</p>}
      </div>
      {/* Where this Mac listens for computers and phones (PRO-487). Shown with the switch off too: the phone listener follows it. */}
      {listenStatus && (
        <RegisteredSetting setting="machines.listen">
          <div className="border-b border-hairline py-3">
            <MachineHosting name={ThisComputer} status={listenStatus} runsAs={view?.status?.runsAs ?? null} busy={host.busy} onChange={(listen, allowPublic) => void setMachineListen(listen, allowPublic)} />
          </div>
        </RegisteredSetting>
      )}
      <div className="border-b border-hairline py-1.5">
        <ThisMac machineId={view?.status?.machineId ?? null} />
      </div>
      <RegisteredSetting setting="machines.yours">
        <section className="mt-6">
          <YourMachines onOpen={onOpen} />
        </section>
      </RegisteredSetting>
      <RegisteredSetting setting="machines.computers">
        <section className="mt-6">
          <h3 className={heading}>Computers that can operate {thisComputer}</h3>
          <p className={cn(soft, "mt-0.5")}>Each has its own credential. Revoking one closes its connection at once.</p>
          {/* A code is how a computer joins this list, so it is made here: nothing sits between This Mac and Your machines (21.02, PRO-398). */}
          {allow && (
            <RegisteredSetting setting="machines.pairingCode">
              <div className="mt-2.5">
                <PairingCode />
              </div>
            </RegisteredSetting>
          )}
          <ComputerList computers={view?.status?.computers ?? []} busy={host.busy} />
          <ActivityLog />
        </section>
      </RegisteredSetting>
    </div>
  );
}

/**
 * "This Mac": the name other computers see (the same setting as Account →
 * This Mac's name) and the key label they show beside it, with Rename.
 */
function ThisMac({ machineId }: { machineId: string | null }) {
  const { revision } = useSettingsFile();
  const [name, setName] = useState<MachineName | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.machineName())
      .then((found) => live && setName(found ?? null))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [revision]);

  const save = async (next: string) => {
    setSaving(true);
    setError(null);
    try {
      setName(await api.setMachineName(next));
      setDraft(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const typed = draft?.trim() ?? "";
  const label = keyLabel(machineId);

  const description =
    draft === null ? (
      <span data-testid="this-mac">
        Shown to other computers as <span className="text-foreground">{name?.name ?? "…"}</span>
        {label && (
          <>
            {" "}· fingerprint <span className="font-mono text-[12px]" title={`A label for ${thisComputer}’s key. Pairing compares a separate four-group fingerprint.`}>{label}</span>
          </>
        )}
      </span>
    ) : (
      <form
        className="mt-1 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (typed) void save(typed);
        }}
      >
        <input
          autoFocus
          aria-label={`${ThisComputer}’s name`}
          value={draft}
          maxLength={80}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setDraft(null);
          }}
          className="h-7 w-64 min-w-0 rounded-md border border-hairline bg-background px-2 text-[12.5px] outline-none focus:border-border"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={saving || !typed || typed === name?.name}>
          {saving ? <LoaderCircle className="animate-spin" /> : null} Save
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
          Cancel
        </Button>
      </form>
    );

  return (
    <>
      <RegisteredSetting
        setting="machines.thisMac"
        description={description}
        control={
          draft === null ? (
            <Button size="sm" variant="outline" className="shrink-0" disabled={!name} onClick={() => name && setDraft(name.name)}>
              Rename
            </Button>
          ) : undefined
        }
      />
      {error && <p role="alert" className="pb-2 text-[12.5px] text-destructive">{error}</p>}
    </>
  );
}

/** The code another computer pastes in Add a machine. Only `createCode` returns it; the status knows its expiry. */
function PairingCode() {
  const status = useMachineHost().view?.status ?? null;
  const [made, setMade] = useState<MachinePairingCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pausedLeft = useSecondsLeft(status?.pausedUntil ?? null);
  // The status ends the code when it is used, replaced or runs out: show it only while it is the live one.
  const live = made && status?.code?.expiresAt === made.expiresAt ? made : null;
  const left = useSecondsLeft(live?.expiresAt ?? null);
  const otherLive = !live && status?.code ? status.code : null;
  const otherLeft = useSecondsLeft(otherLive?.expiresAt ?? null);
  const paused = pausedLeft > 0;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setMade(await createMachineCode());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!live) return;
    await navigator.clipboard.writeText(live.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-6">
        <p className={cn(soft, "min-w-0 flex-1")}>To add a computer, create a pairing code and paste it in Add a machine there. Allow it here only if both screens show the same fingerprint.</p>
        <Button className="shrink-0" size="sm" variant="outline" disabled={busy || paused || !status} onClick={() => void create()}>
          {busy ? <LoaderCircle className="animate-spin" /> : null} {live ? "Create a new code" : "Create pairing code"}
        </Button>
      </div>
      {live && left > 0 && (
        <div className="grid gap-1.5" data-testid="machine-pairing-code">
          <code className="block break-all rounded-lg border border-hairline-strong bg-well px-3 py-2 font-mono text-[12.5px] leading-[19px]">{live.code}</code>
          <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <span aria-live="polite">Expires in {minutesSeconds(left)} · works once</span>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void copy()}>
              {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy code"}
            </Button>
          </div>
        </div>
      )}
      {otherLive && otherLeft > 0 && <p className={soft}>A code made earlier works for {minutesSeconds(otherLeft)} more. Creating a new code ends it.</p>}
      {paused && (
        <p role="status" className="text-[12.5px] text-warning">Pairing is paused after too many wrong codes. Try again in {minutesSeconds(pausedLeft)}.</p>
      )}
      {error && <MachineHostError error={error} onRestarted={() => void create()} onFailed={setError} />}
    </div>
  );
}

/**
 * Machines this Mac can operate, from the same store as the sidebar, so a
 * machine paired or removed here shows there at once.
 */
function YourMachines({ onOpen }: { onOpen: (machineId: string) => void }) {
  const store = useMachineConnections();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<PairedMachine | null>(null);
  useEffect(() => {
    void refreshPairedMachines();
  }, []);

  return (
    <>
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h3 className={heading}>Your machines</h3>
          <p className={cn(soft, "mt-0.5")}>Computers {thisComputer} can operate. Each one appears as a section in the sidebar.</p>
        </div>
        <Button className="shrink-0" onClick={() => setAdding(true)}>
          <Plus /> Add a machine
        </Button>
      </div>
      {store.error && <p role="alert" className="mt-2 text-[12.5px] text-destructive">{store.error}</p>}
      {store.machines.length > 0 && (
        <ul className="mt-2.5 grid grid-cols-1 gap-2" aria-label="Your machines">
          {store.machines.map((machine) => (
            <MachineCard key={machine.machineId} machine={machine} onOpen={() => onOpen(machine.machineId)} onRemove={() => setRemoving(machine)} />
          ))}
        </ul>
      )}
      {store.ready && store.machines.length === 0 && !store.error && <MachinesFirstRun />}
      <AddMachineDialog open={adding} onOpenChange={setAdding} onPaired={() => void refreshPairedMachines()} />
      <RemoveMachineDialog machine={removing} onClose={() => setRemoving(null)} />
    </>
  );
}

/**
 * Your machines with none paired (PRO-360): how to start, in three steps, and
 * the guide. No 21.xx screen shows this state; it is 21.02's bordered card
 * with 21.06's numbered steps.
 */
function MachinesFirstRun() {
  const step = "text-[12px] leading-[18px] text-muted-foreground";
  return (
    <div className="mt-2.5 rounded-lg border border-hairline px-4 py-3.5" data-testid="machines-first-run">
      <p className="text-[13px] font-medium">No machines yet</p>
      <p className={cn(soft, "mt-0.5")}>Add a Mac, a Windows PC or a Linux server that runs TerminalX. Its sessions run there, and {thisComputer} shows them in the sidebar.</p>
      <ol className="mt-3 grid gap-3" aria-label="How to add a machine">
        <StepRow n={1} title="Get the other computer ready">
          <p className={step}>On a Mac or a Windows PC, open Settings → Machines there and turn on letting other computers operate it. On a Linux server, install TerminalX and run terminalx-serve pair.</p>
        </StepRow>
        <StepRow n={2} title="Add it here">
          <p className={step}>Choose Add a machine: from your account, with a pairing code, or as a headless server. Check that both screens show the same fingerprint, then choose Allow on the other computer.</p>
        </StepRow>
        <StepRow n={3} title="Start a session there">
          <p className={step}>It appears as a section in the sidebar. Start a session from its +, or choose it under Where it runs in a new session.</p>
        </StepRow>
      </ol>
      <div className="mt-3">
        <GuideLink />
      </div>
    </div>
  );
}

const connectedState = (state: MachineConnectionState) => state.state === "direct" || state.state === "relay";

/** The state beside a machine's name on its card (21.02). */
function CardState({ state }: { state: MachineConnectionState }) {
  if (state.state === "needsUpdate") {
    return <span className="inline-flex h-5 items-center rounded bg-warning/12 px-1.5 text-[12px] font-medium whitespace-nowrap text-warning">Needs update</span>;
  }
  const label: Record<MachineConnectionState["state"], string> = {
    idle: "Not connected",
    connecting: "Connecting",
    direct: "Connected",
    relay: "Connected",
    reconnecting: "Reconnecting",
    offline: "Offline",
    updating: "Updating",
    needsUpdate: "Needs update",
    accessRemoved: "Access removed",
    disconnected: "Disconnected",
  };
  return (
    <span className={cn("flex items-center gap-1 text-[12px] font-normal", toneText(machineTone(state)))} data-testid="machine-card-state">
      <MachineStateMark state={state} />
      {label[state.state]}
    </span>
  );
}

/** The card's second line: system, version, route and running sessions, or why it cannot be used. */
function cardLine(machine: PairedMachine, state: MachineConnectionState, running: number | null): string {
  const system = [osLabel(machine.os), machine.hasWindow === false ? "headless" : null].filter(Boolean).join(" · ");
  switch (state.state) {
    case "needsUpdate":
      return `TerminalX ${state.version ?? machine.version} · some features are hidden until it is updated`;
    case "offline": {
      const seen = state.lastSeenAt ?? machine.lastSeenAt;
      return seen ? `${system} · last seen ${seenText(seen)}` : `${system} · not reached yet`;
    }
    case "accessRemoved":
      return `${machine.name} no longer lets ${thisComputer} operate it. Remove it here, or pair again.`;
    case "disconnected":
      return `${machine.name} disconnected ${thisComputer}. Try again once it lets ${thisComputer} back.`;
    case "direct":
    case "relay":
      return [system, `TerminalX ${machine.version}`, routeLabel(state.route.kind), running === null ? null : runningText(running)].filter(Boolean).join(" · ");
    default:
      return `${system} · TerminalX ${machine.version}`;
  }
}

/**
 * One machine this Mac operates. Choosing it opens the machine's page; the menu removes it.
 * A connected machine that does not grant a feature this Mac uses says Needs update, as one
 * whose connection says so does, with Update when it can be updated from here and otherwise
 * where to update it (PRO-354).
 */
export function MachineCard({ machine, onOpen, onRemove }: { machine: PairedMachine; onOpen: () => void; onRemove: () => void }) {
  const store = useMachineConnections();
  const { state, connection } = machineConnection(store, machine.machineId);
  const running = useRunningSessions(connection, connectedState(state));
  const version = useMachineVersion(machine.machineId);
  const update = useUpdateAction(machine.machineId, version);
  const needsUpdate = !!version.gap;
  const shown = version.shownState;
  const label = keyLabel(machine.machineId);
  const dim = state.state === "offline" || state.state === "idle";
  return (
    <li className="group relative" data-testid="paired-machine" data-machine={machine.machineId} data-state={state.state} data-needs-update={needsUpdate || undefined}>
      <button
        type="button"
        className={cn(card, "w-full text-left outline-none transition-colors hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-ring/40", needsUpdate && update.available ? "pr-36" : "pr-12")}
        aria-label={`Open ${machine.name}`}
        onClick={() => openCloudWorkspace(machineSectionKey(machine.machineId))}
      >
        <span className={iconBox}>
          <MachineIcon machine={machine} className="size-[15px] text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("flex min-w-0 items-center gap-2 text-[13px] font-medium", dim && "text-muted-foreground")}>
            <span className="truncate">{machine.name}</span>
            <CardState state={shown} />
          </span>
          <span className="block truncate text-[12px] text-faint" data-testid="paired-machine-line">{cardLine(machine, shown, running)}</span>
          {needsUpdate && update.note && <span className="block truncate text-[12px] text-faint" data-testid="paired-machine-update-note">{update.note}</span>}
        </span>
        {label && <span className="shrink-0 font-mono text-[12px] text-faint">{label}</span>}
        <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />
      </button>
      {needsUpdate && <UpdateButton action={update} variant="outline" className="absolute right-16 top-1/2 -translate-y-1/2" />}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`More for ${machine.name}`}
            className="absolute right-8 top-1/2 -translate-y-1/2 text-faint opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* Its page (21.10): version, updates and details (PRO-354). */}
          <DropdownMenuItem onSelect={onOpen}>
            <Info /> Version and updates…
          </DropdownMenuItem>
          <DropdownMenuItem className="text-destructive" onSelect={onRemove}>
            <Trash2 /> Remove from {thisComputer}…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function ComputerList({ computers, busy }: { computers: PairedComputer[]; busy: boolean }) {
  if (computers.length === 0) return <p className="mt-3 text-[12.5px] text-faint">No computer can operate {thisComputer}.</p>;
  return (
    <ul className="mt-2.5 grid grid-cols-1 gap-2" aria-label={`Computers that can operate ${thisComputer}`}>
      {computers.map((computer) => (
        <ComputerRow key={computer.id} computer={computer} busy={busy} />
      ))}
    </ul>
  );
}

function computerLine(computer: PairedComputer): string {
  const platform = computer.platform ? osLabel({ family: computer.platform, version: null }) : null;
  const how = computer.disconnectedAt
    ? `disconnected ${seenText(computer.disconnectedAt)}, until you let it back`
    : computer.connected
      ? computer.route
        ? routeLabel(computer.route)
        : null
      : computer.lastSeenAt
        ? `last seen ${seenText(computer.lastSeenAt)}`
        : "not connected yet";
  return [platform, how, `approved ${shortDate(computer.approvedAt)}`].filter(Boolean).join(" · ");
}

/**
 * One computer that may operate this Mac. While it is connected, Disconnect
 * closes its connection and holds it off until Let back (PRO-357); Revoke
 * asks once: it ends the credential and closes the connection.
 */
function ComputerRow({ computer, busy }: { computer: PairedComputer; busy: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const label = keyLabel(computer.keyId);
  const held = computer.disconnectedAt != null;
  return (
    <li className={cn(card, confirming && "flex-wrap")} data-testid="operating-computer">
      <span className={iconBox}>
        <PlatformIcon platform={computer.platform} className="size-[15px] text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
          <span className="truncate">{computer.label}</span>
          {computer.connected && !held && (
            <span className="flex shrink-0 items-center gap-1 text-[12px] font-normal text-add" data-testid="computer-connected">
              <span className="size-1.5 rounded-full bg-add" aria-hidden />
              Connected now
            </span>
          )}
          {held && (
            <span className="flex shrink-0 items-center gap-1 text-[12px] font-normal text-warning" data-testid="computer-disconnected">
              <span className="size-1.5 rounded-full bg-warning" aria-hidden />
              Disconnected
            </span>
          )}
        </div>
        <div className="truncate text-[12px] text-faint">{computerLine(computer)}</div>
      </div>
      {label && <span className="shrink-0 font-mono text-[12px] text-faint">{label}</span>}
      {confirming ? (
        <div className="flex w-full flex-wrap items-center gap-2 pb-1 pl-11" role="group" aria-label={`Revoke ${computer.label}`}>
          <span className="mr-auto min-w-0 text-[12.5px] text-muted-foreground">
            Ends {computer.label}’s credential and closes its connection. It does not undo what it already did on {thisComputer}.
          </span>
          <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>Keep</Button>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void revokeComputer(computer.id).then(() => setConfirming(false))}>
            Revoke
          </Button>
        </div>
      ) : (
        <>
          {held ? (
            <Button size="sm" variant="outline" className="ml-1 shrink-0" disabled={busy} onClick={() => void letComputerBack(computer.id)}>
              Let back
            </Button>
          ) : (
            computer.connected && (
              <Button size="sm" variant="outline" className="ml-1 shrink-0" disabled={busy} onClick={() => void disconnectComputer(computer.id)}>
                Disconnect
              </Button>
            )
          )}
          <Button size="sm" variant="ghost" className="shrink-0 text-[13px] text-destructive hover:text-destructive" disabled={busy} onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        </>
      )}
    </li>
  );
}

const ROUTE_WORDS: Record<string, string> = { lan: "on this network", tailscale: "over Tailscale", relay: "through Relay" };

/** One line of the activity log, in words. Never more than a name, a project, a route or a version. */
export function activityText(entry: MachineActivityEntry): string {
  const who = entry.computer || "A computer";
  const detail = entry.detail ?? null;
  switch (entry.kind) {
    case "paired":
      return `${who} was allowed to operate ${thisComputer}`;
    case "connected":
      return [`${who} connected`, detail ? ROUTE_WORDS[detail] ?? null : null].filter(Boolean).join(" ");
    case "disconnected":
      return `${who} disconnected`;
    case "sessionCreated":
      return detail ? `${who} started a session in ${detail}` : `${who} started a session`;
    case "terminalOpened":
      return detail ? `${who} opened a terminal in ${detail}` : `${who} opened a terminal`;
    case "projectAdded":
      return detail ? `Project ${detail} was added while a computer was connected` : `A project was added while a computer was connected`;
    case "projectRemoved":
      return detail ? `Project ${detail} was removed while a computer was connected` : `A project was removed while a computer was connected`;
    case "update":
      return detail ? `${who} asked to update TerminalX to ${detail}` : `${who} asked to update TerminalX`;
    case "revoked":
      return `${who}’s access was revoked`;
    case "expired":
      return `${who}’s access expired after 90 days unused`;
    case "held":
      return `${who} was disconnected until let back`;
    case "letBack":
      return `${who} was let back`;
    default:
      return `${who}: an event from a newer TerminalX`;
  }
}

/**
 * What operating computers did on this Mac (PRO-357): the last 200 entries,
 * newest first, read again whenever the host changes and while the page is open.
 */
function ActivityLog() {
  const view = useMachineHost().view;
  const [entries, setEntries] = useState<MachineActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      machinesApi
        .activity()
        .then((found) => {
          if (!live) return;
          setEntries(Array.isArray(found) ? found : []);
          setError(null);
        })
        .catch((e) => live && setError(errorMessage(e)));
    void read();
    const timer = window.setInterval(() => void read(), 15_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [view]);

  return (
    <div className="mt-5" data-testid="machine-activity">
      <h4 className="text-[13px] font-medium">Activity</h4>
      <p className={cn(soft, "mt-0.5")}>Connections, sessions and terminals opened, and changes to access, with the computer and the time. Never what was typed or a file’s contents. The last 200 are kept.</p>
      {error && <p role="alert" className="mt-2 text-[12.5px] text-destructive">{error}</p>}
      {entries && entries.length === 0 && !error && <p className="mt-2 text-[12.5px] text-faint">Nothing yet.</p>}
      {entries && entries.length > 0 && (
        <ul className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-hairline" aria-label={`Activity on ${thisComputer}`}>
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="flex items-baseline gap-3 border-b border-hairline px-3 py-1.5 text-[12.5px] last:border-b-0" data-kind={entry.kind}>
              <span className="min-w-0 flex-1 truncate">{activityText(entry)}</span>
              <time className="shrink-0 text-[12px] text-faint" dateTime={new Date(entry.at).toISOString()}>{seenText(entry.at)}</time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
