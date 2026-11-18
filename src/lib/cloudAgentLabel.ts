const AGENT_LABELS: Record<string, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", opencode: "OpenCode" };

/**
 * An agent's name wherever a cloud session shows one (the new-tab menu, a
 * tab without a title yet, a presence tooltip): the product names the local
 * harness list and the runtime's own `runtime.agents` use, so one agent is
 * never "Claude" in one menu and "Claude Code" in the next.
 */
export function cloudAgentLabel(harness: string): string {
  const key = harness.toLowerCase();
  return Object.prototype.hasOwnProperty.call(AGENT_LABELS, key) ? AGENT_LABELS[key] : (harness.trim() || "Agent");
}
