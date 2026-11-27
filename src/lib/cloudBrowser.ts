import { useEffect, useState } from "react";
import type { WorkspaceNotification, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { PendingAsk } from "@/lib/transcript";

/**
 * Cloud browser for agents (PRO-209): agents in a cloud tab drive Chrome on
 * the workspace's cloud desktop through the runtime's `cloud_browser` MCP
 * server. Tabs that ask show one approval per browser session.
 */
export const CLOUD_BROWSER_SERVER = "cloud_browser";
export const CLOUD_BROWSER_OPEN_TOOL = `mcp__${CLOUD_BROWSER_SERVER}__open`;

/** The card that starts a browser session: one per session, never per click. */
export function isCloudBrowserAsk(ask: Pick<PendingAsk, "toolName">): boolean {
  return ask.toolName === CLOUD_BROWSER_OPEN_TOOL;
}

function text(input: unknown, name: string): string | null {
  if (!input || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Where the session starts and the agent's stated plan, as the runtime asked. */
export function cloudBrowserAskDetail(ask: Pick<PendingAsk, "input">): { url: string | null; plan: string | null; agent: string } {
  return { url: text(ask.input, "url"), plan: text(ask.input, "plan"), agent: text(ask.input, "agent") ?? "The agent" };
}

/** What the Desktop tab shows while an agent drives the cloud desktop's browser. */
export interface CloudDesktopAgent {
  /** "Claude Code", "Codex". */
  agent: string;
  /** The tab the agent runs in. */
  tabTitle: string | null;
  /** "Clicking “Sign in”". */
  action: string | null;
  /** How many actions this browser session has taken. */
  actions: number;
  /** Someone took control: the agent waits until the desktop is handed back. */
  held: boolean;
}

/**
 * Whether the runtime offers the tool: off, on, on but missing the desktop
 * packages, or on while Chrome could not start with the runtime's pipe.
 */
export type CloudBrowserOffer = "off" | "on" | "packages-missing" | "unavailable";

export interface CloudDesktopAgentState {
  browser: CloudBrowserOffer;
  driving: CloudDesktopAgent | null;
}

const OFFERS: readonly CloudBrowserOffer[] = ["off", "on", "packages-missing", "unavailable"];

/** Read a `desktop.agent` notification. Anything malformed is ignored. */
export function parseDesktopAgent(event: WorkspaceNotification): CloudDesktopAgentState | null {
  if (event.event !== "desktop.agent") return null;
  const { browser, driving } = event.params;
  if (typeof browser !== "string" || !OFFERS.includes(browser as CloudBrowserOffer)) return null;
  if (driving === null || driving === undefined) return { browser: browser as CloudBrowserOffer, driving: null };
  if (typeof driving !== "object") return null;
  const d = driving as Record<string, unknown>;
  if (typeof d.agent !== "string" || !d.agent.trim()) return null;
  const actions = typeof d.actions === "number" && Number.isInteger(d.actions) && d.actions >= 0 ? d.actions : 0;
  return {
    browser: browser as CloudBrowserOffer,
    driving: {
      agent: d.agent.trim(),
      tabTitle: typeof d.tabTitle === "string" && d.tabTitle.trim() ? d.tabTitle.trim() : null,
      action: typeof d.action === "string" && d.action.trim() ? d.action.trim() : null,
      actions,
      held: d.held === true,
    },
  };
}

/**
 * The runtime's last word on the tool, per workspace and in memory only, so
 * the workspace details card can say the environment lacks the packages.
 */
const offers = new Map<string, CloudBrowserOffer>();
const offerListeners = new Set<() => void>();

export function rememberCloudBrowserOffer(workspaceKey: string, offer: CloudBrowserOffer): void {
  if (offers.get(workspaceKey) === offer) return;
  offers.set(workspaceKey, offer);
  for (const listener of offerListeners) listener();
}

export function useCloudBrowserOffer(workspaceKey: string): CloudBrowserOffer | null {
  const [offer, setOffer] = useState(() => offers.get(workspaceKey) ?? null);
  useEffect(() => {
    const update = () => setOffer(offers.get(workspaceKey) ?? null);
    update();
    offerListeners.add(update);
    return () => { offerListeners.delete(update); };
  }, [workspaceKey]);
  return offer;
}

type AgentClient = Pick<WorkspaceRpcClient, "onNotification">;

/** The latest `desktop.agent` state on this link; reset when the link changes. */
export function useCloudDesktopAgent(client: AgentClient | null, workspaceKey: string | null): CloudDesktopAgentState | null {
  const [state, setState] = useState<CloudDesktopAgentState | null>(null);
  useEffect(() => {
    setState(null);
    if (!client) return;
    return client.onNotification((event) => {
      const next = parseDesktopAgent(event);
      if (!next) return;
      if (workspaceKey) rememberCloudBrowserOffer(workspaceKey, next.browser);
      setState(next);
    });
  }, [client, workspaceKey]);
  return state;
}

/** The chat's "Open Desktop tab" on a cloud browser card; SessionView listens. */
export const OPEN_CLOUD_DESKTOP_EVENT = "terminalx:open-cloud-desktop";

export function openCloudDesktop(): void {
  window.dispatchEvent(new CustomEvent(OPEN_CLOUD_DESKTOP_EVENT));
}
