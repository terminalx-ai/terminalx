import { FileChip } from "./FileChip";
import { openAttachment, setLastFocused } from "@/lib/editors";
import { shortPath } from "@/lib/paths";

/**
 * The files attached to a message the reader sent (PRO-290, screen 03.22),
 * as chips above its text. A chip opens its stored copy in a file tab of the
 * session, with the time the message was sent. Without `open` (a message
 * still sending, or a cloud session's file, which is not on this computer)
 * the chips only name the files.
 */
export function MessageFiles({ files, sessionId, sentAt, cwd, open }: {
  files: readonly { name: string; path?: string }[];
  sessionId?: string;
  sentAt?: string;
  cwd?: string;
  open: boolean;
}) {
  if (!files.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5 whitespace-normal" data-testid="message-files">
      {files.map((file, i) => {
        const path = file.path;
        const openable = open && !!sessionId && !!path?.startsWith("/");
        return (
          <FileChip
            key={`${i}:${path ?? file.name}`}
            name={file.name}
            title={path ? shortPath(path) : file.name}
            onOpen={openable ? () => {
              openAttachment(sessionId!, { path: path!, name: file.name }, sentAt, cwd);
              setLastFocused("editor");
            } : undefined}
          />
        );
      })}
    </div>
  );
}
