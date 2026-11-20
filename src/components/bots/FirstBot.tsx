import { useEffect, useState, type ComponentType } from "react";
import { Bell, Bot as BotIcon, CalendarClock, CircleDot, LayoutGrid, Laptop, Loader2, MessageSquare, Plus, ShieldOff, SquareTerminal, GitPullRequest } from "@/icons";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { createBot, loadBotTemplates, useBotStore } from "@/lib/bots";
import { showHireBot } from "@/lib/botsPage";
import type { BotDutyWake, BotRoleTemplate } from "@/types/bots";
import { BotAvatar } from "./BotAvatar";
import { BotsHeader } from "./BotsHeader";

/** The three roles the first-bot page offers (23.11), lead first. */
export const FIRST_ROLES = ["cto", "watcher", "security-auditor"];

export function wakeIcon(wake: BotDutyWake): ComponentType<{ className?: string }> {
  switch (wake.kind) {
    case "schedule":
      return CalendarClock;
    case "github":
      return GitPullRequest;
    case "linear":
      return CircleDot;
    case "bot":
      return BotIcon;
    default:
      return MessageSquare;
  }
}

/** 23.11: no bots yet. Three role cards with one-click Hire, what a bot is, and how it differs from a session. */
export function FirstBot() {
  const store = useBotStore();
  const [templates, setTemplates] = useState<BotRoleTemplate[] | null>(store.templates);
  const [error, setError] = useState<string | null>(null);
  const [hiring, setHiring] = useState<string | null>(null);

  useEffect(() => {
    if (templates) return;
    let live = true;
    loadBotTemplates().then((list) => live && setTemplates(list), (cause) => live && setError(errorMessage(cause)));
    return () => {
      live = false;
    };
  }, [templates]);

  const offered = templates ? FIRST_ROLES.map((id) => templates.find((template) => template.id === id)).filter((template): template is BotRoleTemplate => !!template) : [];
  // One click: the role's own title is its first name, and it can be renamed any time.
  const hire = (template: BotRoleTemplate) => {
    setHiring(template.id);
    createBot(template.id, template.title).then(() => setError(null), (cause) => setError(errorMessage(cause))).finally(() => setHiring(null));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="bots-first">
      <BotsHeader title="Bots" note="No bots yet">
        <Button variant="outline" size="sm" onClick={() => showHireBot()} data-testid="bots-all-roles">
          <LayoutGrid /> {templates ? `All ${templates.length} roles` : "All roles"}
        </Button>
      </BotsHeader>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-6 px-6 py-8">
          <div>
            <h2 className="text-[22px] font-semibold text-foreground">Hire your first bot</h2>
            <p className="mt-1.5 max-w-[720px] text-[13.5px] leading-[1.6] text-muted-foreground">
              A bot is an agent with a standing job. It keeps a role, a memory and a list of work, wakes up for its duties without being asked, and comes to you only when it needs a decision.
            </p>
          </div>

          {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{error}</p>}

          <div className="grid grid-cols-1 gap-4 @3xl/editor-host:grid-cols-3" data-testid="bots-first-roles">
            {!templates && !error && (
              <p className="flex items-center gap-2 text-[12.5px] text-faint" role="status"><Loader2 className="size-3.5 animate-spin" /> Reading the roles…</p>
            )}
            {offered.map((template, index) => (
              <RoleCard key={template.id} template={template} lead={index === 0} hiring={hiring === template.id} disabled={!!hiring} onHire={() => hire(template)} />
            ))}
          </div>

          <ul className="grid grid-cols-1 gap-4 @3xl/editor-host:grid-cols-3" data-testid="bots-first-points">
            <Point icon={Laptop} title="Runs on this Mac, with no account">
              Uses the Claude Code and Codex logins you already have.
            </Point>
            <Point icon={ShieldOff} title="Full access, with a brake">
              Works without asking, like your sessions. Pause stops one bot or all of them at once, and you can lower one bot to read and report.
            </Point>
            <Point icon={Bell} title="Asks you when it needs you">
              A question comes to you with its answers. One choice and the bot goes on.
            </Point>
          </ul>

          <section aria-labelledby="bots-difference">
            <h2 id="bots-difference" className="mb-2 text-[11px] font-medium uppercase tracking-[.08em] text-faint">What is different about a bot</h2>
            <div className="divide-y divide-hairline rounded-lg border border-hairline bg-card px-4" data-testid="bots-difference">
              <Difference icon={SquareTerminal} name="A session">Does one task you gave it, then stops. Remembers nothing next time.</Difference>
              <Difference icon={CalendarClock} name="An automation">Runs one prompt on a schedule. Does not follow up or hold a list of work.</Difference>
              <Difference icon={BotIcon} name="A bot" strong>
                Holds a job. Keeps its own work list, remembers what you taught it, starts sessions and runs, and reports to you or to a lead bot.
              </Difference>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function RoleCard({ template, lead, hiring, disabled, onHire }: { template: BotRoleTemplate; lead: boolean; hiring: boolean; disabled: boolean; onHire: () => void }) {
  return (
    <article className="flex min-w-0 flex-col rounded-xl border border-hairline bg-card p-4" aria-label={template.title} data-testid="bots-role-card" data-role={template.id}>
      <div className="flex min-w-0 items-start gap-3">
        <BotAvatar roleTemplateId={template.id} size="md" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[14px] font-medium text-foreground">{template.title}</h3>
          <p className="truncate text-[12px] text-faint">named {template.title} · rename any time</p>
        </div>
        {lead && <span className="shrink-0 text-[11px] text-accent">start here</span>}
      </div>
      <p className="mt-3 text-[12.5px] leading-[1.55] text-muted-foreground">{template.description}</p>
      {template.duties.length > 0 && (
        <>
          <p className="mt-3 text-[11px] font-medium uppercase tracking-[.08em] text-faint">Comes with</p>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {template.duties.slice(0, 3).map((duty) => {
              const Icon = wakeIcon(duty.wake);
              return (
                <li key={duty.id} className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted-foreground">
                  <Icon className="size-3.5 shrink-0 text-faint" />
                  <span className="truncate">{duty.title}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <div className="mt-auto pt-4">
        <Button variant={lead ? "accent" : "outline"} size="sm" className="w-full" disabled={disabled} onClick={onHire} data-testid="bots-role-hire">
          {hiring ? <Loader2 className="animate-spin" /> : <Plus />} Hire {template.title}
        </Button>
      </div>
    </article>
  );
}

function Point({ icon: Icon, title, children }: { icon: ComponentType<{ className?: string }>; title: string; children: string }) {
  return (
    <li className="flex min-w-0 gap-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-[12.5px] leading-[1.5] text-faint">{children}</p>
      </div>
    </li>
  );
}

function Difference({ icon: Icon, name, strong = false, children }: { icon: ComponentType<{ className?: string }>; name: string; strong?: boolean; children: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 py-2.5 @2xl/editor-host:flex-row @2xl/editor-host:items-center @2xl/editor-host:gap-4">
      <span className={strongClass(strong, "flex w-36 shrink-0 items-center gap-2 text-[13px]")}>
        <Icon className={strong ? "size-3.5 text-accent" : "size-3.5 text-faint"} />
        {name}
      </span>
      <span className={strongClass(strong, "min-w-0 text-[12.5px]")}>{children}</span>
    </div>
  );
}

function strongClass(strong: boolean, base: string) {
  return `${base} ${strong ? "text-foreground" : "text-muted-foreground"}`;
}
