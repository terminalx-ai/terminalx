import mediaTypes from "./mediaTypes.json";
import { extOf } from "@/lib/paths";
import { parseChatLink } from "@/lib/chatLinks";

/** What a chat can draw in place of a path: SVG is drawn from its source, the rest streamed. */
export type ChatMediaKind = "image" | "video" | "audio" | "svg";

/** At most this many files are drawn under one message. */
const MOST = 6;

export function chatMediaKind(path: string): ChatMediaKind | null {
  const ext = extOf(path);
  if (ext === "svg") return "svg";
  const format = mediaTypes[ext as keyof typeof mediaTypes];
  return format?.kind === "image" || format?.kind === "video" || format?.kind === "audio" ? format.kind : null;
}

const MEDIA_EXTENSIONS = ["svg", ...Object.keys(mediaTypes)].sort((a, b) => b.length - a.length).join("|");
// A run with no spaces, quotes, brackets or parentheses ending in a media
// extension: a bare path, a Markdown link or image target, or inline code.
const CANDIDATE = new RegExp(`[^\\s\`'"()<>\\[\\]]+\\.(?:${MEDIA_EXTENSIONS})(?![\\w.])`, "gi");

/**
 * The local media files a message names, in order and once each. Web
 * addresses are left to the Markdown; a path that names nothing on disk is
 * found out later, when it is opened.
 */
export function mediaMentions(text: string): string[] {
  const found: string[] = [];
  for (const [candidate] of text.matchAll(CANDIDATE)) {
    const destination = parseChatLink(candidate);
    if (destination.kind !== "local" || !chatMediaKind(destination.path)) continue;
    if (!found.includes(destination.path)) found.push(destination.path);
    if (found.length === MOST) break;
  }
  return found;
}
