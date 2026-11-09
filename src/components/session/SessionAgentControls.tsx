import { PipelineLaunchControls } from "./PipelineLaunchControls";
import type { usePipelineLaunch } from "@/lib/pipelineLaunch";
import { Fragment } from "react";
import { ChevronDown } from "@/icons";
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
import { EFFORT_LABEL, PERMISSION_MODES, modelGroups, modelNote, runningModelName } from "@/lib/models";
import type { useSessionAgent } from "@/lib/useSessionAgent";

/**
 * Agent, model, effort and permission mode for a new session or agent tab.
 * Shared by New Session, issue starts, a new cloud workspace, a cloud
 * workspace's new agent tab, and the handoffs (Continue in New Session, Link
 * to a project); the parent supplies a wrapping row. `disabled` holds the
 * choices once a launch has begun.
 */
export function SessionAgentControls({ selection, pipeline, disabled = false, fill = false }: {
  pipeline?: ReturnType<typeof usePipelineLaunch>; selection: ReturnType<typeof useSessionAgent>; disabled?: boolean;
  /** Stretch the pills across their row, each name left and its chevron right, so the row is as wide as what is under it. */
  fill?: boolean;
}) {
  const { harnesses, harness, here, models, refreshModels, model, modelId, effort, mode, selectHarness, selectModel, selectEffort, selectMode, unavailableModel, allowDefaultEffort } = selection;
  const agentMenu = useRowMenu();
  const modelMenu = useRowMenu({ onOpenChange: (open) => open && void refreshModels() });
  const effortMenu = useRowMenu();
  const modeMenu = useRowMenu();
  // The model's own name on its pill (`Opus 5.5`), not what the menu says about it: the menu is where "latest" is explained.
  const pill = fill ? "h-8 min-w-0 flex-auto justify-between gap-1.5" : "min-w-0 max-w-full shrink gap-1.5";

  return (
    <>
      <DropdownMenu {...agentMenu.root}>
        <DropdownMenuTrigger asChild {...agentMenu.trigger}>
          <Button variant="secondary" size="sm" className={pill} title="Agent" disabled={disabled}>
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

      {harness && (model || unavailableModel || allowDefaultEffort) && (
        <DropdownMenu {...modelMenu.root}>
          <DropdownMenuTrigger asChild {...modelMenu.trigger}>
            <Button variant="secondary" size="sm" className={pill} title="Model" disabled={disabled}>
              <span className="truncate">{unavailableModel ? `Unavailable: ${unavailableModel}` : model ? runningModelName(model) : "Agent default"}</span>
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
                    const note = modelNote(m, models);
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
            <Button variant="secondary" size="sm" className={pill} title="Effort" disabled={disabled}>
              <span className="truncate">{effort ? (EFFORT_LABEL[effort] ?? effort) : allowDefaultEffort ? "Default" : "Effort"}</span>
              <ChevronDown className="text-faint" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Effort</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={effort ?? ""} onValueChange={selectEffort}>
              {allowDefaultEffort && <DropdownMenuRadioItem value="">Default</DropdownMenuRadioItem>}
              {model.efforts.map((e) => (
                <DropdownMenuRadioItem key={e} value={e}>
                  {EFFORT_LABEL[e] ?? e}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <DropdownMenu {...modeMenu.root}>
        <DropdownMenuTrigger asChild {...modeMenu.trigger}>
          <Button variant="secondary" size="sm" className={pill} title="Permissions" disabled={disabled}>
            <span className="truncate">{PERMISSION_MODES.find((m) => m.id === mode)?.label ?? mode}</span>
            <ChevronDown className="text-faint" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[14rem]">
          <DropdownMenuLabel>Permissions</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={mode} onValueChange={selectMode}>
            {PERMISSION_MODES.map((m) => (
              <DropdownMenuRadioItem key={m.id} value={m.id} className="flex-col items-start gap-0">
                <span>{m.label}</span>
                <span className="text-[11px] text-faint">{m.hint}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {pipeline && <PipelineLaunchControls launch={pipeline} disabled={disabled} />}
    </>
  );
}
