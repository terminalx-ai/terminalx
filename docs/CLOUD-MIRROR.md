# Local mirror of a cloud workspace (PRO-25)

An optional, one-way copy of a cloud workspace's files on this computer, so
local tools (an editor, a search tool, a diff viewer) can read them. It is
off until a person turns it on for a workspace, on that device.

It is a copy of files and nothing else. Commands, agents and terminals still
run in the cloud workspace. It is not a backup: it holds only the files
listed below, and only as of the last successful sync.

## Status

| Part | Where | State |
| --- | --- | --- |
| The file set: `mirror/1`, `mirror.manifest` | `src-tauri/src/remote/mirror.rs`, `src-tauri/src/mirror_rules.rs` | built |
| Reading the manifest on the client | `packages/portable/src/workspaceMirror.ts` | built |
| Writing the mirror: staging, verify, publish, divergence | desktop, Rust | next PR |
| The sync loop, the opt-in, states and labels in the UI | desktop, TypeScript | next PR |

## Direction

Cloud to local, only.

- Nothing is ever uploaded from the mirror. There is no code path that sends
  mirror content to the workspace.
- A local edit is never overwritten silently either: see Conflicts.
- Two-way sync is a separate piece of work and is not started.

## What is mirrored

Git decides. For every repository in the workspace (`git.repositories`), the
runtime lists `git ls-files --cached --others --exclude-standard`: tracked
files, and untracked files Git does not ignore. A workspace with no
repository has nothing to mirror.

Left out, and counted by reason in the manifest's `skipped`:

| Reason | What |
| --- | --- |
| `secret` | Credential and key files by name: `.env` and `.env.*` (not `.env.example` and the like), `.envrc`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.kdbx`, `*.ppk`, `*.tfstate`, `*.tfvars`, `id_rsa` and its siblings, `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`, `credentials.json`, `secrets.*`, and anything under `.ssh`, `.aws`, `.gnupg`, `.kube`, `.azure`, `.gcloud`, `.docker`. Tracked or not. |
| `excluded` | The repository's own `.terminalx-mirror-ignore` at its root (gitignore syntax). |
| `symlink` | Every symbolic link. Links are never followed and never recreated locally. |
| `unsupported` | Sockets, devices, nested repositories and submodules, `.git` itself. |
| `tooLarge` | Files over 32 MiB, the largest `fs.read` serves. |

The rules are in `mirror_rules.rs`, compiled into both the runtime and the
desktop. The runtime applies them when it lists, so excluded bytes are never
read; the desktop applies them again before it writes.

The runtime's own credentials (its API credential, agent logins, GitHub
tokens) live outside the workspace root and cannot appear in the file set.

More than 50,000 files makes the manifest `truncated`. A truncated manifest
is never published: the mirror fails with that reason instead of holding a
partial copy that looks whole.

## `mirror.manifest`

`Participate` authority: it lists what `fs.read` already serves to the same
caller. It takes `{ manifestId?, cursor? }` and nothing else; unknown
parameters are refused.

```jsonc
→ { "manifestId": "6f1c…",                       // same files at the same versions give the same id
    "repositories": [{ "repo": ".", "branch": "main", "head": "<40 hex>" }],
    "entries": [{ "path": "src/main.rs", "size": 812, "version": "…", "executable": false }],
    "next": 2731,                                 // or null on the last page
    "total": 9120, "totalBytes": 48211003,
    "skipped": { "secret": 2, "excluded": 0, "symlink": 1, "unsupported": 0, "tooLarge": 0 },
    "truncated": false }
```

- `version` is `fs.stat`'s: size, modification time, inode and change time.
  It changes whenever the file is rewritten, without hashing the workspace
  on every scan.
- A page is at most 320 KiB. A later page names the first page's
  `manifestId`; when the files changed in between, or two minutes passed, it
  is `cursor_expired` and the client starts over (three times, then the scan
  fails as `unstable`).
- It runs off the connection's ordered loop, like `fs.search`.
- A runtime from before `mirror/1` does not grant the capability. The
  desktop then says the workspace's runtime is too old for a mirror.

## Where the mirror lives (next PR)

`<TerminalX home>/cloud-mirrors/<workspace id>/`, created by the app, 0700:

- `files/`: the mirrored tree.
- `mirror.json`: the ownership manifest: which workspace this is, every path
  the mirror wrote with the content hash it wrote, and the last successful
  revision.
- `staging/`, `journal.json`: a sync in progress.

The directory is chosen by the app, never by the person, and never by the
workspace. **No local path is sent to the workspace.** The only requests a
sync makes are `mirror.manifest { manifestId, cursor }` and
`fs.read { path, offset, version }` with workspace-relative paths. The
mirror's location exists only in the desktop's native side and its UI.

## When it syncs: never by waking compute (next PR)

- A sync runs only on a connection that is **already open** for another
  reason (the person has the workspace open). It subscribes to
  `onCloudConnected`; it never takes a connection lease, never opens a
  connection, and never asks for a resume.
- A stopped or archived workspace is not touched. The mirror says "Paused:
  the workspace is stopped" with its last successful revision.
- It does not keep a workspace awake either: `mirror.manifest` and `fs.read`
  are not activity, and with no lease of its own the connection still closes
  when the person leaves.
- On connect it scans once, then every 30 seconds while connected. An
  unchanged workspace answers the same `manifestId` and nothing is read.

## How a sync is applied (next PR)

1. Read the manifest. Compare with `mirror.json`.
2. Read each new or changed file with `fs.read` into `staging/`, and check
   its bytes against the content hash `fs.read` reported.
3. Check for divergence (below). If there is any, stop: nothing is written.
4. Write `journal.json` (what will be written and removed), then move each
   staged file into place by rename, remove files the mirror wrote that the
   workspace no longer has, and commit `mirror.json`.

Each file appears whole or not at all. The tree as a whole is not one
transaction: a crash in step 4 leaves the journal, and the next sync
finishes or redoes it. Nothing outside `files/` is ever written, a path is
refused if any parent inside the mirror is a symbolic link, and only paths
the mirror wrote are ever removed.

States: `off`, `paused`, `queued`, `syncing` (files and bytes so far),
`synced`, `failed` (with the reason), `diverged`. The last successful
revision is shown explicitly: the manifest id, each repository's branch and
commit, and the time.

## Conflicts (next PR)

The first version treats any local change as a conflict and resolves
nothing by itself.

- **Diverged** means: a file the mirror wrote was edited or deleted locally,
  or a local file sits at a path the workspace now has a file for.
- While diverged, the mirror is not updated at all, and the divergent files
  are listed.
- The person chooses, deliberately:
  - **Discard local changes**: the listed paths are replaced by the
    workspace's versions.
  - **Export, then discard**: the local versions are first copied to
    `exports/<time>/` beside the mirror.
- Local files the workspace has no file for, at paths it does not use, are
  left alone: never uploaded, never deleted, not a conflict.

## Labels (next PR)

Terminals are labelled by where they run: a local terminal opened in the
mirror runs on this computer; a cloud terminal runs in the workspace. The
"Synced" badge says files only: it never implies that anything runs locally
or that the workspace is backed up.

## Tests

- `src-tauri/src/remote/mirror_tests.rs`: the Git file set (tracked,
  untracked, ignored, deleted), secrets tracked and untracked, symlinks in
  and out of the workspace, a nested repository, the repository's own
  exclusions, several repositories, no repository, paging under one id, a
  changed listing refused as `cursor_expired`, no parameter that names a
  place, the capability.
- `src-tauri/src/mirror_rules.rs`: the secret names.
- `packages/portable/src/workspaceMirror.test.ts`: paging, restart, an
  incomplete or escaping manifest refused, a runtime without `mirror/1`.
