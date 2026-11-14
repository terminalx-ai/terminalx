import { memo, useMemo, type ReactNode } from "react";
import { textLinks } from "@terminalx/portable/textLinks";
import { codexFileCitationLabel, codexFileCitationParts, isCodexFileOutput } from "@terminalx/portable/codexCitations";
import type { ChatLinkContext } from "@/lib/chatLinks";
import { ChatLink } from "./ChatLink";

/**
 * Plain text with its URLs as links. `citations`: also Codex file citations
 * (#776), for an agent's reply shown as plain text; elsewhere, such as in a
 * code span, the marker stays literal.
 */
export const LinkedText = memo(function LinkedText({ text, context, citations }: { text: string; context?: ChatLinkContext; citations?: boolean }) {
  const content = useMemo(() => {
    const linked = (part: string, key: string): ReactNode[] =>
      textLinks(part).map((link, index) => link.href ? <ChatLink key={`${key}.${index}`} href={link.href} context={context}>{link.text}</ChatLink> : link.text);
    if (!citations) return linked(text, "t");
    return codexFileCitationParts(text).flatMap((part, index) => part.citation
      ? [<ChatLink key={index} href={part.citation.path} title={part.citation.path} file={isCodexFileOutput(part.citation)} context={context}>{codexFileCitationLabel(part.citation)}</ChatLink>]
      : linked(part.text, String(index)));
  }, [text, context, citations]);
  return <>{content}</>;
});
