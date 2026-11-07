import { MessageSquare, CircleAlert, Loader2 } from "@/icons";
import type { ToolCall } from "@/lib/transcript";
import type { ChatLinkContext } from "@/lib/chatLinks";
import { reviewLocation, type ReviewAuthor, type ReviewComment } from "@/lib/reviewComments";
import { LinkedText } from "./LinkedText";
import { useState } from "react";

type ReviewerComment = Pick<ReviewComment, "path" | "startLine" | "endLine" | "note" | "lineText" | "side"> & { author: ReviewAuthor; quoteTruncated?: boolean };

/** These are structured control events, never guesses from shell text. */
export function reviewComment(call: ToolCall): ReviewerComment | null {
  if (call.name !== "terminalx.review.comment" || !call.input || typeof call.input !== "object") return null;
  const value = call.input as Partial<ReviewerComment>;
  if (typeof value.path !== "string" || !value.path || typeof value.note !== "string" || typeof value.lineText !== "string"
    || typeof value.startLine !== "number" || !Number.isSafeInteger(value.startLine) || value.startLine < 1
    || typeof value.endLine !== "number" || !Number.isSafeInteger(value.endLine) || value.endLine < value.startLine
    || value.side !== "after" || value.author?.type !== "reviewerAgent" || typeof value.author.name !== "string"
    || typeof value.author.sessionId !== "string" || typeof value.author.tabId !== "string") return null;
  return value as ReviewerComment;
}

export function ReviewCommentCard({ call, comment, linkContext }: { call: ToolCall; comment: ReviewerComment; linkContext?: ChatLinkContext }) {
  const [expanded, setExpanded] = useState(false);
  const failed = call.result?.isError;
  const done = !!call.result;
  const label = failed ? "Could not comment on" : done ? "Commented on" : call.abandoned ? "Comment interrupted on" : "Saving comment on";
  const Icon = failed ? CircleAlert : !done && !call.abandoned ? Loader2 : MessageSquare;
  const location = reviewLocation(comment);
  // Bound legacy transcript events too, and mount the quote only when opened.
  const quote = comment.lineText.split("\n").slice(0, 20).join("\n").slice(0, 4096);
  const count = comment.endLine - comment.startLine + 1;
  const truncated = comment.quoteTruncated === true || count > 20 || quote.length < comment.lineText.length;
  return (
    <div className="my-1 rounded-md border border-border bg-well px-3 py-2 text-[13px]" data-testid="review-comment-card">
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">{label}{" "}</span>
        <span className="min-w-0 truncate font-mono" title={location}><LinkedText text={location} context={linkContext} /></span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{comment.author.name}</div>
      <div className="mt-1 whitespace-pre-wrap break-words select-text">{failed ? call.result?.text : comment.note}</div>
      {comment.lineText && <details className="mt-2 text-xs text-muted-foreground" onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className="cursor-pointer">Quoted lines{truncated ? ` (preview of ${count} ${count === 1 ? "line" : "lines"})` : ""}</summary>
        {expanded && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono select-text">{quote}</pre>}
      </details>}
    </div>
  );
}
