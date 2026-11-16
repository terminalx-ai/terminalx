import { Fragment, useEffect, useRef, useState } from "react";
import { DropdownMenu as Prim } from "radix-ui";
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
import { cn } from "@/lib/cn";
import { EFFORT_LABEL, PERMISSION_MODES, modeIsUnguarded, modelGroups, modelNote, runningModelName } from "@/lib/models";
import type { useSessionAgent } from "@/lib/useSessionAgent";
import { AccountRadioItems } from "./SessionAgentControls";

/**
 * Agent, model, effort and permissions behind one quiet button: `Opus 5.5
 * High · Ask every time`. The menu is the session composer's: an Agent, a
 * Model and an Effort row, each naming what is chosen and opening its choices
 * beside it, then Permissions. The mode is always on the button, so
 * what the agent may do unasked is never a menu away (PRO-162); Bypass is
 * marked as a warning and Plan in the composer's plan colour.
 */
export function AgentMenu({ selection, disabled = false }: { selection: ReturnType<typeof useSessionAgent>; disabled?: boolean }) {
  const { harnesses, harness, readiness, here, models, refreshModels, model, modelId, effort, mode, selectHarness, selectModel, selectEffort, selectMode, unavailableModel, allowDefaultEffort, accounts, account, selectAccount } = selection;
  const menu = useRowMenu({ onOpenChange: (open) => open && void refreshModels() });
  const modelText = unavailableModel ? `Unavailable: ${unavailableModel}` : (model ? runningModelName(model) : (harness?.name ?? "Agent"));
  const effortText = effort ? (EFFORT_LABEL[effort] ?? effort) : null;
  const permission = PERMISSION_MODES.find((m) => m.id === mode);
  const modeText = permission?.label ?? mode;
  const bypass = modeIsUnguarded(mode);

  return (
    <DropdownMenu {...menu.root}>
      <DropdownMenuTrigger asChild {...menu.trigger}>
        <button
          type="button"
          disabled={disabled}
          data-testid="agent-menu"
          aria-label={`${modelText}${effortText ? ` ${effortText}` : ""}${account ? ` on ${account.label}` : ""}, ${modeText}`}
          title={`${harness?.name ?? "Agent"}${account ? ` · ${account.label}` : ""} · ${modeText}`}
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-foreground transition-colors hover:bg-veil-raised disabled:opacity-50"
        >
          {harness && <AgentMark id={harness.id} className="size-3.5" decorative brand />}
          <span className="truncate" data-testid="agent-model">{modelText}</span>
          {effortText && <span className="shrink-0 text-muted-foreground" data-testid="agent-effort">{effortText}</span>}
          {account && <span className="min-w-0 max-w-[9rem] truncate text-[12px] text-muted-foreground" data-testid="agent-account">{account.label}</span>}
          <span
            data-testid="agent-mode"
            className={cn("flex shrink-0 items-center gap-1 text-[11.5px]", bypass ? "text-warning" : mode === "plan" ? "text-info" : "text-muted-foreground")}
            title={bypass ? "The agent runs commands and edits files without asking" : permission?.hint}
          >
            <span aria-hidden className="text-faint">·</span>
            {bypass && <TriangleAlert className="size-3" aria-hidden />}
            {bypass ? "Bypass" : modeText}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-faint" />
        </button>
      </DropdownMenuTrigger>
      {/* `overflow-visible`: the Agent and Effort choices are drawn from inside this menu (ChoiceRow). */}
      <DropdownMenuContent align="start" className="min-w-[15rem] overflow-visible">
        <ChoiceRow label="Agent" value={harness?.name ?? "None"} testId="agent-menu-agent" className="min-w-[14rem]">
          {harnesses.map((h) => {
            const state = readiness?.[h.id]?.state;
            const unavailable = here && (!h.available || (readiness !== undefined && (!state || state === "missing" || state === "signed_out")));
            const hint = !h.available || state === "missing" ? "not installed" : state === "signed_out" ? "sign in required" : "checking…";
            return <DropdownMenuItem key={h.id} disabled={unavailable} onSelect={() => selectHarness(h.id)}>
              <AgentMark id={h.id} decorative brand />
              <span>{h.name}</span>
              {h.id === harness?.id ? <span className="ml-auto pl-3 text-[11px] text-faint">current</span> : unavailable ? <span className="ml-auto pl-3 text-[11px] text-faint">{hint}</span> : null}
            </DropdownMenuItem>
          })}
        </ChoiceRow>

        {/* Only an agent with more than one account offers the choice (#980). */}
        {harness && accounts && account && (
          <>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span className="flex-1">Account</span>
                <span className="ml-auto max-w-[10rem] truncate pl-3 text-[12px] text-faint">{account.label}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[14rem]">
                <AccountRadioItems accounts={accounts.accounts} value={account.id} onValueChange={selectAccount} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}

        {harness && (model || unavailableModel || allowDefaultEffort) && (
          <>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="agent-menu-model">
                <span className="flex-1">Model</span>
                <span className="ml-auto max-w-[10rem] truncate pl-3 text-[12px] text-faint">{modelText}</span>
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
          <ChoiceRow label="Effort" value={effortText ?? "Default"} testId="agent-menu-effort" className="min-w-[12rem]">
            <DropdownMenuRadioGroup value={effort ?? ""} onValueChange={selectEffort}>
              {allowDefaultEffort && <DropdownMenuRadioItem value="">Default</DropdownMenuRadioItem>}
              {model.efforts.map((e) => (
                <DropdownMenuRadioItem key={e} value={e}>
                  {EFFORT_LABEL[e] ?? e}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </ChoiceRow>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="flex-1">Permissions</span>
            <span className="ml-auto pl-3 text-[12px] text-faint">{permission?.label ?? mode}</span>
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

/**
 * The Agent and Effort rows: what is chosen, and its choices beside the row.
 * They open like any submenu, but stay mounted inside the menu's own element
 * (hidden until their row opens them) instead of in a layer of their own: the
 * agents and efforts remain part of the one menu, which is how IssuesView's
 * tests pick them. Two things a submenu mounted on opening gets for free are
 * done here. Mounted with the menu, the list is a layer below it, which a
 * modal menu takes the pointer from: `pointerEvents` gives it back. And a
 * list opened from the keyboard takes the focus once it is shown.
 */
function ChoiceRow({ label, value, testId, className, children }: { label: string; value: string; testId: string; className?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const byKey = useRef(false);
  useEffect(() => {
    if (open && byKey.current) list.current?.focus();
    byKey.current = false;
  }, [open]);
  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger
        data-testid={testId}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") byKey.current = true;
        }}
      >
        <span className="flex-1">{label}</span>
        <span className="ml-auto max-w-[10rem] truncate pl-3 text-[12px] text-faint">{value}</span>
      </DropdownMenuSubTrigger>
      <Prim.SubContent
        ref={list}
        forceMount
        role="group"
        collisionPadding={8}
        avoidCollisions
        style={{ pointerEvents: "auto" }}
        className={cn("z-(--z-menu) overflow-hidden rounded-lg bg-popover p-1 text-popover-foreground shadow-surface hairline data-[state=closed]:hidden data-[state=open]:animate-fade-in", className)}
      >
        {children}
      </Prim.SubContent>
    </DropdownMenuSub>
  );
}
