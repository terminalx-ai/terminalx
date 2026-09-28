# Cloud workspace files (PRO-24)

Browse, edit and search a cloud workspace's files from the desktop. The
runtime (`terminalx-serve`) serves `fs/1` of `terminalx-workspace-rpc/1` over
the relay E2EE channel (PRO-13); the desktop's existing file tree, editor and
media viewer read and write through it. The checkout stays on the runtime:
the desktop never mounts, syncs or caches it on disk.

## Runtime: `src-tauri/src/remote/files.rs`

| Method | Authority | What |
| --- | --- | --- |
| `fs.list` | participate | One directory level. Entries carry `path`, `kind`, `size`, `modifiedMs`, `mediaType`; a symlink carries `symlink: true`, and one that leaves the workspace (or dangles) `escapes: true` and `kind: "symlink"`. Sorted by name; at most 5000 entries and a 384 KiB answer (`truncated`). Entry paths extend the path asked for, so a link to an ancestor is just another level. |
| `fs.stat` | participate | `version` (size, mtime, inode, ctime) always; `etag` (content hash) for files up to 4 MiB, or up to 32 MiB with `etag: true`. |
| `fs.read` | participate | One part: `offset`, `length` ≤ 384 KiB. The first part carries `etag` and `binary`; every part carries `version`, and a later part asked with the first part's `version` is `conflict` if the file changed in between. A small UTF-8 file comes back whole as `text`, anything else as `dataB64`. Files over 32 MiB are `too_large`. |
| `fs.writePart` | manage | Stage a part of a large write (`uploadId`, `offset`, `dataB64`) in a 0700 directory outside the workspace. Offset 0 starts over; a gap is refused. At most 4 uploads per device, 10 minutes idle. |
| `fs.write` | manage | Replace a file at once from `text`/`dataB64` (≤ one part) or a staged `uploadId` of exactly `size` bytes. `expectedEtag`: a string must match the current content, null means the file must not exist, absent writes unconditionally. The file's mode is kept. A staged upload is used up by its commit, even a refused one. |
| `fs.search` | participate | Grep under `path`: literal or `regex`, `caseSensitive`, `.gitignore`d/hidden/binary files skipped, symlinks never followed. `maxResults` ≤ 1000, answer ≤ 384 KiB, ≤ 32 matches per line (`capped`). |
| `fs.cancel` | participate | Stop a search this connection started (`searchId`); the search answers with what it found and `cancelled: true`. A new search under the same id, or the connection closing, cancels too. |
| `fs.watch` / `fs.unwatch` | participate | `fs.changed { subscriptionId, paths }`, debounced. `.git`, the writer's temporaries and anything under an escaping link are left out. A burst of more than 1000 paths (or 128 KiB) is `paths: [], overflow: true`: re-read what is shown. At most 8 per connection. |
| `fs.rename`, `fs.delete`, `fs.mkdir` | manage | Unchanged from PRO-13. |

Why parts of 384 KiB and not zuse's 4 MB (#647): the relay Cell accepts frames
up to 1 MiB, and a part is base64'd in the JSON answer and again around the
sealed frame. 384 KiB leaves room for both; `rpc.hello` reports it as
`limits.fsPartBytes` (and `fsMaxFileBytes`).

Paths are resolved only here: lexically (no root, drive or `..`), then
through symlinks, and a path that resolves outside the workspace root is
`path_forbidden`. A write or mkdir through an existing symlink must resolve
inside; a delete removes the link, never its target.

`fs.search` runs off the connection's ordered loop (`host.rs` `SLOW_METHODS`)
so `fs.cancel`, reads and terminal traffic are not held behind it.

## Client: `packages/portable/src/workspaceFiles.ts`

`readRemoteFile` (parts under one version, restarted once if the file changes
midway), `writeRemoteFile` (inline or staged parts, then one conditional
commit; every part and the commit keep their `clientRequestId` across
resends), `searchRemote` (an `AbortSignal` sends `fs.cancel`) and
`remotePath` (refuses absolute and `..` paths before sending).
`WorkspaceRpcClient.watchFiles` resubscribes after a reconnect and reports
`null` then: changes made while away were not seen.

## Desktop

- `src/lib/workspaceFiles.ts`: a `FileSource` is the local checkout (the Tauri
  commands, unchanged behaviour) or a cloud workspace over its connection.
  Cloud editors carry the source key (`EditorEntry.source`); the source is
  registered while the workspace's page is open and disposed when it closes:
  searches are cancelled and answers still on their way are dropped
  (`StaleRequestError`).
- `src/components/cloud/CloudFiles.tsx`: the Files view of a cloud session —
  `FileTreeView` and `EditorSplit` on the source, plus search. A participant
  gets read-only editors.
- `EditorPane`: a cloud save is conditional on the `etag` the buffer was read
  at. A refusal shows **Not saved** with *Overwrite with mine* (conditional on
  the version now there), *Discard mine and reload* and *Copy mine*; nothing is
  ever last-write-wins. A clean buffer follows `fs.changed`; a dirty one gets
  the changed-on-disk banner. After a reconnect the file is re-checked.
- Unsaved cloud buffers survive reconnects (the view stays mounted) and the
  page closing (kept in memory by editor id, restored and re-checked against
  the runtime when shown again). Closing the editor or changing account or
  organization drops them.
- `MediaPane`: cloud media is read in parts into an object URL (CSP
  `media-src` allows `blob:`), up to 32 MiB.
- Git badges in the tree come from `git.status`, re-read on change notifications.

## Tests

- `src-tauri/src/remote/files_tests.rs`: parted reads and the version check,
  binary/media detection, an agent's edit refused as a conflict, staged
  writes (idempotent parts, per-device uploads, mode kept, nothing visible
  midway), symlink escapes in list/read/stat/search/watch, bounded search,
  cancellation, watch caps, no temporaries in notifications.
- `packages/portable/src/workspaceFiles.test.ts`, `src/components/editor/CloudEditor.test.tsx`,
  `src/components/cloud/CloudFiles.test.tsx`.
- `src-tauri/serve/tests/relay_e2e.rs` `cloud_files_…` through the real relay
  (`scripts/remote-runtime/e2e.sh`).
