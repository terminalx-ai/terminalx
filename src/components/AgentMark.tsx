import { cn } from "@/lib/cn";
import { agentName, lookupAgent } from "@terminalx/portable/agentMarks";

// The agents' marks and names live in `@terminalx/portable/agentMarks`, shared with the phone.
export { KNOWN_AGENT_IDS, agentBrandColor, agentName, type KnownAgentId } from "@terminalx/portable/agentMarks";

export function AgentMark({
  id,
  className,
  decorative = false,
  brand = false,
}: {
  id: string;
  className?: string;
  decorative?: boolean;
  /** Tint the mark with the agent's brand colour instead of inheriting `currentColor`. */
  brand?: boolean;
}) {
  const normalizedId = id.toLowerCase();
  const agent = lookupAgent(normalizedId);
  const fill = brand && agent?.color ? agent.color : "currentColor";
  const accessibility = decorative
    ? { "aria-hidden": true as const }
    : { role: "img", "aria-label": agentName(id) };
  const common = {
    ...accessibility,
    className: cn("inline-block shrink-0", className),
    focusable: "false" as const,
    "data-agent-id": normalizedId || "unknown",
  };

  if (agent) {
    return (
      <svg {...common} data-agent-icon="brand" viewBox="0 0 24 24" fill={fill}>
        <path d={agent.path} />
      </svg>
    );
  }

  return (
    <svg {...common} data-agent-icon="fallback" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 7V4M9.5 4h5" />
      <rect x="4" y="7" width="16" height="13" rx="3" />
      <path d="M8 12h.01M16 12h.01M8.5 16h7" />
    </svg>
  );
}
