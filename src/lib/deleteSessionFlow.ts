import { openSessionDelete } from "@/lib/dialogs";
import type { SessionEntry } from "@/types/session";

/** The shared removal dialog defaults to deleting exactly this conversation. */
export async function confirmDeleteSession(session: SessionEntry) {
  openSessionDelete(session.projectPath, session.cwd, session.title, session.id);
}
