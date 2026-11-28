import { ThisComputer } from "@/lib/platform";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MachineHostError } from "@/components/machines/MachineHostError";
import { Check, ChevronDown, ChevronRight, Cpu, Laptop, Loader2, MessageSquare, Search, Shield, Sparkles, Users, Waypoints } from "@/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { errorMessage } from "@/lib/api";
import { createBot, loadBotTemplates, useBotStore } from "@/lib/bots";
import { getBotsPage, showBotsTeam } from "@/lib/botsPage";
import { getSessionStore, useSessionStore } from "@/lib/sessions";
import { cn } from "@/lib/cn";
import type { BotRoleTemplate } from "@/types/bots";
import { BotAvatar } from "./BotAvatar";
import { accessLabel, roleDuties, wakeLabel, worksInLabel } from "./botLabels";
import { wakeIcon } from "./FirstBot";

/** The role list's groups (23.03). A role this build does not place goes under Other. */
const GROUPS: { label: string; roles: string[] }[] = [
  { label: "Lead", roles: ["cto", "chief-of-staff"] },
  { label: "Build", roles: ["ux-designer", "qa-engineer", "release-manager", "docs-writer"] },
  { label: "Guard", roles: ["security-auditor", "watcher"] },
];

export function groupRoles(templates: BotRoleTemplate[]): { label: string; templates: BotRoleTemplate[] }[] {
  const placed = new Set(GROUPS.flatMap((group) => group.roles));
  const groups = GROUPS.map((group) => ({ label: group.label, templates: group.roles.map((id) => templates.find((template) => template.id === id)).filter((template): template is BotRoleTemplate => !!template) }));
  groups.push({ label: "Other", templates: templates.filter((template) => !placed.has(template.id)) });
  return groups.filter((group) => group.templates.length > 0);
}

/**
 * Hire a bot (23.03): the roles on the left, the picked role in the middle (what it does, its duties, skills, where it
 * reports), and on the right only a name, the Hire button and the defaults it starts with. Hiring asks for a role and a
 * name and nothing else (PRO-459).
 */
export function HireBot({ initialRoleId }: { initialRoleId: string | null }) {
  const store = useBotStore();
  const [templates, setTemplates] = useState<BotRoleTemplate[] | null>(store.templates);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [roleId, setRoleId] = useState<string | null>(initialRoleId);

  useEffect(() => setRoleId(initialRoleId), [initialRoleId]);
  useEffect(() => {
    if (templates) return;
    let live = true;
    loadBotTemplates().then((list) => live && setTemplates(list), (cause) => live && setLoadError(errorMessage(cause)));
    return () => {
      live = false;
    };
  }, [templates]);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    const list = templates ?? [];
    return words ? list.filter((template) => `${template.title} ${template.description}`.toLowerCase().includes(words)) : list;
  }, [templates, query]);
  const role = templates?.find((template) => template.id === roleId) ?? templates?.[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="bots-hire-page">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline px-6 py-2" data-testid="bots-header">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
          <button type="button" onClick={() => showBotsTeam()} className="rounded-sm text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40">
            Bots
          </button>
          <ChevronRight className="size-3.5 text-faint" />
          <h1 className="text-[15px] font-semibold text-foreground">Hire a bot</h1>
        </nav>
        <p className="min-w-0 flex-1 truncate text-[12.5px] text-faint">Pick a role and a name. Everything else starts from your defaults.</p>
        <label className="ml-auto flex h-8 w-56 min-w-0 items-center gap-2 rounded-lg border border-hairline bg-input px-2.5 text-[12.5px] focus-within:ring-2 focus-within:ring-ring/40">
          <Search className="size-3.5 shrink-0 text-faint" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search roles" aria-label="Search roles" spellCheck={false} className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" />
        </label>
      </header>

      {loadError && <p role="alert" className="mx-6 mt-3 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">Couldn't read the roles: {loadError}</p>}

      <div className="@container/hire-layout flex min-h-0 flex-1 flex-col @2xl/hire-layout:flex-row">
        <nav aria-label="Roles" className="max-h-[35%] w-full shrink-0 overflow-y-auto scrollbar-thin border-b border-hairline px-3 py-3 @2xl/hire-layout:max-h-none @2xl/hire-layout:w-[260px] @2xl/hire-layout:border-r @2xl/hire-layout:border-b-0" data-testid="bots-hire-roles">
          {!templates && !loadError && <p role="status" className="flex items-center gap-2 px-2 text-[12.5px] text-faint"><Loader2 className="size-3.5 animate-spin" /> Reading the roles…</p>}
          {templates && shown.length === 0 && <p className="px-2 text-[12.5px] text-faint">No role matches.</p>}
          {groupRoles(shown).map((group) => (
            <div key={group.label} className="mb-3">
              <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-[.08em] text-faint">{group.label}</p>
              <ul className="flex flex-col gap-0.5">
                {group.templates.map((template) => {
                  const picked = role?.id === template.id;
                  return (
                    <li key={template.id}>
                      <button
                        type="button"
                        onClick={() => setRoleId(template.id)}
                        aria-current={picked ? "true" : undefined}
                        className={cn("flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40", picked ? "bg-selected" : "hover:bg-selected/50")}
                        data-testid="bots-hire-role"
                        data-role={template.id}
                      >
                        <BotAvatar roleTemplateId={template.id} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] text-foreground">{template.title}</span>
                          <span className="block truncate text-[11.5px] text-faint">{template.description}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto scrollbar-thin">
          {role && (
            <div className="@container/hire flex min-w-0 flex-col gap-6 px-6 py-5">
              <div className="flex min-w-0 items-start gap-3.5">
                <BotAvatar roleTemplateId={role.id} size="lg" />
                <div className="min-w-0">
                  <h2 className="text-[17px] font-semibold text-foreground">{role.title}</h2>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">{role.description}</p>
                </div>
              </div>
              <div className="flex min-w-0 flex-col gap-6 @3xl/hire:flex-row">
                <RoleDetail role={role} />
                {/* Not keyed by the role: a name typed before picking another role is kept. */}
                <HireForm role={role} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Heading({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <h3 className="mb-2 text-[11px] font-medium uppercase tracking-[.08em] text-faint">
      {children}
      {note && <span className="ml-1 font-normal normal-case tracking-normal"> · {note}</span>}
    </h3>
  );
}

function RoleDetail({ role }: { role: BotRoleTemplate }) {
  const duties = roleDuties(role.role);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-5" data-testid="bots-hire-detail">
      <section>
        <Heading>What it does</Heading>
        {duties.length ? (
          <ul className="flex list-disc flex-col gap-1 pl-4 text-[13px] leading-[1.55] text-muted-foreground marker:text-faint">
            {duties.map((duty) => <li key={duty}>{duty}</li>)}
          </ul>
        ) : (
          <p className="text-[13px] leading-[1.55] text-muted-foreground">{role.description}</p>
        )}
      </section>
      {role.duties.length > 0 && (
        <section>
          <Heading note="all start off">Duties it comes with</Heading>
          <ul className="divide-y divide-hairline border-y border-hairline" data-testid="bots-hire-duties">
            {role.duties.map((duty) => {
              const Icon = wakeIcon(duty.wake);
              return (
                <li key={duty.id} className="flex min-w-0 items-center gap-2.5 py-2" title={duty.description}>
                  <Icon className="size-3.5 shrink-0 text-faint" />
                  <span className="min-w-0 truncate text-[13px] text-foreground">{duty.title}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-faint">{wakeLabel(duty.wake)}</span>
                  <Switch size="md" checked={false} disabled aria-label={`${duty.title}: off until the bot is hired`} />
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {role.skills.length > 0 && (
        <section>
          <Heading>Skills</Heading>
          <ul className="flex flex-wrap gap-1.5">
            {role.skills.map((skill) => (
              <li key={skill} className="inline-flex items-center gap-1 rounded-md border border-hairline px-2 py-0.5 text-[12px] text-muted-foreground">
                <Sparkles className="size-3 text-faint" /> {skill}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <Heading>Where it reports</Heading>
        <ul className="flex flex-wrap gap-1.5">
          <li className="inline-flex items-center gap-1 rounded-md border border-hairline px-2 py-0.5 text-[12px] text-muted-foreground">
            <MessageSquare className="size-3 text-faint" /> TerminalX · its Home chat
          </li>
        </ul>
      </section>
    </div>
  );
}

/** The right column: a name, Hire, and what it starts with. */
function HireForm({ role }: { role: BotRoleTemplate }) {
  const sessions = useSessionStore();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Set while this form is on screen: a hire that finishes after the person went elsewhere does not take them back.
  const live = useRef(true);
  const trimmed = name.trim();

  useEffect(() => {
    live.current = true;
    input.current?.focus();
    return () => {
      live.current = false;
    };
  }, []);
  // A refusal was about the role it was for.
  useEffect(() => setError(null), [role.id]);
  const agent = sessions.harnesses.find((harness) => harness.id === "claude")?.name ?? "Claude Code";

  const hire = () => {
    if (!trimmed || busy) return;
    setBusy(true);
    createBot(role.id, trimmed).then(
      () => {
        if (live.current && getSessionStore().view === "bots" && getBotsPage().page === "hire") showBotsTeam(true);
        else if (live.current) setBusy(false);
      },
      (cause) => {
        if (!live.current) return;
        setError(errorMessage(cause));
        setBusy(false);
      },
    );
  };

  return (
    <form
      className="flex w-full min-w-0 shrink-0 flex-col gap-3 @3xl/hire:w-[360px]"
      onSubmit={(event) => {
        event.preventDefault();
        hire();
      }}
      data-testid="bots-hire-form"
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] text-foreground">Name</span>
        <input
          ref={input}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="What you'll call it"
          spellCheck={false}
          autoComplete="off"
          className="h-9 rounded-lg border border-hairline bg-input px-3 text-[13.5px] outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/40"
          data-testid="bots-hire-name"
        />
        <span className="break-words text-[12px] text-faint">The name is the only thing to fill in. You can change the rest once it is hired.</span>
      </label>
      {error && <MachineHostError error={error} onRestarted={() => setError(null)} onFailed={setError} className="rounded-md bg-destructive/10 px-3 py-2" />}
      <div>
        <Button type="submit" variant="accent" size="sm" className="max-w-full" disabled={!trimmed || busy} data-testid="bots-hire-submit">
          {busy ? <Loader2 className="animate-spin" /> : <Check />} <span className="min-w-0 truncate">{trimmed ? `Hire ${trimmed}` : "Hire"}</span>
        </Button>
      </div>
      <div className="rounded-lg border border-hairline bg-card" data-testid="bots-hire-defaults">
        <div className="flex items-center gap-2 px-3 py-2">
          <p className="flex-1 text-[11px] font-medium uppercase tracking-[.08em] text-faint">Starts with your defaults</p>
          <button type="button" onClick={() => setMore((value) => !value)} aria-expanded={more} className="inline-flex items-center gap-1 rounded-sm text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40">
            More options <ChevronDown className={cn("size-3 transition-transform", more && "rotate-180")} />
          </button>
        </div>
        <dl className="divide-y divide-hairline border-t border-hairline px-3">
          <Default icon={<Cpu />} label="Agent and model" value={`${agent} · its default model`} />
          <Default icon={<Laptop />} label="Runs on" value={ThisComputer} />
          <Default icon={<Shield />} label="Access" value={accessLabel("full")} />
          <Default icon={<Users />} label="Reports to" value="You" />
          {/* What the store gives every new bot (src-tauri bots `create`): it works for you alone. */}
          <Default icon={<Waypoints />} label="Works in" value={worksInLabel(["personal"])} />
        </dl>
        {more && <p className="border-t border-hairline px-3 py-2 text-[12px] text-faint">Each of these can be changed on the bot once it is hired. Hiring asks for nothing more than a role and a name.</p>}
      </div>
    </form>
  );
}

function Default({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 py-2 text-[12.5px]">
      <span className="shrink-0 text-faint [&_svg]:size-3.5">{icon}</span>
      <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-foreground">{value}</dd>
    </div>
  );
}
