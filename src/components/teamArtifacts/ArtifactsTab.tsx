import { useMemo, useState } from "react";
import { AtSign, Copy, Ellipsis, Eye, LayoutTemplate, Search, Trash2, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { WithTooltip } from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { openAgents } from "@/lib/sessions";
import { insertTemplateSlug, openTeamArtifact, useTeamArtifacts, type TeamArtifact } from "@/lib/teamArtifacts";
import { ArtifactIcon, DeleteArtifactConfirm, useTeamOrg } from "./shared";

const TEMPLATE_COMMAND = "terminalx artifact publish plan.html \\\n  --template migration-plan";

function EmptyMark() {
  return (
    <span aria-hidden className="grid size-11 place-items-center rounded-xl border border-hairline bg-veil-raised text-muted-foreground">
      <LayoutTemplate className="size-5" />
    </span>
  );
}

/** "A, B and C". */
function listed(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function matchTemplates(templates: TeamArtifact[], query: string): TeamArtifact[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return templates.filter((template) => {
    const text = `${template.title} ${template.slug} ${template.description ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word.replace(/^@/, "")));
  });
}

/**
 * Team templates (06.04): the organization's templates, searched, and one
 * picked inserts its @slug in the composer; the agent fills it in and
 * publishes it. Each row's menu previews it, copies its @slug, or deletes it
 * for those who may (06.15).
 */
export function TemplatePicker({ orgId, tabId }: { orgId: string; tabId: string | null }) {
  const org = useTeamOrg(orgId);
  const { artifacts, error } = useTeamArtifacts(orgId);
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<TeamArtifact | null>(null);
  const templates = useMemo(() => (artifacts ?? []).filter((item) => item.template), [artifacts]);
  const matches = matchTemplates(templates, query);
  const insert = (template: TeamArtifact) => { if (tabId) insertTemplateSlug(tabId, template.slug); };
  const preview = (template: TeamArtifact) => {
    openTeamArtifact({ orgId, id: template.id, version: null });
    openAgents();
  };
  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-popover text-left shadow-lg" data-testid="team-template-picker">
      <label className="flex items-center gap-2 border-b border-hairline px-3 py-2">
        <Search aria-hidden className="size-3.5 text-faint" />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search templates…" aria-label="Search templates" spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint" />
      </label>
      <div className="px-3 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-faint">Team templates · {org.name}</div>
      {artifacts === null ? (
        <p className="px-3 py-4 text-[12px] text-faint">{error ? "Team templates could not be reached." : "Loading…"}</p>
      ) : !templates.length ? (
        <div className="flex flex-col items-center gap-2 px-4 pt-3 pb-4 text-center" data-testid="team-templates-none">
          <EmptyMark />
          <p className="text-[13px] font-medium text-foreground">No team templates yet</p>
          <p className="text-[12px] leading-5 text-muted-foreground">Publish any artifact as a template and everyone in {org.name} can start from it.</p>
          <div className="relative mt-1 w-full rounded-lg border border-hairline px-3 py-2 text-left">
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-5 text-muted-foreground">{TEMPLATE_COMMAND}</pre>
            <WithTooltip label="Copy">
              <Button variant="ghost" size="icon-xs" aria-label="Copy command" className="absolute top-1.5 right-1.5" onClick={() => void copyText(TEMPLATE_COMMAND.replace("\\\n  ", ""))}><Copy /></Button>
            </WithTooltip>
          </div>
        </div>
      ) : !matches.length ? (
        <div className="flex flex-col items-center gap-2 px-4 pt-3 pb-4 text-center" data-testid="team-templates-no-match">
          <p className="text-[13px] text-foreground">No templates match “{query.trim()}”</p>
          <p className="text-[12px] leading-5 text-muted-foreground">
            {org.name} has {templates.length} template{templates.length === 1 ? "" : "s"}: {listed(templates.slice(0, 5).map((template) => template.title))}{templates.length > 5 ? " and more" : ""}.
          </p>
          <Button variant="secondary" size="sm" onClick={() => setQuery("")}><X />Clear search</Button>
        </div>
      ) : (
        <ul className="max-h-72 overflow-y-auto scrollbar-thin px-1.5 pb-1.5">
          {matches.map((template) => (
            <li key={template.id} className="group relative" data-testid="team-template">
              <button type="button" disabled={!tabId} onClick={() => insert(template)}
                className="flex w-full items-start gap-3 rounded-lg px-2 py-2 pr-9 text-left hover:bg-veil-strong disabled:opacity-60">
                <ArtifactIcon artifact={{ ...template, template: false }} className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-[13px] text-foreground">{template.title}</span>
                    <span className="shrink-0 font-mono text-[11px] text-destructive/80">@{template.slug}</span>
                  </span>
                  {template.description && <span className="block truncate text-[11.5px] text-faint">{template.description}</span>}
                </span>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" aria-label={`${template.title} actions`}
                    className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"><Ellipsis /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem disabled={!tabId} onSelect={() => insert(template)}><AtSign />Insert @{template.slug}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => preview(template)}><Eye />Preview</DropdownMenuItem>
                  {template.canDelete && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive" onSelect={() => setDeleting(template)}><Trash2 />Delete template…</DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-hairline px-3 py-2.5 text-[11.5px] leading-[18px] text-faint">
        {templates.length ? "Inserts the @slug in the composer. The agent fills the template in and publishes it." : "Templates are shared with your organization. Anyone can use them; their author and admins can delete them."}
      </p>
      {deleting && <DeleteArtifactConfirm orgId={orgId} artifact={deleting} onCancel={() => setDeleting(null)} onDeleted={() => setDeleting(null)} />}
    </div>
  );
}

/** A session's Artifacts tab (06.04), with nothing of its own published yet: start from a team template. */
export function ArtifactsTab({ orgId, tabId }: { orgId: string; tabId: string | null }) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="flex h-full flex-col items-center overflow-y-auto scrollbar-thin px-6 pt-10 pb-6 text-center" data-testid="panel-artifacts">
      <EmptyMark />
      <p className="mt-3 text-[13px] font-medium text-foreground">Nothing published yet</p>
      <p className="mt-1 max-w-[19rem] text-[12px] leading-5 text-muted-foreground">Pages an agent publishes for the team appear on the overview.</p>
      <pre className="mt-3 rounded-lg border border-hairline px-3 py-2 text-left font-mono text-[11px] leading-5 text-muted-foreground">{"terminalx artifact publish plan.html \\\n  --title \"Seat migration plan\""}</pre>
      <Button variant="secondary" size="sm" className={cn("mt-4", picking && "ring-2 ring-ring/40")} aria-expanded={picking} onClick={() => setPicking((open) => !open)}>
        <LayoutTemplate />Start from a template
      </Button>
      {picking && <div className="mt-3 w-full max-w-[22rem]"><TemplatePicker orgId={orgId} tabId={tabId} /></div>}
    </div>
  );
}
