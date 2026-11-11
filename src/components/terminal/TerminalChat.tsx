import { createContext, type ReactNode } from "react";
import type { SessionEntry } from "@/types/session";
import { getSessionStore } from "@/lib/sessions";
import { useTerminals } from "@/lib/terminal";
import { addTerminalSelection, terminalChatTarget } from "@/lib/terminalSelection";

export const TerminalChatContext = createContext<((text: string) => Promise<void>) | null>(null);

/** Local session attachments belong to this session, including its dock. */
export function TerminalChatProvider({ session, children }: { session?: SessionEntry; children: ReactNode }) {
  const selected = useTerminals().selected;
  const target = session ? terminalChatTarget(session, selected[session.id]) : undefined;
  const add = session && target ? (text: string) => addTerminalSelection(session.id, target.id, text,
    () => !!getSessionStore().sessions.find((entry) => entry.id === session.id)?.tabs.some((tab) => tab.id === target.id && tab.front !== "terminal")) : null;
  return <TerminalChatContext value={add}>{children}</TerminalChatContext>;
}
