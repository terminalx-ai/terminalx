import { Fragment } from "react";
import { ChevronDown, TriangleAlert } from "@/icons";
import { AgentMark } from "@/components/AgentMark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { EFFORT_LABEL, PERMISSION_MODES, modelGroups, modelNote, runningModelName } from "@/lib/models";
import type { useSessionAgent } from "@/lib/useSessionAgent";

/**
 * Agent, model, effort and permissions behind one quiet button: `Opus 5.5
 * High`. The menu holds the agent and the efforts inline, the models and
 * permissions one level in. Bypassing permissions is shown on the button,
 * since it changes what the agent may do unasked.
 */
export function AgentMenu({ selection, disabled = false }: { selection: ReturnType<typeof useSessionAgent>; disabled?: boolean }) {
  const { harnesses, harness, here, models, refreshModels, model, modelId, effort, mode, selectHarness, selectModel, selectEffort, selectMode, unavailableModel, allowDefaultEffort } = selection;
  const menu = useRowMenu({ onOpenChange: (open) => open && void refreshModels() });
  const modelText = unavailableModel ? `Unavailable: ${unavailableModel}` : (model ? runningModelName(model) : (harness?.name ?? "Agent"));
  const effortText = effort ? (EFFORT_LABEL[effort] ?? effort) : null;
  const permission = PERMISSION_MODES.find((m) => m.id === mode);
  const bypass = mode === "bypassPermissions";

  return (
    <DropdownMenu {...menu.root}>
      <DropdownMenuTrigger asChild {...menu.trigger}>
        <button
          type="button"
          disabled={disabled}
          data-testid="agent-menu"
          aria-label={`${modelText}${effortText ? ` ${effortText}` : ""}`}
          title={`${harness?.name ?? "Agent"} · ${permission?.label ?? mode}`}
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-foreground transition-colors hover:bg-veil-raised disabled:opacity-50"
        >
          {harness && <AgentMark id={harness.id} className="size-3.5" decorative brand />}
          <span className="truncate" data-testid="agent-model">{modelText}</span>
          {effortText && <span className="shrink-0 text-muted-foreground" data-testid="agent-effort">{effortText}</span>}
          {bypass && (
            <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-warning" title="The agent runs commands and edits files without asking">
              <TriangleAlert className="size-3" aria-hidden />
              Bypass
            </span>
          )}
          <ChevronDown className="size-3.5 shrink-0 text-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[15rem]">
        <DropdownMenuLabel>Agent</DropdownMenuLabel>
        {harnesses.map((h) => (
          <DropdownMenuItem key={h.id} disabled={here && !h.available} onSelect={() => selectHarness(h.id)}>
            <AgentMark id={h.id} decorative brand />
            <span>{h.name}</span>
            {h.id === harness?.id ? <span className="ml-auto pl-3 text-[11px] text-faint">current</span> : here && !h.available ? <span className="ml-auto pl-3 text-[11px] text-faint">not installed</span> : null}
          </DropdownMenuItem>
        ))}

        {harness && (model || unavailableModel || allowDefaultEffort) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span>Model</span>
                <span className="ml-auto max-w-[10rem] truncate pl-3 text-[11px] text-faint">{modelText}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[12rem] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto">
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
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}

        {harness && model && model.efforts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Effort</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={effort ?? ""} onValueChange={selectEffort}>
              {allowDefaultEffort && <DropdownMenuRadioItem value="">Default</DropdownMenuRadioItem>}
              {model.efforts.map((e) => (
                <DropdownMenuRadioItem key={e} value={e}>
                  {EFFORT_LABEL[e] ?? e}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span>Permissions</span>
            <span className="ml-auto pl-3 text-[11px] text-faint">{permission?.label ?? mode}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-[14rem]">
            <DropdownMenuRadioGroup value={mode} onValueChange={selectMode}>
              {PERMISSION_MODES.map((m) => (
                <DropdownMenuRadioItem key={m.id} value={m.id} className="flex-col items-start gap-0">
                  <span>{m.label}</span>
                  <span className="text-[11px] text-faint">{m.hint}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
