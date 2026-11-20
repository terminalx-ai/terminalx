import { Fragment } from "react";
import { FileChip } from "./FileChip";
import { AttachmentPreview } from "./AttachmentPreview";
import { openImageViewer } from "@/lib/imageViewer";
import { summaryParts, type Refusal } from "@/lib/attachmentRules";
import { cn } from "@/lib/cn";
import type { Attachments } from "./useImageAttachments";

/** What a refused chip says after its name. */
const REFUSED_LABEL: Record<Refusal, string> = { reserved: "reserved name", "too-large": "too large" };

const PART_TONE = { attached: undefined, refused: "text-destructive", notAdded: "text-warning" } as const;

/**
 * The files on the draft (PRO-290, screen 03.23): a line counting them,
 * "10 attached · 1 refused · 4 not added", then each one with its preview,
 * wrapping (PRO-461): an image as its thumbnail, which opens the image
 * viewer on the draft's images, and any other file as a card with its type,
 * size and, for text, its first lines. A refused file is a red chip with its
 * reason, and is never sent; every one has its remove control.
 */
export function AttachmentChips({ attach, className }: { attach: Attachments; className?: string }) {
  const { attachments, notAdded } = attach;
  if (!attachments.length && !notAdded) return null;
  const refused = attachments.filter((a) => a.refused).length;
  const shown = attachments.filter((a) => !a.refused && a.previewUrl);
  const view = (id: string) => openImageViewer(shown.map((a) => ({ src: a.previewUrl!, name: a.name })), shown.findIndex((a) => a.id === id));
  const parts = summaryParts({ attached: attachments.length - refused, refused, notAdded });
  return (
    <div className={cn("mb-1.5 min-w-0 px-1", className)} data-testid="composer-attachments">
      <div className="mb-1.5 text-[11px] text-faint" data-testid="attachment-summary">
        {parts.map((part, index) => (
          <Fragment key={part.kind}>
            {index > 0 && <span aria-hidden className="mx-[3px] whitespace-pre"> · </span>}
            <span className={PART_TONE[part.kind]}>{part.text}</span>
          </Fragment>
        ))}
      </div>
      {attachments.length > 0 && (
        <div className="flex max-h-[min(40vh,240px)] min-w-0 flex-wrap items-end gap-2 overflow-y-auto pt-1.5 pr-1.5" role="list" aria-label="Attached files" data-testid="attachment-list">
          {attachments.map((a) => (
            <span key={a.id} role="listitem" className="min-w-0 max-w-full">
              {a.refused ? (
                <FileChip
                  name={a.name}
                  refused={REFUSED_LABEL[a.refused]}
                  title={`${a.name}: ${REFUSED_LABEL[a.refused]}, not sent`}
                  onRemove={() => attach.remove(a.id)}
                />
              ) : (
                <AttachmentPreview
                  name={a.name}
                  size={a.size}
                  thumbnail={a.previewUrl}
                  text={a.text}
                  onView={a.previewUrl ? () => view(a.id) : undefined}
                  onRemove={() => attach.remove(a.id)}
                />
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
