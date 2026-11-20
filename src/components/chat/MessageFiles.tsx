import { AttachmentPreview, hasTextPreview, isDrawableImage, useTextSnippet } from "./AttachmentPreview";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openAttachment, setLastFocused } from "@/lib/editors";
import { openImageViewer, type ViewerImage } from "@/lib/imageViewer";
import { shortPath } from "@/lib/paths";

type SentFile = { name: string; path?: string; size?: number };

/** A stored attachment as the web view loads it: the asset protocol is scoped to the attachments folder. */
function assetUrl(path: string): string | undefined {
  try {
    return convertFileSrc(path);
  } catch {
    return undefined;
  }
}

/**
 * The files attached to a message the reader sent (PRO-290, screen 03.22),
 * above its text, each with the preview it had in the composer (PRO-461):
 * an image's thumbnail opens the image viewer on the message's images; any
 * other file is a card that opens its stored copy in a file tab of the
 * session, with the time the message was sent. Without `open` (a message
 * still sending, or a cloud session's file, which is not on this computer)
 * the cards only name the files.
 */
export function MessageFiles({ files, sessionId, sentAt, cwd, open }: {
  files: readonly SentFile[];
  sessionId?: string;
  sentAt?: string;
  cwd?: string;
  open: boolean;
}) {
  if (!files.length) return null;
  const local = (file: SentFile) => open && !!sessionId && !!file.path?.startsWith("/");
  const images: (ViewerImage & { at: number })[] = files.flatMap((file, at) => {
    const src = local(file) && isDrawableImage(file.name) ? assetUrl(file.path!) : undefined;
    return src ? [{ src, name: file.name, path: file.path, at }] : [];
  });
  return (
    <div className="mb-2 flex flex-wrap items-end gap-2 whitespace-normal" data-testid="message-files">
      {files.map((file, i) => {
        const openable = local(file);
        const image = images.find((im) => im.at === i);
        return (
          <SentFileCard
            key={`${i}:${file.path ?? file.name}`}
            file={file}
            thumbnail={image?.src}
            readText={openable && !image && hasTextPreview(file.name)}
            onView={image ? () => openImageViewer(images.map(({ at: _, ...shown }) => shown), images.indexOf(image)) : undefined}
            onOpen={openable ? () => {
              openAttachment(sessionId!, { path: file.path!, name: file.name }, sentAt, cwd);
              setLastFocused("editor");
            } : undefined}
          />
        );
      })}
    </div>
  );
}

function SentFileCard({ file, thumbnail, readText, onView, onOpen }: {
  file: SentFile;
  thumbnail?: string;
  readText: boolean;
  onView?: () => void;
  onOpen?: () => void;
}) {
  const text = useTextSnippet(file.path, readText);
  const meta = file.path ? shortPath(file.path) : undefined;
  return (
    <AttachmentPreview
      name={file.name}
      size={file.size}
      thumbnail={thumbnail}
      text={text}
      onView={onView}
      // A thumbnail that does not draw falls back to the card, which still opens the file.
      onOpen={onOpen}
      title={meta}
    />
  );
}
