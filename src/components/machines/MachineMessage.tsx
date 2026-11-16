import type { ReactNode } from "react";
import { FolderX, KeyRound, MonitorOff, ShieldX, WifiOff } from "@/icons";
import { cn } from "@/lib/cn";

/**
 * The inline messages of screen 21.09: one rounded line with its icon, saying
 * what is wrong with a machine and what to do. The "needs update" one is
 * `MachineFeatureNotice`, drawn the same way. An action (Try again, Pair
 * again) sits at the line's end.
 */
export type MachineMessageKind = "unreachable" | "signIn" | "projectMissing" | "accessRemoved" | "localOnly";

const ICON = { unreachable: WifiOff, signIn: KeyRound, projectMissing: FolderX, accessRemoved: ShieldX, localOnly: MonitorOff } as const;

/** Red for what cuts this Mac off from the machine; a plain hairline for what the person can fix there. */
const BORDER: Record<MachineMessageKind, string> = {
  unreachable: "border-destructive/40",
  accessRemoved: "border-destructive/40",
  signIn: "border-hairline",
  projectMissing: "border-hairline",
  localOnly: "border-hairline",
};

const ICON_TONE: Record<MachineMessageKind, string> = {
  unreachable: "text-destructive",
  accessRemoved: "text-destructive",
  signIn: "text-muted-foreground",
  projectMissing: "text-muted-foreground",
  localOnly: "text-muted-foreground",
};

/** Built-in browser, computer use, dictation into a terminal and Local VM run on the computer a person sits at (decision 7). */
export const MACHINE_LOCAL_ONLY = "Browser and computer use aren't available on another machine.";

/** The words of each message (21.09). */
export function machineMessageText(kind: MachineMessageKind, words: { name: string; agent?: string; project?: string }): string {
  switch (kind) {
    case "unreachable":
      return `${words.name} isn't reachable. Sessions there keep running.`;
    case "signIn":
      return `${words.agent ?? "The agent"} isn't signed in on ${words.name}. Sign in from its page.`;
    case "projectMissing":
      return `${words.project ?? "This project"} isn't a project on ${words.name} yet. Add it there first.`;
    case "accessRemoved":
      return `${words.name} no longer allows this Mac. Pair again to reconnect.`;
    case "localOnly":
      return MACHINE_LOCAL_ONLY;
  }
}

export function MachineMessage({
  kind,
  name,
  agent,
  project,
  action,
  className,
}: {
  kind: MachineMessageKind;
  name: string;
  agent?: string;
  project?: string;
  action?: ReactNode;
  className?: string;
}) {
  const Icon = ICON[kind];
  return (
    <div
      role="status"
      className={cn("flex min-h-10 items-center gap-2.5 rounded-lg border px-3.5 py-2 text-[13px] text-foreground", BORDER[kind], className)}
      data-testid="machine-message"
      data-kind={kind}
    >
      <Icon className={cn("size-4 shrink-0", ICON_TONE[kind])} aria-hidden />
      <span className="min-w-0 flex-1">{machineMessageText(kind, { name, agent, project })}</span>
      {action && <span className="flex shrink-0 items-center gap-1.5">{action}</span>}
    </div>
  );
}
