import { useSyncExternalStore } from "react";

/**
 * Read an answer aloud with the system voice (PRO-379). One answer speaks at
 * a time: starting another stops the first, and its button shows Stop while
 * it speaks.
 */
let speaking: string | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of [...listeners]) listener(); };

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined" ? window.speechSynthesis : null;
}

export function canReadAloud(): boolean {
  return !!synth();
}

/** Markdown as it would be said: code blocks named rather than spelled out, marks and link targets dropped. */
export function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " (code block) ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, "$2")
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, "")
    .replace(/\|/g, ", ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function stopReading() {
  synth()?.cancel();
  if (speaking !== null) { speaking = null; notify(); }
}

export function readAloud(key: string, markdown: string) {
  const voice = synth();
  if (!voice) return;
  voice.cancel();
  const utterance = new SpeechSynthesisUtterance(speakable(markdown));
  const done = () => { if (speaking === key) { speaking = null; notify(); } };
  utterance.onend = done;
  utterance.onerror = done;
  speaking = key;
  notify();
  voice.speak(utterance);
}

/** Whether the answer under `key` is the one being read now. */
export function useReadingAloud(key: string): boolean {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => speaking === key,
    () => false,
  );
}
