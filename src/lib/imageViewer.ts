import { useSyncExternalStore } from "react";

/** One image the viewer can show: what to draw, its name, and the file on this computer when there is one. */
export interface ViewerImage {
  src: string;
  name: string;
  /** A local file, for Open in default app. */
  path?: string;
}

interface ViewerState {
  images: ViewerImage[];
  index: number;
}

let state: ViewerState | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Show `images` in the image viewer, starting at `index`. */
export function openImageViewer(images: ViewerImage[], index = 0) {
  if (!images.length) return;
  state = { images, index: Math.min(Math.max(index, 0), images.length - 1) };
  emit();
}

export function closeImageViewer() {
  state = null;
  emit();
}

/** Step to another image of the same set; wraps at the ends. */
export function stepImageViewer(by: number) {
  if (!state) return;
  const count = state.images.length;
  state = { ...state, index: (state.index + by + count) % count };
  emit();
}

export function useImageViewer(): ViewerState | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => null,
  );
}
