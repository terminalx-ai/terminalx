import { createContext, useCallback, useContext, useRef, useState, type SetStateAction } from "react";

/**
 * What the reader opened or folded in one chat, by row. A chat draws only the
 * turns near the view (#727), so a turn scrolled far away is unmounted; drawn
 * again, its rows read here what they were left as.
 */
export type Disclosures = Map<string, boolean>;

const Remembered = createContext<Disclosures | null>(null);
const Scope = createContext("");

/** Held by the chat for as long as it shows one conversation. */
export const DisclosureMemory = Remembered.Provider;
/** A turn's key: the rows under it name themselves within it. */
export const DisclosureScope = Scope.Provider;

/**
 * `useState` for whether a row is open, remembered in the chat under the
 * enclosing turn and `name`. Outside a chat it is plain state.
 */
export function useDisclosure(name: string, initial = false): [boolean, (next: SetStateAction<boolean>) => void] {
  const memory = useContext(Remembered);
  const key = `${useContext(Scope)}/${name}`;
  const [open, setOpen] = useState(() => memory?.get(key) ?? initial);
  // Changed only by the setter, which reads it: two toggles before a render make two changes.
  const current = useRef(open);
  const set = useCallback((next: SetStateAction<boolean>) => {
    const value = typeof next === "function" ? next(current.current) : next;
    current.current = value;
    memory?.set(key, value);
    setOpen(value);
  }, [memory, key]);
  return [open, set];
}
