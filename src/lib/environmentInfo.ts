export const ENVIRONMENT_TOOLS = [
  ["node", "Node.js"], ["npm", "npm"], ["pnpm", "pnpm"], ["python", "Python"],
  ["git", "Git"], ["gh", "GitHub CLI"], ["jq", "jq"], ["rg", "ripgrep"],
  ["git-lfs", "Git LFS"], ["tmux", "tmux"], ["vim", "Vim"],
] as const;
export type EnvironmentToolId = typeof ENVIRONMENT_TOOLS[number][0];
export type EnvironmentTool = { id: EnvironmentToolId; status: "installed"; version: string }
  | { id: EnvironmentToolId; status: "missing" | "error" | "timeout" };
export interface EnvironmentReport { version: 1; observedAt: number; tools: EnvironmentTool[] }
export const ENVIRONMENT_STALE_MS = 60_000;

export function environmentReport(value: unknown): EnvironmentReport {
  const invalid = () => { throw new Error("Invalid environment report"); };
  if (!value || typeof value !== "object") return invalid();
  const report = value as Record<string, unknown>;
  if (report.version !== 1 || !Number.isSafeInteger(report.observedAt) || Number(report.observedAt) <= 0
    || !Array.isArray(report.tools) || report.tools.length !== ENVIRONMENT_TOOLS.length) return invalid();
  const tools = ENVIRONMENT_TOOLS.map(([id]): EnvironmentTool => {
    const matches = (report.tools as unknown[]).filter((tool) => tool && typeof tool === "object" && (tool as Record<string, unknown>).id === id);
    if (matches.length !== 1) return invalid();
    const tool = matches[0] as Record<string, unknown>;
    if (tool.status === "installed" && typeof tool.version === "string" && /^\d[\d.]{0,30}[a-z]?$/.test(tool.version)) {
      return { id, status: "installed", version: tool.version };
    }
    if (tool.status === "missing" || tool.status === "error" || tool.status === "timeout") return { id, status: tool.status };
    return invalid();
  });
  return { version: 1, observedAt: Number(report.observedAt), tools };
}
