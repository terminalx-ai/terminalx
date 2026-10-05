import { memo, useMemo } from "react";
import { textLinks } from "@terminalx/portable/textLinks";
import type { ChatLinkContext } from "@/lib/chatLinks";
import { ChatLink } from "./ChatLink";

export const LinkedText = memo(function LinkedText({ text, context }: { text: string; context?: ChatLinkContext }) {
  const parts = useMemo(() => textLinks(text), [text]);
  return <>{parts.map((part, index) => part.href ? <ChatLink key={index} href={part.href} context={context}>{part.text}</ChatLink> : part.text)}</>;
});
