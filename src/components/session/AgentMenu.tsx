import { Fragment } from "react";
import { ChevronDown, ShieldCheck, TriangleAlert } from "@/icons";
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
 * High · Ask every time`. The menu holds agent, model, effort and permissions in submenus. The mode is always on the button, so
 * what the agent may do unasked is never a menu away (PRO-162); Bypass is
 * marked as a warning and Plan in the composer's plan colour.
 *
 * With `split`, as the new-session box shows them: two chips, the model and
 * effort on one and the permission mode on its own, each with its own menu.
 */
export function AgentMenu({ selection, disabled = false, split = false, onSetup }: {
  selection: ReturnType<typeof useSessionAgent>;
  disabled?: boolean;
  split?: boolean;
  /** New Session (#1064): an agent this Mac knows is missing or signed out can be picked to set it up, here rather than in a card per agent. */
  onSetup?: (id: string) => void;
}) {
  const { harnesses, harness, readiness, here, models, refreshModels, model, modelId, effort, mode, selectHarness, selectModel, selectEffort, selectMode, unavailableModel, allowDefaultEffort, accounts, account, selectAccount } = selection;
  const menu = useRowMenu({ onOpenChange: (open) => open && void refreshModels() });
  const modeMenu = useRowMenu();
  const modelText = unavailableModel ? `Unavailable: ${unavailableModel}` : (model ? runningModelName(model) : (harness?.name ?? "Agent"));
  const effortText = effort ? (EFFORT_LABEL[effort] ?? effort) : null;
  const permission = PERMISSION_MODES.find((m) => m.id === mode);
  const modeText = permission?.label ?? mode;
  const bypass = modeIsUnguarded(mode);

  const modeTone = bypass ? "text-warning" : mode === "plan" ? "text-info" : "text-muted-foreground";
  const modeHint = bypass ? "The agent runs commands and edits files without asking" : permission?.hint;
  const permissions = (
    <DropdownMenuRadioGroup value={mode} onValueChange={selectMode}>
      {PERMISSION_MODES.map((m) => (
        <DropdownMenuRadioItem key={m.id} value={m.id} className="flex-col items-start gap-0">
          <span>{m.label}</span>
          <span className="text-[11px] text-faint">{m.hint}</span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );

  return (
    <>
    <DropdownMenu {...menu.root}>
      <DropdownMenuTrigger asChild {...menu.trigger}>
        <button
          type="button"
          disabled={disabled}
          data-testid="agent-menu"
          aria-label={`${modelText}${effortText ? ` ${effortText}` : ""}${account ? ` on ${account.label}` : ""}${split ? "" : `, ${modeText}`}`}
          title={`${harness?.name ?? "Agent"}${account ? ` · ${account.label}` : ""} · ${modeText}`}
          className={cn("flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-foreground transition-colors hover:bg-veil-raised disabled:opacity-50", split ? "text-[12.5px]" : "text-[13px]")}
        >
          {harness && <AgentMark id={harness.id} className={split ? "size-[13px]" : "size-3.5"} decorative brand />}
          <span className={cn("truncate", split && "font-medium")} data-testid="agent-model">{modelText}</span>
          {effortText && <span className="shrink-0 text-muted-foreground" data-testid="agent-effort">{effortText}</span>}
          {account && <span className="min-w-0 max-w-[9rem] truncate text-[12px] text-muted-foreground" data-testid="agent-account">{account.label}</span>}
          {!split && (
            <span data-testid="agent-mode" className={cn("flex shrink-0 items-center gap-1 text-[11.5px]", modeTone)} title={modeHint}>
              <span aria-hidden className="text-faint">·</span>
              {bypass && <TriangleAlert className="size-3" aria-hidden />}
              {bypass ? "Bypass" : modeText}
            </span>
          )}
          <ChevronDown className={cn("shrink-0 text-faint", split ? "size-3" : "size-3.5")} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[15rem]">
        <ChoiceRow label="Agent" value={harness?.name ?? "Choose an agent"} testId="agent-menu-agent" className="min-w-[14rem]">
          {harnesses.map((h) => {
            const state = readiness?.[h.id]?.state;
            const unavailable = here && (!h.available || (readiness !== undefined && (!state || state === "missing" || state === "signed_out")));
            const hint = !h.available || state === "missing" ? "not installed" : state === "signed_out" ? "sign in required" : "checking…";
            // Only a definite answer offers setup: "checking…" stays off until the check says.
            const setup = unavailable && !!onSetup && (state === "missing" || state === "signed_out");
            return <DropdownMenuItem key={h.id} disabled={unavailable && !setup} onSelect={() => setup ? onSetup(h.id) : selectHarness(h.id)}>
              <AgentMark id={h.id} decorative brand />
              <span>{h.name}</span>
              {h.id === harness?.id ? <span className="ml-auto pl-3 text-[11px] text-faint">current</span> : unavailable ? <span className="ml-auto pl-3 text-[11px] text-faint">{hint}</span> : null}
            </DropdownMenuItem>
          })}
        </ChoiceRow>

        {/* Only an agent with more than one account offers the choice (#980). */}
        {harness && accounts && account && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span>Account</span>
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

        {!split && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span>Permissions</span>
                <span className="ml-auto pl-3 text-[11px] text-faint">{permission?.label ?? mode}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[14rem]">{permissions}</DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    {split && (
      <DropdownMenu {...modeMenu.root}>
        <DropdownMenuTrigger asChild {...modeMenu.trigger}>
          <button
            type="button"
            disabled={disabled}
            data-testid="agent-mode"
            aria-label={`Permissions: ${modeText}`}
            title={modeHint}
            className={cn("flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12.5px] transition-colors hover:bg-veil-raised disabled:opacity-50", modeTone)}
          >
            {bypass ? <TriangleAlert className="size-[13px]" aria-hidden /> : <ShieldCheck className="size-[13px]" aria-hidden />}
            {bypass ? "Bypass" : modeText}
            <ChevronDown className="size-3 text-faint" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[14rem]">
          <DropdownMenuLabel>Permissions</DropdownMenuLabel>
          {permissions}
        </DropdownMenuContent>
      </DropdownMenu>
    )}
    </>
  );
}

/** The Agent and Effort rows: what is chosen, and its choices in a submenu beside the row. */
function ChoiceRow({ label, value, testId, className, children }: { label: string; value: string; testId: string; className?: string; children: React.ReactNode }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid={testId}>
        <span className="flex-1">{label}</span>
        <span className="ml-auto max-w-[10rem] truncate pl-3 text-[12px] text-faint">{value}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className={className}>{children}</DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
