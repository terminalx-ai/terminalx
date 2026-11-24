import { useId } from "react";
import { RadioGroup } from "radix-ui";
import { Clock, Github, Link2 } from "@/icons";
import type { AutomationForm } from "@/lib/cloudSchedules";

type TriggerKind = AutomationForm["triggerKind"];

const TRIGGERS = [
  { kind: "timer", label: "Schedule", description: "Hourly, daily, weekdays or weekly", icon: Clock },
  { kind: "github", label: "GitHub event", description: "A PR is opened, pushed or merged", icon: Github },
  { kind: "webhook", label: "Webhook", description: "Another tool posts JSON to a URL", icon: Link2 },
] as const;

export function CloudAutomationTriggerPicker({
  value,
  onChange,
  githubAvailable = false,
  webhookAvailable = false,
}: {
  value: TriggerKind;
  onChange: (value: TriggerKind) => void;
  /** The form's existing readiness checks for the target organization. */
  githubAvailable?: boolean;
  webhookAvailable?: boolean;
}) {
  const id = useId();
  const available = { timer: true, github: githubAvailable === true, webhook: webhookAvailable === true };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span id={id} className="font-medium">Trigger</span>
      <RadioGroup.Root
        aria-labelledby={id}
        orientation="vertical"
        value={available[value] ? value : ""}
        onValueChange={(next) => {
          const trigger = TRIGGERS.find(({ kind }) => kind === next && available[kind]);
          if (trigger) onChange(trigger.kind);
        }}
        className="grid gap-1 rounded-xl border border-hairline bg-card p-1"
      >
        {TRIGGERS.filter(({ kind }) => available[kind]).map(({ kind, label, description, icon: Icon }) => {
          const labelId = `${id}-${kind}-label`;
          const descriptionId = `${id}-${kind}-description`;
          return (
            <RadioGroup.Item
              key={kind}
              value={kind}
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
              className="group flex w-full min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left outline-none hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=checked]:border-accent/60 data-[state=checked]:bg-accent/5"
            >
              <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground group-data-[state=checked]:text-accent" />
              <span className="min-w-0 flex-1">
                <span id={labelId} className="block text-[13px] font-medium">{label}</span>
                <span id={descriptionId} className="block text-xs text-muted-foreground">{description}</span>
              </span>
              {kind !== "timer" && <span className="rounded bg-accent/10 px-1.5 text-[10px] font-medium text-accent">Cloud</span>}
              <span aria-hidden="true" className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-hairline-strong group-data-[state=checked]:border-accent">
                <RadioGroup.Indicator className="size-2 rounded-full bg-accent" />
              </span>
            </RadioGroup.Item>
          );
        })}
      </RadioGroup.Root>
    </div>
  );
}
