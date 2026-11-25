import { useEffect, useMemo, useState } from "react";
import { WorkspaceRpcError } from "@terminalx/portable/workspace";
import { errorMessage, type CloudWorkspaceQuote } from "@/lib/api";
import { isRoleRefusal, roleRefusedMessage } from "@/lib/accountRoles";
import { getAccount, useAccount } from "@/lib/account";
import { cloudOrganizations, defaultOrgId, liveCloudOrgIds, placeCloudProjects, useCloudCatalog } from "@/lib/cloudCatalog";
import { WORKSPACE_NOT_REACHABLE } from "@/lib/cloudAgentApi";
import { CreateRefused, createErrorMessage, isClientError } from "@/lib/cloudCreate";
import { cloudIdleOptions, type CloudIdleOptions } from "@/lib/cloudNewSession";
import { cloudKeyOrgId, managesOrganization, mayStartCloudSessions } from "@/lib/multiOrg";
import { idleSuspendSentence } from "@/lib/idleSuspend";
import { formatMicros } from "@/lib/organizationCompute";
import { usePrefs } from "@/lib/prefs";
import { useCloudPins } from "@/lib/cloudPins";
import { useSessionStore } from "@/lib/sessions";
import type { CloudProject } from "@/types/target";

/**
 * The cloud half of the new-session form (PRO-23): which cloud project the
 * form is for, and the words for a start's errors and a new workspace's machine.
 */

/**
 * Cloud projects the new-session picker offers, per organization section:
 * every live organization's (all cloud-enabled ones on a server that
 * authorizes by membership, CS-18; else the default one), as their sidebar
 * sections show them, default first. None while signed out.
 * Sidebar hiding and One organization mode never restrict this picker.
 */
export function useCloudProjectChoices(): { orgId: string; orgName: string; projects: CloudProject[]; more?: CloudProject[]; mayStart: boolean | null }[] {
  const catalog = useCloudCatalog();
  const prefs = usePrefs();
  const cloudPins = useCloudPins();
  const { status } = useAccount();
  return useMemo(() => {
    const live = new Set(liveCloudOrgIds(status));
    const defaultOrg = defaultOrgId(status);
    const orgs = cloudOrganizations(status)
      .filter((org) => live.has(org.id))
      .sort((a, b) => Number(b.id === defaultOrg) - Number(a.id === defaultOrg) || sectionName(a).localeCompare(sectionName(b)));
    return orgs.map((org) => {
      const placed = placeCloudProjects(catalog.orgs[org.id] ?? { orgId: org.id, workspaces: [], repositories: null }, catalog.createMemory, {
        pinned: cloudPins[org.id],
        added: prefs.cloudProjects[org.id],
        blank: prefs.cloudBlankProjects[org.id],
      });
      // Whether this account may start a session there: an owner or admin; null while its role is not known yet.
      return { orgId: org.id, orgName: sectionName(org), projects: placed.projects, more: placed.more, mayStart: mayStartCloudSessions(status, org.id) };
    });
  }, [catalog, cloudPins, prefs.cloudProjects, prefs.cloudBlankProjects, status]);
}

function sectionName(org: { isPersonal?: boolean; name: string }): string {
  return org.isPersonal ? "Personal" : org.name;
}

/** The cloud project the new-session form is preset with, and its organization's name; null for a local draft. */
export function useCloudDraft(): { project: CloudProject | null; orgName: string; mayStart: boolean | null } | null {
  const store = useSessionStore();
  const catalog = useCloudCatalog();
  const prefs = usePrefs();
  const cloudPins = useCloudPins();
  const { status } = useAccount();
  const key = store.cloudSessionPreset?.projectKey ?? null;
  return useMemo(() => {
    // Only a cloud project presets this form; any other key is no cloud draft.
    const orgId = cloudKeyOrgId(key);
    if (!orgId) return null;
    const org = status.organizations?.find((item) => item.id === orgId);
    const orgName = org ? (org.isPersonal ? "Personal" : org.name) : "Organization";
    const placed = placeCloudProjects(catalog.orgs[orgId] ?? { orgId, workspaces: [], repositories: null }, catalog.createMemory, {
      pinned: cloudPins[orgId],
      added: prefs.cloudProjects[orgId],
      blank: prefs.cloudBlankProjects[orgId],
    });
    const project = [...placed.projects, ...placed.more].find((item) => item.key === key) ?? null;
    return { project, orgName, mayStart: mayStartCloudSessions(status, orgId) };
  }, [key, catalog, cloudPins, prefs.cloudProjects, prefs.cloudBlankProjects, status]);
}

export function cloudStartError(error: unknown, orgId: string | null = null): string {
  // Refused for lack of role (the server's code, or the runtime's `forbidden`
  // for a session this connection may not start): the form was offered on a
  // role that has changed since.
  if (isRoleRefusal(error)) return roleRefusedMessage("start a new cloud session");
  if (error instanceof CreateRefused) return createErrorMessage(error.code, error.detail, managesOrganization(getAccount().status, orgId));
  if (isClientError(error)) return createErrorMessage(error.code);
  // The workspace's runtime refused the new tab ("Claude Code is not installed
  // in this workspace"): its message is written for the reader, and its code
  // (`unavailable`, `invalid`) is no create refusal. It comes off the wire:
  // bounded, and an empty one falls back to the code's own wording.
  if (error instanceof WorkspaceRpcError) {
    const message = typeof error.message === "string" ? error.message.trim() : "";
    return message ? message.slice(0, 300) : createErrorMessage(error.code);
  }
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : error instanceof Error ? error.message : null;
  if (code === "cloud_workspace_unreachable") return "The cloud workspace did not come up in time. Try again.";
  if (code === "cloud_runtime_update_required") return "The cloud workspace's runtime needs an update before it can start sessions.";
  if (code === "cloud_workspace_stopped") return "The cloud workspace is stopped.";
  if (code === WORKSPACE_NOT_REACHABLE) return "The cloud workspace can't be reached: it needs attention. Open it to see why.";
  if (code && /^[a-z_]+$/.test(code)) return createErrorMessage(code);
  return errorMessage(error);
}

export function cloudPlacementError(error: unknown, orgId: string): string {
  if (error && typeof error === "object" && "code" in error && error.code === "cloud_environment_version_missing") {
    return "No environment version is ready for this organization.";
  }
  return cloudStartError(error, orgId);
}

/** A quote in words: the machine it is for, and what it costs running and stopped. */
export function quoteText(quote: CloudWorkspaceQuote, providerLabel: string): { machine: string; price: string } {
  const config = quote.configuration;
  const hourly = formatMicros(quote.activeHourlyMicros, quote.currency);
  const suspended = quote.estimatedSuspendedMonthlyMicros !== null ? formatMicros(quote.estimatedSuspendedMonthlyMicros, quote.currency) : null;
  return {
    machine: `${providerLabel} · ${config.machineClassLabel} (${config.vcpu} vCPU, ${Math.round(config.memoryMiB / 1024)} GB) · ${config.locationLabel}`,
    price: `${hourly} an hour while it runs${quote.pricing === "estimate" ? " (estimate)" : ""}${suspended ? `, about ${suspended} a month while stopped` : ""}. ${idleSuspendSentence(config.idleSuspendMinutes)}`,
  };
}

/** How long one organization's idle choices are kept before setup is asked again. */
const IDLE_OPTIONS_TTL_MS = 5 * 60_000;
const idleOptionsCache = new Map<string, { at: number; options: Promise<CloudIdleOptions> }>();

/**
 * What "Stop when idle" offers for a new workspace in this organization
 * (PRO-410), or null while it loads, when it cannot be read (the create then
 * takes the provider's default and reports its own errors), or for no
 * organization. Read once per organization for a few minutes, not per render.
 */
export function useCloudIdleOptions(orgId: string | null): CloudIdleOptions | null {
  const [loaded, setLoaded] = useState<{ orgId: string; options: CloudIdleOptions } | null>(null);
  useEffect(() => {
    if (!orgId) return;
    let live = true;
    const cached = idleOptionsCache.get(orgId);
    const entry = cached && Date.now() - cached.at < IDLE_OPTIONS_TTL_MS ? cached : { at: Date.now(), options: cloudIdleOptions(orgId) };
    idleOptionsCache.set(orgId, entry);
    entry.options.then(
      (options) => live && setLoaded({ orgId, options }),
      () => {
        if (idleOptionsCache.get(orgId) === entry) idleOptionsCache.delete(orgId);
      },
    );
    return () => {
      live = false;
    };
  }, [orgId]);
  return orgId && loaded?.orgId === orgId && loaded.options.choices.length > 0 ? loaded.options : null;
}
