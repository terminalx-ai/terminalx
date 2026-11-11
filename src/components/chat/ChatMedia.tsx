import { PrivacyImage } from "@/components/ui/privacy-image";
import { useEffect, useState } from "react";
import { fs } from "@/lib/api";
import { fileName } from "@/lib/paths";
import { chatMediaKind, type ChatMediaKind } from "@/lib/chatMedia";
import type { ChatLinkContext } from "@/lib/chatLinks";
import { openImageViewer } from "@/lib/imageViewer";

/** An SVG larger than this is left as its link. */
const SVG_MOST = 2 * 1024 * 1024;

/**
 * The pictures, videos and sounds a message names, drawn under it, so a file
 * an agent made is seen where it says so rather than behind a link. A path
 * that names nothing readable draws nothing.
 */
export function ChatMedia({ paths, context }: { paths: string[]; context: ChatLinkContext }) {
  if (!paths.length) return null;
  return (
    <div className="mt-2 flex flex-col items-start gap-2" data-testid="chat-media">
      {paths.map((path) => <MediaItem key={path} path={path} context={context} />)}
    </div>
  );
}

function MediaItem({ path, context }: { path: string; context: ChatLinkContext }) {
  const [shown, setShown] = useState<{ kind: ChatMediaKind; src: string } | null>(null);
  const base = context.basePath ?? context.cwd;

  useEffect(() => {
    let cancelled = false;
    let token: string | undefined;
    setShown(null);
    if (path.startsWith("data:image/")) {
      setShown({ kind: "image", src: path });
      return;
    }
    const kind = chatMediaKind(path);
    if (!kind) return;
    void (async () => {
      const info = await fs.inspectPath(base, path);
      if (info.kind !== "file" || cancelled) return;
      if (kind === "svg") {
        // Drawn as an image, so a script in it never runs.
        const file = await fs.readText(info.path);
        if (!cancelled && !file.binary && !file.truncated && file.size <= SVG_MOST) {
          setShown({ kind, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.content)}` });
        }
        return;
      }
      const media = await fs.openMedia(info.root, info.rel);
      token = media.token;
      if (cancelled) void fs.closeMedia(media.token).catch(() => {});
      else setShown({ kind, src: media.url });
    })().catch(() => {});
    return () => {
      cancelled = true;
      if (token) void fs.closeMedia(token).catch(() => {});
    };
  }, [base, path]);

  if (!shown) return null;
  const name = path.startsWith("data:") ? "Image" : fileName(path);
  return (
    <figure className="m-0 max-w-full" data-testid="chat-media-item">
      {shown.kind === "video" ? (
        <video src={shown.src} controls preload="metadata" className="max-h-96 max-w-full rounded-lg bg-black hairline" />
      ) : shown.kind === "audio" ? (
        <audio src={shown.src} controls preload="metadata" className="max-w-full" />
      ) : (
        <button type="button" onClick={() => openImageViewer([{ src: shown.src, name, path: path.startsWith("data:") ? undefined : path }])} aria-label={`View ${name}`} className="block max-w-full cursor-zoom-in rounded-lg">
          <PrivacyImage src={shown.src} alt={name} className="max-h-96 max-w-full rounded-lg object-contain hairline" />
        </button>
      )}
      <figcaption className="mt-1 truncate text-xs text-faint" title={path.startsWith("data:") ? undefined : path}>{name}</figcaption>
    </figure>
  );
}
