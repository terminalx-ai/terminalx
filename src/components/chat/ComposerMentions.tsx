import { AtSign, Share2, X } from "@/icons";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { externalImage } from "@/components/ui/privacy-image";
import type { MentionPerson } from "@/lib/mentions";
import type { Participant } from "@terminalx/portable/workspaceCollab";

/** Role words as the workspace's people list says them. */
const ROLE_WORD: Record<string, string> = { manager: "Admin", driver: "Driver", viewer: "Viewer" };

/**
 * The second line of a person's row in the `@` menu (design 13.02): their
 * email, then, while they are in the workspace, their role and where.
 */
export function personDetail(person: MentionPerson, here: Pick<Participant, "role" | "tabId" | "activity"> | undefined, tabId: string): string {
  const parts = [person.email];
  if (here) {
    parts.push(ROLE_WORD[here.role] ?? here.role);
    parts.push(here.activity === "typing" ? "typing" : here.tabId === tabId ? "in this tab" : "here");
  }
  return parts.filter(Boolean).join(" · ");
}

/** A person's face; no outside photo while data privacy is on. */
export function PersonAvatar({ person, online, className }: { person: MentionPerson; online?: boolean; className?: string }) {
  const privacy = useDataPrivacy().enabled;
  const photo = person.photoUrl && !(privacy && externalImage(person.photoUrl)) ? person.photoUrl : null;
  return <Avatar name={person.name} photoUrl={photo} presence={online ? "online" : undefined} decorative className={className} />;
}

/** `@Name` as a chip, in the composer and in the transcript (design 13.03). The text under it stays `@Name`. */
export function MentionChip({ person, className }: { person: MentionPerson; className?: string }) {
  return (
    <span
      className={cn("mx-0.5 inline-flex h-[22px] items-center gap-1 rounded-md bg-mention/15 pl-[3px] pr-1.5 align-[1px] text-[12.5px] font-medium text-mention", className)}
      data-testid="mention-chip"
      data-user-id={person.userId}
    >
      <PersonAvatar person={person} className="size-4 select-none text-[8px]" />
      {/* Copying the message gives back what was typed. */}
      <span aria-hidden className="sr-only">@</span>
      {person.name}
    </span>
  );
}

/** Who the draft mentions, above the text, each with its remove button. */
export function MentionChips({ people, onRemove }: { people: readonly MentionPerson[]; onRemove: (person: MentionPerson) => void }) {
  if (!people.length) return null;
  return (
    <div className="mb-1 flex flex-wrap items-center gap-1 px-1" aria-label="Mentioned people" data-testid="composer-mentions">
      {people.map((person) => (
        <span key={person.userId} className="inline-flex items-center">
          <MentionChip person={person} className="mx-0 rounded-r-none pr-1" />
          <button
            type="button"
            aria-label={`Remove mention of ${person.name}`}
            onClick={() => onRemove(person)}
            className="flex h-[22px] items-center rounded-r-md bg-mention/15 pr-1 text-mention/80 hover:text-mention focus-visible:outline-2 focus-visible:outline-mention"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

export type MentionRefused = { kind: "no-access"; message: string } | { kind: "unchecked" };

/**
 * Nothing was sent and nobody was told (design 14.07): someone mentioned
 * cannot watch the workspace. Share opens the workspace's Share dialog.
 */
export function MentionRefusal({ refused, onShare, onDismiss }: { refused: MentionRefused; onShare: () => void; onDismiss: () => void }) {
  const message = refused.kind === "no-access"
    ? refused.message
    : "Couldn't check who can follow this workspace, so nothing was sent. Try again, or remove the mention.";
  return (
    <div role="alert" className="mb-2 flex items-center gap-2.5 rounded-lg border border-mention/40 bg-mention/5 px-3 py-2 text-[12.5px] text-foreground" data-testid="mention-refused">
      <AtSign aria-hidden className="size-3.5 shrink-0 text-mention" />
      <span className="min-w-0 flex-1">{message}</span>
      {refused.kind === "no-access" && (
        <Button variant="outline" size="sm" className="h-6 shrink-0 gap-1 px-2 text-[12px]" onClick={onShare} data-testid="mention-refused-share">
          <Share2 className="size-3" />
          Share
        </Button>
      )}
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className="shrink-0 rounded text-muted-foreground hover:text-foreground focus-visible:outline-2">
        <X className="size-3.5" />
      </button>
    </div>
  );
}
