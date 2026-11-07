import { useEffect, useState } from "react";
import { Copy, Eye, Link2, Plus, QrCode, Terminal, UserPlus, Users } from "@/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { CollaborationScene } from "./CollaborationScene";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  changeShare,
  closeSessionShare,
  createShare,
  defaultShareSettings,
  openSessionShare,
  refreshShare,
  useLocalShare,
  useShareDialog,
  type ShareLink,
  type ShareRole,
  type ShareSettings,
} from "@/lib/localSharing";
import { errorMessage } from "@/lib/api";
import { usePairing } from "@/lib/pairing";
import { useAccount, signIn } from "@/lib/account";

const field = "rounded-md border border-hairline bg-background px-2 py-1.5 text-sm";
function RolePicker({
  value,
  onChange,
  label,
}: {
  value: ShareRole;
  onChange: (role: ShareRole) => void;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      className={field}
      value={value}
      onChange={(event) => onChange(event.target.value as ShareRole)}
    >
      <option value="driver">Can drive</option>
      <option value="viewer">Read only</option>
    </select>
  );
}
function SettingsForm({ value, set }: { value: ShareSettings; set: (value: ShareSettings) => void }) {
  const patch = (update: Partial<ShareSettings>) => set({ ...value, ...update });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs">
          Who can join
          <select
            className={field}
            value={value.audience}
            onChange={(event) => patch({ audience: event.target.value as ShareSettings["audience"] })}
          >
            <option value="anyone">Anyone with the link, signed in</option>
            <option value="people">Only specific people</option>
            <option value="organization">Members of my organization</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Default access
          <RolePicker value={value.role} onChange={(role) => patch({ role })} label="Default access" />
        </label>
      </div>
      {value.audience === "people" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Only verified account emails are admitted. Choose access for each person.
          </p>
          {value.people.map((person, i) => (
            <div key={i} className="flex gap-2">
              <input
                type="email"
                aria-label={`Account email ${i + 1}`}
                className={`${field} min-w-0 flex-1`}
                value={person.email}
                onChange={(event) =>
                  patch({ people: value.people.map((p, at) => (at === i ? { ...p, email: event.target.value } : p)) })
                }
              />
              <RolePicker
                label={`Access for account ${i + 1}`}
                value={person.role}
                onChange={(role) => patch({ people: value.people.map((p, at) => (at === i ? { ...p, role } : p)) })}
              />
              <Button
                variant="ghost"
                aria-label={`Remove account ${i + 1}`}
                onClick={() => patch({ people: value.people.filter((_, at) => at !== i) })}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            onClick={() => patch({ people: [...value.people, { email: "", role: value.role }] })}
          >
            <Plus /> Add account
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs">
          Expires in
          <select
            className={field}
            aria-label="Expiry"
            value={Math.max(1, Math.round((value.expiresAt - Date.now()) / 60_000))}
            onChange={(event) => patch({ expiresAt: Date.now() + Number(event.target.value) * 60_000 })}
          >
            <option value={Math.max(1, Math.round((value.expiresAt - Date.now()) / 60_000))}>
              Current · {new Date(value.expiresAt).toLocaleTimeString()}
            </option>
            <option value="15">15 minutes</option>
            <option value="60">1 hour</option>
            <option value="240">4 hours</option>
            <option value="1440">24 hours</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Maximum people
          <input
            aria-label="Maximum people"
            type="number"
            min={1}
            max={32}
            className={`${field} w-24`}
            value={value.maximumPeople}
            onChange={(event) => patch({ maximumPeople: Number(event.target.value) })}
          />
        </label>
      </div>
      {(
        [
          ["approveEachPerson", "Approve each person"],
          ["canApprove", "Guests may approve permissions"],
          ["singleUse", "Single use"],
        ] as const
      ).map(([key, label]) => (
        <label key={key} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value[key]} onChange={(event) => patch({ [key]: event.target.checked })} />
          {label}
        </label>
      ))}
    </div>
  );
}
function SecretLink({ link, edit, revoke }: { link: ShareLink; edit: () => void; revoke: () => void }) {
  const [shown, setShown] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function showQr() {
    try {
      const { toDataURL } = await import("qrcode");
      setQr(await toDataURL(link.url, { width: 240, margin: 1 }));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <div className="rounded-lg border border-hairline p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <strong>{link.settings.role === "driver" ? "Can drive" : "Read only"}</strong>
        <span>
          {link.settings.audience === "anyone"
            ? "Anyone signed in"
            : link.settings.audience === "people"
              ? "Named accounts"
              : "Organization members"}
        </span>
        <span className="ml-auto">
          {link.revoked ? "Revoked" : `Expires ${new Date(link.settings.expiresAt).toLocaleTimeString()}`}
        </span>
      </div>
      {!link.revoked && (
        <>
          <input
            aria-label="Secret share link"
            readOnly
            type={shown ? "text" : "password"}
            value={link.url}
            className={`${field} w-full font-mono text-xs`}
          />
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="outline" onClick={() => void copy()}>
              <Copy />
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShown(!shown)}>
              {shown ? "Hide" : "Reveal"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void showQr()}>
              <QrCode />
              QR
            </Button>
            <Button size="sm" variant="ghost" onClick={edit}>
              Edit settings
            </Button>
            <Button size="sm" variant="destructive" onClick={revoke}>
              Revoke
            </Button>
          </div>
          {qr && <img src={qr} alt="Secret share link QR code" width={240} height={240} />}
          {link.directOnly && (
            <p className="text-xs text-muted-foreground">Local network only: guests need this Wi-Fi or Tailscale.</p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
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
  return session ? <ShareSessionDialog key={session} sessionId={session} /> : null;
}
function ShareSessionDialog({ sessionId }: { sessionId: string }) {
  const share = useLocalShare(sessionId);
  const { status } = useAccount();
  const signedIn = status.state === "signed-in";
  const relay = usePairing().status.relay.phase === "connected";
  const [settings, setSettings] = useState(defaultShareSettings);
  const [editing, setEditing] = useState<string | null>(null);
  const [directOnly, setDirectOnly] = useState(!relay);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
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
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeSessionShare();
      }}
    >
      {/* Signed out it is a short card with one thing to do; signed in it widens for the link form. */}
      <DialogContent width={signedIn ? "max-w-[40rem]" : "max-w-[26rem]"} className="max-h-[90vh] overflow-y-auto p-6">
        {/* Signed out, a picture of what sharing is before the words: people at one conversation, together. */}
        {!signedIn && <CollaborationScene className="mb-5 mt-6" />}
        <DialogHeader className={cn("mb-5 gap-0", signedIn ? "flex-row items-center gap-3 pr-8" : "items-center text-center")}>
          {signedIn && (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-veil-raised text-foreground/80 hairline" aria-hidden>
              <Users className="size-4" />
            </span>
          )}
          <span className="flex min-w-0 flex-col gap-1">
            <DialogTitle className="text-[15px] font-medium text-foreground">Share this session</DialogTitle>
            <DialogDescription className="text-[13px] leading-relaxed text-muted-foreground">
              Invite people into this conversation. Sharing ends when TerminalX restarts.
            </DialogDescription>
          </span>
        </DialogHeader>
        {/* What sharing gives away, one fact a row, so it is read rather than skimmed. */}
        <ul className="mb-5 flex flex-col divide-y divide-hairline rounded-xl bg-well hairline" data-testid="share-terms">
          <ShareTerm icon={<Eye />} title="Guests can watch">They see the transcript and terminal so far.</ShareTerm>
          <ShareTerm icon={<Terminal />} title="A driver can act">They can have the agent change files and run commands on this computer.</ShareTerm>
          <ShareTerm icon={<Link2 />} title="The link is the key">Anyone signed in with it can join. Name people or require approval to limit who.</ShareTerm>
        </ul>
        {!signedIn ? (
          <div className="flex flex-col items-stretch gap-2" data-testid="share-sign-in">
            <Button onClick={() => void signIn()}>Sign in to share</Button>
            <p className="text-center text-[11px] text-faint">Share links are made with your TerminalX account.</p>
          </div>
        ) : (
          <fieldset disabled={busy} className="space-y-4">
            <SettingsForm value={settings} set={setSettings} />
            {!editing && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={directOnly} onChange={(event) => setDirectOnly(event.target.checked)} />
                Local network only
              </label>
            )}
            {!directOnly && !relay && (
              <p className="text-xs text-muted-foreground">
                Relay needs the host's Relay entitlement and an active connection. Choose local network only to share
                with people who can reach this computer directly.
              </p>
            )}
            {directOnly && (
              <p className="text-xs text-muted-foreground">
                Guests must reach this computer on this Wi-Fi or Tailscale. Allow local network access and incoming
                connections when prompted.
              </p>
            )}
            <div className="flex gap-2">
              <Button
                onClick={() =>
                  void run(async () => {
                    if (editing) await changeShare(sessionId, "edit", { linkId: editing, settings });
                    else await createShare(sessionId, settings, directOnly);
                    setEditing(null);
                    setSettings(defaultShareSettings());
                  })
                }
              >
                {busy ? "Saving…" : editing ? "Save settings" : "Create share link"}
              </Button>
              {editing && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditing(null);
                    setSettings(defaultShareSettings());
                  }}
                >
                  Cancel edit
                </Button>
              )}
            </div>
          </fieldset>
        )}
        {error && signedIn && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
        {/* Only when there are links: empty, its top margin left a gap under the dialog's last line. */}
        {!!share.links?.length && <div className="mt-5 space-y-3">
          {share.links.map((link) => (
            <SecretLink
              key={link.id}
              link={link}
              edit={() => {
                setEditing(link.id);
                setSettings(structuredClone(link.settings));
              }}
              revoke={() => void run(() => changeShare(sessionId, "revoke", { linkId: link.id, removeGuests: true }))}
            />
          ))}
        </div>}
        {share.people.length > 0 && (
          <div className="mt-5 space-y-2">
            <h3 className="text-sm font-medium">People</h3>
            {share.people.map((guest) => (
              <div key={guest.person.userId} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="flex-1">
                  <strong>{guest.person.displayName}</strong> · {guest.person.email} ·{" "}
                  {guest.admitted
                    ? guest.typing
                      ? "Typing"
                      : guest.role === "driver"
                        ? "Can drive"
                        : "Read only"
                    : "Waiting for approval"}
                </span>
                {(guest.pendingLinkIds?.length || !guest.admitted) && (
                  <Button
                    size="xs"
                    onClick={() =>
                      void run(async () => {
                        for (const linkId of guest.pendingLinkIds ?? guest.linkIds)
                          await changeShare(sessionId, "approve", { linkId, userId: guest.person.userId, allow: true });
                      })
                    }
                  >
                    Admit
                  </Button>
                )}
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() =>
                    void run(async () => {
                      for (const linkId of guest.linkIds)
                        await changeShare(sessionId, "remove", { linkId, userId: guest.person.userId });
                    })
                  }
                >
                  {guest.admitted ? "Remove" : "Decline"}
                </Button>
              </div>
            ))}
          </div>
        )}
        {share.leases.map((lease) => (
          <div key={lease.tabId} className="mt-3 flex items-center gap-2 text-xs">
            <span>{lease.holder.displayName} is driving</span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void run(() => changeShare(sessionId, "takeover", { tabId: lease.tabId }))}
            >
              Take over
            </Button>
          </div>
        ))}
        {share.active && (
          <form
            className="mt-4 flex gap-2"
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
              className={`${field} min-w-0 flex-1`}
              maxLength={16384}
            />
            <Button type="submit" size="sm" disabled={busy || !note.trim()}>
              Post note
            </Button>
          </form>
        )}
        {share.notes.length > 0 && (
          <div className="mt-4 space-y-2 text-sm">
            <h3 className="font-medium">Notes to people</h3>
            {share.notes.slice(-20).map((note) => (
              <p key={note.id}>
                <strong>{note.author.displayName}:</strong> {note.text}
              </p>
            ))}
          </div>
        )}
        {(share.active || share.activity.length > 0) && (
          <div className="mt-5 flex justify-between">
            <details className="text-xs">
              <summary>Activity</summary>
              {share.activity.slice(-30).map((entry) => (
                <p key={entry.id}>
                  {new Date(entry.createdAt).toLocaleTimeString()} · {entry.userId} · {entry.action}
                </p>
              ))}
            </details>
            {share.active && (
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => void run(() => changeShare(sessionId, "stop"))}
              >
                Stop sharing
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
export function LocalShareButton({ sessionId }: { sessionId: string }) {
  const share = useLocalShare(sessionId);
  useEffect(() => {
    void refreshShare(sessionId).catch(() => undefined);
  }, [sessionId]);
  const people = share.people.filter((person) => person.admitted);
  const detail = [
    ...people.map((guest) => `${guest.person.displayName}${guest.typing ? " (typing)" : ""}`),
    ...share.leases.map((lease) => `${lease.holder.displayName} is driving`),
  ].join(" · ");
  return (
    <Button
      variant="ghost"
      size="sm"
      // A 20px icon like the header's others, and a label sized to stand beside it.
      className="gap-1.5 px-3 text-[13px] [&>svg]:size-5"
      aria-label="Share session…"
      title={detail || "Share session"}
      onClick={() => openSessionShare(sessionId)}
    >
      <UserPlus />
      <span>{share.active ? `${people.length} guests` : "Share"}</span>
    </Button>
  );
}
