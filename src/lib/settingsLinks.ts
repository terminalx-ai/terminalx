/**
 * The way from a message elsewhere in the app to Settings → Account → Agent
 * logins. The shell opens Settings on the request; the section scrolls
 * itself into view when it takes it, which may be after it has mounted.
 */
const OPEN_AGENT_LOGINS = "terminalx:open-agent-logins";

let wanted = false;

export function openAgentLogins(): void {
  wanted = true;
  window.dispatchEvent(new Event(OPEN_AGENT_LOGINS));
}

export function onOpenAgentLogins(listener: () => void): () => void {
  window.addEventListener(OPEN_AGENT_LOGINS, listener);
  return () => window.removeEventListener(OPEN_AGENT_LOGINS, listener);
}

/** True once per request. */
export function takeAgentLoginsRequest(): boolean {
  const was = wanted;
  wanted = false;
  return was;
}
