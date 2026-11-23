/**
 * What the chat says when answering a question the agent's CLI drew in its
 * own terminal fails (PRO-460). The runtime's own refusals are said as they
 * are; anything else (an I/O error, an IPC failure) is never echoed, only
 * that the answer did not go in.
 */
const REFUSALS = [
  "The question in the agent's terminal has changed. Look at it again before answering.",
  "That question is no longer showing in the agent's terminal.",
  "A message is being typed into the agent right now. Try again in a moment.",
  "This question cannot be dismissed. Choose one of its options.",
  "That option is not one of this question's.",
  "The agent's terminal shows no option chosen. Open the terminal to answer there.",
  "The agent's terminal did not move to that option. Open the terminal to answer there.",
  "The agent is no longer running.",
  "The agent is asking something else first. Answer that request, then this question.",
];

export const TERMINAL_PROMPT_FAILED = "The answer could not be typed into the agent's terminal. Open the terminal view to answer there.";

export function terminalPromptError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return REFUSALS.find((refusal) => message.includes(refusal)) ?? TERMINAL_PROMPT_FAILED;
}
