import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { Check, Circle, CircleAlert, CircleCheck, Link, Loader2, LoaderCircle, PartyPopper, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { api, type CloudWorkspaceProviderId } from "@/lib/api";
import { listedProviders } from "@/lib/hiddenProviders";
import { cloudProviderIsPlatform } from "@/lib/cloudProviders";
import { providerLabel } from "@/lib/organizationCompute";
import { organizationGithubApp } from "@/lib/organizationGithubApp";
import { buildTimeLeft, isBuilding, organizationEnvironment } from "@/lib/organizationEnvironment";
import { initials } from "@/lib/cloudPeople";
import { COMPUTER_COLORS } from "@/lib/computerIdentity";
import {
  isInvitableEmail,
  isTransientMembersError,
  membersErrorMessage,
  organizationMembers,
  type AssignableRole,
  type IssuedInvite,
  type OrganizationRoster,
} from "@/lib/organizationMembers";
import { mutateOrganizationRoster } from "@/lib/organizationRoster";
import { agentLoginUsable } from "@/components/settings/OrganizationAgentLogins";
import { cn } from "@/lib/cn";
import { FieldLabel, StepError, StepPage } from "./FlowLayout";
import { FinishActions } from "./FinishActions";
import type { StepProps } from "./stepProps";

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const roleLabel = (role: string) => ROLE_LABEL[role] ?? role;
const AGENT_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };
/** How long after a failed roster read the one automatic retry is made (as in Settings' Members). */
const MEMBERS_RETRY_DELAY_MS = 400;
const ENVIRONMENT_POLL_MS = 5000;
/** Refusals that every further invite of this batch would get too: the batch stops at the first. */
const BATCH_STOPPERS = new Set([
  "organization_requires_pro",
  "personal_org_no_invites",
  "forbidden",
  "invite_rate_limited",
  "account_context_changed",
  "account_context_changed_after_send",
  "account_signed_out",
  "account_organization_unavailable",
  "unauthorized",
]);
const SEPARATORS = /[\s,;]+/;

const codeOf = (failure: unknown) => {
  const code = (failure as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
};
const lower = (email: string) => email.trim().toLowerCase();

function sentLabel(createdAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - createdAt) / 1000));
  if (seconds < 60) return "Sent just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Sent ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Sent ${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `Sent ${days} ${days === 1 ? "day" : "days"} ago`;
  return `Sent ${new Date(createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const list = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

type Mark = "done" | "working" | "todo" | "unknown";
interface Area {
  mark: Mark;
  detail: string;
}

const UNKNOWN: Area = { mark: "unknown", detail: "Couldn't check" };

/** "ana.kim@example.com" → "Ana Kim": an invitation carries only the address. */
export function inviteeName(email: string): string {
  const local = email.replace(/@.*/, "").replace(/\+.*/, "");
  const words = local.split(/[._-]+/).filter(Boolean);
  return words.length ? words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ") : email;
}

/** One colour per person, the same every time for the same address (12.06). */
export function personColor(email: string): string {
  const palette = COMPUTER_COLORS.filter((item) => item.id !== "gray");
  let hash = 0;
  for (const char of email.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!.css;
}

const tint = (css: string) => ({ background: `color-mix(in oklab, ${css} 15%, transparent)`, color: css });

function AreaRow({ title, area }: { title: string; area: Area | null }) {
  const mark = area?.mark;
  return (
    <li className="flex items-start gap-2.5 py-2">
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center">
        {!area ? (
          <Loader2 className="size-3.5 animate-spin text-faint" aria-label="checking" />
        ) : mark === "done" ? (
          <CircleCheck className="size-4 text-add" aria-label="done" />
        ) : mark === "working" ? (
          <LoaderCircle className="size-4 animate-spin text-warning" aria-label="in progress" />
        ) : mark === "unknown" ? (
          <CircleAlert className="size-4 text-faint" aria-label="unknown" />
        ) : (
          <Circle className="size-4 text-faint" aria-label="not done" />
        )}
      </span>
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{title}</div>
        <div className={cn("truncate text-[12px] leading-[18px]", mark === "unknown" ? "text-faint" : "text-muted-foreground")}>{area ? area.detail : "Checking…"}</div>
      </div>
    </li>
  );
}

/**
 * "You're almost set" (12.06): each area of the setup as the service reports
 * it now, read live. A read that fails says so; it never shows as done.
 */
function AlmostSet({
  organizationId,
  machine,
  roster,
}: {
  organizationId: string;
  machine: StepProps["record"]["machine"];
  /** The member roster as this step read it: null while loading, "failed" when it could not be read. */
  roster: OrganizationRoster | null | "failed";
}) {
  const [github, setGithub] = useState<Area | null>(null);
  const [compute, setCompute] = useState<Area | null>(null);
  const [logins, setLogins] = useState<Area | null>(null);
  const [environment, setEnvironment] = useState<Area | null>(null);
  const [provider, setProvider] = useState<{ id: string; name: string } | null | undefined>(undefined);
  const [environmentBuilding, setEnvironmentBuilding] = useState(false);
  const alive = useRef(true);
  const wanted = useRef(machine);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    void organizationGithubApp
      .summary()
      .then((summary) => {
        if (!alive.current) return;
        const accessible = summary.repositories.filter((repository) => repository.state === "accessible").length;
        const blocked = summary.repositories.length - accessible;
        if (!summary.installations.length && !summary.repositories.length) return setGithub({ mark: "todo", detail: "Not connected" });
        if (!summary.repositories.length) return setGithub({ mark: "todo", detail: "Connected, no repository chosen" });
        setGithub({
          mark: accessible ? "done" : "todo",
          detail: [plural(accessible, "repository", "repositories"), blocked && `${blocked} not accessible`].filter(Boolean).join(" · "),
        });
      })
      .catch(() => alive.current && setGithub(UNKNOWN));

    void api
      .cloudAgentLogins(organizationId)
      .then(({ credentials }) => {
        if (!alive.current) return;
        const usable = credentials.filter((login) => agentLoginUsable(login)).map((login) => AGENT_NAME[login.provider] ?? login.provider);
        const names = [...new Set(usable)];
        setLogins(names.length ? { mark: "done", detail: list(names) } : { mark: "todo", detail: "None connected yet" });
      })
      .catch(() => alive.current && setLogins(UNKNOWN));

    void api
      .cloudProviders()
      .then(async (response) => {
        if (!alive.current) return;
        const listed = listedProviders(response.providers);
        const chosen = wanted.current?.provider;
        // The provider the organization connected, else one TerminalX provides (PRO-452), which needs no connection.
        const summary = (chosen ? listed.find((option) => option.id === chosen) : undefined) ?? listed.find((option) => option.connection !== null) ?? listed.find(cloudProviderIsPlatform);
        if (!summary || (!summary.connection && !cloudProviderIsPlatform(summary))) {
          setProvider(chosen ? { id: chosen, name: providerLabel(chosen) } : null);
          setCompute({ mark: "todo", detail: "No provider connected" });
          if (!chosen) setEnvironment({ mark: "todo", detail: "Needs a compute provider" });
          return;
        }
        setProvider({ id: summary.id, name: summary.displayName });
        const state =
          summary.availability === "available"
            ? null
            : summary.availability === "disabled-for-create"
              ? "new machines paused"
              : summary.availability === "attention-required"
                ? cloudProviderIsPlatform(summary)
                  ? "not available right now"
                  : "connection needs attention"
                : "not connected";
        const parts = [summary.displayName];
        try {
          const setup = await api.cloudWorkspaceSetup(summary.id as CloudWorkspaceProviderId, organizationId);
          const size = setup.machineClasses.find((option) => option.id === wanted.current?.machineClassId) ?? setup.machineClasses.find((option) => option.id === setup.defaults.machineClassId);
          const region = setup.locations.find((option) => option.id === wanted.current?.locationId) ?? setup.locations.find((option) => option.id === setup.defaults.locationId);
          if (size) parts.push(size.label);
          if (region) parts.push(region.label);
        } catch {
          /* the size and region are detail; the connection is what this row reports */
        }
        if (!alive.current) return;
        if (state) parts.push(state);
        setCompute({ mark: state ? "todo" : "done", detail: parts.join(" · ") });
      })
      .catch(() => {
        if (!alive.current) return;
        setProvider(null);
        setCompute(UNKNOWN);
        setEnvironment(UNKNOWN);
      });
  }, [organizationId]);

  const readEnvironment = useCallback(async (id: string, name: string) => {
    try {
      const status = await organizationEnvironment.status(id);
      if (!alive.current) return;
      const building = status.versions.find(isBuilding);
      setEnvironmentBuilding(Boolean(building));
      const active = status.activeVersion;
      if (!status.supported) setEnvironment({ mark: "done", detail: `${name} starts workspaces from its base image` });
      else if (building)
        setEnvironment({
          mark: "working",
          detail: `Version ${building.number} ${building.state === "queued" ? "waiting to build" : `building · ${buildTimeLeft(building, status.versions, Date.now())}`}`,
        });
      else if (active) setEnvironment({ mark: "done", detail: `Version ${active.number} active${status.rebuildRequired ? " · unbuilt changes" : ""}` });
      else {
        const failed = [...status.versions].sort((left, right) => right.number - left.number)[0];
        setEnvironment({ mark: "todo", detail: failed?.state === "failed" ? `Version ${failed.number} failed · not built yet` : "Not built yet" });
      }
    } catch {
      if (alive.current) setEnvironment(UNKNOWN);
    }
  }, []);

  useEffect(() => {
    if (provider) void readEnvironment(provider.id, provider.name);
  }, [provider, readEnvironment]);
  useEffect(() => {
    if (!provider || !environmentBuilding) return;
    const timer = setInterval(() => void readEnvironment(provider.id, provider.name), ENVIRONMENT_POLL_MS);
    return () => clearInterval(timer);
  }, [provider, environmentBuilding, readEnvironment]);

  const pending = roster && roster !== "failed" ? roster.pendingInvites.filter((invite) => invite.status !== "expired").length : 0;
  const members = roster && roster !== "failed" ? roster.members.length : 0;
  const team: Area | null =
    roster === null
      ? null
      : roster === "failed"
        ? UNKNOWN
        : pending > 0
        ? { mark: "done", detail: `${plural(pending, "invitation", "invitations")} pending` }
        : members > 1
          ? { mark: "done", detail: plural(members, "member", "members") }
          : { mark: "todo", detail: "No one invited yet. Invites can wait." };

  return (
    <div className="rounded-xl border border-hairline bg-card p-4" data-testid="cloud-setup-almost-set">
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <PartyPopper className="size-4 text-warning" aria-hidden /> You're almost set
      </div>
      <p className="mt-1 border-b border-hairline pb-3 text-[12px] leading-[18px] text-muted-foreground">
        Finish opens a setup check: an agent builds and tests every repository on the new computer, so the first member's session just works.
      </p>
      <ul className="mt-1">
        <AreaRow title="GitHub" area={github} />
        <AreaRow title="Compute" area={compute} />
        <AreaRow title="Agent logins" area={logins} />
        <AreaRow title="Environment" area={environment} />
        <AreaRow title="Team" area={team} />
      </ul>
    </div>
  );
}

interface Chip {
  email: string;
  /** Why the last send of this address failed. */
  error?: string;
}

/**
 * Step 6 (12.06): invite the team by email, one invite per address, and see
 * the invitations still pending. Nothing here is required: the setup can be
 * finished without inviting anyone. A link is offered only for an invite
 * sent from here, since the server gives no link for older ones.
 */
export function InviteStep(props: StepProps & { onDone: () => void }) {
  // Discard recipient tokens and pending clipboard feedback on any context change,
  // including when this step is mounted outside CloudSetupFlow.
  return <InviteStepContent key={JSON.stringify([props.organization.id, props.contextRevision, props.accountEmail])} {...props} />;
}

function InviteStepContent(props: StepProps & { onDone: () => void }) {
  const { organization, record, contextRevision } = props;
  const [roster, setRoster] = useState<OrganizationRoster | null>(null);
  const [rosterState, setRosterState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [chips, setChips] = useState<Chip[]>([]);
  const [text, setText] = useState("");
  const [role, setRole] = useState<AssignableRole>("member");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  // Invites sent from here, by lower-case address: the only ones with a link to copy.
  const [issued, setIssued] = useState<Record<string, IssuedInvite>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);
  const loadSeq = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    alive.current = true;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const load = useCallback(async (keepError = false) => {
    const current = ++loadSeq.current;
    const fresh = () => alive.current && current === loadSeq.current;
    setRosterState((state) => ({ ...state, loading: true }));
    try {
      let next: OrganizationRoster;
      try {
        next = await organizationMembers.list();
      } catch (failure) {
        // The first read often races the account session's own refresh: ask once more before saying so.
        if (!isTransientMembersError(failure) || !fresh()) throw failure;
        await new Promise((resolve) => setTimeout(resolve, MEMBERS_RETRY_DELAY_MS));
        if (!fresh()) return;
        next = await organizationMembers.list();
      }
      if (!fresh()) return;
      setRoster(next);
      setNow(Date.now());
      setRosterState({ loading: false, error: null });
      if (!keepError) setError(null);
    } catch (failure) {
      if (fresh()) {
        setRoster(null);
        setIssued({});
        setRosterState({ loading: false, error: membersErrorMessage(failure) });
      }
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, contextRevision]);

  const memberEmails = new Set((roster?.members ?? []).map((member) => lower(member.email)));
  const problemOf = (chip: Chip): string | null => {
    if (!isInvitableEmail(chip.email)) return "Not a valid email address";
    if (memberEmails.has(lower(chip.email))) return "Already a member";
    return chip.error ?? null;
  };

  const add = (raw: string) => {
    const addresses = raw.split(SEPARATORS).map((value) => value.trim()).filter(Boolean);
    if (!addresses.length) return;
    setOutcome(null);
    setChips((current) => {
      const seen = new Set(current.map((chip) => lower(chip.email)));
      const added = addresses.filter((address) => {
        const key = lower(address);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return [...current, ...added.map((email) => ({ email }))];
    });
  };
  const remove = (email: string) => setChips((current) => current.filter((chip) => chip.email !== email));

  const manage = Boolean(roster?.canManageMembers);
  const canInvite = manage && roster?.canInvite !== false;
  const sendable = chips.filter((chip) => isInvitableEmail(chip.email) && !memberEmails.has(lower(chip.email)));

  const send = async () => {
    if (!roster || busy || !canInvite) return;
    // Text still in the field is an address too.
    const typed = text.split(SEPARATORS).map((value) => value.trim()).filter(Boolean);
    const known = new Set(chips.map((chip) => lower(chip.email)));
    const all: Chip[] = [...chips, ...typed.filter((address) => !known.has(lower(address))).map((email) => ({ email }))];
    setChips(all);
    setText("");
    const targets = all.filter((chip) => isInvitableEmail(chip.email) && !memberEmails.has(lower(chip.email)));
    if (!targets.length) return;
    setBusy("send");
    setError(null);
    setOutcome(null);
    const failures = new Map<string, string>();
    const sent: string[] = [];
    const repeated: string[] = [];
    let revision = roster.contextRevision;
    let stopped: string | null = null;
    // One at a time, in order: each invite is fenced by the roster the one before returned.
    for (const chip of targets) {
      if (stopped) break;
      try {
        const next = await mutateOrganizationRoster(organization.id, contextRevision, () => organizationMembers.invite(chip.email, role, revision));
        if (!alive.current) return;
        // Newer than any list read still in flight; retire those reads.
        loadSeq.current += 1;
        revision = next.contextRevision;
        setRoster(next);
        setNow(Date.now());
        sent.push(lower(chip.email));
        const invite = next.invite;
        if (invite?.deduplicated) repeated.push(chip.email);
        // A deduplicated resend leaves the earlier link valid; keep showing it.
        if (invite && !invite.deduplicated) setIssued((current) => ({ ...current, [lower(invite.email || chip.email)]: invite }));
      } catch (failure) {
        if (!alive.current) return;
        const message = membersErrorMessage(failure);
        failures.set(lower(chip.email), message);
        if (BATCH_STOPPERS.has(codeOf(failure))) stopped = message;
      }
    }
    if (!alive.current) return;
    setChips((current) =>
      current.filter((chip) => !sent.includes(lower(chip.email))).map((chip) => ({ ...chip, error: failures.get(lower(chip.email)) ?? chip.error })),
    );
    const notSent = targets.length - sent.length - failures.size;
    setOutcome(
      [
        sent.length ? `Sent ${plural(sent.length, "invite", "invites")}.` : "",
        repeated.length ? `${list(repeated)} ${repeated.length === 1 ? "was" : "were"} invited moments ago, so no new email went out.` : "",
        failures.size ? `${plural(failures.size, "address", "addresses")} failed; ${failures.size === 1 ? "its reason is" : "their reasons are"} on ${failures.size === 1 ? "it" : "them"}.` : "",
        notSent > 0 ? `${plural(notSent, "address was", "addresses were")} not tried.` : "",
      ]
        .filter(Boolean)
        .join(" ") || null,
    );
    if (stopped) setError(stopped);
    setBusy(null);
    // The server is authoritative: after a refusal the list shows what it holds.
    if (failures.size) void load(true);
  };

  const revoke = async (email: string) => {
    if (!roster || busy) return;
    setBusy(`revoke:${email}`);
    setError(null);
    try {
      const next = await mutateOrganizationRoster(organization.id, contextRevision, () => organizationMembers.revokeInvite(email, roster.contextRevision));
      if (!alive.current) return;
      loadSeq.current += 1;
      setRoster(next);
      // The revoked link no longer works; stop offering it.
      setIssued((current) => {
        const rest = { ...current };
        delete rest[lower(email)];
        return rest;
      });
    } catch (failure) {
      if (!alive.current) return;
      setError(membersErrorMessage(failure));
      void load(true);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const copyLink = async (email: string, url: string) => {
    if (!canInvite || busy || rosterState.loading) return;
    setCopied(null);
    setError(null);
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(url);
      if (alive.current) setCopied(email);
    } catch {
      if (alive.current) setError("Couldn't copy the invitation link. Try again.");
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" || event.key === "," || event.key === " " || event.key === ";") {
      if (event.key === "Enter" && !text.trim()) {
        event.preventDefault();
        if (sendable.length) void send();
        return;
      }
      event.preventDefault();
      add(text);
      setText("");
    } else if (event.key === "Backspace" && !text && chips.length) {
      event.preventDefault();
      setChips((current) => current.slice(0, -1));
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text");
    if (!SEPARATORS.test(pasted.trim())) return;
    event.preventDefault();
    add(`${text} ${pasted}`);
    setText("");
  };

  const pending = [...(roster?.pendingInvites ?? [])].sort((left, right) => right.createdAt - left.createdAt);

  return (
    <StepPage
      title="Invite your team"
      description="Members use the organization's GitHub access, agent logins and cloud computer. There's nothing for them to set up."
      aside={
        <AlmostSet
          organizationId={organization.id}
          machine={record.machine}
          roster={roster ?? (rosterState.error && !rosterState.loading ? "failed" : null)}
        />
      }
    >
      {!roster ? (
        rosterState.loading ? (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading members…
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <p className="text-[13px] text-destructive">{rosterState.error}</p>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        )
      ) : (
        <>
          {!manage ? (
            <p className="text-[13px] text-muted-foreground">Only owners and admins can invite people to {organization.name}.</p>
          ) : !canInvite ? (
            <p className="text-[13px] text-muted-foreground">{organization.name} cannot invite members.</p>
          ) : (
            <>
              <FieldLabel htmlFor="cloud-setup-invite-email">Invite by email</FieldLabel>
              <div className="flex flex-wrap items-start gap-2">
                <div
                  className="flex min-h-[68px] min-w-[260px] flex-1 cursor-text flex-wrap content-start gap-1.5 rounded-lg border border-hairline bg-card p-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30"
                  onClick={() => input.current?.focus()}
                >
                  {chips.map((chip) => {
                    const problem = problemOf(chip);
                    return (
                      <span
                        key={chip.email}
                        title={problem ?? undefined}
                        className={cn(
                          "inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border pr-1 pl-1.5 text-[12.5px]",
                          problem ? "border-destructive/50 bg-destructive/10 text-destructive" : "border-hairline bg-raised",
                        )}
                      >
                        <span
                          className={cn("grid size-[22px] shrink-0 place-items-center rounded-full text-[12px] leading-none font-semibold tracking-[-0.04em]", problem && "bg-destructive/15")}
                          style={problem ? undefined : tint(personColor(chip.email))}
                        >
                          {initials(chip.email)}
                        </span>
                        <span className="truncate">{chip.email}</span>
                        {problem && <span className="sr-only">: {problem}</span>}
                        <button
                          type="button"
                          aria-label={`Remove ${chip.email}`}
                          className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-veil-raised hover:text-foreground"
                          disabled={busy === "send"}
                          onClick={(event) => {
                            event.stopPropagation();
                            remove(chip.email);
                          }}
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    );
                  })}
                  <input
                    ref={input}
                    id="cloud-setup-invite-email"
                    type="email"
                    autoComplete="off"
                    autoFocus
                    placeholder={chips.length ? "" : "name@company.com"}
                    className="h-7 min-w-[160px] flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-faint"
                    value={text}
                    maxLength={320}
                    disabled={busy === "send"}
                    onChange={(event) => {
                      const value = event.target.value;
                      // A typed separator ends an address.
                      if (SEPARATORS.test(value)) {
                        add(value);
                        setText("");
                      } else setText(value);
                    }}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                    onBlur={() => {
                      if (text.trim()) {
                        add(text);
                        setText("");
                      }
                    }}
                  />
                </div>
                <select
                  aria-label="Role for these invites"
                  className="h-9 w-[150px] shrink-0 rounded-md border border-hairline bg-card px-2 text-[12.5px] disabled:opacity-60"
                  value={role}
                  disabled={busy === "send"}
                  onChange={(event) => setRole(event.target.value === "admin" ? "admin" : "member")}
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <Button className="h-9 px-3 text-[12.5px]" disabled={Boolean(busy) || (!sendable.length && !text.trim())} onClick={() => void send()}>
                  {busy === "send" && <Loader2 className="animate-spin" />}
                  Send invites
                </Button>
              </div>
              {chips.some((chip) => problemOf(chip)) && (
                <ul className="mt-2 grid gap-0.5 text-[12px] text-destructive" aria-label="Addresses not sent">
                  {chips.flatMap((chip) => {
                    const problem = problemOf(chip);
                    return problem ? [<li key={chip.email}>{`${chip.email}: ${problem}`}</li>] : [];
                  })}
                </ul>
              )}
              <p className="mt-2 text-[12px] text-faint">Press Enter, a comma or a space after each address. Invitees get no access until they accept.</p>
              {/* #1114: no domain-join policy exists in the accepted member contract.
                  Keep this unavailable until the dependency in docs/ACCOUNTS.md ships. */}
              <p className="mt-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Link className="size-3.5 shrink-0" aria-hidden />
                Shared invite link unavailable. Invite each person by email.
              </p>
              {outcome && (
                <p role="status" className="mt-2 text-[12px] text-muted-foreground">
                  {outcome}
                </p>
              )}
            </>
          )}

          <div className="mt-7 mb-2 flex items-baseline gap-2 text-[12.5px]">
            <span className="font-medium">Pending invitations</span>
            <span className="text-faint">{pending.length}</span>
          </div>
          {pending.length ? (
            <ul className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-card" aria-label="Pending invitations">
              {pending.map((invite) => {
                const key = lower(invite.email);
                const own = issued[key];
                const expired = invite.status === "expired" || (invite.expiresAt !== undefined && invite.expiresAt <= now);
                const copyable = canInvite && own?.inviteUrl && own.role === invite.role && !expired;
                return (
                  <li key={invite.email} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5" aria-label={invite.email}>
                    <span className="grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold" style={tint(personColor(invite.email))} aria-hidden>
                      {initials(invite.email)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px]">{inviteeName(invite.email)}</div>
                      <div className="truncate text-[12px] text-muted-foreground">{invite.email}</div>
                      {copyable && <div className="text-[12px] text-muted-foreground">Only {invite.email} can accept this link, joining as {roleLabel(invite.role)}.</div>}
                      {copyable && !own.emailSent && <div className="text-[12px] text-warning">The email could not be sent. Copy the link and share it with them.</div>}
                    </div>
                    <span className="text-[12.5px] text-muted-foreground">{roleLabel(invite.role)}</span>
                    <span className={cn("text-[12px]", expired ? "text-warning" : "text-faint")}>{expired ? "Expired" : sentLabel(invite.createdAt, now)}</span>
                    {copyable && (
                      <Button size="xs" variant="ghost" className="text-[12px]" disabled={Boolean(busy) || rosterState.loading} aria-label={`Copy invitation link for ${invite.email}`} onClick={() => void copyLink(key, own.inviteUrl!)}>
                        {copied === key ? <Check /> : <Link />}
                        {copied === key ? "Copied" : "Copy link"}
                      </Button>
                    )}
                    {manage && (
                      <Button size="xs" variant="ghost" className="text-[12px]" disabled={Boolean(busy)} aria-label={`Revoke invite to ${invite.email}`} onClick={() => void revoke(invite.email)}>
                        {busy === `revoke:${invite.email}` ? <Loader2 className="animate-spin" /> : "Revoke"}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">No invitations are pending. Inviting can wait: you can finish now and invite people later from Settings.</p>
          )}
        </>
      )}
      <StepError>{error}</StepError>
      <div className="mt-8">
        <FinishActions {...props} onDone={props.onDone} />
      </div>
    </StepPage>
  );
}
