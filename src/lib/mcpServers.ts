import { invoke } from "@tauri-apps/api/core";
import type { AccountStatus } from "@/lib/api";
import { phase2Features } from "@/lib/phase2Readiness";

/** Settings › MCP (PRO-239). Secrets go from the form to the Keychain and are never read back here. */
export type McpAuth = "oauth" | "bearer" | "headers" | "none";
export interface McpAgents { claudeCode: boolean; codex: boolean }

export interface McpServerRow {
  /** `local/<id>`, or `<organization id>/<server id>` for a shared server. */
  key: string;
  name: string;
  target: string;
  auth: McpAuth;
  headerNames: string[];
  agents: McpAgents;
  /** The organization sharing it. */
  sharedBy: string | null;
  off: boolean;
  /** Shared, but one of your own servers has its name. */
  shadowed: boolean;
  hasSecret: boolean;
  clientId: string | null;
}

export interface McpListing { servers: McpServerRow[]; callbackUrl: string; problems: string[] }

export type McpStatus =
  | { state: "connected" }
  | { state: "needsSignIn" }
  | { state: "exited"; code: number | null }
  | { state: "unreachable"; detail: string }
  | { state: "off" };

export interface McpServerInput {
  key?: string;
  name: string;
  target: string;
  auth: McpAuth;
  headerNames: string[];
  agents: McpAgents;
  /** The organization to share it with; none for Just me. */
  organization?: string | null;
  clientId?: string | null;
  secret: { token?: string; headerValues?: string[]; clientSecret?: string };
}

export interface McpImportFile { path: string; count: number | null }
export interface McpImportSource { files: McpImportFile[]; new: string[] }
export interface McpImportScan { claudeCode: McpImportSource; codex: McpImportSource }
export interface McpImported { added: string[]; skipped: [string, string][]; listing: McpListing }

export const mcp = {
  list: () => invoke<McpListing>("mcp_servers"),
  save: (input: McpServerInput) => invoke<McpListing>("mcp_server_save", { input }),
  remove: (key: string) => invoke<McpListing>("mcp_server_remove", { key }),
  setOff: (key: string, off: boolean) => invoke<McpListing>("mcp_server_set_off", { key, off }),
  check: (key: string) => invoke<McpStatus>("mcp_server_check", { key }),
  signIn: (key: string) => invoke<McpListing>("mcp_server_sign_in", { key }),
  signOut: (key: string) => invoke<McpListing>("mcp_server_sign_out", { key }),
  importScan: () => invoke<McpImportScan>("mcp_import_scan"),
  import: (agent: "claudeCode" | "codex") => invoke<McpImported>("mcp_import", { agent }),
};

/** The page is offered while an organization the person belongs to reports `organization.mcp-servers.v1`. */
export function mcpSettingsOffered(status: AccountStatus): boolean {
  return status.state === "signed-in" && Object.values(status.phase2Readiness ?? {}).some((features) => Array.isArray(features) && features.includes(phase2Features.mcpServers));
}

/** Organizations that can be given a shared server: ready for it, and managed by this person. */
export function sharingOrganizations(status: AccountStatus): { id: string; name: string }[] {
  if (status.state !== "signed-in") return [];
  return (status.organizations ?? [])
    .filter((org) => !org.isPersonal && (org.role === "owner" || org.role === "admin") && status.phase2Readiness?.[org.id]?.includes(phase2Features.mcpServers))
    .map((org) => ({ id: org.id, name: org.name }));
}

export const AUTH_LABELS: Record<McpAuth, string> = { oauth: "OAuth", bearer: "Bearer token", headers: "Custom headers", none: "None" };

export function isUrlTarget(target: string): boolean {
  return /^https?:\/\//i.test(target.trim());
}

export function nameError(name: string): string | null {
  if (!name) return "Enter a name.";
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) ? null : "Use letters, digits, - and _.";
}

/** `Name: value` lines into header names and values. Blank lines are skipped. */
export function parseHeaders(text: string): { names: string[]; values: string[]; error: string | null } {
  const names: string[] = [];
  const values: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    const name = colon > 0 ? line.slice(0, colon).trim() : "";
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(name)) return { names, values, error: "Write each header as Name: value." };
    if (names.some((n) => n.toLowerCase() === name.toLowerCase())) return { names, values, error: `${name} is listed twice.` };
    names.push(name);
    values.push(line.slice(colon + 1).trim());
  }
  if (names.length === 0) return { names, values, error: "Add at least one header." };
  if (names.length > 20) return { names, values, error: "At most 20 headers." };
  return { names, values, error: null };
}

export function agentsLabel(agents: McpAgents): string {
  if (agents.claudeCode && agents.codex) return "Both";
  return agents.claudeCode ? "Claude Code" : "Codex";
}

/** Installed search: names, URLs and commands. */
export function matchesServer(server: Pick<McpServerRow, "name" | "target">, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || server.name.toLowerCase().includes(q) || server.target.toLowerCase().includes(q);
}

export interface RecommendedServer {
  name: string;
  title: string;
  description: string;
  target: string;
  auth: McpAuth;
  /** A lucide icon name, drawn by the page. */
  icon: string;
  tint: string;
}

/** Servers worth adding, each from its maker's own documentation. */
export const RECOMMENDED: readonly RecommendedServer[] = [
  { name: "linear", title: "Linear", description: "Issues, projects and comments", target: "https://mcp.linear.app/mcp", auth: "oauth", icon: "CircleDot", tint: "text-[#7d84f5]" },
  { name: "sentry", title: "Sentry", description: "Errors and traces for a release", target: "https://mcp.sentry.dev/mcp", auth: "oauth", icon: "Bug", tint: "text-[#a78bfa]" },
  { name: "github", title: "GitHub", description: "Repos, issues and pull requests", target: "https://api.githubcopilot.com/mcp/", auth: "bearer", icon: "Github", tint: "text-foreground" },
  { name: "figma", title: "Figma", description: "Frames and variables from a file", target: "https://mcp.figma.com/mcp", auth: "oauth", icon: "PenTool", tint: "text-[#f24e1e]" },
  { name: "notion", title: "Notion", description: "Pages and databases", target: "https://mcp.notion.com/mcp", auth: "oauth", icon: "NotebookText", tint: "text-foreground" },
  // Slack registers no clients itself: its sign-in needs your own app under Advanced client identity.
  { name: "slack", title: "Slack", description: "Read channels, post updates", target: "https://mcp.slack.com/mcp", auth: "oauth", icon: "Hash", tint: "text-[#e9a820]" },
  { name: "stripe", title: "Stripe", description: "Customers, payments and logs", target: "https://mcp.stripe.com", auth: "oauth", icon: "CreditCard", tint: "text-[#7a73ff]" },
  { name: "supabase", title: "Supabase", description: "Tables, SQL and edge functions", target: "https://mcp.supabase.com/mcp", auth: "oauth", icon: "Database", tint: "text-[#3ecf8e]" },
  { name: "vercel", title: "Vercel", description: "Deployments and build logs", target: "https://mcp.vercel.com", auth: "oauth", icon: "Triangle", tint: "text-foreground" },
  { name: "neon", title: "Neon", description: "Branches and SQL for Postgres", target: "https://mcp.neon.tech/mcp", auth: "oauth", icon: "DatabaseZap", tint: "text-[#34d59a]" },
  { name: "posthog", title: "PostHog", description: "Insights and feature flags", target: "https://mcp.posthog.com/mcp", auth: "oauth", icon: "ChartLine", tint: "text-[#f9bd2b]" },
  { name: "datadog", title: "Datadog", description: "Monitors, logs and incidents", target: "https://mcp.datadoghq.com/v1/mcp", auth: "oauth", icon: "Activity", tint: "text-[#a78bfa]" },
  { name: "context7", title: "Context7", description: "Current library docs for prompts", target: "https://mcp.context7.com/mcp", auth: "none", icon: "BookOpen", tint: "text-foreground" },
  { name: "playwright", title: "Playwright", description: "Drive a browser from the agent", target: "npx @playwright/mcp@latest", auth: "none", icon: "Drama", tint: "text-[#2ead33]" },
  { name: "firecrawl", title: "Firecrawl", description: "Fetch and clean web pages", target: "https://mcp.firecrawl.dev/v2/mcp", auth: "none", icon: "Flame", tint: "text-[#ff6b35]" },
];

/** A recommended server counts as added when one installed here reaches the same place. */
export function recommendedAdded(server: RecommendedServer, installed: readonly McpServerRow[]): boolean {
  const norm = (target: string) => target.trim().replace(/\/+$/, "").toLowerCase();
  return installed.some((row) => norm(row.target) === norm(server.target));
}
