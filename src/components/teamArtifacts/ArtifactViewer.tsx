import { useEffect, useState } from "react";
import { AtSign, ChevronDown, ChevronRight, Ellipsis, Eye, History, Trash2, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { Markdown } from "@/components/chat/Markdown";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import {
  formatSize,
  kindLabel,
  openTeamArtifact,
  teamArtifactsApi,
  type OpenArtifact,
  type TeamArtifactContent,
  type TeamArtifactDetail,
} from "@/lib/teamArtifacts";
import { ArtifactIcon, DeleteArtifactConfirm, errorWords, Face, usePeopleNames, useTeamOrg } from "./shared";
import { publishedAgo } from "./TeamPanel";

/** The artifact and its versions, read again whenever another one is opened, or `revision` changes. */
function useDetail(open: OpenArtifact, revision = 0) {
  const [detail, setDetail] = useState<{ key: string; value: TeamArtifactDetail | null; error: string | null }>({ key: "", value: null, error: null });
  const key = `${open.orgId}:${open.id}:${revision}`;
  useEffect(() => {
    let current = true;
    teamArtifactsApi.get(open.orgId, open.id)
      .then((value) => { if (current) setDetail({ key, value, error: null }); })
      .catch((error: unknown) => { if (current) setDetail({ key, value: null, error: errorWords(error) }); });
    return () => { current = false; };
  }, [open.orgId, open.id, key]);
  return detail.key === key ? detail : { key, value: null, error: null };
}

function useContent(orgId: string, id: string, version: number | null) {
  const [content, setContent] = useState<{ key: string; value: TeamArtifactContent | null; error: string | null }>({ key: "", value: null, error: null });
  const key = `${orgId}:${id}:${version}`;
  useEffect(() => {
    if (version === null) return;
    let current = true;
    teamArtifactsApi.content(orgId, id, version)
      .then((value) => { if (current) setContent({ key, value, error: null }); })
      .catch((error: unknown) => { if (current) setContent({ key, value: null, error: errorWords(error) }); });
    return () => { current = false; };
  }, [orgId, id, version, key]);
  return content.key === key ? content : { key, value: null, error: null };
}

/**
 * What a published page may do inside the viewer: draw itself with its own
 * styles and inline images, and nothing else. No script, no network, no
 * form, no frame, no navigation.
 */
export const ARTIFACT_PAGE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";

/** The page with the policy put first, so nothing in it loads before the policy holds. */
export function sandboxedDocument(html: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_PAGE_POLICY}"><meta name="referrer" content="no-referrer">${html}`;
}

/**
 * The page itself. HTML (and SVG inside it) runs in an iframe whose empty
 * `sandbox` gives it an opaque origin: no scripts run, it cannot reach this
 * window, its storage or the app's commands, submit forms, open windows or
 * navigate the app. The policy above also stops it loading anything.
 */
function ArtifactBody({ content }: { content: TeamArtifactContent }) {
  if (content.contentType === "text/html") {
    return <iframe title="Artifact" sandbox="" referrerPolicy="no-referrer" srcDoc={sandboxedDocument(content.content)} className="h-full w-full border-0 bg-white" data-testid="team-artifact-html" />;
  }
  if (content.contentType === "text/markdown") {
    return (
      <div className="h-full overflow-y-auto scrollbar-thin px-12 py-10">
        <Markdown text={content.content} className="mx-auto max-w-[680px] text-[14px]" remoteImages={false} webLinksOnly rawHtml={false} />
      </div>
    );
  }
  return <pre className="h-full overflow-auto whitespace-pre-wrap px-12 py-10 font-mono text-[12.5px] text-foreground">{content.content}</pre>;
}

/**
 * A team artifact opened from the overview (13.32): what it is, who published
 * which version from where, the page, and its history beside it (13.33).
 */
export function ArtifactViewer({ open, history, onHistory }: { open: OpenArtifact; history: boolean; onHistory: (shown: boolean) => void }) {
  const detail = useDetail(open);
  const artifact = detail.value?.artifact ?? null;
  const versions = detail.value?.versions ?? [];
  const shownVersion = open.version ?? artifact?.version ?? null;
  const content = useContent(open.orgId, open.id, shownVersion);
  const nameOf = usePeopleNames(open.orgId);
  const shown = versions.find((version) => version.version === shownVersion);
  const old = artifact && shownVersion !== null && shownVersion !== artifact.version;
  const [deleting, setDeleting] = useState(false);
  const back = () => openTeamArtifact(null);
  const choose = (version: number) => openTeamArtifact({ ...open, version: version === artifact?.version ? null : version });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="team-artifact-viewer">
      <header className="flex min-h-[52px] shrink-0 items-center gap-2 border-b border-hairline px-4 text-[13px]">
        <button type="button" onClick={back} className="shrink-0 text-muted-foreground hover:text-foreground">Team artifacts</button>
        <ChevronRight aria-hidden className="size-3.5 shrink-0 text-faint" />
        {artifact && <ArtifactIcon artifact={artifact} className="text-destructive/80" />}
        <span className="min-w-0 truncate font-medium text-foreground">{artifact?.title ?? (detail.error ? "Unavailable" : "Loading…")}</span>
        {artifact && versions.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="Version" className="flex h-6 shrink-0 items-center gap-1 rounded-md bg-veil-strong px-1.5 text-[12px] text-foreground">
                v{shownVersion}<ChevronDown className="size-3 text-faint" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {versions.map((version) => (
                <DropdownMenuItem key={version.version} onSelect={() => choose(version.version)}>
                  <span className="w-6 text-faint">v{version.version}</span>
                  <span className="min-w-0 truncate">{version.note ?? publishedAgo(version.createdAt)}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {shown && (
          <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground" data-testid="team-artifact-byline">
            <Face name={nameOf(shown.author)} />
            <span className="min-w-0 truncate">{[nameOf(shown.author), shown.source && `from ${shown.source}`, publishedAgo(shown.createdAt)].filter(Boolean).join(" · ")}</span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <Button variant={history ? "secondary" : "ghost"} size="sm" aria-pressed={history} onClick={() => onHistory(!history)} disabled={!artifact}>
            <History />History
          </Button>
          {artifact && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More"><Ellipsis /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={() => void copyText(`@${artifact.slug}`)}><AtSign />Copy @{artifact.slug}</DropdownMenuItem>
                {artifact.canDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive" onSelect={() => setDeleting(true)}><Trash2 />Delete artifact…</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      </header>
      {old && artifact && shown && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-veil-raised px-4 py-2 text-[12.5px]" role="status" data-testid="team-artifact-old-version">
          <History aria-hidden className="size-3.5 text-faint" />
          <span className="text-foreground">You're viewing v{shown.version} from {publishedAgo(shown.createdAt)}.</span>
          <span className="text-muted-foreground">v{artifact.version} is the current version.</span>
          <Button size="sm" className="ml-auto" onClick={() => choose(artifact.version)}>Back to v{artifact.version}</Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {content.value ? <ArtifactBody content={content.value} /> : (
          <p className="px-12 py-10 text-[13px] text-faint">{detail.error ?? content.error ?? "Loading…"}</p>
        )}
      </div>
      {deleting && artifact && (
        <DeleteArtifactConfirm orgId={open.orgId} artifact={artifact} versions={versions.length} onCancel={() => setDeleting(false)} onDeleted={() => { setDeleting(false); back(); }} />
      )}
    </div>
  );
}

/** The History panel (13.33): every version, what the artifact is, and Delete for those who may. */
export function ArtifactHistory({ open, onClose }: { open: OpenArtifact; onClose: () => void }) {
  const [revision, setRevision] = useState(0);
  const [pruneError, setPruneError] = useState<string | null>(null);
  const detail = useDetail(open, revision);
  const org = useTeamOrg(open.orgId);
  const nameOf = usePeopleNames(open.orgId);
  const [deleting, setDeleting] = useState(false);
  const artifact = detail.value?.artifact ?? null;
  const versions = detail.value?.versions ?? [];
  const shownVersion = open.version ?? artifact?.version ?? null;
  const first = versions.at(-1);
  const prune = (version: number) => {
    setPruneError(null);
    teamArtifactsApi.removeVersion(open.orgId, open.id, version)
      .then(() => {
        if (open.version === version) openTeamArtifact({ ...open, version: null });
        setRevision((n) => n + 1);
      })
      .catch((error: unknown) => setPruneError(errorWords(error)));
  };
  const row = "flex items-center justify-between gap-3 py-1.5 text-[12.5px]";
  return (
    <aside className="flex h-full w-[368px] shrink-0 flex-col border-l border-hairline" aria-label="History" data-testid="team-artifact-history">
      <header className="flex min-h-[52px] shrink-0 items-center gap-2 border-b border-hairline px-4">
        <span className="text-[13px] font-medium text-foreground">History</span>
        <span className="min-w-0 truncate text-[13px] text-muted-foreground">{artifact?.title}</span>
        <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="Close history" onClick={onClose}><X /></Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-3 py-4">
        <div className="flex items-center px-1 pb-2 text-[11px] font-medium uppercase tracking-wider text-faint">
          <span>Versions</span><span className="ml-auto tabular-nums">{versions.length}</span>
        </div>
        <div className="overflow-hidden rounded-lg border border-hairline">
          {versions.map((version) => (
            <div key={version.version} className="group relative border-b border-hairline last:border-b-0">
              <button type="button" data-testid="team-artifact-version"
                aria-current={version.version === shownVersion || undefined}
                onClick={() => openTeamArtifact({ ...open, version: version.version === artifact?.version ? null : version.version })}
                className={cn("flex w-full items-start gap-3 px-3 py-2.5 pr-14 text-left hover:bg-veil-raised", version.version === shownVersion && "bg-veil-strong")}>
                <span className="w-6 shrink-0 pt-px text-[12.5px] text-faint tabular-nums">v{version.version}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 truncate text-[13px] text-foreground">{version.note ?? `Version ${version.version}`}</span>
                    {version.version === artifact?.version && <span className="shrink-0 rounded bg-add/15 px-1.5 text-[10.5px] text-add">Current</span>}
                  </span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-faint">
                    <Face name={nameOf(version.author)} size={14} />
                    <span className="truncate">{[nameOf(version.author), version.source && `from ${version.source}`, publishedAgo(version.createdAt)].filter(Boolean).join(" · ")}</span>
                  </span>
                </span>
              </button>
              <span className="pointer-events-none absolute top-2.5 right-3 flex items-center gap-1.5">
                <Eye aria-hidden className={cn("size-3.5 text-faint opacity-0 group-hover:opacity-100", version.version === shownVersion && "opacity-100")} />
                {artifact?.canDelete && version.version !== artifact.version && (
                  <button type="button" aria-label={`Delete v${version.version}`} data-testid="team-artifact-prune" onClick={() => prune(version.version)}
                    className="pointer-events-auto text-faint opacity-0 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100">
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
        {pruneError && <p role="alert" className="px-1 pt-2 text-[11.5px] text-destructive">{pruneError}</p>}
        {artifact && (
          <>
            <h2 className="mt-6 px-1 pb-1 text-[11px] font-medium uppercase tracking-wider text-faint">Artifact</h2>
            <dl className="px-1">
              <div className={row}><dt className="text-muted-foreground">Author</dt><dd className="flex min-w-0 items-center gap-1.5 text-foreground"><Face name={nameOf(artifact.author)} size={14} /><span className="truncate">{nameOf(artifact.author)}</span></dd></div>
              {first?.source && <div className={row}><dt className="text-muted-foreground">Published from</dt><dd className="min-w-0 truncate text-foreground">{first.source}</dd></div>}
              <div className={row}><dt className="text-muted-foreground">Who can see it</dt><dd className="min-w-0 truncate text-foreground">Everyone at {org.name}</dd></div>
              <div className={row}><dt className="text-muted-foreground">Size</dt><dd className="text-foreground">{formatSize(artifact.sizeBytes)} · {kindLabel(artifact.contentType)}</dd></div>
              {artifact.template && <div className={row}><dt className="text-muted-foreground">Template</dt><dd className="font-mono text-foreground">@{artifact.slug}</dd></div>}
            </dl>
            {artifact.canDelete && (
              <div className="mt-5 rounded-lg border border-hairline px-3 py-3">
                <button type="button" className="flex items-center gap-2 text-[13px] text-destructive hover:underline" onClick={() => setDeleting(true)}>
                  <Trash2 className="size-3.5" />Delete artifact…
                </button>
                <p className="mt-1.5 text-[11.5px] leading-[18px] text-faint">
                  Removes {versions.length === 1 ? "it" : `all ${versions.length} versions`} for everyone at {org.name}. The author and admins can delete; you're {org.admin ? "an admin" : "the author"}.
                </p>
              </div>
            )}
          </>
        )}
      </div>
      {deleting && artifact && (
        <DeleteArtifactConfirm orgId={open.orgId} artifact={artifact} versions={versions.length} onCancel={() => setDeleting(false)} onDeleted={() => { setDeleting(false); onClose(); openTeamArtifact(null); }} />
      )}
    </aside>
  );
}
