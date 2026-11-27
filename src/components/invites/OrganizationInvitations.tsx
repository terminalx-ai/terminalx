import { useEffect, useState } from "react";
import { CheckCircle2, Clock, CreditCard, Loader2 } from "@/icons";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { cn } from "@/lib/cn";
import { acceptInvite, declineInvite, fetchWelcome, inviteErrorMessage, openInvite, useInvites, type InviteWelcome, type MyInvite } from "@/lib/myInvites";
import { InviteOrgMark, possessive, welcomeLines } from "./InviteWelcome";

const DAY_MS = 86_400_000;

function ago(at: number, now = Date.now()): string {
  const days = Math.floor((now - at) / DAY_MS);
  if (days <= 0) return "today";
  return days === 1 ? "yesterday" : `${days} days ago`;
}

const dayMonth = (at: number) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** "GitHub, Claude Code and the cloud computer are ready for you · Codex needs a login" (12.20). */
export function readinessSummary(welcome: InviteWelcome): string {
  const lines = welcomeLines(welcome);
  const name = (title: string) => (title === "Cloud computer" ? "the cloud computer" : title);
  const ready = lines.filter((line) => line.state === "ready").map((line) => name(line.title));
  const others = lines
    .filter((line) => line.state !== "ready")
    .map((line) => {
      const title = name(line.title);
      const said = line.state === "needs_login" ? "needs a login" : line.state === "building" ? "is building" : "isn’t set up";
      return `${title.charAt(0).toUpperCase()}${title.slice(1)} ${said}`;
    });
  const readyText = !ready.length ? "" : ready.length === 1 ? `${ready[0]} is ready for you` : `${ready.slice(0, -1).join(", ")} and ${ready.at(-1)} are ready for you`;
  return [readyText ? `${readyText.charAt(0).toUpperCase()}${readyText.slice(1)}` : "", ...others].filter(Boolean).join(" · ");
}

/**
 * Settings → Organizations → Invitations (12.20): every invitation addressed to
 * the person, kept until they answer it or it expires. Decide later on the
 * welcome card leaves one here.
 */
export function OrganizationInvitations() {
  const { enabled, invites, deferred } = useInvites();
  if (!enabled || !invites.length) return null;
  return (
    <section aria-labelledby="organization-invitations-title" className="pb-6">
      <h2 id="organization-invitations-title" className="text-[14px] font-semibold">
        Invitations
      </h2>
      <p className="mt-0.5 text-[12.5px] text-muted-foreground">An invitation stays here until you answer it or it expires.</p>
      <ul className="mt-3 overflow-hidden rounded-lg border border-hairline bg-card">
        {invites.map((invite) => (
          <InvitationRow key={invite.id} invite={invite} deferred={deferred.includes(invite.id)} />
        ))}
      </ul>
    </section>
  );
}

function InvitationRow({ invite, deferred }: { invite: MyInvite; deferred: boolean }) {
  const expired = invite.expired === true || invite.expiresAt <= Date.now();
  const [welcome, setWelcome] = useState<InviteWelcome | null>(null);
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (expired) return;
    let live = true;
    fetchWelcome(invite.id).then(
      (answer) => live && setWelcome(answer),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [invite.id, expired]);

  const run = async (kind: "accept" | "decline") => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === "accept") await acceptInvite(invite.id);
      else await declineInvite(invite.id);
    } catch (failure) {
      setError(inviteErrorMessage(failure));
      setBusy(null);
    }
  };

  const name = invite.organizationName;
  const role = invite.role === "admin" ? "an admin" : "a member";
  const inviter = invite.invitedBy;
  const seatCovered = welcome?.seatCovered ?? invite.teamsPlan === true;

  if (expired) {
    const first = inviter?.split(/\s+/)[0];
    return (
      <li className="flex items-center gap-3.5 border-t border-hairline px-4 py-3 first:border-t-0" aria-label={`${name}, expired invitation`}>
        <span className="opacity-60">
          <InviteOrgMark name={name} size="sm" />
        </span>
        <div className="min-w-0 flex-1 text-muted-foreground">
          <div className="flex items-center gap-2 text-[13px]">
            {name}
            <Chip className="text-muted-foreground">Expired</Chip>
          </div>
          <div className="mt-0.5 text-[12px] text-faint">
            {inviter ? `${inviter} invited you` : "You were invited"}
            {invite.createdAt ? ` on ${dayMonth(invite.createdAt)}` : ""}. {first ? `Ask ${first} for a new invitation.` : "Ask an admin for a new invitation."}
          </div>
          {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
        </div>
        <Button size="sm" variant="outline" className="text-muted-foreground" disabled={busy !== null} onClick={() => void run("decline")}>
          {busy === "decline" && <Loader2 className="animate-spin" />}
          Remove
        </Button>
      </li>
    );
  }

  return (
    <li className="border-t border-hairline px-4 py-3.5 first:border-t-0" aria-label={`${name} invitation`}>
      <div className="flex items-start gap-3.5">
        <InviteOrgMark name={name} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
            {name}
            {seatCovered && <Chip className="font-normal text-muted-foreground">Teams</Chip>}
            {deferred && <Chip className="border-warning/30 bg-warning/10 font-normal text-warning">You chose Decide later</Chip>}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
            {inviter && <Avatar name={inviter} size="sm" decorative />}
            {inviter ? `${inviter} invited you as ${role}` : `You were invited as ${role}`}
            {invite.createdAt ? ` · ${ago(invite.createdAt)}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run("decline")}>
            {busy === "decline" && <Loader2 className="animate-spin" />}
            Decline
          </Button>
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => openInvite(invite.id)}>
            Review
          </Button>
          <Button size="sm" disabled={busy !== null} onClick={() => void run("accept")}>
            {busy === "accept" && <Loader2 className="animate-spin" />}
            Accept and join
          </Button>
        </div>
      </div>
      <div className="mt-2.5 grid gap-1.5 pl-[42px] text-[12px] text-muted-foreground">
        {welcome && (
          <div className="flex items-center gap-2">
            <CheckCircle2 aria-hidden className={cn("size-3.5 shrink-0", "text-add")} />
            {readinessSummary(welcome)}
          </div>
        )}
        {seatCovered && (
          <div className="flex items-center gap-2">
            <CreditCard aria-hidden className="size-3.5 shrink-0" />
            Your seat is covered by {possessive(name)} Teams plan.
          </div>
        )}
        <div className="flex items-center gap-2">
          <Clock aria-hidden className="size-3.5 shrink-0" />
          Expires on {dayMonth(invite.expiresAt)}.
        </div>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
    </li>
  );
}
