import { createContext, useContext } from "react";

/**
 * The paired machine an open view runs on (PRO-398). The same view shows a
 * cloud workspace and a paired machine; on a machine every tab names the
 * machine and speaks from the machine's own connection state, so the Agent,
 * Files, Git and Ports tabs agree with the header chip and the sidebar.
 */
export interface MachinePlace {
  name: string;
  /** A sentence for while the view is not connected: "Mac mini isn’t reachable. Sessions there keep running." */
  status: string;
  /** The same in a word or two, for a chip: "Offline". */
  label: string;
}

const Place = createContext<MachinePlace | null>(null);

export const WorkspacePlaceProvider = Place.Provider;

/** The machine this view runs on; null in a cloud workspace's view. */
export function useMachinePlace(): MachinePlace | null {
  return useContext(Place);
}
