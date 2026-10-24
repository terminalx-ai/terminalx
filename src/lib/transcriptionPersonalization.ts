import { invoke } from "@tauri-apps/api/core";

export interface TranscriptionOptions {
  context: boolean;
  project: boolean;
  session: boolean;
  terminal: boolean;
  composer: boolean;
  remoteContext: boolean;
  dictionary: boolean;
  replacements: boolean;
  snippets: boolean;
  learn: boolean;
  guards: boolean;
  retakes: boolean;
  normalize: boolean;
  code: boolean;
  fillers: boolean;
  language: string | null;
  sensitiveTargets: string[];
}
export interface TranscriptionEntry {
  id: string;
  kind: "vocabulary" | "replacement" | "snippet" | "learned";
  heard: string;
  written: string;
  soundsLike: string[];
  project: string | null;
}
export interface TranscriptionPersonalizationData {
  revision?: number;
  options: TranscriptionOptions;
  entries: TranscriptionEntry[];
}
export interface TranscriptionDiagnostic {
  raw: string;
  finalText: string;
  biasTerms: string[];
  engine: string;
  target?: string;
}

/** These commands always execute locally, including for cloud tabs. */
export const transcriptionPersonalization = {
  export: (path: string) => invoke<void>("transcription_personalization_export", { path }),
  load: () => invoke<TranscriptionPersonalizationData>("transcription_personalization_load"),
  save: async (data: TranscriptionPersonalizationData) => {
    const saved = await invoke<TranscriptionPersonalizationData>("transcription_personalization_save", { data });
    window.dispatchEvent(new Event("transcription-personalization-changed"));
    return saved;
  },
  reset: async () => {
    const saved = await invoke<TranscriptionPersonalizationData>("transcription_personalization_reset");
    window.dispatchEvent(new Event("transcription-personalization-changed"));
    return saved;
  },
};
