import { api, type TurnCheckpoint, type TurnUndoResult } from "@/lib/api";

/**
 * Where a turn card reads and reviews what a finished turn changed: this
 * computer's checkpoints for a local tab, the runtime's (`checkpoints/1`,
 * #1326) for a cloud workspace's or a machine's.
 */
export interface TurnCheckpointApi {
  /** Reads only: this person may not keep or undo a turn here (a viewer of a shared workspace). */
  readOnly?: boolean;
  get(sessionId: string, tabId: string, seq: number): Promise<TurnCheckpoint | null>;
  keep(sessionId: string, tabId: string, seq: number): Promise<void>;
  /** Refused with what it would overwrite (`undone: false`) unless `confirmed` is that refusal's token. */
  undo(sessionId: string, tabId: string, seq: number, confirmed: string | null): Promise<TurnUndoResult>;
  /** Put back what an undo removed; refused as `undo` is. */
  restore(sessionId: string, tabId: string, seq: number, confirmed: string | null): Promise<TurnUndoResult>;
}

/** A local tab's checkpoints, kept by this computer's runtime. */
export const localTurnCheckpoints: TurnCheckpointApi = {
  get: (sessionId, tabId, seq) => api.turnCheckpoint(sessionId, tabId, seq),
  keep: (sessionId, tabId, seq) => api.keepTurn(sessionId, tabId, seq),
  undo: (sessionId, tabId, seq, confirmed) => api.undoTurn(sessionId, tabId, seq, confirmed),
  restore: (sessionId, tabId, seq, confirmed) => api.restoreUndo(sessionId, tabId, seq, confirmed),
};
