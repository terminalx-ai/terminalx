import { PrivacyImage } from "@/components/ui/privacy-image";
import { thisComputer } from "@/lib/platform";
import { useDataPrivacy, PRIVACY_MESSAGE } from "@/lib/dataPrivacy";
import { PrivacyEmptyState } from "@/components/settings/DataPrivacySettings";
import { useEffect, useState } from "react";
import { ChevronDown, Copy, Eye, Link2, Lock, Plus, RadioTower, ShieldAlert, ShieldCheck, StickyNote, Terminal, UserPlus, X } from "@/icons";
import { Segmented, Switch } from "@/components/ui/controls";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { agent } from "@/lib/api";
import { modeIsUnguarded, modeLabel, PERMISSION_MODES } from "@/lib/models";
import { conversationTitle, useSessionStore } from "@/lib/sessions";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { CollaborationScene } from "./CollaborationScene";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { changeShare, closeSessionShare, createShare, defaultShareSettings, isWaitingGuest, longestShareExpiry, MAX_SHARE_PEOPLE, openSessionShare, refreshShare, type ShareLink, type ShareRole, type ShareSettings, type ShareState, useLocalShare, useShareDialog } from "@/lib/localSharing";
import { errorMessage } from "@/lib/api";
import { usePairing } from "@/lib/pairing";
import { useAccount, signIn } from "@/lib/account";

const field = "h-7 rounded-md border border-hairline bg-background px-2 text-[12px]";
const sectionLabel = "text-[11px] uppercase tracking-[.08em] text-faint";
const HOUR = 3_600_000;
/** A link lasts 24 hours at most from when it was made (local_sharing.rs). */
const CREDENTIAL_MS = 24 * HOUR;

const ROLE_OPTIONS = [
  { value: "viewer" as const, label: "Read only" },
  { value: "driver" as const, label: "Can drive" },
];
const AUDIENCE_OPTIONS = [
  { value: "anyone" as const, label: "Anyone signed in" },
  { value: "people" as const, label: "Only specific people" },
  { value: "organization" as const, label: "Members of my organization" },
];
/** Link expires, in minutes: how long after the link was made. */
const EXPIRY_MINUTES = [15, 60, 240, 1440] as const;
const EXPIRY_LABEL: Record<(typeof EXPIRY_MINUTES)[number], string> = { 15: "15 min", 60: "1 hour", 240: "4 hours", 1440: "24 hours" };

const roleLabel = (role: ShareRole) => (role === "driver" ? "Can drive" : "Read only");
const clockTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** When a link was made, from its credential's 24 hours; a link that does not say is taken as made now. */
function madeAt(link: ShareLink | null, now: number): number {
  return link?.credentialExpiresAt ? link.credentialExpiresAt - CREDENTIAL_MS : now;
}
/** The Link expires choice nearest the link's real expiry, so editing a 4-hour link shows 4 hours. */
function expiryChoice(expiresAt: number, made: number): (typeof EXPIRY_MINUTES)[number] {
  const minutes = (expiresAt - made) / 60_000;
  return EXPIRY_MINUTES.reduce((best, choice) => (Math.abs(choice - minutes) < Math.abs(best - minutes) ? choice : best));
}
/** The expiry a choice means: for a new link from now (24 hours as long as the host allows), for a made one from when it was made. */
function expiryFor(minutes: number, link: ShareLink | null, now: number): number {
  if (!link) return minutes === 1440 ? longestShareExpiry(now) : now + minutes * 60_000;
  const made = madeAt(link, now);
  return Math.min(made + minutes * 60_000, link.credentialExpiresAt ?? made + CREDENTIAL_MS);
}

/** One setting of the column: what it is (and a line on it) on the left, its control on the right. */
function Row({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-foreground">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-snug text-faint">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}
function RolePicker({ value, onChange, label, className }: { value: ShareRole; onChange: (role: ShareRole) => void; label: string; className?: string }) {
  return (
    <select aria-label={label} className={cn(field, className)} value={value} onChange={(event) => onChange(event.target.value as ShareRole)}>
      <option value="viewer">Read only</option>
      <option value="driver">Can drive</option>
    </select>
  );
}

/** The session's tabs in different permission modes, as the picker shows it. */
const MIXED = "__mixed__";
/** The dialog's choice of a new link while others are live. */
const NEW = "__new__";

/**
 * The link's settings, every one in view: who can join, their access, how
 * long the link lasts, approval, and how many people it admits. `link` is the
 * link being edited (its expiry choices count from when it was made), or null
 * for a new one; `extra` rows (local network only) close the column.
 */
function SettingsForm({ value, set, link, extra }: { value: ShareSettings; set: (value: ShareSettings) => void; link: ShareLink | null; extra?: React.ReactNode }) {
  const patch = (update: Partial<ShareSettings>) => set({ ...value, ...update });
  const now = Date.now();
  const made = madeAt(link, now);
  const expiry = expiryChoice(value.expiresAt, link ? made : now);
  return (
    <div className="flex flex-col" data-testid="share-settings">
      <div className="flex flex-col gap-2 pb-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] text-foreground" id="share-audience-label">Who can join</span>
          <span className="text-[11.5px] text-faint">people sign in to TerminalX first</span>
        </div>
        <Segmented
          aria-label="Who can join"
          value={value.audience}
          options={AUDIENCE_OPTIONS}
          onChange={(audience) => patch({ audience, people: audience === "people" && !value.people.length ? [{ email: "", role: value.role }] : value.people })}
          packed
          className="h-8 w-full border border-hairline"
        />
        {value.audience === "people" && (
          <div className="flex flex-col gap-2 pt-1">
            <p className="text-[11.5px] text-faint">Only verified account emails are admitted. Choose access for each person.</p>
            {value.people.map((person, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="email"
                  aria-label={`Account email ${i + 1}`}
                  placeholder="name@example.com"
                  className={`${field} min-w-0 flex-1`}
                  value={person.email}
                  onChange={(event) => patch({ people: value.people.map((p, at) => (at === i ? { ...p, email: event.target.value } : p)) })}
                />
                <RolePicker label={`Access for account ${i + 1}`} value={person.role} onChange={(role) => patch({ people: value.people.map((p, at) => (at === i ? { ...p, role } : p)) })} />
                <Button variant="ghost" size="icon-sm" aria-label={`Remove account ${i + 1}`} onClick={() => patch({ people: value.people.filter((_, at) => at !== i) })}>
                  <X />
                </Button>
              </div>
            ))}
            <Button size="sm" variant="ghost" className="self-start" onClick={() => patch({ people: [...value.people, { email: "", role: value.role }] })}>
              <Plus /> Add account
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-col divide-y divide-hairline border-t border-hairline">
        <Row label="Default access" hint="Read only watches; Can drive sends to the agent">
          <Segmented aria-label="Default access" value={value.role} options={ROLE_OPTIONS} onChange={(role) => patch({ role })} />
        </Row>
        <Row label="Link expires" hint="Revoke it at any time">
          <Segmented
            aria-label="Link expires"
            value={String(expiry)}
            // A made link counts from when it was made: a time already past is not offered.
            options={EXPIRY_MINUTES.map((minutes) => ({ value: String(minutes), label: EXPIRY_LABEL[minutes], disabled: !!link && made + minutes * 60_000 <= now + 60_000 }))}
            onChange={(minutes) => patch({ expiresAt: expiryFor(Number(minutes), link, Date.now()) })}
          />
        </Row>
        <Row label="Approve each person" hint="You let each person in before they see anything">
          <Switch aria-label="Approve each person" checked={value.approveEachPerson} onCheckedChange={(approveEachPerson) => patch({ approveEachPerson })} />
        </Row>
        <Row label="Guests may approve permissions" hint={value.canApprove ? "A driver may answer the agent's approval cards" : "Off: only you answer approval cards"}>
          <Switch aria-label="Guests may approve permissions" checked={value.canApprove} onCheckedChange={(canApprove) => patch({ canApprove })} />
        </Row>
        <div className="flex min-h-12 items-center gap-6 py-2.5">
          <label className="flex items-center gap-3 text-[13px]">
            Single use
            <Switch aria-label="Single use" checked={value.singleUse} onCheckedChange={(singleUse) => patch({ singleUse })} />
          </label>
          <label className="flex items-center gap-3 text-[13px]">
            Maximum people
            <input
              aria-label="Maximum people"
              type="number"
              min={1}
              max={MAX_SHARE_PEOPLE}
              className={`${field} h-8 w-14 text-center tabular-nums`}
              value={value.maximumPeople}
              onChange={(event) => patch({ maximumPeople: Math.min(MAX_SHARE_PEOPLE, Math.max(1, Number(event.target.value) || 1)) })}
            />
          </label>
        </div>
        {extra}
      </div>
    </div>
  );
}

/** The link column: its QR always in view, the link, Copy link and Revoke, and how it travels. */
function SecretLink({ link, revoke }: { link: ShareLink; revoke: () => void }) {
  const [qr, setQr] = useState<{ url: string; image: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void import("qrcode")
      .then(({ toDataURL }) => toDataURL(link.url, { width: 360, margin: 1 }))
      .then((image) => { if (current) setQr({ url: link.url, image }); })
      .catch((e) => { if (current) setError(errorMessage(e)); });
    return () => { current = false; };
  }, [link.url]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const image = qr?.url === link.url ? qr.image : null;
  return (
    <div className="flex flex-col items-center gap-3" data-testid="share-link">
      <div className="flex size-[180px] items-center justify-center overflow-hidden rounded-xl bg-white p-1.5">
        {image && <PrivacyImage src={image} alt="Secret share link QR code" className="size-full" />}
      </div>
      <input aria-label="Secret share link" readOnly value={link.url} onFocus={(event) => event.currentTarget.select()} className={`${field} h-8 w-full font-mono text-[11.5px] text-muted-foreground`} />
      <div className="flex w-full gap-2">
        <Button size="sm" className="flex-1" onClick={() => void copy()}>
          <Copy />
          {copied ? "Copied" : "Copy link"}
        </Button>
        <Button size="sm" variant="outline" className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={revoke}>
          Revoke
        </Button>
      </div>
      <p className="flex gap-1.5 text-center text-[11.5px] leading-snug text-faint">
        <Lock className="mt-px size-3 shrink-0" aria-hidden />
        <span>
          {link.directOnly ? "Local network only: guests need this Wi-Fi or Tailscale. End-to-end encrypted." : "Through TerminalX Relay, end-to-end encrypted."} Expires {clockTime(link.settings.expiresAt)}.
        </span>
      </p>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

type Guest = ShareState["people"][number];

/** The access a waiting person would be let in with: their named account's, else the link's. */
function askedRole(guest: Guest, links: ShareLink[]): ShareRole {
  const link = links.find((candidate) => (guest.pendingLinkIds?.length ? guest.pendingLinkIds : guest.linkIds).includes(candidate.id));
  if (!link) return guest.role;
  if (link.settings.audience !== "people") return link.settings.role;
  return link.settings.people.find((entry) => entry.email.trim().toLowerCase() === guest.person.email.trim().toLowerCase())?.role ?? link.settings.role;
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts.at(-1)![0] : "")).toUpperCase();
}

/** One person in or at the door: who, where they are, and the host's answer or their access. */
function PersonRow({
  guest,
  links,
  tabTitle,
  driving,
  run,
  sessionId,
}: {
  guest: Guest;
  links: ShareLink[];
  tabTitle: (id: string) => string | null;
  driving: string[];
  run: (action: () => Promise<void>) => void;
  sessionId: string;
}) {
  const waiting = isWaitingGuest(guest);
  const name = guest.person.displayName;
  const viewing = guest.viewing.map(tabTitle).filter(Boolean)[0];
  const status = waiting
    ? `Waiting for approval · asked for ${roleLabel(askedRole(guest, links))}`
    : [roleLabel(guest.role), guest.typing ? "typing" : driving.length ? `driving ${tabTitle(driving[0]) ?? "a tab"}` : viewing ? `viewing ${viewing}` : null].filter(Boolean).join(" · ");
  return (
    <div className={cn("flex items-center gap-3 px-5 py-2.5", waiting && "bg-warning/[.06]")} data-testid="share-person">
      <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-well text-[11px] font-medium text-muted-foreground" aria-hidden>
        {initials(name)}
        <span className={cn("absolute -bottom-px -right-px size-2 rounded-full ring-2 ring-popover", waiting ? "bg-warning" : guest.connections > 0 ? "bg-add" : "bg-faint")} />
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-[13px]">
          <span className="text-foreground">{name}</span>
          <span className="text-faint"> · {guest.connections > 1 ? `${guest.connections} devices` : guest.person.email}</span>
        </div>
        <div className={cn("mt-0.5 truncate text-[11.5px]", waiting ? "text-warning" : "text-faint")}>{status}</div>
      </div>
      {waiting ? (
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={() => run(async () => {
            for (const linkId of guest.linkIds) await changeShare(sessionId, "remove", { linkId, userId: guest.person.userId });
          })}>
            Decline
          </Button>
          <Button size="sm" onClick={() => run(async () => {
            for (const linkId of guest.pendingLinkIds?.length ? guest.pendingLinkIds : guest.linkIds)
              await changeShare(sessionId, "approve", { linkId, userId: guest.person.userId, allow: true });
          })}>
            Let in
          </Button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          {driving.length > 0 && (
            <Button size="xs" variant="outline" onClick={() => run(async () => {
              for (const tabId of driving) await changeShare(sessionId, "takeover", { tabId });
            })}>
              Take over
            </Button>
          )}
          <span className="relative flex items-center">
            <select
              aria-label={`Access for ${name}`}
              className="h-7 cursor-pointer appearance-none rounded-md bg-transparent pl-2 pr-6 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              value={guest.role}
              onChange={(event) => {
                const role = event.target.value as ShareRole;
                run(async () => {
                  for (const linkId of guest.linkIds) await changeShare(sessionId, "access", { linkId, userId: guest.person.userId, role });
                });
              }}
            >
              <option value="viewer">Read only</option>
              <option value="driver">Can drive</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-1.5 size-3 text-faint" aria-hidden />
          </span>
          <Button variant="ghost" size="icon-xs" className="text-faint" aria-label={`Remove ${name}`} onClick={() => run(async () => {
            for (const linkId of guest.linkIds) await changeShare(sessionId, "remove", { linkId, userId: guest.person.userId });
          })}>
            <X />
          </Button>
        </div>
      )}
    </div>
  );
}

/** One thing sharing allows: its icon, a short heading, and a line on what it means. */
function ShareTerm({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 px-3.5 py-3">
      <span className="flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4" aria-hidden>
        {icon}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] text-foreground">{title}</span>
        <span className="text-[12px] leading-snug text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}

export function ShareSessionDialogHost() {
  const session = useShareDialog();
  const privacy = useDataPrivacy();
  if (session && privacy.enabled) return <Dialog open onOpenChange={(open) => { if (!open) closeSessionShare(); }}><DialogContent><DialogTitle>Share session</DialogTitle><PrivacyEmptyState /></DialogContent></Dialog>;
  return session ? <ShareSessionDialog key={session} sessionId={session} /> : null;
}
function ShareSessionDialog({ sessionId }: { sessionId: string }) {
  const share = useLocalShare(sessionId);
  const { status } = useAccount();
  const signedIn = status.state === "signed-in";
  // Until the first link is made, signed in opens on the introduction; How sharing works opens it again.
  const onboarded = usePrefs().shareOnboarded;
  const [intro, setIntro] = useState(!onboarded);
  const showIntro = !signedIn || intro;
  // The session's agent tabs and their permission mode, as the share is about to expose them.
  const session = useSessionStore().sessions.find((candidate) => candidate.id === sessionId);
  const sessionTitle = session && Array.isArray(session.tabs) ? conversationTitle(session) : session?.title;
  const agentTabs = (session?.tabs ?? []).filter((tab) => !!tab.permissionMode);
  const unguarded = agentTabs.some((tab) => modeIsUnguarded(tab.permissionMode) || (!!tab.requestedPermissionMode && modeIsUnguarded(tab.requestedPermissionMode)));
  const modes = [...new Set(agentTabs.map((tab) => tab.requestedPermissionMode || tab.permissionMode))];
  const sessionMode = modes.length === 1 ? modes[0] : MIXED;
  // Sharing where nothing asks takes a second, deliberate click: the first turns Create into Share in Bypass anyway.
  const [bypassConfirmed, setBypassConfirmed] = useState(false);

  const relay = usePairing().status.relay.phase === "connected";
  // The link the dialog shows: the one picked, else the newest still live. Its settings are the form's.
  const live = (share.links ?? []).filter((link) => !link.revoked);
  // Another link (NEW) shows the form for a new one beside those live, as many as the host wants side by side.
  const [picked, setPicked] = useState<string | null>(null);
  const link = picked === NEW ? null : (live.find((candidate) => candidate.id === picked) ?? live.at(-1) ?? null);
  const [settings, setSettings] = useState(defaultShareSettings);
  // Whenever the link shown changes, or its settings do, the form starts from the link's real settings.
  const linkSettings = link ? JSON.stringify(link.settings) : "";
  useEffect(() => {
    setSettings(link ? structuredClone(link.settings) : defaultShareSettings());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link?.id, linkSettings]);
  const changed = !!link && JSON.stringify(settings) !== linkSettings;
  const [directOnly, setDirectOnly] = useState(!relay);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  useEffect(() => {
    void refreshShare(sessionId).catch((e) => setError(errorMessage(e)));
  }, [sessionId]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const tabTitle = (id: string) => {
    const tab = session?.tabs?.find((candidate) => candidate.id === id);
    return tab ? tab.title?.trim() || "a tab" : null;
  };
  // The count beside a link's limit is of that link's people; with no link shown, of everyone in.
  const admitted = share.people.filter((guest) => guest.admitted && (!link || guest.linkIds.includes(link.id))).length;
  const allLinks = share.links ?? [];
  function create() {
    if (unguarded && !bypassConfirmed) { setBypassConfirmed(true); return; }
    void run(async () => {
      // The expiry chosen counts from now, the moment the link is made.
      const chosen = expiryChoice(settings.expiresAt, Date.now());
      await createShare(sessionId, { ...settings, expiresAt: expiryFor(chosen, null, Date.now()) }, directOnly);
      // The first link made: from now on Share opens on its settings.
      if (!onboarded) setPrefs({ shareOnboarded: true });
      setPicked(null);
      setBypassConfirmed(false);
    });
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeSessionShare();
      }}
    >
      {/* Two views. The introduction (the picture of a shared session, what guests can do) greets anyone signed out,
          and anyone signed in until their first link; How sharing works brings it back. After that, Share opens
          straight on the link's settings beside the link itself. */}
      <DialogContent width={showIntro ? "max-w-[26rem]" : "max-w-[760px]"} className={showIntro ? "p-6" : "p-0"}>
        {showIntro ? (
          <div data-testid="share-intro">
            <CollaborationScene className="mb-5 mt-6" />
            <DialogHeader className="mb-5 items-center gap-0 text-center">
              <span className="flex min-w-0 flex-col gap-1">
                <DialogTitle className="text-[15px] font-medium text-foreground">{signedIn && onboarded ? "How sharing works" : "Share this session"}</DialogTitle>
                <DialogDescription className="text-[13px] leading-relaxed text-muted-foreground">
                  Invite people into this conversation. Sharing ends when TerminalX restarts.
                </DialogDescription>
              </span>
            </DialogHeader>
            <ul className="mb-5 flex flex-col divide-y divide-hairline rounded-xl bg-well hairline" data-testid="share-terms">
              <ShareTerm icon={<Eye />} title="Guests can watch">They see the transcript and terminal so far.</ShareTerm>
              <ShareTerm icon={<Terminal />} title="A driver can act">They can have the agent change files and run commands on this computer.</ShareTerm>
              <ShareTerm icon={<Link2 />} title="The link is the key">Anyone signed in with it can ask to join. While Approve each person is on, each waits until you admit them.</ShareTerm>
            </ul>
            {!signedIn ? (
              <div className="flex flex-col items-stretch gap-2" data-testid="share-sign-in">
                <Button onClick={() => void signIn()}>Sign in to share</Button>
                <p className="text-center text-[11px] text-faint">Share links are made with your TerminalX account.</p>
              </div>
            ) : (
              <Button className="w-full" onClick={() => setIntro(false)}>{onboarded ? "Back to sharing" : "Continue"}</Button>
            )}
          </div>
        ) : (
          <>
            <DialogHeader className="mb-0 flex-row items-center gap-3 border-b border-hairline px-5 py-3.5 pr-12">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-well text-muted-foreground" aria-hidden>
                <RadioTower className="size-4" />
              </span>
              <span className="flex min-w-0 flex-col">
                <DialogTitle className="text-[14px] font-semibold text-foreground">Share session</DialogTitle>
                <DialogDescription className="truncate text-[12px] text-faint">
                  {sessionTitle ? `${sessionTitle} · local on ${thisComputer}` : `Local on ${thisComputer}`}
                </DialogDescription>
              </span>
            </DialogHeader>
            <fieldset disabled={busy} className="grid grid-cols-[minmax(0,1fr)_252px]">
              <div className="flex min-w-0 flex-col gap-3 px-5 pb-2 pt-4">
                <p className="text-[12.5px] text-muted-foreground">
                  Invite people to this session. Sharing ends when TerminalX restarts.{" "}
                  <button type="button" className="text-foreground/80 underline decoration-hairline-strong underline-offset-2 hover:text-foreground" onClick={() => setIntro(true)}>
                    How sharing works
                  </button>
                </p>
                <SettingsForm
                  value={settings}
                  set={setSettings}
                  link={link}
                  extra={!link && (
                    <Row
                      label="Local network only"
                      hint={directOnly ? "Guests must reach this computer on this Wi-Fi or Tailscale" : relay ? "Off: guests anywhere join through Relay" : "Relay is not connected here, so only people on your network can join"}
                    >
                      <Switch aria-label="Local network only" checked={directOnly} onCheckedChange={setDirectOnly} />
                    </Row>
                  )}
                />
              </div>
              <div className="flex min-w-0 flex-col gap-3 border-l border-hairline px-5 py-4">
                <div className={sectionLabel}>Secret share link</div>
                {link ? (
                  <SecretLink key={link.id} link={link} revoke={() => void run(() => changeShare(sessionId, "revoke", { linkId: link.id, removeGuests: true }))} />
                ) : (
                  <>
                    <div className="flex size-[180px] items-center justify-center self-center rounded-xl border border-dashed border-hairline-strong bg-well p-4 text-center text-[11.5px] leading-4 text-faint">
                      The link and its QR code appear here once it is made.
                    </div>
                    {/* The session's permissions, beside the link that shares it: a tab where nothing asks (Bypass, or Codex
                        with no sandbox) would let a guest have the agent do anything here, so the host settles it now. */}
                    {agentTabs.length > 0 && (
                      <label className={cn("relative flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-hairline bg-background pl-2.5 text-[12px] focus-within:ring-2 focus-within:ring-ring/40", unguarded && "border-warning/50")}>
                        {unguarded ? <ShieldAlert className="size-3.5 shrink-0 text-warning" aria-hidden /> : <ShieldCheck className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                        <span className="shrink-0 text-muted-foreground">Permissions</span>
                        <select
                          aria-label="Session permissions"
                          className="h-full min-w-0 flex-1 cursor-pointer appearance-none bg-transparent pr-5 text-[12px] text-foreground outline-none"
                          value={sessionMode}
                          onChange={(event) => void run(async () => {
                            const mode = event.target.value;
                            setBypassConfirmed(false);
                            for (const tab of agentTabs) await agent.setPermissionMode(sessionId, tab.id, mode);
                          })}
                        >
                          {sessionMode === MIXED && <option value={MIXED} disabled>Mixed</option>}
                          {/* A mode the picker has no entry for (a Codex stance, say) is shown as it is. */}
                          {sessionMode !== MIXED && !PERMISSION_MODES.some((mode) => mode.id === sessionMode) && <option value={sessionMode} disabled>{modeLabel(sessionMode)}</option>}
                          {PERMISSION_MODES.map((mode) => (
                            <option key={mode.id} value={mode.id}>{mode.label}</option>
                          ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-2 size-3 text-faint" aria-hidden />
                      </label>
                    )}
                    {unguarded && (
                      <p role="status" className="rounded-lg bg-warning/10 px-3 py-2 text-[11.5px] leading-snug text-warning" data-testid="share-unguarded">
                        Bypass is on: a guest who can drive could have the agent do anything on this computer, with nothing
                        asking you first. Share only with people you trust, or choose another mode.
                      </p>
                    )}
                    <Button className={cn("w-full", unguarded && bypassConfirmed && "bg-warning text-black hover:bg-warning/90")} onClick={create}>
                      {busy ? "Saving…" : unguarded && bypassConfirmed ? "Share in Bypass anyway" : "Create share link"}
                    </Button>
                  </>
                )}
                {live.length > 0 && (
                  <div className="flex flex-col items-start gap-1 border-t border-hairline pt-2 text-[11.5px] text-faint" data-testid="share-links">
                    {live.length > 1 && <span>{live.length} live links</span>}
                    {live.map((candidate, i) => candidate.id !== link?.id && (
                      <button key={candidate.id} type="button" className="text-left text-muted-foreground underline decoration-hairline-strong underline-offset-2 hover:text-foreground" onClick={() => setPicked(candidate.id)}>
                        Show link {i + 1} · {roleLabel(candidate.settings.role)} · expires {clockTime(candidate.settings.expiresAt)}
                      </button>
                    ))}
                    {link && (
                      <button type="button" className="flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => setPicked(NEW)}>
                        <Plus className="size-3" aria-hidden /> Another link
                      </button>
                    )}
                  </div>
                )}
              </div>
            </fieldset>
            {share.people.length > 0 && (
              <section className="border-t border-hairline py-2" aria-label="People">
                <div className="flex items-center justify-between px-5 py-1.5">
                  <h3 className={sectionLabel}>People</h3>
                  <span className="text-[11.5px] tabular-nums text-faint">{link ? `${admitted} of ${link.settings.maximumPeople}` : admitted}</span>
                </div>
                {share.people.map((guest) => (
                  <PersonRow
                    key={guest.person.userId}
                    guest={guest}
                    links={allLinks}
                    tabTitle={tabTitle}
                    driving={share.leases.filter((lease) => lease.holder.userId === guest.person.userId).map((lease) => lease.tabId)}
                    run={(action) => void run(action)}
                    sessionId={sessionId}
                  />
                ))}
              </section>
            )}
            {notesOpen && share.active && (
              <div className="flex flex-col gap-2 border-t border-hairline px-5 py-3" data-testid="share-notes">
                {share.notes.length > 0 && (
                  <div className="flex max-h-28 flex-col gap-1 overflow-y-auto text-[12px] scrollbar-thin">
                    {share.notes.slice(-20).map((entry) => (
                      <p key={entry.id}>
                        <span className="text-foreground">{entry.author.displayName}:</span> <span className="text-muted-foreground">{entry.text}</span>
                      </p>
                    ))}
                  </div>
                )}
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      await changeShare(sessionId, "note", { text: note });
                      setNote("");
                    });
                  }}
                >
                  <input
                    aria-label="Note to people"
                    placeholder="Note to people, separate from the agent"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    className={`${field} h-8 min-w-0 flex-1`}
                    maxLength={16384}
                  />
                  <Button type="submit" size="sm" disabled={busy || !note.trim()}>
                    Post note
                  </Button>
                </form>
                {share.activity.length > 0 && (
                  <details className="text-[11.5px] text-faint">
                    <summary className="cursor-pointer">Activity</summary>
                    <div className="max-h-28 overflow-y-auto scrollbar-thin">
                      {share.activity.slice(-30).map((entry) => (
                        <p key={entry.id}>
                          {clockTime(entry.createdAt)} · {entry.userId} · {entry.action}
                        </p>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
            <footer className="flex items-center gap-3 border-t border-hairline px-5 py-3">
              <div className="min-w-0 flex-1">
                {error ? (
                  <p role="alert" className="text-[12px] text-destructive">{error}</p>
                ) : share.active ? (
                  <button type="button" aria-expanded={notesOpen} className="flex items-center gap-1.5 text-[12px] text-faint hover:text-foreground" onClick={() => setNotesOpen(!notesOpen)}>
                    <StickyNote className="size-3.5" aria-hidden />
                    Notes to people stay separate from the agent
                  </button>
                ) : (
                  <span className="flex items-center gap-1.5 text-[12px] text-faint">
                    <StickyNote className="size-3.5" aria-hidden />
                    Notes to people stay separate from the agent
                  </span>
                )}
              </div>
              {share.active && (
                <Button variant="outline" className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={busy} onClick={() => void run(() => changeShare(sessionId, "stop"))}>
                  Stop sharing
                </Button>
              )}
              {link && (
                <Button disabled={busy || !changed} onClick={() => void run(() => changeShare(sessionId, "edit", { linkId: link.id, settings }))}>
                  {busy ? "Saving…" : "Save settings"}
                </Button>
              )}
            </footer>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
export function LocalShareButton({ sessionId }: { sessionId: string }) {
  const privacy = useDataPrivacy();
  const share = useLocalShare(sessionId);
  useEffect(() => {
    void refreshShare(sessionId).catch(() => undefined);
  }, [sessionId]);
  const people = share.people.filter((person) => person.admitted);
  // Each link approves people by default (PRO-162): whoever waits is shown here, not only inside Share.
  const waiting = share.people.filter(isWaitingGuest);
  const waitingNote = `${waiting.length} waiting`;
  const detail = [
    ...people.map((guest) => `${guest.person.displayName}${guest.typing ? " (typing)" : ""}`),
    ...share.leases.map((lease) => `${lease.holder.displayName} is driving`),
    ...waiting.map((guest) => `${guest.person.displayName} is waiting to join`),
  ].join(" · ");
  const waitingId = `share-waiting-${sessionId}`;
  return (
    <Button
      variant="ghost"
      size="sm"
      // A 20px icon like the header's others, and a label sized to stand beside it.
      className="gap-1.5 px-3 text-[13px] [&>svg]:size-5"
      aria-label="Share session…"
      aria-describedby={waiting.length ? waitingId : undefined}
      disabled={privacy.enabled}
      // Who is in is said on hover; the label stays Share, with whoever waits beside it.
      title={privacy.enabled ? PRIVACY_MESSAGE : detail || "Share session"}
      onClick={() => openSessionShare(sessionId)}
    >
      <UserPlus />
      <span>Share</span>
      {waiting.length > 0 && (
        <span className="text-warning" data-testid="share-waiting">
          <span aria-hidden className="text-faint">· </span>
          <span id={waitingId}>{waitingNote}</span>
        </span>
      )}
    </Button>
  );
}
