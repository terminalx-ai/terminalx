import { memo, useMemo, type ReactNode } from "react";
import { textLinks } from "@terminalx/portable/textLinks";
import { codexFileCitationLabel, codexFileCitationParts, isCodexFileOutput } from "@terminalx/portable/codexCitations";
import type { ChatLinkContext } from "@/lib/chatLinks";
import { ChatLink } from "./ChatLink";
import { mentionSegments } from "@/lib/mentions";
import { MentionChip } from "./ComposerMentions";
import { useTranscriptMentionPeople } from "./useMentionPeople";

const NO_PEOPLE: never[] = [];

/**
 * Plain text with its URLs as links. `citations`: also Codex file citations
 * (#776), for an agent's reply shown as plain text; elsewhere, such as in a
 * code span, the marker stays literal.
 */
export const LinkedText = memo(function LinkedText({ text, context, citations, mentions }: { text: string; context?: ChatLinkContext; citations?: boolean; mentions?: boolean }) {
  // `mentions`: a person's message, where `@Name` of a teammate is drawn as their chip (PRO-141).
  const transcriptPeople = useTranscriptMentionPeople();
  const people = mentions ? transcriptPeople : NO_PEOPLE;
  const content = useMemo(() => {
    const links = (part: string, key: string): ReactNode[] =>
      textLinks(part).map((link, index) => link.href ? <ChatLink key={`${key}.${index}`} href={link.href} context={context}>{link.text}</ChatLink> : link.text);
    const linked = (part: string, key: string): ReactNode[] => !people.length ? links(part, key)
      : mentionSegments(part, people).flatMap((segment, index) => typeof segment === "string"
        ? links(segment, `${key}.${index}`)
        : [<MentionChip key={`${key}.${index}`} person={segment.person} />]);
    if (!citations) return linked(text, "t");
    return codexFileCitationParts(text).flatMap((part, index) => part.citation
      ? [<ChatLink key={index} href={part.citation.path} title={part.citation.path} file={isCodexFileOutput(part.citation)} context={context}>{codexFileCitationLabel(part.citation)}</ChatLink>]
      : linked(part.text, String(index)));
  }, [text, context, citations, people]);
  return <>{content}</>;
});
