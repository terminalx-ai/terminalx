// `fs/1` from a client (PRO-24, docs/CLOUD-FILES.md): what the desktop needs
// to browse, edit and search a cloud workspace's files over the relay.
// - Paths are workspace-relative; the runtime resolves and contains them.
//   A path that could only mean "outside" is refused here before sending.
// - Files move in parts the relay frame can carry, a read under one
//   `version` so it never mixes two states of a file, a write staged whole
//   before it replaces the file.
// - Saves carry the content hash they were based on; a file changed
//   meanwhile is a `conflict` the caller resolves, never overwritten.
// - A search can be cancelled, and is when the caller stops waiting.
import { WorkspaceRpcError, type WorkspaceRpcClient } from "./workspace";

/** Raw bytes per part; matches the runtime's `fsPartBytes`. */
export const FS_PART_BYTES = 384 * 1024;
/** Largest file read or written remotely; matches `fsMaxFileBytes`. */
export const FS_MAX_FILE_BYTES = 32 * 1024 * 1024;

export type RemoteEntryKind = "file" | "directory" | "symlink" | "other";

export interface RemoteDirEntry {
  name: string;
  /** Workspace-relative, `/`-separated. */
  path: string;
  kind: RemoteEntryKind;
  size: number;
  modifiedMs: number | null;
  /** A symbolic link; `kind` is what it points at when that is inside the workspace. */
  symlink?: boolean;
  /** A link that leaves the workspace (or dangles); it is never followed. */
  escapes?: boolean;
  /** A previewable media format, by extension. */
  mediaType?: string | null;
}

export interface RemoteListing {
  path: string;
  entries: RemoteDirEntry[];
  truncated: boolean;
}

export interface RemoteStat {
  name: string;
  kind: RemoteEntryKind;
  size: number;
  modifiedMs: number | null;
  version?: string;
  etag?: string;
  mediaType?: string | null;
}

export interface RemoteFile {
  path: string;
  size: number;
  /** Content hash; a save names it as `expectedEtag`. */
  etag: string;
  /** Cheap identity of the file's state, to tell changes apart. */
  version: string;
  /** NUL bytes near the start. */
  binary: boolean;
  mediaType: string | null;
  bytes: Uint8Array;
  /** The content as text: set unless binary or not UTF-8. */
  text: string | null;
}

export interface RemoteWriteResult {
  path: string;
  etag: string;
  size: number;
  version: string | null;
}

export interface RemoteTextHit {
  path: string;
  line: number;
  col: number;
  text: string;
  matches: [number, number][];
}

export interface RemoteSearchResult {
  hits: RemoteTextHit[];
  files: number;
  /** More matched than came back (result count or size). */
  capped: boolean;
  /** Stopped early by `fs.cancel`. */
  cancelled: boolean;
}

export interface RemoteSearchQuery {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  /** A directory to search under; the whole workspace by default. */
  path?: string;
  maxResults?: number;
}

export class RemotePathError extends Error {
  readonly code = "path_forbidden";
}

/**
 * A workspace-relative path as the runtime expects it, or a refusal for one
 * that is absolute or climbs out. The runtime checks again (and resolves
 * symlinks); this only keeps an obviously wrong path from being sent.
 */
export function remotePath(path: string): string {
  const parts: string[] = [];
  if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/.test(path) || path.includes("\0")) {
    throw new RemotePathError(`${path} is not a workspace-relative path`);
  }
  for (const part of path.split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    if (part === "..") throw new RemotePathError(`${path} leaves the workspace`);
    parts.push(part);
  }
  return parts.join("/");
}

export function isConflict(error: unknown): boolean {
  return error instanceof WorkspaceRpcError && error.code === "conflict";
}

export async function listRemoteDir(client: WorkspaceRpcClient, path: string): Promise<RemoteListing> {
  return client.call<RemoteListing>("fs.list", { path: remotePath(path) });
}

/** `etag`: hash files up to the remote limit too, not only small ones. */
export async function statRemote(client: WorkspaceRpcClient, path: string, options: { etag?: boolean } = {}): Promise<RemoteStat> {
  return client.call<RemoteStat>("fs.stat", { path: remotePath(path), ...(options.etag ? { etag: true } : {}) });
}

interface ReadPart {
  path: string;
  size: number;
  version: string;
  offset: number;
  eof: boolean;
  etag?: string;
  binary?: boolean;
  mediaType?: string | null;
  text?: string;
  dataB64?: string;
}

export interface ReadOptions {
  signal?: AbortSignal;
  /** Refuse files larger than this (`too_large`) after the first part. */
  maxBytes?: number;
}

/**
 * A whole file, read part by part under the version of its first part. If
 * the file changes midway the read starts over once, then gives up with
 * `conflict`.
 */
export async function readRemoteFile(client: WorkspaceRpcClient, path: string, options: ReadOptions = {}): Promise<RemoteFile> {
  const rel = remotePath(path);
  for (let attempt = 0; ; attempt++) {
    try {
      return await readOnce(client, rel, options);
    } catch (error) {
      if (!isConflict(error) || attempt >= 1) throw error;
    }
  }
}

async function readOnce(client: WorkspaceRpcClient, path: string, { signal, maxBytes }: ReadOptions): Promise<RemoteFile> {
  const first = await client.call<ReadPart>("fs.read", { path });
  abortIfNeeded(signal);
  if (maxBytes !== undefined && first.size > maxBytes) throw new WorkspaceRpcError("too_large", `${path} is larger than ${maxBytes} bytes`, "fs.read");
  if (first.text !== undefined) {
    return {
      path: first.path,
      size: first.size,
      etag: first.etag ?? "",
      version: first.version,
      binary: false,
      mediaType: first.mediaType ?? null,
      bytes: new TextEncoder().encode(first.text),
      text: first.text,
    };
  }
  const bytes = new Uint8Array(first.size);
  let received = decodeInto(bytes, 0, first.dataB64 ?? "");
  let eof = first.eof;
  while (!eof) {
    const part = await client.call<ReadPart>("fs.read", { path, offset: received, version: first.version });
    abortIfNeeded(signal);
    received += decodeInto(bytes, received, part.dataB64 ?? "");
    eof = part.eof;
    if (!eof && part.dataB64 === "") throw new WorkspaceRpcError("internal", "the runtime returned an empty part", "fs.read");
  }
  const binary = first.binary ?? false;
  let text: string | null = null;
  if (!binary) {
    try {
      // Keep a byte order mark, as a single-part read does: saving must not drop it.
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      text = null;
    }
  }
  return { path: first.path, size: first.size, etag: first.etag ?? "", version: first.version, binary, mediaType: first.mediaType ?? null, bytes, text };
}

/**
 * Replace a file. `expectedEtag` is the content hash the edit was based on
 * (null: the file must not exist yet; undefined: unconditional, only for an
 * explicit "overwrite"). Content larger than one part is staged with
 * `fs.writePart` and committed at once, so the workspace never sees half a file.
 */
export async function writeRemoteFile(
  client: WorkspaceRpcClient,
  path: string,
  content: string | Uint8Array,
  expectedEtag: string | null | undefined,
): Promise<RemoteWriteResult> {
  const rel = remotePath(path);
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  if (bytes.length > FS_MAX_FILE_BYTES) throw new WorkspaceRpcError("too_large", `${rel} is larger than ${FS_MAX_FILE_BYTES} bytes`, "fs.write");
  const condition = expectedEtag === undefined ? {} : { expectedEtag };
  if (bytes.length <= FS_PART_BYTES) {
    const body = typeof content === "string" ? { text: content } : { dataB64: encodeBase64(bytes) };
    return client.mutate<RemoteWriteResult>("fs.write", { path: rel, ...body, ...condition });
  }
  const uploadId = `upload-${crypto.randomUUID().replace(/-/g, "")}`;
  for (let offset = 0; offset < bytes.length; offset += FS_PART_BYTES) {
    const part = bytes.subarray(offset, Math.min(bytes.length, offset + FS_PART_BYTES));
    await client.mutate("fs.writePart", { uploadId, offset, dataB64: encodeBase64(part) });
  }
  return client.mutate<RemoteWriteResult>("fs.write", { path: rel, uploadId, size: bytes.length, ...condition });
}

/**
 * Search file contents. Aborting `signal` cancels the search on the
 * runtime (`fs.cancel`) and rejects with an `AbortError`; results of a
 * search nobody waits for are never delivered.
 */
export async function searchRemote(client: WorkspaceRpcClient, query: RemoteSearchQuery, signal?: AbortSignal): Promise<RemoteSearchResult> {
  abortIfNeeded(signal);
  const searchId = `search-${crypto.randomUUID().replace(/-/g, "")}`;
  const params: Record<string, unknown> = { searchId, query: query.query, regex: !!query.regex, caseSensitive: !!query.caseSensitive };
  if (query.path) params.path = remotePath(query.path);
  if (query.maxResults) params.maxResults = query.maxResults;
  const request = client.call<RemoteSearchResult & { searchId: string }>("fs.search", params);
  if (!signal) return request;
  return new Promise<RemoteSearchResult>((resolve, reject) => {
    const abort = () => {
      void client.call("fs.cancel", { searchId }).catch(() => undefined);
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    request.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(abortError());
        else resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(signal.aborted ? abortError() : error);
      },
    );
  });
}

function abortError(): Error {
  const error = new Error("The request was cancelled");
  error.name = "AbortError";
  return error;
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function decodeInto(target: Uint8Array, offset: number, base64: string): number {
  const binary = atob(base64);
  if (offset + binary.length > target.length) throw new WorkspaceRpcError("conflict", "the file grew while it was being read", "fs.read");
  for (let index = 0; index < binary.length; index++) target[offset + index] = binary.charCodeAt(index);
  return binary.length;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
