import { useEffect, useId, useRef, useState } from "react";
import { Tabs } from "radix-ui";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/menu";
import { Avatar, AvatarStack, type AvatarPerson } from "@/components/ui/avatar";
import { Chip, ChipButton } from "@/components/ui/chip";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { SurfaceSection, SurfaceState, type SurfaceStatus } from "@/components/ui/SurfaceState";
import { surfaceIds, surfaceMessage, teamSurfaceDesigns, type TeamSurfaceId } from "./teamSurfaceStates";

export interface TeamPreviewData {
  people: readonly AvatarPerson[];
  workspace: string;
  organization: string;
  plan: string;
  automation: string;
  port: number | null;
  remotePort?: number | null;
  forwardState?: "forwarded" | "opening" | "closed";
  profile?: { email?: string; role?: string; joined?: string };
  billing?: { seats?: string; payer?: string; nextCharge?: string };
  schedule?: { trigger?: string; runs?: string; lastRun?: string; nextRun?: string; created?: string };
}

export interface TeamExampleProps {
  data: TeamPreviewData;
  state: "ready" | SurfaceStatus;
  /** Explicit fixture authority. A feature must derive this from its actual contract. */
  canAct: boolean;
  onAction: (action: string) => void;
}

const row = "flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-hairline p-3";
const field = "min-h-8 max-w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-foreground";

function ReadyExample({ surface, data, canAct, onAction }: TeamExampleProps & { surface: TeamSurfaceId }) {
  const first = data.people[0];
  const action = (label: string) => <Button variant="outline" size="sm" disabled={!canAct} onClick={() => onAction(label)}>{label}</Button>;
  switch (surface) {
    case "presence":
      return <div className="space-y-3"><AvatarStack people={data.people} label="In this workspace" /><ul className="space-y-2">{data.people.map((person) => <li key={person.id} className="flex min-w-0 items-center gap-2"><Avatar name={person.name} photoUrl={person.photoUrl} presence={person.presence} decorative /><span className="min-w-0 break-words">{person.name}</span><Chip>{person.presence === "unknown" ? "Presence unavailable" : person.presence}</Chip></li>)}</ul></div>;
    case "profile":
      return <div className="space-y-3"><div className="flex min-w-0 items-center gap-2"><Avatar name={first.name} photoUrl={first.photoUrl} presence={first.presence} size="md" decorative /><p className="min-w-0 break-words font-medium">{first.name}</p></div><p className="break-words text-xs text-muted-foreground">{data.organization || "Organization not supplied"}</p><dl className="grid grid-cols-2 gap-2 text-xs">{[["Role", data.profile?.role], ["Email", data.profile?.email], ["Joined", data.profile?.joined]].map(([label, value]) => value ? <div key={label} className="contents"><dt>{label}</dt><dd className="min-w-0 break-words select-text">{value}</dd></div> : null)}</dl>{action("Copy name")}{data.profile?.email && action("Copy email")}</div>;
    case "mention":
      return <div className="flex flex-wrap items-center gap-2"><Popover><PopoverTrigger asChild><ChipButton aria-label={`View profile for ${first.name}`}><Avatar name={first.name} photoUrl={first.photoUrl} presence={first.presence} decorative /><span className="min-w-0 break-words">@{first.name}</span></ChipButton></PopoverTrigger><PopoverContent label="Mentioned person"><ReadyExample surface="profile" data={data} state="ready" canAct={canAct} onAction={onAction} /></PopoverContent></Popover>{action("Remove mention")}</div>;
    case "following":
      return <ul><li className={row}><Button variant="ghost" className="h-auto min-h-8 min-w-0 whitespace-normal break-words text-left" onClick={() => onAction("Open followed workspace")}>{data.workspace}</Button><Chip>Following</Chip>{action("Unfollow")}</li></ul>;
    case "share":
      return null; // ShareDialogExample owns the persistent draft across state changes.
    case "onboarding":
      return <div className="space-y-4"><ol aria-label="Setup progress" className="flex flex-wrap gap-2 text-xs"><li>Organization</li><li aria-current="step"><Chip>Connect services</Chip></li><li>Review setup</li></ol><div className="space-y-2"><h3 className="text-sm font-medium">Connect services</h3><p className="text-xs text-muted-foreground">Choose a service to connect. Opening this step does not start a workspace.</p>{action("Connect a service")}</div><div className="flex flex-wrap justify-between gap-2">{action("Back")}{action("Review setup")}</div></div>;
    case "billing":
      return <div className="space-y-3"><Chip>{data.plan}</Chip><p className="break-words text-xs">{data.organization || "Organization not supplied"}</p><dl className="grid grid-cols-2 gap-2 text-xs"><dt>Seats</dt><dd className="min-w-0 break-words tabular-nums">{data.billing?.seats || "Not supplied"}</dd><dt>Next charge</dt><dd className="min-w-0 break-words">{data.billing?.nextCharge || "Not supplied"}</dd><dt>Payer</dt><dd className="min-w-0 break-words">{data.billing?.payer || "Not supplied"}</dd></dl>{action("Open billing")}</div>;
    case "automations":
      return <AutomationExample data={data} canAct={canAct} onAction={onAction} />;
    case "ports":
      return <PortsExample data={data} canAct={canAct} onAction={onAction} />;
    case "desktop":
      return <DesktopExample canAct={canAct} onAction={onAction} />;
  }
}

function AutomationExample({ data, canAct, onAction }: Pick<TeamExampleProps, "data" | "canAct" | "onAction">) {
  const [filter, setFilter] = useState("show");
  const prefix = useId();
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-3"><label htmlFor={`${prefix}-organization`} className="flex min-w-0 flex-col gap-1 text-xs">Organization<select id={`${prefix}-organization`} className={field} value={data.organization} onChange={() => onAction("Select organization")}><option value={data.organization}>{data.organization || "Organization not supplied"}</option></select></label><label htmlFor={`${prefix}-filter`} className="flex flex-col gap-1 text-xs">Automations filter<select id={`${prefix}-filter`} className={field} value={filter} onChange={(event) => setFilter(event.target.value)}><option value="show">Show automations</option><option value="hide">Hide automations</option><option value="only">Only automations</option></select></label></div>
    {filter === "hide" ? <SurfaceState status="empty" title="Automations are hidden" description="Change the filter to show automations." /> : <ul><li className="space-y-3 rounded-lg border border-hairline p-3"><h3 className="break-words text-sm font-medium">{data.automation}</h3><dl className="grid grid-cols-2 gap-2 text-xs">{[["Workspace", data.workspace], ["Trigger", data.schedule?.trigger], ["Runs", data.schedule?.runs], ["Created", data.schedule?.created], ["Last run", data.schedule?.lastRun], ["Next run", data.schedule?.nextRun], ["Author", data.people[0]?.name]].map(([label, value]) => <div key={label} className="contents"><dt>{label}</dt><dd className="min-w-0 break-words tabular-nums">{value || "Not supplied"}</dd></div>)}</dl><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={!canAct} onClick={() => onAction("Run now")}>Run now</Button><Button variant="outline" size="sm" onClick={() => onAction("Runs")}>Runs</Button><DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="sm">Automation actions</Button></DropdownMenuTrigger><DropdownMenuContent aria-label="Automation actions">{["Edit", "Duplicate", "Copy link"].map((label) => <DropdownMenuItem key={label} disabled={!canAct} onSelect={() => onAction(label)}>{label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></div></li></ul>}
  </div>;
}

function PortsExample({ data, canAct, onAction }: Pick<TeamExampleProps, "data" | "canAct" | "onAction">) {
  const active = data.forwardState === "forwarded";
  return <div className="space-y-3"><dl className="grid grid-cols-2 gap-2 text-xs"><dt>Workspace port</dt><dd className="font-mono">{data.remotePort}</dd><dt>Local address</dt><dd className="min-w-0 break-all font-mono">{active ? `127.0.0.1:${data.port}` : "No active local listener"}</dd></dl><Chip>{active ? "Forwarded · Local only" : data.forwardState === "opening" ? "Opening forward…" : "Forward ended"}</Chip><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={!canAct || !active} onClick={() => onAction("Open preview")}>Open preview</Button><Button variant="outline" size="sm" disabled={!canAct || !active} onClick={() => onAction("Stop forwarding")}>Stop forwarding</Button></div><label className="flex items-start gap-2 text-xs"><input type="checkbox" disabled />Forward new ports automatically</label><p className="text-xs text-muted-foreground">Automatic forwarding awaits PRO-223. This page opens no listeners.</p></div>;
}

function DesktopExample({ canAct, onAction }: Pick<TeamExampleProps, "canAct" | "onAction">) {
  const viewport = useRef<HTMLDivElement>(null);
  const leave = useRef<HTMLButtonElement>(null);
  return <Tabs.Root defaultValue="desktop" activationMode="manual" className="space-y-3"><Tabs.List aria-label="Workspace preview tabs" className="flex flex-wrap gap-2"><Tabs.Trigger value="conversation" asChild><Button variant="outline" size="sm">Conversation</Button></Tabs.Trigger><Tabs.Trigger value="desktop" asChild><Button variant="outline" size="sm">Desktop</Button></Tabs.Trigger></Tabs.List><Tabs.Content value="conversation" className="text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-foreground">Conversation content belongs to the existing session view; none is mounted in this fixture.</Tabs.Content><Tabs.Content value="desktop" className="space-y-3 focus-visible:outline-2 focus-visible:outline-foreground">
    <div className="flex flex-wrap items-center justify-between gap-2"><Chip>{canAct ? "Input allowed by caller" : "View only"}</Chip><Button variant="outline" size="sm" onClick={() => onAction("Reconnect desktop")}>Reconnect</Button></div>
    <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => viewport.current?.focus()}>Focus desktop viewport</Button><Button ref={leave} variant="outline" size="sm" onClick={() => leave.current?.focus()}>Leave desktop controls</Button></div>
    <div ref={viewport} role="region" aria-label="Cloud desktop viewport" tabIndex={0} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); leave.current?.focus(); } }} className="min-h-40 rounded-lg border border-hairline bg-well p-4 text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-foreground">Viewport slot for the existing VncView. No remote desktop is connected in this review fixture.</div>
    <p className="text-xs text-muted-foreground">Escape from the viewport returns to Leave desktop controls. Remote keyboard capture and input admission remain with PRO-206.</p>
  </Tabs.Content></Tabs.Root>;
}

const initialShareDraft = { recipientId: null as string | null, level: "viewer", approve: false };

function ShareDialogExample({ data, state, canAct, onAction }: TeamExampleProps) {
  const prefix = useId();
  const [open, setOpen] = useState(false);
  const [seenReady, setSeenReady] = useState(false);
  const [draft, setDraft] = useState<typeof initialShareDraft>(() => ({ ...initialShareDraft, recipientId: data.people[0]?.id ?? null }));
  const dialogContent = useRef<HTMLDivElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const [discarding, setDiscarding] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const recipient = data.people.find((person) => person.id === draft.recipientId);
  const dirty = draft.level !== initialShareDraft.level || draft.approve !== initialShareDraft.approve;
  useEffect(() => { if (discarding) keepEditing.current?.focus(); }, [discarding]);
  // Offline/error preserve choices; a revoked scope cannot keep a sensitive draft.
  useEffect(() => { if (state === "ready") setSeenReady(true); if (state === "no-access") { setSeenReady(false); setDraft(initialShareDraft); setDiscarding(false); setReviewing(false); dialogContent.current?.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.focus(); } }, [state]);
  useEffect(() => { if ((state === "ready" || state === "empty") && draft.recipientId && !recipient) { setDraft(initialShareDraft); setReviewing(false); } }, [state, draft.recipientId, recipient]);
  const requestOpen = (next: boolean) => { if (!next && dirty && state !== "no-access") setDiscarding(true); else setOpen(next); };
  const closeDiscarding = () => { setDraft({ ...initialShareDraft, recipientId: recipient?.id ?? null }); setDiscarding(false); setReviewing(false); setOpen(false); };
  const message = state !== "ready" ? <SurfaceState {...surfaceMessage("share", state)} action={state === "error" ? { label: "Try again", onAction: () => onAction("Retry share") } : undefined} /> : null;
  const choices = <div className="space-y-4">
      <label className="flex flex-col gap-1 text-xs" htmlFor={`${prefix}-recipient`}>Person to share with<select id={`${prefix}-recipient`} className={field} disabled={!canAct || state !== "ready"} value={recipient?.id ?? ""} onChange={(event) => { setDraft({ ...initialShareDraft, recipientId: event.target.value || null }); setReviewing(false); }}><option value="">Choose a person</option>{data.people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
      {recipient ? <>
      <p className="break-words text-sm">{data.workspace}</p><div className={row}><span className="min-w-0 break-words">{recipient.name}</span><label className="flex flex-col gap-1 text-xs" htmlFor={`${prefix}-level`}>Access level<select id={`${prefix}-level`} className={field} disabled={!canAct || state !== "ready"} value={draft.level} onChange={(event) => setDraft({ ...draft, level: event.target.value })}><option value="viewer">View only</option><option value="driver">Can send</option><option disabled>Admin — pending PRO-167</option></select></label></div>
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" disabled={!canAct || state !== "ready"} checked={draft.approve} onChange={(event) => setDraft({ ...draft, approve: event.target.checked })} />Can approve permissions (separate from sending)</label>
      <label className="flex flex-col gap-1 text-xs" htmlFor={`${prefix}-general`}>General access<select id={`${prefix}-general`} className={field} disabled defaultValue="invited"><option value="invited">Only people invited</option><option value="everyone">Everyone at the organization — pending PRO-167</option></select></label>
      <p className="text-xs text-muted-foreground">Organization visibility alone does not grant content access. General access awaits PRO-167; review every access change before saving.</p><DialogFooter><Button variant="outline" size="sm" disabled={!canAct || state !== "ready"} onClick={() => setReviewing(true)}>Review access changes</Button></DialogFooter>
      </> : <p className="text-xs text-muted-foreground">Choose a person before reviewing access. An unavailable recipient is never replaced automatically.</p>}
    </div>;
  const retaining = seenReady && (state === "offline" || state === "error");
  return <Dialog open={open} onOpenChange={requestOpen}><DialogTrigger asChild><Button variant="outline">Review Share dialog</Button></DialogTrigger><DialogContent ref={dialogContent} showClose={!discarding} className="motion-reduce:animate-none" onEscapeKeyDown={(event) => { if (discarding) { event.preventDefault(); setDiscarding(false); } }}>
    <DialogHeader><DialogTitle>{discarding ? "Discard access choices?" : "Share workspace"}</DialogTitle><DialogDescription>Design review only. No access changes are sent.</DialogDescription></DialogHeader>
    {discarding ? <><p className="text-sm">Your unsaved access choices will be discarded.</p><DialogFooter><Button ref={keepEditing} variant="outline" onClick={() => setDiscarding(false)}>Keep editing</Button><Button variant="destructive" onClick={closeDiscarding}>Discard choices</Button></DialogFooter></> : message ? <>{message}{retaining && choices}</> : (reviewing && recipient ? <div className="space-y-3"><h3 className="text-sm font-medium">Review access choices</h3><p className="break-words text-xs">{recipient.name}: {draft.level === "viewer" ? "View only" : "Can send"}; {draft.approve ? "can approve permissions" : "cannot approve permissions"}.</p><p className="text-xs text-muted-foreground">This preview cannot save access. PRO-171 owns the actual draft diff and confirmed save.</p><DialogFooter><Button variant="outline" onClick={() => setReviewing(false)}>Back to choices</Button><Button disabled={!canAct} onClick={() => onAction("Review access choices")}>Report preview choice</Button></DialogFooter></div> : choices)}
  </DialogContent></Dialog>;
}

function hasPreviewData(surface: TeamSurfaceId, data: TeamPreviewData) {
  if (["presence", "profile", "mention"].includes(surface)) return data.people.length > 0;
  if (surface === "following") return !!data.workspace.trim();
  if (surface === "share") return !!data.workspace.trim() && data.people.length > 0;
  if (surface === "billing") return !!data.plan.trim();
  if (surface === "automations") return !!data.automation.trim();
  if (surface === "ports") return data.port !== null && data.remotePort != null && data.forwardState != null;
  return true;
}

/** Executable composition examples only; no production imports, store, network or credentials. */
export function TeamSurfaceExample({ surface, ...props }: TeamExampleProps & { surface: TeamSurfaceId }) {
  const { title, contract } = teamSurfaceDesigns[surface];
  const [open, setOpen] = useState(false);
  const effectiveState = props.state === "ready" && !hasPreviewData(surface, props.data) ? "empty" : props.state;
  const content = effectiveState === "ready" ? <ReadyExample surface={surface} {...props} /> : <SurfaceState {...surfaceMessage(surface, effectiveState)} action={effectiveState === "error" ? { label: "Try again", onAction: () => props.onAction(`Retry ${surface}`) } : undefined} />;
  return (
    <SurfaceSection title={title} description={contract}>
      {surface === "profile" || surface === "ports" ? <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button variant="outline">{surface === "profile" ? "Open profile" : "Forward ports"}</Button></PopoverTrigger><PopoverContent label={title}>{content}</PopoverContent></Popover>
        : surface === "share" ? <ShareDialogExample key={JSON.stringify([props.data.organization, props.data.workspace])} {...props} state={effectiveState} />
          : content}
    </SurfaceSection>
  );
}

export function TeamSurfaceExamples(props: TeamExampleProps) {
  return <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">{surfaceIds.map((surface) => <TeamSurfaceExample key={surface} surface={surface} {...props} />)}</div>;
}
