import { invoke } from "@tauri-apps/api/core";

export type AiEditStyle = "clear" | "formal" | "short" | "friendly" | "detailed" | "improve";

export type AiEdit =
  | { kind: "fix" }
  | { kind: "style"; style: AiEditStyle }
  | { kind: "translate"; language: string };

/** Where a composer's AI Editor sends a draft. */
export interface AiEditorBackend {
  run: (edit: AiEdit, text: string, requestId: string) => Promise<string>;
  cancel: (requestId: string) => void;
}

/** A local tab's own Claude Code login, in a one-shot run with no tools. */
export function localAiEditor(sessionId: string, tabId: string): AiEditorBackend {
  return {
    run: (edit, text, requestId) => invoke<string>("ai_edit", { sessionId, tabId, requestId, edit, text }),
    cancel: (requestId) => {
      void invoke("ai_edit_cancel", { requestId }).catch(() => undefined);
    },
  };
}
