import { buildTranscript, type Turn } from "@/lib/transcript";
import type { AgentEvent } from "@/types/events";

/** How "Copy transcript ›" (PRO-381) writes a chat out: Markdown with a heading per speaker, or plain text. */
export type TranscriptFormat = "markdown" | "text";

/** What the agent said in a turn: its replies in order, then a failed turn's last words. */
function replyOf(turn: Turn): string {
  const parts = turn.work.flatMap((item) => (item.kind === "text" || item.kind === "message" ? [item.kind === "message" ? `> ${item.text.trim().replace(/\n/g, "\n> ")}` : item.text.trim()] : []));
  if (turn.finalText?.trim()) parts.push(turn.finalText.trim());
  if (turn.detail?.trim()) parts.push(turn.detail.trim());
  return parts.filter(Boolean).join("\n\n");
}

/**
 * The conversation a tab holds as text to paste elsewhere: each prompt and
 * the agent's reply to it, without tool calls or reasoning. `conversation`
 * is the tab's provider conversation, so a reset chat copies only what it
 * shows now. Empty when nothing was said yet.
 */
export function transcriptText(events: AgentEvent[], format: TranscriptFormat, agent: string, conversation?: string | null): string {
  const { turns } = buildTranscript(events, false, { conversationId: conversation ?? null });
  const blocks: string[] = [];
  for (const turn of turns) {
    const prompt = turn.prompt?.text.trim();
    const reply = replyOf(turn);
    if (prompt) blocks.push(format === "markdown" ? `## ${turn.prompt?.author?.displayName ?? "You"}\n\n${prompt}` : `${turn.prompt?.author?.displayName ?? "You"}:\n${prompt}`);
    if (reply) blocks.push(format === "markdown" ? `## ${agent}\n\n${reply}` : `${agent}:\n${reply}`);
  }
  return blocks.join("\n\n");
}
