import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Where a page's own buttons go beside its title (design 10.06: Paste
 * KEY=VALUE and + Add variable at the top right). The settings page provides
 * the slot next to its heading; a section with its own heading provides one
 * for what is inside it. `undefined`: no slot, so the buttons stay in place.
 */
const SettingsHeaderSlot = createContext<HTMLElement | null | undefined>(undefined);
export const SettingsHeaderSlotProvider = SettingsHeaderSlot.Provider;

/** Renders its children into the nearest title slot, or where it stands when there is none. */
export function SettingsHeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(SettingsHeaderSlot);
  if (slot === undefined) return <div className="flex flex-wrap gap-2">{children}</div>;
  return slot ? createPortal(children, slot) : null;
}
