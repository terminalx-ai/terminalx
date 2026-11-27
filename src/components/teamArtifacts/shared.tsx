import { useState } from "react";
import { File, FileCode, FileText, LayoutTemplate } from "@/icons";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { PersonFace } from "@/components/dashboard/OverviewToolbar";
import { useAccount } from "@/lib/account";
import { useOrganizationRoster } from "@/lib/organizationRoster";
import { cn } from "@/lib/cn";
import {
  contentTypeForName,
  noteTeamArtifact,
  SLUG_PATTERN,
  slugify,
  teamArtifactsApi,
  type TeamArtifact,
  type TeamArtifactPerson,
} from "@/lib/teamArtifacts";

export function ArtifactIcon({ artifact, className }: { artifact: Pick<TeamArtifact, "template" | "contentType">; className?: string }) {
  const Icon = artifact.template ? LayoutTemplate : artifact.contentType === "text/html" ? FileCode : artifact.contentType === "text/markdown" ? FileText : File;
  return <Icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
}

/** The organization's name and the viewer's place in it. */
export function useTeamOrg(orgId: string | null) {
  const { status } = useAccount();
  const org = status.state === "signed-in" ? status.organizations?.find((item) => item.id === orgId) : undefined;
  return { name: org?.name ?? "your organization", admin: org?.role === "owner" || org?.role === "admin" };
}

/** A person's name: the roster's, the server's, or a placeholder for someone who left. */
export function usePeopleNames(orgId: string | null) {
  const roster = useOrganizationRoster(orgId, !!orgId);
  const members = roster.roster?.members ?? [];
  return (person: TeamArtifactPerson | null) => {
    if (!person) return "Former member";
    const member = members.find((item) => item.userId === person.id);
    return member?.displayName || person.name || member?.email.split("@")[0] || "Teammate";
  };
}

export function Face({ name, size = 16 }: { name: string; size?: number }) {
  return <PersonFace name={name} size={size} />;
}

export function errorWords(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  switch (code) {
    case "team_artifact_too_large":
      return "It is larger than 1 MB, the most one artifact may hold.";
    case "team_artifact_limit_reached":
      return "This organization has reached its limit of artifacts or versions.";
    case "team_artifact_delete_forbidden":
      return "Only its author and admins can delete it.";
    case "team_artifact_publish_forbidden":
      return "Only its author and admins can publish a new version of it.";
    case "team_artifact_storage_full":
      return "This organization's artifacts are full. Delete old versions or artifacts first.";
    case "team_artifact_version_current":
      return "The current version cannot be deleted.";
    case "team_artifact_not_found":
      return "It was deleted.";
    default:
      return "It could not be reached. Try again.";
  }
}

/** Delete an artifact or template, after the person confirms (06.15). */
export function DeleteArtifactConfirm({ orgId, artifact, versions, onCancel, onDeleted }: {
  orgId: string;
  artifact: TeamArtifact;
  versions?: number;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const org = useTeamOrg(orgId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = versions ?? artifact.version;
  return (
    <ConfirmDialog
      open
      destructive
      busy={busy}
      error={error}
      title={artifact.template ? `Delete template ${artifact.title}?` : `Delete ${artifact.title}?`}
      action={artifact.template ? "Delete template" : "Delete artifact"}
      onCancel={onCancel}
      onAction={() => {
        setBusy(true);
        setError(null);
        teamArtifactsApi.remove(orgId, artifact.id)
          .then(() => {
            noteTeamArtifact(orgId, { removed: artifact.id });
            onDeleted();
          })
          .catch((reason: unknown) => setError(errorWords(reason)))
          .finally(() => setBusy(false));
      }}
    >
      {artifact.template
        ? `This permanently deletes @${artifact.slug} for everyone in ${org.name}. Artifacts made from it keep their content.`
        : `This permanently deletes ${count === 1 ? "it" : `all ${count} versions`} for everyone at ${org.name}.`}
    </ConfirmDialog>
  );
}

/** Publish… (13.17): a file from this Mac, as an artifact or a template. */
export function PublishDialog({ orgId, onClose, onPublished }: { orgId: string; onClose: () => void; onPublished: (artifact: TeamArtifact) => void }) {
  const org = useTeamOrg(orgId);
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState(false);
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const type = file ? contentTypeForName(file.name) : null;
  const slugValue = slug || slugify(title);
  const ready = !!file && !!type && !!title.trim() && (!template || SLUG_PATTERN.test(slugValue));

  const pick = () => {
    setError(null);
    teamArtifactsApi.pickFile()
      .then((picked) => {
        if (!picked) return;
        if (!picked.content || picked.refused) {
          setError(picked.refused === "too_large" ? "That file is larger than 1 MB." : picked.refused === "not_text" ? "That file is not text." : "That file could not be read.");
          return;
        }
        if (!contentTypeForName(picked.name)) {
          setError("Pick a Markdown, HTML or text file.");
          return;
        }
        setFile({ name: picked.name, content: picked.content });
        if (!title) setTitle(picked.name.replace(/\.[^.]+$/, ""));
      })
      .catch(() => setError("The file could not be read."));
  };

  const publish = () => {
    if (!file || !type) return;
    setBusy(true);
    setError(null);
    teamArtifactsApi.publish(orgId, {
      title: title.trim(),
      contentType: type,
      content: file.content,
      ...(template ? { template: true, slug: slugValue } : {}),
    })
      .then(({ artifact }) => {
        noteTeamArtifact(orgId, { saved: artifact });
        onPublished(artifact);
      })
      .catch((reason: unknown) => setError(errorWords(reason)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent width="max-w-[24rem]" data-testid="team-artifact-publish">
        <DialogTitle className="text-[15px] font-semibold">Publish to {org.name}</DialogTitle>
        <DialogDescription className="text-[12.5px] text-muted-foreground">Everyone at {org.name} can open it from the overview.</DialogDescription>
        <div className="mt-3 flex flex-col gap-3 text-[12.5px]">
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={pick} disabled={busy}>Choose file…</Button>
            <span className="min-w-0 truncate text-muted-foreground" data-testid="team-artifact-publish-file">{file?.name ?? "Markdown, HTML or text, up to 1 MB"}</span>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Title</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} spellCheck={false}
              className="h-8 rounded-md border border-hairline bg-transparent px-2 outline-none focus:border-ring" />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={template} onChange={(event) => setTemplate(event.target.checked)} />
            <span>Template for new sessions</span>
          </label>
          {template && (
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Inserted as</span>
              <span className="flex h-8 items-center rounded-md border border-hairline px-2 font-mono focus-within:border-ring">
                <span className="text-faint">@</span>
                <input value={slug} placeholder={slugify(title)} onChange={(event) => setSlug(event.target.value.toLowerCase())} maxLength={64} spellCheck={false}
                  aria-label="Template slug" className="min-w-0 flex-1 bg-transparent outline-none" />
              </span>
            </label>
          )}
          {error && <p role="alert" className="text-destructive">{error}</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={publish} disabled={!ready || busy}>{busy ? "Publishing…" : "Publish"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
