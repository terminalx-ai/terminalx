import { useEffect, useState, useSyncExternalStore } from "react";
import { api, type CloudWorkspacePreflight } from "./api";
import { getAccount, useAccount } from "./account";
import { organizationMembers } from "./organizationMembers";

// These are the existing cloud login agents, with their actual launch/preflight IDs.
export const welcomeAgents = [{ id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex" }, { id: "cursor-agent", name: "Cursor" }] as const;
export type Readiness = "loading" | "ready" | "not-ready" | "unknown" | "unavailable";
export interface WelcomeReadiness {
  repositories: { state: Readiness; count?: number };
  compute: Readiness | "selection-required";
  agents: Record<string, Readiness>;
  admins: { state: Readiness; names: string[] };
}
const loading = (): WelcomeReadiness => ({ repositories: { state: "loading" }, compute: "loading", agents: Object.fromEntries(welcomeAgents.map(({ id }) => [id, "loading"])), admins: { state: "loading", names: [] } });
export function agentReadiness(result: CloudWorkspacePreflight, agent: string): Readiness {
  // Old servers can return ready:true without ever checking this agent.
  const checks = result.checks.filter((check) => check.kind === "agent-credential" && check.agent === agent);
  if (!checks.length) return "unknown";
  if (checks.some((check) => check.status === "failed")) return "not-ready";
  return checks.every((check) => check.status === "verified") ? "ready" : "unknown";
}
async function loadReadiness(orgId: string): Promise<WelcomeReadiness> {
  const [repositories, providers, roster, ...agents] = await Promise.allSettled([
    api.cloudWorkspaceRepositories(orgId), api.cloudProviders(orgId), organizationMembers.listIn(orgId),
    ...welcomeAgents.map(({ id }) => api.cloudWorkspacePreflight([], orgId, id)),
  ] as const);
  const count = repositories.status === "fulfilled" ? repositories.value.repositories.filter((repo) => repo.state === "accessible").length : undefined;
  const names = roster.status === "fulfilled" ? roster.value.members.filter((person) => person.role === "owner" || person.role === "admin").map((person) => person.displayName || person.email) : [];
  return {
    repositories: { state: repositories.status === "rejected" ? "unavailable" : count ? "ready" : "not-ready", count },
    compute: providers.status === "rejected" ? ((providers.reason as { code?: string } | null)?.code === "active_organization_required" ? "selection-required" : "unavailable") : providers.value.providers.some((provider) => provider.availability === "available") ? "ready" : "not-ready",
    admins: { state: roster.status === "rejected" ? "unavailable" : names.length ? "ready" : "unknown", names },
    agents: Object.fromEntries(welcomeAgents.map(({ id }, index) => [id, agents[index].status === "fulfilled" ? agentReadiness(agents[index].value, id) : "unavailable"])),
  };
}
// Deduplicate simultaneous sidebar/settings reads; never retain readiness as a cached claim.
const flights = new Map<string, Promise<WelcomeReadiness>>();
export function useWelcomeReadiness(orgId: string) {
  const { status } = useAccount();
  const context = status.context;
  const member = status.state === "signed-in" && status.organizations?.some((org) => org.id === orgId);
  const key = member && context?.account ? JSON.stringify([context.account, context.revision, orgId]) : null;
  const [result, setResult] = useState<{ key: string; data: WelcomeReadiness } | null>(null);
  const [request, setRequest] = useState(0);
  useEffect(() => {
    if (!key) return;
    let active = true;
    setResult(null);
    let flight = flights.get(key);
    if (!flight) {
      flight = loadReadiness(orgId).finally(() => { if (flights.get(key) === flight) flights.delete(key); });
      flights.set(key, flight);
    }
    void flight.then((data) => {
      const latest = getAccount().status;
      if (active && latest.state === "signed-in" && latest.context?.account === context?.account && latest.context?.revision === context?.revision && latest.organizations?.some((org) => org.id === orgId)) setResult({ key, data });
    });
    return () => { active = false; };
  }, [key, orgId, context?.account, context?.revision, request]);
  return { data: result?.key === key ? result.data : loading(), retry: () => setRequest((value) => value + 1) };
}

const dismissalListeners = new Set<() => void>();
const dismissalKey = (account: string, organization: string) => `terminalx.organization-welcome.v1:${JSON.stringify([account, organization])}`;
export function welcomeDismissed(account: string, organization: string): boolean {
  try { return localStorage.getItem(dismissalKey(account, organization)) === "dismissed"; } catch { return false; }
}
export function dismissWelcome(account: string, organization: string): boolean {
  // Never let a stale click write a preference for the newly signed-in account.
  const { status } = getAccount();
  if (status.state !== "signed-in" || status.context?.account !== account || !status.organizations?.some((org) => org.id === organization)) return false;
  try { localStorage.setItem(dismissalKey(account, organization), "dismissed"); } catch { return false; }
  for (const listener of dismissalListeners) listener();
  return true;
}
export function useWelcomeDismissed(account: string, organization: string) {
  return useSyncExternalStore((listener) => {
    dismissalListeners.add(listener);
    window.addEventListener("storage", listener);
    return () => { dismissalListeners.delete(listener); window.removeEventListener("storage", listener); };
  }, () => welcomeDismissed(account, organization), () => false);
}
