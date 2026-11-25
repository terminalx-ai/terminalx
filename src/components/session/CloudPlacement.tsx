import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown, Eye, Server } from "@/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { AgentLoginsLink } from "@/components/cloud/AgentLoginsLink";
import { useAccount } from "@/lib/account";
import { api, type CloudWorkspaceQuote, type GithubIdentity } from "@/lib/api";
import { NEW_SESSION_ADMIN_REASON } from "@/lib/cloudCollab";
import { useCloudCatalog } from "@/lib/cloudCatalog";
import { checkCloudPlacement, cloudPlacementOffers, quoteCloudPlacement, sessionPlacementReady, type CloudCreatePlacement, type CloudPlacementOffer } from "@/lib/cloudNewSession";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { refreshGithubIdentity } from "@/lib/githubIdentity";
import { ProvidersPaused } from "@/lib/hiddenProviders";
import { initialIdleSuspend, idleSuspendChoices } from "@/lib/idleSuspend";
import { formatMicros } from "@/lib/organizationCompute";
import { phase2Ready } from "@/lib/phase2Readiness";
import { atLimit, runningLimitMessage } from "@/lib/runningLimit";
import type { CloudProject } from "@/types/target";
import { cloudPlacementError, useCloudProjectChoices } from "./CloudNewSession";
import type { CloudWhere } from "./MachineNewSession";

type Read<T> = { value: T; error?: never } | { value?: never; error: unknown };

function usePlacementRead<T>(key: string | null, read: () => Promise<T>): Read<T> | undefined {
  const [answer, setAnswer] = useState<{ key: string; result: Read<T> }>();
  useEffect(() => {
    if (!key) return;
    let live = true;
    setAnswer(undefined);
    read().then(
      (value) => { if (live) setAnswer({ key, result: { value } }); },
      (error) => { if (live) setAnswer({ key, result: { error } }); },
    );
    return () => { live = false; };
  }, [key]); // The key identifies every input to the read.
  return answer?.key === key ? answer?.result : undefined;
}

export type PlacementChoice = { orgId: string; provider: string | null };
type Section = ReturnType<typeof useCloudProjectChoices>[number];
type Target = { project: CloudProject | null; locked: string | null };

function targetFor(section: Section, cloudProject: CloudProject | null, localPath: string | null, localIdentity: Read<GithubIdentity> | undefined): Target {
  if (section.mayStart !== true) {
    return { project: null, locked: section.mayStart === false ? NEW_SESSION_ADMIN_REASON : "Checking organization access…" };
  }
  const current = cloudProject?.orgId === section.orgId ? cloudProject : null;
  if (!cloudProject && localPath) {
    if (!localIdentity) return { project: null, locked: "Checking the repository’s GitHub remote…" };
    if (!localIdentity.value) return { project: null, locked: "Couldn’t check the repository’s GitHub remote." };
  }
  const github = localIdentity?.value;
  const identity = cloudProject?.identity ?? (github?.remoteHost === "github" && github.repo ? `github.com/${github.repo.toLowerCase()}` : null);
  if (!current?.blank && (cloudProject || localPath) && !identity?.startsWith("github.com/")) {
    return { project: null, locked: "Cloud placement requires a GitHub repository." };
  }
  const project = current ?? section.projects.find((choice) => choice.identity === identity) ?? section.more?.find((choice) => choice.identity === identity);
  if (!project?.selected) {
    return { project: null, locked: identity ? "This repository is unavailable in the organization’s cloud." : "Choose a GitHub project first." };
  }
  return { project, locked: null };
}

export function useCloudPlacement({
  sections, cloudProject, localPath, agent, selection, defaultCreate, idleChoice,
}: {
  sections: Section[];
  cloudProject: CloudProject | null;
  localPath: string | null;
  agent: string | null;
  selection: PlacementChoice | null;
  defaultCreate: boolean;
  idleChoice: number | null;
}) {
  const { status } = useAccount();
  const catalog = useCloudCatalog();
  const privacy = useDataPrivacy();
  const ready = privacy.ready && !privacy.enabled ? sections.filter(({ orgId }) => sessionPlacementReady(status, orgId)) : [];
  const readyHere = !!cloudProject && ready.some(({ orgId }) => orgId === cloudProject.orgId);
  const [revision, retry] = useState(0);
  const scope = status.context?.revision ?? status.identity?.email;
  const shouldReadIdentity = !cloudProject && localPath && ready.some(({ mayStart }) => mayStart === true);
  const identityKey = shouldReadIdentity ? JSON.stringify([scope, revision, localPath]) : null;
  const localIdentity = usePlacementRead(identityKey, () => refreshGithubIdentity(localPath!));
  const targets = ready.map((section) => ({ section, ...targetFor(section, cloudProject, localPath, localIdentity) }));
  const offerKey = ready.length ? JSON.stringify([scope, revision, ready.map(({ orgId }) => [orgId, status.organizations?.find((org) => org.id === orgId)?.cloud?.flags])]) : null;
  const offers = usePlacementRead(offerKey, () => Promise.all(ready.map(async ({ orgId }) => {
    try {
      return { orgId, offers: await cloudPlacementOffers(orgId), error: null };
    } catch (error) {
      return { orgId, offers: [], error };
    }
  })));
  const readAgent = cloudProject ? agent : null;
  const checkTargets = targets.filter(({ project }) => !!project);
  const checksKey = readAgent && checkTargets.length ? JSON.stringify([scope, revision, readAgent, checkTargets.map(({ project }) => project?.key)]) : null;
  const checks = usePlacementRead(checksKey, () => Promise.all(checkTargets.map(async ({ project }) => {
    try {
      await checkCloudPlacement(project!, readAgent!);
      return { key: project!.key, error: null };
    } catch (error) {
      return { key: project!.key, error };
    }
  })));
  const activeSelection = readyHere && selection?.orgId === cloudProject?.orgId ? selection : null;
  const startsNew = readyHere && (defaultCreate || !!activeSelection?.provider);
  const activeOffers = offers?.value?.find(({ orgId }) => orgId === cloudProject?.orgId);
  const offer = startsNew ? (activeSelection?.provider
    ? activeOffers?.offers.find(({ id }) => id === activeSelection.provider)
    : activeOffers?.offers.find(({ setup }) => setup)) : null;
  const setup = offer?.setup;
  const choices = setup ? idleSuspendChoices(setup.allowedIdleSuspendMinutes) : [];
  const idleMinutes = setup ? initialIdleSuspend(choices, setup.defaults.idleSuspendMinutes, idleChoice) : null;
  const idleOptions = setup ? { choices, defaultMinutes: setup.defaults.idleSuspendMinutes, cap: setup.maxIdleSuspendMinutes ?? null } : null;
  const [quoteRevision, retryQuote] = useState(0);
  const quoteKey = setup ? JSON.stringify([offerKey, quoteRevision, cloudProject?.orgId, setup.provider, idleMinutes]) : null;
  const price = usePlacementRead(quoteKey, () => quoteCloudPlacement(cloudProject!.orgId, setup!, idleMinutes));
  const quote = price?.value ?? null;
  useEffect(() => {
    if (!quote) return;
    const timer = window.setTimeout(() => retryQuote((value) => value + 1), Math.max(0, quote.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [quote]);

  const quotaReason = (orgId: string) => {
    const quota = catalog.orgs[orgId]?.quota;
    return atLimit(quota?.running) ? runningLimitMessage(orgId, catalog)
      : atLimit(quota?.total ?? quota) ? "The organization has reached its cloud workspace limit." : null;
  };
  const preflightReason = (project: CloudProject | null) => {
    if (!project) return null;
    if (!readAgent) return "Choose an agent first.";
    const check = checks?.value?.find(({ key }) => key === project.key);
    return !check ? "Checking cloud readiness…" : check.error ? cloudPlacementError(check.error, project.orgId) : null;
  };
  function offerReason(entry: CloudPlacementOffer, orgId: string) {
    return entry.error ? cloudPlacementError(entry.error, orgId) : null;
  }
  const rows = targets.flatMap<CloudWhere>(({ section, project, locked }) => {
    const { orgId, orgName } = section;
    const result = offers?.value?.find((item) => item.orgId === orgId);
    const common = locked ?? quotaReason(orgId) ?? (readAgent ? preflightReason(project) : null);
    if (!result?.offers.length) return [{
      orgId, orgName, projectCount: 0, startKey: null,
      locked: locked ?? (!result ? "Loading cloud providers…" : result.error ? cloudPlacementError(result.error, orgId) : "Connect a compute provider in Settings first."),
    }];
    return result.offers.map((entry) => ({
      orgId, orgName, projectCount: section.projects.length, startKey: project?.key ?? null,
      provider: entry.id, providerLabel: entry.label, detail: entry.setup ? setupSummary(entry.setup) : null,
      locked: locked ?? offerReason(entry, orgId) ?? common,
    }));
  });
  const usageOrg = (startsNew || defaultCreate) && cloudProject && privacy.ready && !privacy.enabled
    && phase2Ready(status, cloudProject.orgId, "precreateUsage") ? cloudProject.orgId : null;
  const usageKey = usageOrg ? JSON.stringify([status.context?.account, scope, revision, usageOrg]) : null;
  const usage = usePlacementRead(usageKey, () => api.cloudWorkspacePrecreateUsage(usageOrg!));
  const running = usage?.value?.quota.running;
  const usageSummary = usage?.value && running ? [
    `At last check, you held ${usage.value.callerOwnedRunning} of ${running.used} organization running slots.`,
    usage.value.callerOwnedRunningLimit === null
      ? "No per-member running limit."
      : `Per-member running limit: ${usage.value.callerOwnedRunningLimit}.`,
    running.limit == null ? null : `Organization running limit: ${running.limit}.`,
    "Create checks capacity again.",
  ].filter(Boolean).join(" ") : null;
  const activeTarget = targets.find(({ section }) => section.orgId === cloudProject?.orgId);
  const pausedFor = startsNew && !offer && activeTarget?.section.mayStart === true
    ? activeOffers?.offers.flatMap(({ error }) => error instanceof ProvidersPaused ? error.providers : []) ?? []
    : [];
  const blocked = startsNew && cloudProject ? activeTarget?.locked ?? quotaReason(cloudProject.orgId)
    ?? (!activeOffers ? "Loading cloud providers…" : activeOffers.error ? cloudPlacementError(activeOffers.error, cloudProject.orgId) : null)
    ?? (offer ? offerReason(offer, cloudProject.orgId) : activeSelection?.provider ? "The selected cloud provider is unavailable." :
      activeOffers?.offers[0] ? offerReason(activeOffers.offers[0], cloudProject.orgId) : "Connect a compute provider in Settings first.")
    ?? preflightReason(cloudProject)
    ?? (!quote ? price?.error ? cloudPlacementError(price.error, cloudProject.orgId) : "Checking the machine price…" : null)
    : null;
  return { ready, readyHere, startsNew, rows, usageSummary, offer, quote, checkingPrice: !!quoteKey && !price, idleOptions, idleMinutes, blocked, pausedFor, recheck: () => retry((value) => value + 1) };
}

function hourly(rate: number, currency: string, pricing: string) {
  return `${pricing === "estimate" ? "About " : ""}${formatMicros(rate, currency)} an hour`;
}

function setupSummary(setup: NonNullable<CloudPlacementOffer["setup"]>): string {
  const machine = setup.machineClasses.find(({ id }) => id === setup.defaults.machineClassId);
  const location = setup.locations.find(({ id }) => id === setup.defaults.locationId);
  if (!machine) return "Machine details unavailable";
  return [
    `${machine.label} · ${machine.vcpu} vCPU · ${machine.memoryMiB / 1024} GB`,
    location?.label,
    machine.activeHourlyMicros == null ? "Price unavailable" : hourly(machine.activeHourlyMicros, setup.currency, setup.pricing),
  ].filter(Boolean).join(" · ");
}

const chip = "flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground";

export function CloudPlacementChips({ accessMode, onAccessMode, orgName, quote, checkingPrice, disabled }: {
  accessMode: CloudCreatePlacement["accessMode"];
  onAccessMode: (mode: CloudCreatePlacement["accessMode"]) => void;
  orgName: string;
  quote: CloudWorkspaceQuote | null;
  checkingPrice: boolean;
  disabled: boolean;
}) {
  const menu = useRowMenu();
  const visibleTo = accessMode === "private" ? "Only me" : orgName;
  const config = quote?.configuration;
  const machine = config && quote ? `${config.machineClassLabel} · ${hourly(quote.activeHourlyMicros, quote.currency, quote.pricing)}` : checkingPrice ? "Machine price pending" : "Machine price unavailable";
  return (
    <>
      <DropdownMenu {...menu.root}>
        <DropdownMenuTrigger asChild {...menu.trigger}>
          <button type="button" className={`${chip} hover:bg-veil-raised`} aria-label={`Visible to ${visibleTo}`} disabled={disabled}>
            <Eye className="size-3.5 shrink-0" />
            <span className="truncate">Visible to {visibleTo}</span>
            <ChevronDown className="size-3 shrink-0 text-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-48">
          <DropdownMenuLabel>Who can open this session</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={accessMode} onValueChange={(value) => onAccessMode(value === "organization" ? value : "private")}>
            <DropdownMenuRadioItem value="organization">Everyone at {orgName}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="private">Only me</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className={chip} data-testid="cloud-placement-machine" title={config ? `${machine} · ${config.vcpu} vCPU · ${config.memoryMiB / 1024} GB · ${config.locationLabel}` : undefined}>
        <Server className="size-3.5 shrink-0" />
        <span className="truncate">{machine}</span>
      </span>
    </>
  );
}

export function CloudPlacementReadiness({ blocked, orgId, orgName, agentName, onRecheck, children }: {
  blocked: string | null;
  orgId: string;
  orgName: string;
  agentName: string;
  onRecheck: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground" data-testid="cloud-placement-readiness">
      <div role="status">
        {blocked ? <>{blocked} <AgentLoginsLink message={blocked} organizationId={orgId} className="ml-1" /></> :
          <span className="inline-flex flex-wrap items-center gap-x-1"><Check className="size-3 text-add" aria-hidden />Cloud preflight checked for {agentName} in {orgName}. Live sign-in is checked at launch. The first message sends once the agent is ready.</span>}
      </div>
      {blocked && !blocked.endsWith("…") && <button type="button" className="underline" onClick={onRecheck}>Recheck</button>}
      {children}
    </div>
  );
}
