import { useEffect, useRef, useState } from "react";
import { ChevronDown, Cloud, Smartphone, Users } from "@/icons";
import { api, errorMessage } from "@/lib/api";
import { refreshAccount, useAccount } from "@/lib/account";
import { newSetup, type OrganizationSetupRecord } from "@/lib/organizationSetup";
import { FieldLabel, PrimaryButton, StepActions, StepError, StepPage } from "./FlowLayout";

const POINTS = [
  { icon: Cloud, title: "Agents that keep going", text: "Sessions run in cloud workspaces on compute you own, even while your Mac sleeps." },
  { icon: Users, title: "Your team in the same sessions", text: "Watch an agent work, take over, or hand a session to a teammate." },
  { icon: Smartphone, title: "Steer from anywhere", text: "From this Mac, your phone, or the terminalx command line." },
];

/** "Paresh Dudhat" → "PD"; an email's first letter when there is no name. */
export function initials(name: string | null | undefined, email = ""): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length) return (words[0]![0]! + (words.length > 1 ? words.at(-1)![0]! : "")).toUpperCase();
  return (email[0] ?? "?").toUpperCase();
}

/**
 * Step 1 (12.01): name the organization and create it. The request is kept
 * on a setup record before it is sent, so a retry after a lost answer (or
 * after quitting) replays the same create: one organization, never two.
 * The new organization is selected, since every later step acts on it.
 */
export function OrganizationStep({
  accountEmail,
  contextRevision,
  creation,
  onRecord,
  onCreated,
}: {
  accountEmail: string;
  contextRevision: string;
  /** A creation already asked for and not confirmed: resumed with its name, never asked for again. */
  creation: OrganizationSetupRecord | null;
  onRecord: (record: OrganizationSetupRecord) => void;
  onCreated: (organizationId: string) => void;
}) {
  const { status } = useAccount();
  const draftKey = `terminalx.organization-setup.v1.${accountEmail}.name`;
  const [name, setName] = useState(() => creation?.name ?? globalThis.localStorage?.getItem(draftKey) ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const trimmed = name.trim();
  const create = async () => {
    if (flight.current || trimmed.length < 2) return;
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      const next: OrganizationSetupRecord = creation ?? { ...newSetup(trimmed, crypto.randomUUID()), flow: { step: "organization", passed: [], finishedAt: null } };
      onRecord(next);
      const created = await api.organizationCreate(next.name, next.requestId);
      const selected = created.selected !== false;
      onRecord({ ...next, organizationId: created.id, step: selected ? "compute" : "select", flow: { step: "github", passed: ["organization"], finishedAt: null } });
      globalThis.localStorage?.removeItem(draftKey);
      // The flow selects it again if that failed here: it is never created a second time.
      await refreshAccount();
      if (mounted.current) onCreated(created.id);
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure));
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const you = status.identity;
  const shown = trimmed || "Your organization";
  return (
    <StepPage
      eyebrow="TerminalX cloud"
      title="Create your organization"
      description="An organization keeps your repositories, agent logins and a cloud computer in one place, so everyone's sessions start in the same environment."
      asideLabel="Preview · how your team appears"
      aside={
        <>
          <div className="rounded-xl border border-hairline bg-raised p-3" data-testid="cloud-setup-team-preview">
            <div className="flex h-8 items-center gap-2 px-1">
              <span className="grid size-5 place-items-center rounded-[5px] bg-accent text-[11px] font-bold text-accent-foreground">{shown[0]!.toUpperCase()}</span>
              <span className="min-w-0 truncate font-medium">{shown}</span>
              <ChevronDown className="size-3.5 text-faint" aria-hidden />
            </div>
            {you && (
              <div className="mt-2 flex h-11 items-center gap-2.5">
                <span className="relative grid size-7 shrink-0 place-items-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                  {initials(you.name, you.email)}
                  <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-raised bg-add" />
                </span>
                <div className="min-w-0 leading-[17px]">
                  <div className="truncate text-[13px]">{you.name || you.email}</div>
                  <div className="truncate text-[11.5px] text-muted-foreground">you · setting up {shown}</div>
                </div>
              </div>
            )}
          </div>
          <p className="mt-3 text-xs leading-[18px] text-muted-foreground">Teammates show up here after they accept an invite. You add them in the last step.</p>
        </>
      }
    >
      <FieldLabel htmlFor="cloud-setup-organization-name">Organization name</FieldLabel>
      <input
        id="cloud-setup-organization-name"
        autoFocus
        className="h-10 w-[420px] max-w-full rounded-md border border-hairline bg-card px-3 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60"
        value={name}
        disabled={busy || Boolean(creation)}
        onChange={(event) => {
          setName(event.target.value);
          globalThis.localStorage?.setItem(draftKey, event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void create();
          }
        }}
      />
      {creation && <p className="mt-1.5 text-xs text-muted-foreground">Creating {creation.name} was asked for already. Creating again finishes that request; it never makes a second organization.</p>}

      <div className="mt-8 grid gap-4">
        {POINTS.map(({ icon: Icon, title, text }) => (
          <div key={title} className="flex items-start gap-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted">
              <Icon className="size-3.5 text-muted-foreground" />
            </span>
            <div>
              <div className="text-[13px] font-medium">{title}</div>
              <div className="text-[12.5px] text-muted-foreground">{text}</div>
            </div>
          </div>
        ))}
      </div>

      <StepActions note="Free to create. GitHub, compute and agent logins come next, and each can wait.">
        <PrimaryButton busy={busy} disabled={busy || trimmed.length < 2 || !contextRevision} onClick={() => void create()}>
          Create organization
        </PrimaryButton>
      </StepActions>
      <StepError>{error}</StepError>
    </StepPage>
  );
}
