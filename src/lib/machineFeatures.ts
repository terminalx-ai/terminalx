import type { MachineConnectionState, MachineUpdateSide } from "@/types/machines";

/**
 * Every feature this desktop uses on a machine, the namespace it needs, and
 * the words for what is lost without it (PRO-354, docs/MACHINES.md "Versions
 * and updates"). A feature whose namespace the machine did not grant is
 * hidden where it would be; that place says so in one line naming the
 * machine ({@link machineFeatureMessage}), and the machine's card, chip and
 * page say Needs update.
 *
 * Only namespaces a machine serves belong here. A machine withholds
 * `keys/1`, `mirror/1` and `collab/1` by design (`WITHHELD` in
 * src-tauri/src/remote/machine.rs), so they are never "missing"; `machine/1`
 * (with `pty/1`, `fs/1`, `git/1`, `session/1`) is what connecting needs at
 * all, and without it the machine is not connected but `needsUpdate`.
 */
export interface MachineFeature {
  id: string;
  /** Sentence case, as the page lists it: "Port forwarding". */
  label: string;
  capability: string;
  /** What the person cannot do without it, after "Update it to …": "forward ports". */
  action: string;
}

/** In the order the page names them. Each is checked with `hasCapability` where the feature is offered. */
export const MACHINE_FEATURES: readonly MachineFeature[] = [
  { id: "ports", label: "Port forwarding", capability: "ports/1", action: "forward ports" },
  { id: "agentCommands", label: "Steering and stopping agents", capability: "agent-commands/1", action: "steer and stop agents" },
  { id: "agentTabs", label: "Agent tabs", capability: "session/2", action: "add agent tabs" },
  { id: "interrupt", label: "Interrupting agents", capability: "session/3", action: "interrupt agents" },
  { id: "sessionStatus", label: "Session status", capability: "session-status/1", action: "set a session's status" },
  { id: "agentTerminal", label: "Agent terminals", capability: "agent-pty/1", action: "open an agent's terminal" },
  { id: "models", label: "Model choice", capability: "agents/1", action: "choose models" },
  { id: "slashCommands", label: "Slash commands", capability: "composer/1", action: "use slash commands" },
  { id: "fileMentions", label: "File mentions", capability: "composer/2", action: "mention files" },
  { id: "images", label: "Images in prompts", capability: "composer/3", action: "send images" },
  { id: "files", label: "Files in prompts", capability: "composer/4", action: "send files" },
  { id: "worktreeRemoval", label: "Worktree removal", capability: "workspace/1", action: "remove a session's worktree" },
  { id: "mergedCleanup", label: "Clean-up after merge", capability: "workspace/2", action: "remove merged worktrees" },
  { id: "cleanup", label: "Worktree clean-up", capability: "cleanup/1", action: "clean up worktrees" },
  { id: "pipelines", label: "Issue pipelines", capability: "pipeline/1", action: "run issue pipelines" },
  { id: "pipelineReviewers", label: "Pipeline reviewers", capability: "pipeline/2", action: "choose pipeline reviewers" },
  { id: "updates", label: "Updating it from this Mac", capability: "machine/3", action: "update it from this Mac" },
  { id: "agentSetup", label: "Signing in its agents from here", capability: "machine/4", action: "sign in its agents" },
  { id: "projects", label: "Adding projects from here", capability: "machine/6", action: "add and remove its projects" },
  { id: "sessionRuns", label: "Setup and Run scripts", capability: "machine/7", action: "run its sessions' Setup and Run scripts" },
  { id: "sessionParity", label: "Session cost, Continue in a new tab and Fix check errors", capability: "machine/8", action: "read session costs, continue in a new tab and fix check errors" },
  { id: "listen", label: "Choosing where it listens", capability: "machine/9", action: "choose where it listens" },
];

export function machineFeature(capability: string): MachineFeature | null {
  return MACHINE_FEATURES.find((feature) => feature.capability === capability) ?? null;
}

/** The features `granted` leaves out, in table order. */
export function missingMachineFeatures(granted: readonly string[]): MachineFeature[] {
  return MACHINE_FEATURES.filter((feature) => !granted.includes(feature.capability));
}

/** Whether the machine granted what `capability`'s feature needs. A capability not in the table is not gated here. */
export function machineHasFeature(granted: readonly string[], capability: string): boolean {
  return !machineFeature(capability) || granted.includes(capability);
}

/** "ci-box runs TerminalX 0.2.27. Update it to forward ports from here." (21.09). */
export function machineFeatureMessage(name: string, version: string | null, feature: MachineFeature): string {
  const runs = version ? `${name} runs TerminalX ${version}.` : `${name} runs an older TerminalX.`;
  return `${runs} Update it to ${feature.action} from here.`;
}

/**
 * The one line a machine's view shows for everything it hides (PRO-354):
 * "dev-server runs TerminalX 0.2.29. Update it to forward ports, interrupt
 * agents and run issue pipelines from here." Updating itself is left out:
 * that is the Update button beside the line. Null when nothing else is hidden.
 */
export function machineFeaturesMessage(name: string, version: string | null, features: readonly MachineFeature[]): string | null {
  const actions = features.filter((feature) => feature.capability !== "machine/3").map((feature) => feature.action);
  if (!actions.length) return null;
  const runs = version ? `${name} runs TerminalX ${version}.` : `${name} runs an older TerminalX.`;
  const list = actions.length === 1 ? actions[0] : `${actions.slice(0, -1).join(", ")} and ${actions[actions.length - 1]}`;
  return `${runs} Update it to ${list} from here.`;
}

/** "Port forwarding and orchestration runs", "A, B and C". */
export function featureList(features: readonly MachineFeature[]): string {
  const labels = features.map((feature, index) => (index === 0 ? feature.label : feature.label.charAt(0).toLowerCase() + feature.label.slice(1)));
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** What a machine's card, chip and page say about versions. */
export interface MachineVersionGap {
  /** The machine's TerminalX version, when known. */
  version: string | null;
  side: MachineUpdateSide;
  /** Features hidden for the machine; empty when it is not connected (then nothing is known to be missing). */
  hidden: MachineFeature[];
}

/**
 * Needs update, or null: the connection says so (`needsUpdate`: the
 * machine does not serve `machine/1`), or the machine is connected and does
 * not grant a listed feature's namespace. `granted` is the connected
 * runtime's capabilities, null while not connected. The older side updates:
 * the machine, unless its `version` is above this desktop's `ours`.
 */
export function machineVersionGap(state: MachineConnectionState, granted: readonly string[] | null, version: string | null, ours: string | null): MachineVersionGap | null {
  if (state.state === "needsUpdate") return { version: state.version ?? version, side: state.side, hidden: [] };
  if (!granted) return null;
  const hidden = missingMachineFeatures(granted);
  if (!hidden.length) return null;
  return { version, side: version && ours && compareVersions(version, ours) > 0 ? "thisMac" : "machine", hidden };
}

/** A connected machine newer than this desktop: nothing is hidden, and its page offers this Mac's update. */
export function machineIsNewer(version: string | null, ours: string | null): boolean {
  return !!version && !!ours && compareVersions(version, ours) > 0;
}

/** "0.2.29" < "0.2.33": a plain numeric comparison of dotted versions; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [core, pre] = version.trim().replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre: pre ?? null };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index++) {
    const diff = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre < right.pre ? -1 : 1;
}
