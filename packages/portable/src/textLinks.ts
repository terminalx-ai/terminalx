import LinkifyIt from "linkify-it";

const matcher = new LinkifyIt()
  .add("tel:", { validate: /^\+?(?:\d[\d().-]*\d|\d)/ })
  .add("file:", { validate: (text, position) => text.slice(position).match(/^\/\/\/[^\s<>"`]+/)?.[0].replace(/[.,;!]+$/, "").length ?? 0 });

export interface TextLinkPart { text: string; href?: string }

/** Recognise links without changing any text, whitespace, or surrounding
 * punctuation. Both chat renderers use the same URL boundaries. */
export function textLinks(text: string): TextLinkPart[] {
  const links = matcher.match(text)?.filter((link) => /^(https?:\/\/|mailto:|tel:|file:\/\/\/)/i.test(link.url));
  if (!links?.length) return [{ text }];
  const parts: TextLinkPart[] = [];
  let from = 0;
  for (const link of links) {
    if (link.index > from) parts.push({ text: text.slice(from, link.index) });
    parts.push({ text: text.slice(link.index, link.lastIndex), href: link.url });
    from = link.lastIndex;
  }
  if (from < text.length) parts.push({ text: text.slice(from) });
  return parts;
}

export function isExternalChatUrl(href: string): boolean {
  return /^(https?:\/\/|mailto:|tel:)/i.test(href);
}
