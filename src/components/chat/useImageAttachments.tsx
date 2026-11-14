import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes, type RefObject } from "react";
import { Paperclip } from "@/icons";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { attachments as attachmentsApi, files as filesApi, type FileFacts, type FileInput, type ImageInput } from "@/lib/api";
import { admit, type Offered, type Refusal } from "@/lib/attachmentRules";
import { announceAdmission } from "@/lib/attachmentNotices";
import { showError } from "@/lib/errorToasts";
import { registerWindowDraft } from "@/lib/windowDrafts";
import { registerFileDropTarget } from "@/lib/fileDrop";

/**
 * One file on the draft, drawn as a chip (PRO-290). Exactly one of `image`,
 * `file` and `refused` is set: an image goes to the agent as an image block,
 * any other file is stored in the session's attachments folder on send, and
 * a refused one stays above the draft, never sent, until it is removed.
 */
export interface Attachment {
  id: string;
  name: string;
  /** An image of a type an agent takes, up to 5 MB: sent with `agent.send`'s images, as before PRO-290. */
  image?: ImageInput;
  /** The image's thumbnail, for the message drawn as sending. */
  previewUrl?: string;
  /** Stored with `attachments.store` on send; its `FileRef` goes with the message. */
  file?: FileInput;
  /** Why it was not attached. It takes no place in the 10. */
  refused?: Refusal;
}

/** Files taken out of the composer for a send, until it is known whether it went (`Attachments.setAside`). */
export interface SetAside {
  images: ImageInput[];
  /** Every other file, for `attachments.store` once the session is known. */
  files: FileInput[];
  /** The images' thumbnails, for the message drawn as sending. */
  previews: { url: string; name?: string }[];
  settle: (sent: boolean) => void;
}

/** Larger images go as files rather than as one huge image block. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The image types every agent takes as an image block; any other image is attached as a file. */
const AGENT_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type OfferVerb = "dropped" | "pasted" | "picked";

export interface Attachments {
  /** Every chip above the draft, refused ones included, in the order offered. */
  attachments: Attachment[];
  /** How many files the last offer left out because the message was full; cleared by a removal or a send. */
  notAdded: number;
  /** A cloud tab: images only, nothing is stored, and no file is mentioned by its path. */
  imagesOnly: boolean;
  /** A file is being dragged over the window or the composer frame. */
  dragging: boolean;
  fileRef: RefObject<HTMLInputElement | null>;
  /** Queue browser `File`s (from paste, the DOM drop path, or the hidden picker). */
  addFiles: (list: File[], verb?: OfferVerb) => Promise<void>;
  /** Open the native picker, or the hidden browser picker outside Tauri. */
  chooseFiles: () => Promise<void>;
  remove: (id: string) => void;
  /** Release every chip and its preview, after the new-session screen has handed them on. */
  clear: () => void;
  /**
   * Take what will be sent out of the composer for a send that is on its
   * way (#727), keeping it: `settle(true)` lets it go once it is sent,
   * `settle(false)` puts the very same images and files back when it was not.
   */
  setAside: () => SetAside;
  /** The queued images in the shape `agent.send` takes. */
  images: ImageInput[];
  /** The queued files, for `attachments.store`. */
  files: FileInput[];
  /** Why the last file offered was not attached (a cloud tab only), until the queue changes again. */
  notice: string | null;
  /** Spread onto the composer frame so it accepts pasted and dropped files. */
  dropZoneProps: Pick<HTMLAttributes<HTMLElement>, "onPaste" | "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop">;
}

/** A file offered to the draft: its name and size for the rules, and how to read it once it is admitted. */
interface Candidate extends Offered {
  size: number;
  read: () => Promise<Omit<Attachment, "id" | "name"> | null>;
}

let lastId = 0;
const nextId = () => `attachment-${++lastId}`;

function readBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error(`${file.name} could not be read`));
    reader.readAsDataURL(file);
  });
}

const takenAsImage = (mediaType: string | undefined, size: number) => !!mediaType && AGENT_IMAGE_TYPES.has(mediaType) && size <= MAX_IMAGE_BYTES;

/** A pasted or DOM-dropped `File`: its bytes go with it, as an image or as a file. */
function browserCandidate(f: File): Candidate {
  return {
    name: f.name,
    size: f.size,
    read: async () => {
      const data = await readBase64(f);
      if (takenAsImage(f.type, f.size)) return { image: { mediaType: f.type, data, name: f.name }, previewUrl: URL.createObjectURL(f) };
      return { file: { name: f.name, data, ...(f.type ? { mediaType: f.type } : {}) } };
    },
  };
}

/** A picked or window-dropped path, as `attachments.inspect` found it: an image is read here, any other file is copied by the store. */
function pathCandidate(facts: FileFacts): Candidate {
  return {
    name: facts.name,
    size: facts.size,
    read: async () => {
      if (takenAsImage(facts.mediaType, facts.size)) {
        const img = await filesApi.readImage(facts.path);
        if (img) return { image: { mediaType: img.mediaType, data: img.data, name: img.name }, previewUrl: `data:${img.mediaType};base64,${img.data}` };
      }
      return { file: { name: facts.name, path: facts.path } };
    },
  };
}

const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

/**
 * Everything a composer needs to carry files with a prompt (PRO-290): the
 * chips, the native and browser pickers, paste, and both drop paths. Any
 * file attaches, up to 10 a message (`attachmentRules.admit`); a reserved
 * name or an oversized file is refused and shown red; what did not fit is
 * counted and said in a toast. Dropped paths reach the app through the Tauri
 * window, not the DOM; a folder dropped there becomes an `@path` mention.
 *
 * A cloud tab (`mentionFiles` false) takes images only, as before: nothing
 * is stored for it, and its own limit of 8 is checked on upload.
 *
 * Shared by the in-session composer and the new-session screen so the first
 * prompt of a session can carry files like every one after it.
 */
export function useAttachments({
  textareaRef,
  draft,
  onDraftChange,
  mentionFiles = true,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  onDraftChange: (v: string) => void;
  /**
   * False when the agent does not run on this computer (a cloud tab): only
   * images attach, and a dropped file that is not one is left alone, since
   * its path here names nothing there.
   */
  mentionFiles?: boolean;
}): Attachments {
  const imagesOnly = !mentionFiles;
  const [attachments, setAttachmentState] = useState<Attachment[]>([]);
  const current = useRef(attachments);
  // Keep the preservation check and the count current even between an async
  // file read and React's next render. Every queue edit goes through this.
  const setAttachments = useCallback((change: (items: Attachment[]) => Attachment[]) => {
    current.current = change(current.current);
    setAttachmentState(current.current);
  }, []);
  const pendingInput = useRef(0);
  const readInput = useCallback(async (read: () => Promise<void>) => {
    pendingInput.current++;
    try { await read(); } finally { pendingInput.current--; }
  }, []);
  // Places taken by files admitted but still being read, so two offers close together cannot both fill the last places.
  const reading = useRef(0);
  const [notAdded, setNotAdded] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // The drop target is registered once, so it reads the draft through a ref
  // rather than taking it as a dependency — otherwise every keystroke tore
  // the registration down and built another.
  const latest = useRef({ draft, onDraftChange });
  latest.current = { draft, onDraftChange };

  const mention = useCallback((paths: string[]) => {
    if (!paths.length) return;
    const { draft: now, onDraftChange: change } = latest.current;
    const sep = now && !/\s$/.test(now) ? " " : "";
    change(now + sep + paths.map((p) => `@${p}`).join(" ") + " ");
  }, []);

  /** Admit an offer by the rules, read what was admitted, and put every chip up in the order offered. */
  const offer = useCallback(async (items: Candidate[], verb: OfferVerb) => {
    if (!items.length) return;
    const queued = current.current.filter((a) => !a.refused).length + reading.current;
    const admission = admit(queued, items);
    setNotAdded(admission.notAdded.length);
    announceAdmission(items.length, admission, verb);
    reading.current += admission.attached.length;
    let read: (Omit<Attachment, "id" | "name"> | null)[];
    try {
      read = await Promise.all(admission.attached.map((item) => item.read().catch((error) => {
        showError(`Couldn't attach ${item.name}`, error);
        return null;
      })));
    } finally {
      reading.current -= admission.attached.length;
    }
    const readOf = new Map(admission.attached.map((item, index) => [item, read[index]]));
    const refusedOf = new Map(admission.refused.map(({ item, reason }) => [item, reason]));
    const added: Attachment[] = [];
    for (const item of items) {
      const reason = refusedOf.get(item);
      const body = readOf.get(item);
      if (reason) added.push({ id: nextId(), name: item.name, refused: reason });
      else if (body) added.push({ id: nextId(), name: item.name, ...body });
    }
    if (added.length) setAttachments((list) => [...list, ...added]);
  }, [setAttachments]);

  // A cloud tab takes images and nothing else, and says why it left a file out.
  const addCloudImages = useCallback(async (images: (Omit<Attachment, "id"> | null)[], skipped: string[]) => {
    const kept = images.filter((a): a is Omit<Attachment, "id"> => !!a);
    if (kept.length) setAttachments((list) => [...list, ...kept.map((a) => ({ ...a, id: nextId() }))]);
    setNotice(skipped.length ? notAttached(skipped) : null);
  }, [setAttachments]);

  const addFiles = useCallback((list: File[], verb: OfferVerb = "dropped") => readInput(async () => {
    if (!imagesOnly) return offer(list.map(browserCandidate), verb);
    const skipped: string[] = [];
    const images: Omit<Attachment, "id">[] = [];
    for (const f of list) {
      if (!f.type.startsWith("image/") || f.size > MAX_IMAGE_BYTES) {
        skipped.push(f.name);
        continue;
      }
      const data = await readBase64(f);
      images.push({ name: f.name, image: { mediaType: f.type, data, name: f.name }, previewUrl: URL.createObjectURL(f) });
    }
    await addCloudImages(images, skipped);
  }), [imagesOnly, offer, addCloudImages, readInput]);

  const addPaths = useCallback(
    (paths: string[], verb: OfferVerb = "dropped") => readInput(async () => {
      if (imagesOnly) {
        const skipped: string[] = [];
        const images: Omit<Attachment, "id">[] = [];
        for (const path of paths) {
          const img = await filesApi.readImage(path).catch(() => null);
          if (img) images.push({ name: img.name, image: { mediaType: img.mediaType, data: img.data, name: img.name }, previewUrl: `data:${img.mediaType};base64,${img.data}` });
          else skipped.push(baseName(path));
        }
        await addCloudImages(images, skipped);
      } else {
        let facts: FileFacts[];
        try {
          facts = await attachmentsApi.inspect(paths);
        } catch (error) {
          showError(paths.length === 1 ? `Couldn't attach ${baseName(paths[0])}` : `Couldn't attach ${paths.length} files`, error);
          return;
        }
        // A folder (or anything else that is not a regular file) is not attached: the agent is pointed at it, as before.
        mention(facts.filter((f) => f.unreadable).map((f) => f.path));
        await offer(facts.filter((f) => !f.unreadable).map(pathCandidate), verb);
      }
      textareaRef.current?.focus();
    }),
    [textareaRef, imagesOnly, mention, offer, addCloudImages, readInput],
  );

  const chooseFiles = useCallback(() => readInput(async () => {
    let selected: string | string[] | null;
    try {
      selected = await openDialog({ multiple: true, title: "Attach files" });
    } catch {
      // The hidden browser picker keeps the composer usable outside Tauri.
      fileRef.current?.click();
      return;
    }
    if (!selected) return;
    await addPaths(Array.isArray(selected) ? selected : [selected], "picked");
  }), [addPaths, readInput]);

  const release = (item: Attachment) => {
    if (item.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(item.previewUrl);
  };

  const remove = useCallback((id: string) => {
    setNotAdded(0);
    setAttachments((list) => {
      const removed = list.find((item) => item.id === id);
      if (removed) release(removed);
      return list.filter((item) => item.id !== id);
    });
  }, [setAttachments]);

  const clear = useCallback(() => {
    setNotice(null);
    setNotAdded(0);
    setAttachments((list) => {
      list.forEach(release);
      return [];
    });
    if (fileRef.current) fileRef.current.value = "";
  }, [setAttachments]);

  // Dropped paths arrive from the window, not the DOM, through the one
  // router every drop target shares (`fileDrop.ts`). A composer takes what
  // lands on it and what lands on nothing else, never what lands on a terminal.
  useEffect(
    () =>
      registerFileDropTarget({
        element: () => textareaRef.current?.parentElement ?? null,
        anywhere: true,
        onDragChange: setDragging,
        onDrop: (paths) => addPaths(paths, "dropped"),
      }),
    [addPaths, textareaRef],
  );

  // Each image is one object for as long as it is queued, set aside and put
  // back included: a send tried again hands over the very same images, which
  // is how a cloud tab knows not to upload them as new ones.
  const sendable = useMemo(() => attachments.filter((a) => !a.refused), [attachments]);
  const images = useMemo(() => sendable.flatMap((a) => (a.image ? [a.image] : [])), [sendable]);
  const files = useMemo(() => sendable.flatMap((a) => (a.file ? [a.file] : [])), [sendable]);

  const aside = useRef(0);
  useLayoutEffect(() => registerWindowDraft(() =>
    current.current.some((a) => !a.refused) || aside.current > 0 || pendingInput.current > 0,
  ), []);
  const setAside = useCallback((): SetAside => {
    const taken = current.current.filter((a) => !a.refused);
    // A refused chip was about this message: it goes once the message has.
    const refusedThen = new Set(current.current.filter((a) => a.refused).map((a) => a.id));
    const ids = new Set(taken.map((a) => a.id));
    setNotAdded(0);
    if (taken.length) setAttachments((list) => list.filter((item) => !ids.has(item.id)));
    if (fileRef.current) fileRef.current.value = "";
    aside.current++;
    let settled = false;
    return {
      images: taken.flatMap((a) => (a.image ? [a.image] : [])),
      files: taken.flatMap((a) => (a.file ? [a.file] : [])),
      previews: taken.flatMap((a) => (a.image && a.previewUrl ? [{ url: a.previewUrl, name: a.name }] : [])),
      settle: (sent) => {
        if (settled) return;
        settled = true;
        aside.current--;
        if (sent) {
          taken.forEach(release);
          if (refusedThen.size) setAttachments((list) => list.filter((item) => !refusedThen.has(item.id)));
        } else if (taken.length) {
          setAttachments((list) => [...taken, ...list.filter((item) => !ids.has(item.id))]);
        }
      },
    };
  }, [setAttachments]);

  const dropZoneProps = useMemo<Attachments["dropZoneProps"]>(
    () => ({
      onPaste: (e) => {
        const list = [...e.clipboardData.files];
        if (list.length) {
          e.preventDefault();
          void addFiles(list, "pasted");
        }
      },
      onDragEnter: (e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      },
      onDragOver: (e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragging(true);
      },
      onDragLeave: (e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragging(false);
      },
      onDrop: (e) => {
        const list = [...e.dataTransfer.files];
        if (!list.length) return;
        e.preventDefault();
        setDragging(false);
        void addFiles(list, "dropped");
      },
    }),
    [addFiles],
  );

  // One stable object per change, so a composer's send callback can list it
  // as a dependency without being rebuilt on every render.
  return useMemo(
    () => ({ attachments, notAdded, imagesOnly, dragging, fileRef, addFiles, chooseFiles, remove, clear, setAside, images, files, notice, dropZoneProps }),
    [attachments, notAdded, imagesOnly, dragging, addFiles, chooseFiles, remove, clear, setAside, images, files, notice, dropZoneProps],
  );
}

/** Said when a cloud tab's composer leaves a file out: it takes images only, and nothing is mentioned by its path here. */
export function notAttached(names: string[]): string {
  const what = names.length === 1 ? `${names[0]} was` : `${names.length} files were`;
  return `${what} not attached: only images (PNG, JPEG, GIF, WebP) up to 5 MB can be sent to a cloud agent.`;
}

/** The overlay that names what a drop does, shown while a file hovers the frame. */
export function DropHint({ dragging, mentionFiles = true }: { dragging: boolean; mentionFiles?: boolean }) {
  if (!dragging) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-composer text-sm text-muted-foreground">
      {mentionFiles ? "Drop files to attach" : "Drop images to attach"}
    </div>
  );
}

/** The attach button and the hidden browser picker behind it. */
export function AttachButton({ attach, disabled = false }: { attach: Attachments; disabled?: boolean }) {
  return (
    <>
      <input
        ref={attach.fileRef}
        type="file"
        // Any file attaches; a cloud tab still takes images only.
        accept={attach.imagesOnly ? "image/*" : undefined}
        multiple
        hidden
        onChange={(e) => {
          const list = e.target.files ? [...e.target.files] : [];
          // A cleared input lets the same file be selected again after a
          // send or removal; browsers do not emit change otherwise.
          e.target.value = "";
          if (list.length) void attach.addFiles(list, "picked");
        }}
      />
      <WithTooltip label="Attach files">
        <Button variant="ghost" size="icon-sm" aria-label="Attach files" className="shrink-0" disabled={disabled} onClick={() => void attach.chooseFiles()}>
          <Paperclip />
        </Button>
      </WithTooltip>
    </>
  );
}
