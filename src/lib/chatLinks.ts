import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { fs, type LocalPathInfo } from "@/lib/api";
import { openBrowserTab } from "@/lib/browser";
import { fileKind, openFile } from "@/lib/editors";

export interface ChatLinkContext {
  /** The session and workspace that rendered the link, captured at render time. */
  sessionId: string;
  cwd: string;
  /** Markdown previews resolve relative links beside the document; chat uses cwd. */
  basePath?: string;
}

export type ChatLinkDestination =
  | { kind: "web"; href: string }
  | { kind: "application"; href: string }
  | { kind: "local"; href: string; path: string; line?: number; col?: number }
  | { kind: "anchor"; href: string }
  | { kind: "rejected"; href: string; reason: string };

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const UNC_PATH = /^(?:\\\\|\/\/)[^/\\]+[/\\][^/\\]+/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const SYSTEM_SCHEMES = new Set(["mailto", "tel"]);
const REJECTED_SCHEMES = new Set(["javascript", "data", "vbscript", "blob"]);
const ROUTED_HREF_PREFIX = "streamdown:terminalx/";
const EXTERNAL_DOCUMENT_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key",
  "odt", "ods", "odp", "rtf", "epub", "mobi",
  "zip", "gz", "bz2", "xz", "7z", "rar", "tar", "dmg", "iso", "exe", "dll", "bin",
]);

/** Keep untrusted destinations inert while Streamdown sanitises the Markdown AST. */
export function routedChatHref(href: string): string {
  return `${ROUTED_HREF_PREFIX}${encodeURIComponent(href)}`;
}

export function originalChatHref(href: string): string {
  return href.startsWith(ROUTED_HREF_PREFIX) ? decodeOnce(href.slice(ROUTED_HREF_PREFIX.length)) : href;
}

type MarkdownNode = { type?: string; url?: string; title?: string; identifier?: string; children?: MarkdownNode[]; [key: string]: unknown };
export function routeMarkdownLinks() {
  return (tree: MarkdownNode) => {
    const definitions = new Map<string, { url: string; title?: string }>();
    const collect = (node: MarkdownNode) => {
      if (node.type === "definition" && node.identifier && typeof node.url === "string") {
        const identifier = node.identifier.toUpperCase();
        if (!definitions.has(identifier)) definitions.set(identifier, { url: node.url, title: node.title });
      }
      node.children?.forEach(collect);
    };
    collect(tree);
    const walk = (node: MarkdownNode) => {
      if (node.type === "link" && typeof node.url === "string") {
        node.url = routedChatHref(node.url);
      } else if (node.type === "linkReference" && node.identifier) {
        const definition = definitions.get(node.identifier.toUpperCase());
        if (definition) {
          node.type = "link";
          node.url = routedChatHref(definition.url);
          node.title = definition.title;
          delete node.identifier;
          delete node.label;
          delete node.referenceType;
        }
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fileUrlPath(href: string): { path: string; line?: number; col?: number } | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "file:") return null;
    // Parse only raw URL syntax. An encoded # or colon belongs to the filename.
    const at = url.hash ? splitHashLineReference(url.hash) : {};
    let rawPath = url.pathname;
    const suffix = splitColonLineReference(rawPath);
    rawPath = suffix.path;
    let path = decodeOnce(rawPath);
    if (url.host && url.host !== "localhost") path = `//${url.host}${path}`;
    // WHATWG file URLs spell Windows drives as /C:/..., while Path expects C:/....
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    return { path, line: at.line ?? suffix.line, col: at.col ?? suffix.col };
  } catch {
    return null;
  }
}

function splitHashLineReference(raw: string): { line?: number; col?: number } {
  const hash = raw.match(/^#L(\d+)(?:(?::|C)(\d+))?$/i);
  return hash ? { line: Number(hash[1]), col: hash[2] ? Number(hash[2]) : undefined } : {};
}

function splitColonLineReference(raw: string): { path: string; line?: number; col?: number } {
  const lineAndColumn = raw.match(/^(.*):(\d+):(\d+)$/);
  if (lineAndColumn?.[1]) return { path: lineAndColumn[1], line: Number(lineAndColumn[2]), col: Number(lineAndColumn[3]) };
  const line = raw.match(/^(.*):(\d+)$/);
  if (line?.[1]) return { path: line[1], line: Number(line[2]) };
  return { path: raw };
}

function splitPathLineReference(raw: string): { path: string; line?: number; col?: number } {
  const hashAt = raw.match(/^(.*)(#L\d+(?:(?::|C)\d+)?)$/i);
  if (hashAt) return { path: decodeOnce(hashAt[1]), ...splitHashLineReference(hashAt[2]) };
  const suffix = splitColonLineReference(raw);
  return { ...suffix, path: decodeOnce(suffix.path) };
}

/** Parse without touching the filesystem. URL ports are classified before file line suffixes. */
export function parseChatLink(href: string): ChatLinkDestination {
  const trimmed = href.trim();
  if (!trimmed) return { kind: "rejected", href, reason: "This link has no destination." };
  if (trimmed === "streamdown:incomplete-link") return { kind: "rejected", href, reason: "This link is not complete yet." };
  if (trimmed.startsWith("#")) return { kind: "anchor", href: trimmed };
  if (/^https?:\/\//i.test(trimmed)) return { kind: "web", href: trimmed };

  const scheme = trimmed.match(SCHEME)?.[1]?.toLowerCase();
  if (scheme === "file") {
    const file = fileUrlPath(trimmed);
    if (file == null) return { kind: "rejected", href, reason: "This file URL is invalid." };
    return { kind: "local", href: trimmed, ...file };
  }
  // A drive prefix is a path, not an application scheme.
  if (WINDOWS_ABSOLUTE.test(trimmed) || UNC_PATH.test(trimmed)) {
    const at = splitPathLineReference(trimmed);
    return { kind: "local", href: trimmed, ...at };
  }
  if (scheme) {
    if (REJECTED_SCHEMES.has(scheme)) return { kind: "rejected", href, reason: `Links using ${scheme}: are not allowed.` };
    if (SYSTEM_SCHEMES.has(scheme)) return { kind: "application", href: trimmed };
    const suffix = splitColonLineReference(trimmed);
    if (suffix.line != null && !trimmed.slice(scheme.length + 1).startsWith("//")) {
      return { kind: "local", href: trimmed, ...suffix, path: decodeOnce(suffix.path) };
    }
    return { kind: "rejected", href, reason: `No supported handler is configured for ${scheme}: links.` };
  }
  const at = splitPathLineReference(trimmed);
  return { kind: "local", href: trimmed, ...at };
}

export async function inspectChatFile(destination: Extract<ChatLinkDestination, { kind: "local" }>, context: ChatLinkContext): Promise<LocalPathInfo> {
  return fs.inspectPath(context.basePath ?? context.cwd, destination.path);
}

function canOpenInternally(info: LocalPathInfo): boolean {
  if (info.kind !== "file") return false;
  const ext = info.rel.split(".").pop()?.toLowerCase() ?? "";
  return fileKind(info.rel) !== "text" || (info.text && !EXTERNAL_DOCUMENT_EXTENSIONS.has(ext));
}

/** The default route for one real click/keyboard activation. */
export async function openChatLink(destination: ChatLinkDestination, context: ChatLinkContext): Promise<void> {
  if (destination.kind === "web") {
    await openBrowserTab(context.sessionId, context.cwd, destination.href);
    return;
  }
  if (destination.kind === "application") {
    await openUrl(destination.href);
    return;
  }
  if (destination.kind === "anchor") {
    document.getElementById(destination.href.slice(1))?.scrollIntoView();
    return;
  }
  if (destination.kind === "rejected") throw new Error(destination.reason);

  const info = await inspectChatFile(destination, context);
  if (info.kind === "directory") {
    await fs.openPath(info.path);
  } else if (canOpenInternally(info)) {
    openFile(context.sessionId, info.root, info.rel, destination.line ? { line: destination.line, col: destination.col } : undefined, context.cwd);
  } else {
    await fs.openPath(info.path);
  }
}

export async function openChatLinkExternally(destination: ChatLinkDestination, context: ChatLinkContext, info?: LocalPathInfo): Promise<void> {
  if (destination.kind === "web" || destination.kind === "application") return openUrl(destination.href);
  if (destination.kind !== "local") throw new Error(destination.kind === "rejected" ? destination.reason : "This destination cannot be opened externally.");
  const target = info ?? (await inspectChatFile(destination, context));
  await fs.openPath(target.path);
}

export async function revealChatLink(destination: ChatLinkDestination, context: ChatLinkContext, info?: LocalPathInfo): Promise<void> {
  if (destination.kind !== "local") throw new Error("Only files can be revealed in the file manager.");
  const target = info ?? (await inspectChatFile(destination, context));
  await revealItemInDir(target.path);
}

export function chatLinkCopyValue(destination: ChatLinkDestination, info?: LocalPathInfo): string {
  return destination.kind === "local" ? (info?.path ?? destination.path) : destination.href;
}

export function chatLinkCanOpenInternally(info: LocalPathInfo): boolean {
  return canOpenInternally(info);
}
