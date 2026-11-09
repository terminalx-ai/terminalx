import Svg, { Path, Rect } from "react-native-svg";
import { agentName, lookupAgent } from "@terminalx/portable/agentMarks";

/** An agent's mark, as the Mac draws it in its tab strip (`src/components/AgentMark.tsx`), in one colour. */
export function AgentMark({ id, size = 15, color }: { id: string; size?: number; color: string }) {
  const agent = lookupAgent(id);
  if (agent) return <Svg width={size} height={size} viewBox="0 0 24 24" fill={color} accessibilityLabel={agentName(id)}><Path d={agent.path} /></Svg>;
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" accessibilityLabel={agentName(id)}>
    <Path d="M12 7V4M9.5 4h5" />
    <Rect x={4} y={7} width={16} height={13} rx={3} />
    <Path d="M8 12h.01M16 12h.01M8.5 16h7" />
  </Svg>;
}
