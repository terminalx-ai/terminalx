import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Bot, Check, CreditCard, Github, Loader2, Server, Sparkles } from "@/icons";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { isMac } from "@/lib/platform";
import { WindowControls } from "@/components/layout/WindowControls";
import { acceptInvite, agentName, decideLater, declineInvite, fetchWelcome, inviteErrorMessage, type InviteWelcome as Welcome, type MyInvite } from "@/lib/myInvites";

type LineState = "ready" | "needs_login" | "building" | "missing";

interface Line {
  key: string;
  icon: typeof Github;
  title: string;
  detail: string;
  state: LineState;
}

const PILL: Record<LineState, { label: string; className: string }> = {
  ready: { label: "Ready", className: "border-add/25 bg-add/10 text-add" },
  needs_login: { label: "Needs a login", className: "border-warning/30 bg-warning/10 text-warning" },
  building: { label: "Building", className: "border-info/30 bg-info/10 text-info" },
  missing: { label: "Not set up", className: "border-hairline bg-well text-muted-foreground" },
};

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** "Procyon Labs’", "Orbit’s". */
export const possessive = (name: string) => (/s$/i.test(name) ? `${name}’` : `${name}’s`);

/** The repository's own name, without its owner, as the screens show it. */
const shortName = (fullName: string) => fullName.split("/").pop() ?? fullName;

export function welcomeLines(welcome: Welcome): Line[] {
  const repositories = welcome.github.repositories.map(shortName);
  const lines: Line[] = [
    {
      key: "github",
      icon: Github,
      title: "GitHub",
      detail: welcome.github.state === "ready" ? `${listNames(repositories)}, through the organization’s GitHub App` : "No repositories connected yet. An admin can add them.",
      state: welcome.github.state,
    },
    ...welcome.agents.map((agent) => ({
      key: agent.provider,
      icon: agent.provider === "claude" ? Sparkles : Bot,
      title: agentName(agent.provider),
      detail: agent.state === "ready" ? "Organization login" : "No organization login yet. Connect your own after joining, or ask an admin.",
      state: agent.state,
    })),
  ];
  const { computer } = welcome;
  const name = computer.name ? `${computer.name} · ` : "";
  lines.push({
    key: "computer",
    icon: Server,
    title: "Cloud computer",
    detail:
      computer.state === "building" ? `${name}${computer.version ? `version ${computer.version} is building` : "building"}`
        : computer.state === "ready" ? `${name}${computer.version ? `version ${computer.version}` : "ready to start sessions"}`
          : "Not set up yet. An admin can connect one.",
    state: computer.state,
  });
  return lines;
}

function Pill({ state }: { state: LineState }) {
  const pill = PILL[state];
  const Icon = state === "ready" ? Check : state === "building" ? Loader2 : AlertCircle;
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[12px] font-medium", pill.className)}>
      <Icon aria-hidden className={cn("size-3", state === "building" && "animate-spin")} />
      {pill.label}
    </span>
  );
}

function checkedAgo(checkedAt: number, now = Date.now()): string {
  const minutes = Math.floor((now - checkedAt) / 60_000);
  return minutes < 1 ? "checked a moment ago" : `checked ${minutes} min ago`;
}

/** The organization's mark: its initial on a coloured square, as the Settings menu draws it larger. */
export function InviteOrgMark({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  return (
    <span aria-hidden className={cn("grid shrink-0 place-items-center rounded-md bg-[#f2766b] font-semibold text-[#1b1214]", size === "md" ? "size-9 text-[15px]" : "size-7 text-[13px]")}>
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/**
 * The combined invite-and-welcome card, shown before joining (owner decision
 * 2026-11-26; screens 12.08 and 12.21): what the organization already has
 * ready, its admins, and Accept and join, Decline, or Decide later.
 */
export function InviteWelcome({ invite, onClose }: { invite: MyInvite; onClose: () => void }) {
  const [welcome, setWelcome] = useState<Welcome | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [routeNote, setRouteNote] = useState(false);
  const root = useRef<HTMLElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  // Opened by a click: focus goes to Accept and join, so Enter there (and only there) accepts.
  useEffect(() => primary.current?.focus({ preventScroll: true }), []);

  useEffect(() => {
    let live = true;
    fetchWelcome(invite.id).then(
      (answer) => live && setWelcome(answer),
      (failure) => live && setLoadError(inviteErrorMessage(failure)),
    );
    return () => {
      live = false;
    };
  }, [invite.id]);

  const later = () => {
    decideLater(invite.id);
    onClose();
  };

  const accept = async () => {
    if (busy) return;
    setBusy("accept");
    setError(null);
    try {
      await acceptInvite(invite.id);
      onClose();
    } catch (failure) {
      setError(inviteErrorMessage(failure));
      setBusy(null);
    }
  };

  const decline = async () => {
    if (busy) return;
    setBusy("decline");
    setError(null);
    try {
      await declineInvite(invite.id);
      onClose();
    } catch (failure) {
      setError(inviteErrorMessage(failure));
      setBusy(null);
    }
  };

  const organization = invite.organizationName;
  const role = (welcome?.role ?? invite.role) === "admin" ? "an admin" : "a member";
  const inviter = welcome?.invitedBy ?? invite.invitedBy;
  const lines = welcome ? welcomeLines(welcome) : [];
  const ready = lines.filter((line) => line.state === "ready").length;
  const allReady = lines.length > 0 && ready === lines.length;
  const building = welcome?.computer.state === "building";

  return (
    // A layer over the app, which stays mounted under it (composers, Settings edits). Keys are the card's own:
    // Esc puts it off, and Enter accepts only from the focused Accept and join button.
    <section
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-welcome-title"
      data-testid="invite-welcome"
      className="fixed inset-0 z-50 flex flex-col bg-background"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        later();
      }}
    >
      <div data-tauri-drag-region="deep" className="absolute inset-x-0 top-0 flex h-(--titlebar-h)">
        <WindowControls />
      </div>
      <Button variant="ghost" size="sm" className={cn("absolute top-1.5 z-10 text-[12.5px]", isMac ? "right-3" : "right-[144px]")} onClick={later}>
        Decide later
      </Button>
      <div className="min-h-0 flex-1 overflow-auto px-10 pt-[92px] pb-16">
        <div className="mx-auto w-full max-w-[680px]">
          <div className="flex items-center gap-2.5">
            <InviteOrgMark name={organization} />
            <span className="min-w-0 truncate text-[13px] text-muted-foreground">{organization}</span>
          </div>
          <h1 id="invite-welcome-title" className="mt-4 text-[26px] leading-8 font-semibold tracking-[-0.01em] break-words">
            Welcome to {organization}
          </h1>
          {inviter && (
            <div className="mt-1.5 flex items-center gap-2 text-[13px] text-muted-foreground">
              <Avatar name={inviter} size="sm" decorative />
              <span className="min-w-0 break-words">
                {inviter} invited you as {role}
              </span>
            </div>
          )}
          {welcome && (
            <p className="mt-5 max-w-[600px] text-[14px] leading-[22px]">
              {allReady
                ? "Your team already connected everything a cloud session needs. Accept, and you can start one right away from this Mac or your phone."
                : "Your team connected most of what a cloud session needs. Accept, and you can start a session from this Mac or your phone."}
            </p>
          )}

          {loadError ? (
            <p role="alert" className="mt-8 text-[13px] text-muted-foreground">
              {loadError}
            </p>
          ) : !welcome ? (
            <div role="status" className="mt-8 flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 aria-hidden className="size-4 animate-spin" /> Checking what {organization} has ready…
            </div>
          ) : (
            <>
              <div className="mt-8 mb-2 flex items-baseline justify-between text-[12.5px]">
                <span className="font-medium">
                  Ready for you
                  {!allReady && <span className="ml-1.5 font-normal text-muted-foreground">{ready} of {lines.length}</span>}
                </span>
                <span className="text-muted-foreground">{checkedAgo(welcome.checkedAt)}</span>
              </div>
              <ul aria-label="Ready for you" className="overflow-hidden rounded-lg border border-hairline bg-card">
                {lines.map((line) => (
                  <li key={line.key} className="flex items-center gap-3.5 border-t border-hairline px-4 py-2.5 first:border-t-0">
                    <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-md border border-hairline bg-well text-muted-foreground">
                      <line.icon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium">{line.title}</div>
                      <div className="truncate text-[12px] text-muted-foreground" title={line.detail}>
                        {line.detail}
                      </div>
                    </div>
                    <Pill state={line.state} />
                  </li>
                ))}
              </ul>
              {welcome.admins.length > 0 && (
                <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px]">
                  <span className="text-muted-foreground">Admins</span>
                  {welcome.admins.map((admin) => (
                    <span key={admin.name} className="flex items-center gap-2">
                      <Avatar name={admin.name} size="sm" decorative />
                      {admin.name}
                      <span className="text-muted-foreground">{admin.owner ? "owner" : "admin"}</span>
                    </span>
                  ))}
                </div>
              )}
              {welcome.seatCovered && (
                <div className="mt-2.5 flex items-center gap-2 text-[12.5px] text-muted-foreground">
                  <CreditCard aria-hidden className="size-3.5" />
                  Your seat is covered by {possessive(organization)} Teams plan.
                </div>
              )}
            </>
          )}

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button ref={primary} className="h-9 px-3 text-[12.5px]" disabled={busy !== null} onClick={() => void accept()}>
              {busy === "accept" && <Loader2 className="animate-spin" />}
              Accept and join
              <kbd aria-hidden className="ml-1 rounded border border-current/25 px-1 text-xs leading-4 opacity-70">
                ↵
              </kbd>
            </Button>
            <Button variant="outline" className="h-9 px-3 text-[12.5px]" disabled={busy !== null} onClick={() => void decline()}>
              {busy === "decline" && <Loader2 className="animate-spin" />}
              Decline
            </Button>
            <span className="ml-2 text-[12.5px] text-muted-foreground">
              Optional:{" "}
              <button type="button" className="text-foreground underline underline-offset-2 outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-ring/40" onClick={() => setRouteNote(true)}>
                use my own model route
              </button>
            </span>
          </div>
          {error && (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {error}
            </p>
          )}
          <Note>
            {routeNote && <>After you join, choose it in Settings → {organization} → Model access. </>}
            {building && "You can join now; cloud sessions can start once the computer finishes building. "}
            Joining doesn’t touch your local projects. Switch between Local and {organization} from the top of the sidebar.
          </Note>
        </div>
      </div>
    </section>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-5 max-w-[680px] text-[12.5px] leading-5 text-muted-foreground">{children}</p>;
}
