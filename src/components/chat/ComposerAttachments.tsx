import { Fragment } from "react";
import { FileChip } from "./FileChip";
import { summaryParts, type Refusal } from "@/lib/attachmentRules";
import { cn } from "@/lib/cn";
import type { Attachments } from "./useImageAttachments";

/** What a refused chip says after its name. */
const REFUSED_LABEL: Record<Refusal, string> = { reserved: "reserved name", "too-large": "too large" };

const PART_TONE = { attached: undefined, refused: "text-destructive", notAdded: "text-warning" } as const;

/**
 * The files on the draft (PRO-290, screen 03.23): a line counting them,
 * "10 attached · 1 refused · 4 not added", then one chip each, wrapping.
 * Images are chips too. A refused chip is red with its reason, and is never
 * sent; every chip has its remove control.
 */
export function AttachmentChips({ attach, className }: { attach: Attachments; className?: string }) {
  const { attachments, notAdded } = attach;
  if (!attachments.length && !notAdded) return null;
  const refused = attachments.filter((a) => a.refused).length;
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
        <div className="flex min-w-0 flex-wrap gap-1.5" role="list" aria-label="Attached files">
          {attachments.map((a) => (
            <span key={a.id} role="listitem" className="min-w-0 max-w-full">
              <FileChip
                name={a.name}
                refused={a.refused ? REFUSED_LABEL[a.refused] : undefined}
                title={a.refused ? `${a.name}: ${REFUSED_LABEL[a.refused]}, not sent` : a.name}
                onRemove={() => attach.remove(a.id)}
              />
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
