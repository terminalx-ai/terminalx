import { useEffect, useRef, useState } from "react";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";

/** How many of the last loudness readings the waveform draws, newest last. */
export const WAVE_LENGTH = 32;
const quiet = () => Array<number>(WAVE_LENGTH).fill(0);

/** Errors that mean only that nothing more was heard, or that the reader stopped it. */
const QUIET = new Set(["aborted", "no-speech", "speech-timeout"]);

/**
 * Speaking into the composer: the system's own speech recognition, in the
 * phone's language, with words arriving as they are said. `onText` is given
 * all that was said since `start`, to set after what was already typed.
 */
export function useDictation(onText: (said: string) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // How loud the voice has been, 0 to 1, a reading every 80 ms: what the waveform draws.
  const [levels, setLevels] = useState<number[]>(quiet);
  const deliver = useRef(onText);
  useEffect(() => { deliver.current = onText; });
  // What was said and settled so far: iOS may settle a long dictation a sentence at a time, each result only the newest.
  const settled = useRef("");
  // Cancelled or sent, a result still on its way is not wanted.
  const heard = useRef(false);
  useSpeechRecognitionEvent("result", (event) => {
    const said = event.results[0]?.transcript?.trim();
    if (!said || !heard.current) return;
    const whole = settled.current && !said.startsWith(settled.current) ? `${settled.current} ${said}` : said;
    if (event.isFinal) settled.current = whole;
    deliver.current(whole);
  });
  useSpeechRecognitionEvent("volumechange", (event) => {
    const level = Math.max(0, Math.min(1, event.value / 10));
    setLevels((current) => [...current.slice(1), level]);
  });
  useSpeechRecognitionEvent("end", () => { setListening(false); setLevels(quiet()); });
  useSpeechRecognitionEvent("error", (event) => {
    setListening(false);
    if (!QUIET.has(event.error)) setError(event.message || "Dictation stopped.");
  });
  // Leaving the conversation stops listening.
  useEffect(() => () => { try { ExpoSpeechRecognitionModule.abort(); } catch { /* not listening */ } }, []);

  const start = async () => {
    setError(null);
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) return setError("Allow the microphone and speech recognition for TerminalX in Settings to dictate.");
    setLevels(quiet());
    settled.current = "";
    heard.current = true;
    ExpoSpeechRecognitionModule.start({ lang: Intl.DateTimeFormat().resolvedOptions().locale, interimResults: true, continuous: true, addsPunctuation: true, volumeChangeEventOptions: { enabled: true, intervalMillis: 80 } });
    setListening(true);
  };
  /** Stops listening and keeps what was said. */
  const stop = () => { ExpoSpeechRecognitionModule.stop(); setListening(false); };
  /** Stops listening and hears nothing more: for a cancel (the caller puts back what was typed before) or a send. */
  const cancel = () => { heard.current = false; ExpoSpeechRecognitionModule.abort(); setListening(false); setLevels(quiet()); };
  return { listening, levels, error, start, stop, cancel, clearError: () => setError(null) };
}
