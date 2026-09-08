import { useEffect, useSyncExternalStore } from "react";
import { errorMessage, transcription, type InputDevice } from "./api";

// Shared by both composers and Settings. Only explicit picker opens enumerate
// devices; reading the persisted preference is safe on passive render.
let state = {
  loaded: false,
  selected: null as string | null,
  inputs: null as InputDevice[] | null,
  loading: false,
  saving: false,
  error: null as string | null,
};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => state;
function update(patch: Partial<typeof state>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}
let reading: Promise<void> | null = null;
let revision = 0;
export function refreshInputPreference(): Promise<void> {
  if (reading) return reading;
  const version = revision;
  reading = transcription.preferences().then((preferences) => {
    if (version === revision) update({ loaded: true, selected: preferences.inputDevice, inputs: state.selected === preferences.inputDevice ? state.inputs : null, error: null });
  }).catch((error) => {
    if (version === revision) update({ error: errorMessage(error) });
  }).finally(() => { reading = null; });
  return reading;
}
export async function refreshTranscriptionInputs() {
  if (state.loading) return;
  update({ loading: true, inputs: null, error: null });
  await refreshInputPreference();
  try {
    update({ inputs: await transcription.inputs() });
  } catch (error) {
    update({ error: errorMessage(error) });
  } finally {
    update({ loading: false });
  }
}
export async function selectTranscriptionInput(selected: string | null) {
  if (state.saving) return;
  revision++;
  update({ saving: true, error: null });
  try {
    await transcription.setInput(selected);
    update({ loaded: true, selected });
  } catch (error) {
    update({ error: errorMessage(error) });
  } finally {
    update({ saving: false });
  }
}
export function isTranscriptionInputSaving() {
  return state.saving;
}
export function useTranscriptionInput() {
  const input = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => { void refreshInputPreference(); }, []);
  return input;
}
