import { Fragment } from "react";
import { ChevronDown } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { EFFORT_LABEL, modelGroups, modelNote, modelOptionText, refreshModels } from "@/lib/models";
import type { useSessionAgent } from "@/lib/useSessionAgent";

/** Shared by New Session and issue starts; the parent supplies a wrapping row. */
export function SessionAgentControls({ selection }: { selection: ReturnType<typeof useSessionAgent> }) {
  const { harnesses, harness, here, models, model, modelId, effort, selectHarness, selectModel, selectEffort } = selection;
  const agentMenu = useRowMenu();
  const modelMenu = useRowMenu({ onOpenChange: (open) => open && void refreshModels() });
  const effortMenu = useRowMenu();
  const pill = "min-w-0 max-w-full gap-1.5";

  return (
    <>
      <DropdownMenu {...agentMenu.root}>
        <DropdownMenuTrigger asChild {...agentMenu.trigger}>
          <Button variant="secondary" size="sm" className={pill} title="Agent">
            {harness && <AgentMark id={harness.id} className="size-3.5" decorative brand />}
            <span className="truncate">{harness?.name ?? "Agent"}</span>
            <ChevronDown className="text-faint" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Agent</DropdownMenuLabel>
          {harnesses.map((h) => (
            <DropdownMenuItem key={h.id} disabled={here && !h.available} onSelect={() => selectHarness(h.id)}>
              <AgentMark id={h.id} decorative brand />
              <span>{h.name}</span>
              {here && !h.available && <span className="ml-auto pl-3 text-[11px] text-faint">not installed</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {harness && model && (
        <DropdownMenu {...modelMenu.root}>
          <DropdownMenuTrigger asChild {...modelMenu.trigger}>
            <Button variant="secondary" size="sm" className={pill} title="Model">
              <span className="truncate">{modelOptionText(model, models, here)}</span>
              <ChevronDown className="text-faint" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[12rem] max-w-[var(--radix-dropdown-menu-content-available-width)] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto">
            <DropdownMenuLabel>Model</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={modelId} onValueChange={selectModel}>
              {modelGroups(models).map((group) => (
                <Fragment key={group.title ?? "models"}>
                  {group.title ? <DropdownMenuLabel className="pt-2">{group.title}</DropdownMenuLabel> : null}
                  {group.models.map((m) => {
                    const note = modelNote(m, models, here);
                    return (
                      <DropdownMenuRadioItem key={m.id} value={m.id} className="flex-wrap whitespace-normal">
                        {m.label}
                        {note ? <span className="ml-1.5 text-faint">{note}</span> : null}
                      </DropdownMenuRadioItem>
                    );
                  })}
                </Fragment>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {harness && model && model.efforts.length > 0 && (
        <DropdownMenu {...effortMenu.root}>
          <DropdownMenuTrigger asChild {...effortMenu.trigger}>
            <Button variant="secondary" size="sm" className={pill} title="Effort">
              <span className="truncate">{effort ? (EFFORT_LABEL[effort] ?? effort) : "Effort"}</span>
              <ChevronDown className="text-faint" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Effort</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={effort ?? ""} onValueChange={selectEffort}>
              {model.efforts.map((e) => (
                <DropdownMenuRadioItem key={e} value={e}>
                  {EFFORT_LABEL[e] ?? e}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}
