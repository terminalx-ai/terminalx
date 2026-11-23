import { useCloudCatalog } from "@/lib/cloudCatalog";
import { useMachineConnections } from "@/lib/machineConnections";
import { cloudPlace, machinePlace, runsOnPlace, type BotPlace, type BotRunsOn } from "@/types/bots";

/** A place a bot can move to, as the pickers list it. */
export interface PlaceChoice {
  place: Extract<BotPlace, { kind: "cloud" | "machine" }>;
  name: string;
  /** Why it cannot take a bot now, if it cannot. */
  unavailable?: string;
  /** A second line: asleep, connecting. */
  note?: string;
}

/** The cloud workspaces a bot can move to: every one listed in an organisation, not archived or gone. */
export function useCloudChoices(): PlaceChoice[] {
  const catalog = useCloudCatalog();
  const choices: PlaceChoice[] = [];
  for (const org of Object.values(catalog.orgs)) {
    for (const { workspace } of org.workspaces) {
      if (workspace.state === "archived" || workspace.state === "destroyed" || workspace.deletedAt) continue;
      choices.push({
        place: cloudPlace(org.orgId, workspace.id),
        name: workspace.name,
        note: workspace.state === "suspended" ? "Asleep: it wakes for the move" : workspace.state === "provisioning" ? "Starting" : undefined,
        unavailable: workspace.state === "attention-required" ? "Needs attention" : undefined,
      });
    }
  }
  return choices.sort((a, b) => a.name.localeCompare(b.name));
}

/** The paired machines a bot can move to: one connected now takes it. */
export function useMachineChoices(): PlaceChoice[] {
  const machines = useMachineConnections();
  return machines.machines.map((machine) => {
    const state = machines.states[machine.machineId]?.state;
    const connected = (state === "direct" || state === "relay") && Boolean(machines.connections[machine.machineId]);
    return { place: machinePlace(machine.machineId), name: machine.name, unavailable: connected ? undefined : "Not connected" };
  });
}

/** What to call the place a bot lives: its workspace's or machine's name when this Mac knows it. */
export function usePlaceName(runsOn: BotRunsOn): string {
  const catalog = useCloudCatalog();
  const machines = useMachineConnections();
  const place = runsOnPlace(runsOn);
  switch (place.kind) {
    case "thisMac":
      return "This Mac";
    case "cloud": {
      const workspace = catalog.orgs[place.orgId]?.workspaces.find((item) => item.workspace.id === place.workspaceId)?.workspace;
      return workspace ? workspace.name : "A cloud workspace";
    }
    case "machine":
      return machines.machines.find((machine) => machine.machineId === place.machineId)?.name ?? "Another machine";
    default:
      return place.key;
  }
}
