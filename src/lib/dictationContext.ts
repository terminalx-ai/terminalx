import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getSessionStore } from "./sessions";
import { getTabLog } from "./agentEvents";
import { agentPaneId, peekInstance } from "./terminal";
import { getEditors } from "./editors";
import { transcriptionPersonalization, type TranscriptionOptions } from "./transcriptionPersonalization";

export interface DictationContext {
  target: string;
  project: string | null;
  remote: boolean;
  sensitive: boolean;
  coding: boolean;
  learn?: boolean;
  projectTerms: string[];
  session: string[];
  terminal: string[];
  composer: string;
}

/** Prepare names ahead of recording; never await a filesystem walk at mic start. */
export function useDictationContext(target: string, cwd?: string, remote = false, draft = "", caret?: number) {
  const prepared = useRef<{ cwd?: string; terms: string[] }>({ terms: [] });
  const options = useRef<TranscriptionOptions | null>(null);
  useEffect(() => {
    let live = true;
    let generation = 0;
    const prepare = async () => {
      const currentGeneration = ++generation;
      prepared.current = { terms: [] };
      try {
        const data = await transcriptionPersonalization.load();
        if (!live || currentGeneration !== generation) return;
        options.current = data.options;
        if (!remote && cwd && data.options.context && data.options.project && !data.options.sensitiveTargets.includes(target)) {
          const terms = await invoke<string[]>("transcription_project_terms", { cwd });
          if (live && currentGeneration === generation) prepared.current = { cwd, terms };
        }
      } catch { /* optional context must not prevent dictation */ }
    };
    void prepare();
    window.addEventListener("transcription-personalization-changed", prepare);
    return () => { live = false; window.removeEventListener("transcription-personalization-changed", prepare); };
  }, [target, cwd, remote]);

  return useCallback((): DictationContext => {
    const o = options.current;
    const owner = getSessionStore().sessions.find(s => s.tabs.some(t => t.id === target));
    const tab = owner?.tabs.find(t => t.id === target);
    const result: DictationContext = {
      target, project: remote ? null : owner?.projectPath ?? cwd ?? null,
      remote, sensitive: o?.sensitiveTargets.includes(target) ?? false,
      coding: true, learn: !!o?.learn && !remote, projectTerms: [], session: [], terminal: [], composer: "",
    };
    // Inspect only the input around the caret for the privacy gate, even when
    // draft biasing is off. Native code applies the same gate before learning.
    const at = caret ?? draft.length;
    result.composer = draft.slice(Math.max(0, at - 2048), at + 2048);
    const terminal = peekInstance(tab?.pane ?? agentPaneId(target))?.term;
    if (terminal) {
      const buffer = terminal.buffer.active;
      for (let i = buffer.viewportY; i < Math.min(buffer.length, buffer.viewportY + terminal.rows); i++) {
        result.terminal.push((buffer.getLine(i)?.translateToString(true) ?? "").slice(0, 512));
      }
      result.sensitive ||= /(?:password|passphrase|passcode|one.time.code)\s*[:?]\s*$/i.test(result.terminal.slice(-3).join("\n"));
    }
    result.sensitive ||= /(?:password|passphrase|passcode|one.time.code|api[_ -]?key|access[_ -]?token|private key|secret)\s*[:=?]/i.test(result.composer);
    if (result.sensitive) result.learn = false;
    if (!o?.context || result.sensitive || (remote && !o.remoteContext)) {
      result.composer = "";
      result.terminal = [];
      return result;
    }
    if (!o.composer) result.composer = "";
    if (!o.terminal) result.terminal = [];
    if (o.project && prepared.current.cwd === cwd) result.projectTerms = prepared.current.terms;
    if (o.project && owner) {
      if (owner.branch) result.projectTerms = [owner.branch, ...result.projectTerms];
      // Open/diff content is intentionally not read: it can contain ignored secrets.
      const allowed = new Set(result.projectTerms);
      const open = getEditors().editors.filter(e => e.sessionId === owner.id && !e.source && allowed.has(e.rel)).map(e => e.rel);
      result.projectTerms = [...open, ...result.projectTerms].slice(0, 128);
    }
    if (o.session && owner && tab) {
      result.session.push(tab.harness, tab.model);
      for (const event of getTabLog(owner.id, target).events.slice(-32)) {
        const p = event.payload;
        if (p.type === "tool_call_started") result.session.push(p.name);
        // Never inspect tool arguments/results or file-edit contents.
      }
    }
    return result;
  }, [target, cwd, remote, draft, caret]);
}
