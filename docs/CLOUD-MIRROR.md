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
| Writing the mirror: staging, verify, publish, divergence, discard and export | `src-tauri/src/cloud_mirror.rs`, the `cloud_mirror_*` commands | built |
| The sync loop, the opt-in, states and labels in the UI | desktop, TypeScript | next PR |

## The workspace is not trusted

A cloud workspace runs agents, and a shared one runs other people's. What
it lists ends up in a folder on this computer that editors, shells and
other tools read. So the mirror treats the workspace as hostile:

- its file list, sizes and flags are checked again on this side;
- some content is never mirrored because of what a local tool would do
  with it (the policy below);
- "verified" in this document means **intact in transit**: the bytes
  written are the bytes the workspace served. It never means authentic or
  safe. A mirrored script is whatever the workspace says it is.

### Dangerous-content policy (defaults, for the owner to confirm)

These are the coordinator's defaults from the security review of
2026-10-04. They hold until the owner changes them.

| Never mirrored | Why | Counted as |
| --- | --- | --- |
| Anything inside a folder that has `HEAD`, `objects/` and `refs/`, under any name, at any depth | It is a Git directory. Git run inside it obeys its `config`, and `core.fsmonitor` names a command to run. A shell prompt, an editor's Git scan or an agent is enough to trigger it | `gitDirectory` |
| `.claude/`, `.codex/`, `.cursor/`, `.gemini/`, `.mcp.json`, `.cursorrules` | Agent settings, hooks and MCP servers: an agent opened there would run what they name | `toolConfig` |
| `.vscode/`, `.idea/`, `.zed/`, `.devcontainer/` | Editor tasks and run configurations that start on open | `toolConfig` |
| `.husky/`, `.githooks/`, `.pre-commit-config.yaml`, `lefthook.yml` | Git hooks | `toolConfig` |
| `.cargo/config.toml`, `.cargo/config`, `.envrc`, `.direnv/` | Build and shell configuration that runs commands | `toolConfig` |
| The executable bit | Every mirrored file is written `0644`. A script is readable, not runnable by double-click or by name | (always) |

And on this computer:

- Every mirrored file gets the `com.apple.quarantine` attribute on macOS,
  so opening one from Finder goes through Gatekeeper.
- A mirror is never a project. The folder is refused as a local project and
  as an agent's working directory, in the app and in the CLI, with the
  reason. It is for reading.
- The names are matched without regard to case, and by the rules in
  `mirror_rules.rs`, on the runtime when it lists and again on the desktop
  before it writes.

Not covered by the defaults, and so still mirrored: `Makefile`,
`package.json` scripts, `CLAUDE.md`/`AGENTS.md`, build scripts, and any
other file that only does something when a person runs a command on it. The
rule above (a mirror is never a project or an agent's working directory) is
what stands between those and an agent. **For the owner:** whether that is
enough, or whether more names should be left out.

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
| `toolConfig`, `gitDirectory` | The dangerous-content policy above. |
| `symlink` | Every symbolic link, and every file reached through a linked folder. Links are never followed and never recreated locally. Git lists what its index names, so a folder replaced by a link (`d -> .git`, `d -> .aws`) would otherwise serve another place's files under an innocent name. |
| `unsupported` | Sockets, devices, nested repositories and submodules, `.git` itself, and names a desktop cannot hold (a backslash, a drive letter). |
| `tooLarge` | Files over 32 MiB, the largest `fs.read` serves. |

The rules are in `mirror_rules.rs`, compiled into both the runtime and the
desktop. The runtime applies them when it lists, so excluded bytes are never
read; the desktop applies them again before it writes.

The runtime's own credentials (its API credential, agent logins, GitHub
tokens) live outside the workspace root. If the runtime's state directory
is ever inside it, everything under that directory is left out as `secret`.
Agent logins by name (`.claude/.credentials.json`, `.codex/auth.json`), the
GitHub CLI's `.config/gh/` and `.terraformrc` are secrets too.

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
- The client does not take the runtime's word for when to stop: it reads at
  most 1,000 pages and 50,000 entries, and refuses a cursor that does not
  move forward, a page of another listing and an empty page.
- A name the client could never ask for (a backslash, a drive letter, a
  `..`) is left out and counted, instead of failing the whole mirror.

## Where the mirror lives

`<TerminalX home>/cloud-mirrors/<organization id>/<workspace id>/`, created
by the app, 0700. Both ids are checked to be plain names before they become
directories:

- `files/`: the mirrored tree.
- `mirror.json`: the ownership manifest: which workspace this is, every path
  the mirror wrote with the content hash it wrote, and the last successful
  revision.
- `staging/`, `journal.json`: a sync in progress.
- `exports/<time>/`: local versions a person asked to keep.

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

## How a sync is applied

1. Read the manifest. Compare with `mirror.json`. What an earlier sync
   staged and never published is dropped here.
2. Read each new or changed file with `fs.read` into `staging/`. It is kept
   only if it is exactly as long as the manifest said and its bytes match
   the content hash `fs.read` reported. That shows it arrived intact, not
   that it can be trusted.
3. Check for divergence (below). If there is any, stop: nothing is written.
4. Check again that every staged file is there, the listed size and intact.
   Write `journal.json`. Remove files the mirror wrote that the workspace no
   longer has, then move each staged file into place by rename (`0644`,
   quarantined), and commit `mirror.json`.

Each file appears whole or not at all. The tree as a whole is not one
transaction, so two things can interrupt step 4:

- **It fails** (a folder in the way, a full disk). What did move is recorded
  as moved, the journal is removed, and the error is reported. The next sync
  sees every path as it is.
- **The app dies.** The journal is left. The next call consumes it once: a
  journaled file whose content is what was being written did arrive and is
  adopted; a removal that happened is recorded; everything else keeps its
  old record. Then the journal is gone.

In neither case is any path exempt from the divergence check afterwards, so
a local edit made in between is never overwritten.

Nothing outside `files/` is ever written. A path is refused if any parent
inside the mirror is a symbolic link, and so is the whole mirror if
`cloud-mirrors`, the organization's or workspace's directory, `files/`,
`staging/` or `exports/` is one: neither a write nor "Remove local copy"
follows a link. Only paths the mirror wrote are ever removed. A local folder
is never removed to make room for a file: the sync fails and says where.

### Bounds, enforced on this computer

The workspace's own limit and `truncated` flag are only its word.

| Bound | Value | When it is exceeded |
| --- | --- | --- |
| Files | 50,000 | the sync fails with the reason |
| Total size | 2 GB | the sync fails with the reason |
| One file | 32 MB | the sync fails with the reason |
| Free disk after the sync | 1 GB | the sync fails with the reason |
| A file's size against the manifest | exact | the file is refused when staged, and again before publish |
| Depth | 32 folders | the file is left out and counted |
| One name; the whole local path | 255 bytes; 1,024 bytes | the file is left out and counted |

### Names that are one file here

On a disk that folds case or Unicode form (APFS does both), two names from
the workspace can be one file. This is settled before anything is written:

- Two names equal after Unicode composition (and lower-casing, where the
  disk folds case): the first in path order is mirrored, the other is left
  out and counted. Composition is compared on every disk.
- A file where another entry needs a folder (`a` beside `A/x`, or `data`
  beside `data/x`): the first in path order stays.
- A rename in the workspace that only changes case is the workspace's
  change: the old file is removed first, then the new one is written. It is
  not a local file in the way.

What the desktop leaves out is reported per reason (`secret`, `toolConfig`,
`gitDirectory`, `collision`, `tooLong`, `invalid`), next to what the runtime
left out.

The native side is eight commands and holds no loop of its own:
`cloud_mirror_status`, `_enable`, `_disable`, `_check` (local changes only,
asks the workspace nothing), `_plan`, `_stage`, `_publish`, `_resolve`. None
takes a local path; the mirror's directory is derived from the two ids and
only reported back for the UI. A file that was rewritten with the same
content (an editor's save) is not a change: size and modification time are
compared first, and the content hash only when they differ.

## Conflicts

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
- The answer covers exactly the paths that were divergent when it was given.
  A change made afterwards is a new divergence.
- Turning the mirror off keeps the files. Removing the local copy is a
  separate, explicit choice, and it keeps `exports/`.

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
- Also there: a file behind a linked folder (into `.git` and out of the
  workspace), the bare-repository attack, tool configuration, the runtime's
  own state directory, a name with a backslash.
- `src-tauri/src/mirror_rules.rs`: the secret names, agent logins, the tool
  configuration list, Git directories under any name and case.
- `packages/portable/src/workspaceMirror.test.ts`: paging, restart, an
  incomplete manifest refused, odd names left out and counted, a listing
  that never ends, a cursor that does not move, a runtime without
  `mirror/1`.
- `src-tauri/src/cloud_mirror_tests.rs`: a first sync (nothing executable);
  remote create, edit and delete with local-only files left alone; content
  and size verified before anything moves; a publish that died reconciled
  once with a later local edit still a divergence; a publish that failed
  part way leaving no journal; local edit, delete and a file in the way
  stopping the sync; discard and export; a symbolic link as a parent and as
  a file; the mirror's own directories as links; secrets, tool
  configuration, Git metadata and escaping paths refused; an embedded Git
  directory, at once and assembled over two syncs; quarantine on macOS; the
  bounds, a size that lies, over-long names; Unicode forms, a file against a
  folder, a case-only rename; another workspace's record; off and removed;
  a mirror refused as a project.
