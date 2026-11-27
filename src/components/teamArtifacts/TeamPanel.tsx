import { useState } from "react";
import { PanelRight } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/time";
import { openTeamArtifact, slugify, useTeamArtifacts, type TeamArtifact } from "@/lib/teamArtifacts";
import { ArtifactIcon, Face, PublishDialog, usePeopleNames, useTeamOrg } from "./shared";

const section = "px-1 pb-2 text-[11px] font-medium uppercase tracking-wider text-faint";
const card = "overflow-hidden rounded-lg border border-hairline";

/** "2h ago", "yesterday", "4 days ago", then a date: the panel's own wording (13.17). */
export function publishedAgo(iso: string, now = Date.now()): string {
  const label = relativeTime(iso, now);
  if (label === "now") return "just now";
  const match = /^(\d+)([mhd])$/.exec(label);
  if (!match) return label;
  const n = Number(match[1]);
  if (match[2] === "d") return n === 1 ? "yesterday" : `${n} days ago`;
  return `${label} ago`;
}

function ArtifactRow({ artifact, name, selected, onOpen }: { artifact: TeamArtifact; name: string; selected: boolean; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} aria-current={selected || undefined} data-testid="team-artifact-row"
      className={cn("flex w-full items-center gap-3 border-b border-hairline px-3 py-2 text-left last:border-b-0 hover:bg-veil-raised", selected && "bg-veil-strong")}>
      <ArtifactIcon artifact={artifact} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-foreground">{artifact.title}</span>
        <span className="block truncate text-[11.5px] text-faint">{artifact.source ? `from ${artifact.source}` : "team artifact"}</span>
      </span>
      <span title={name}><Face name={name} /></span>
      <span className="w-[68px] shrink-0 text-right text-[11.5px] text-faint tabular-nums">{publishedAgo(artifact.updatedAt)}</span>
    </button>
  );
}

/**
 * The overview's Team panel (13.17): the organization's artifacts newest
 * first, its templates, and how to publish from the command line.
 */
export function TeamPanel({ orgId, selectedId, onCollapse }: { orgId: string; selectedId: string | null; onCollapse: () => void }) {
  const org = useTeamOrg(orgId);
  const nameOf = usePeopleNames(orgId);
  const { artifacts, error, loading } = useTeamArtifacts(orgId);
  const [publishing, setPublishing] = useState(false);
  const all = (artifacts ?? []).filter((item) => !item.template);
  const templates = (artifacts ?? []).filter((item) => item.template);
  const open = (artifact: TeamArtifact) => openTeamArtifact({ orgId, id: artifact.id, version: null });
  return (
    <aside className="flex h-full w-[368px] shrink-0 flex-col border-l border-hairline" aria-label="Team" data-testid="team-panel">
      <header className="flex min-h-[52px] shrink-0 items-center gap-2 border-b border-hairline px-4">
        <span className="text-[13px] font-medium text-foreground">Team</span>
        <span className="min-w-0 truncate text-[13px] text-muted-foreground">{org.name}</span>
        <WithTooltip label="Hide panel">
          <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="Hide team panel" onClick={onCollapse}><PanelRight /></Button>
        </WithTooltip>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-3 py-4">
        <div className="flex items-center">
          <h2 className={section}>Team artifacts</h2>
          <button type="button" className="ml-auto pb-2 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setPublishing(true)}>Publish…</button>
        </div>
        {all.length ? (
          <div className={card} data-testid="team-artifacts-list">
            {all.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact} name={nameOf(artifact.updatedBy ?? artifact.author)} selected={artifact.id === selectedId} onOpen={() => open(artifact)} />)}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-hairline px-3 py-3 text-[12px] text-faint" data-testid="team-artifacts-empty">
            {artifacts === null && loading ? "Loading…" : artifacts === null && error ? "Team artifacts could not be reached." : "Nothing published yet."}
          </p>
        )}
        {artifacts !== null && error && <p className="px-1 pt-1.5 text-[11px] text-faint" role="status">Could not refresh. Showing what was there.</p>}

        {templates.length > 0 && (
          <>
            <h2 className={cn(section, "mt-6")}>Templates for new sessions</h2>
            <div className={card} data-testid="team-templates-list">
              {templates.map((template) => (
                <button key={template.id} type="button" onClick={() => open(template)} data-testid="team-template-row"
                  className={cn("flex w-full items-center gap-3 border-b border-hairline px-3 py-2.5 text-left last:border-b-0 hover:bg-veil-raised", template.id === selectedId && "bg-veil-strong")}>
                  <ArtifactIcon artifact={template} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{template.title}</span>
                  <span className="shrink-0 font-mono text-[11px] text-faint">@{template.slug}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <p className="mt-4 px-1 font-mono text-[11px] leading-5 text-faint" data-testid="team-artifacts-cli">
          $ terminalx artifact publish standup.md --org {slugify(org.name)}
        </p>
      </div>
      {publishing && <PublishDialog orgId={orgId} onClose={() => setPublishing(false)} onPublished={(artifact) => { setPublishing(false); open(artifact); }} />}
    </aside>
  );
}
