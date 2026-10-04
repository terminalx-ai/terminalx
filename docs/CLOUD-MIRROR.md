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
| The sync loop, the opt-in, states and labels in the UI | `src/lib/cloudMirror.ts`, `src/components/cloud/CloudMirrorDialog.tsx` | built |

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

### Dangerous-content policy (decided)

The owner confirmed the strict policy on 2026-10-04. It is the rule, not a
default:

1. Anything that looks like a Git folder is refused.
2. Tool configuration that runs by itself is skipped, and shown to the
   person as not mirrored.
3. The executable bit is never written.
4. Every mirrored file carries the macOS quarantine flag.
5. A mirror can never be a project or an agent's folder.
6. The mirror is deleted when access is revoked, at sign-out, and when the
   workspace is deleted, by the recorded manifest only.

The tables below are how each point is carried out.

| Never mirrored | Why | Counted as |
| --- | --- | --- |
| Anything inside a folder that has `HEAD` and any other piece of a Git directory (`objects/`, `refs/`, `commondir`, `gitdir`, `config`, `config.worktree`), under any name, at any depth | It is a Git directory, or half of one: Git accepts a folder holding only `HEAD` and a `commondir` pointing at a sibling. Git run inside it obeys its config, which can name a command to run. A shell prompt, an editor's Git scan or an agent is enough to trigger it | `gitDirectory` |
| A file named `commondir` or `gitdir`, anywhere | It points Git at a directory elsewhere | `gitDirectory` |
| Agents: `.claude/`, `.codex/`, `.cursor/`, `.gemini/`, `.windsurf/`, `.continue/`, `.roo/`, `.kiro/`, `.amazonq/`, `.opencode/`, `.clinerules/`, `.factory/`, `.goose/`, `.agents/`, `.github/hooks/`, `.mcp.json`, `.cursorrules`, `opencode.json`, `.aider.conf.yml` | Agent settings, hooks and MCP servers: an agent opened there would run what they name | `toolConfig` |
| Editors: `.vscode/`, `.idea/`, `.zed/`, `.helix/`, `.run/`, `.devcontainer/`, `*.code-workspace`, `.nvim.lua`, `.exrc` | Tasks, run configurations and editor scripts that start on open | `toolConfig` |
| Hooks and shells: `.husky/`, `.githooks/`, `.pre-commit-config.yaml`, `lefthook.yml`, `.envrc`, `.direnv/`, `mise.toml` | Run by Git or by the shell on entering the folder | `toolConfig` |
| Other version control: `.hg/`, `.jj/`, `.sl/`, `.svn/` | Their tools obey these as Git obeys `.git` | `toolConfig` |
| Build tools: `.cargo/config.toml`, `.cargo/config`, `.yarnrc.yml`, `.yarnrc`, `bunfig.toml`, `.pnpmfile.cjs`, `.mvn/`, `gradle/wrapper/gradle-wrapper.properties` | Configuration that names commands, plugins or downloads the tool then runs | `toolConfig` |
| The executable bit | Every mirrored file is written `0644` | (always) |

**How names are compared.** The way the disk compares them, not by ASCII
lower-casing: Unicode case folding (the long s `ſ` is `s`, the Kelvin sign
is `k`, so `objectſ` is `objects` and `.vſcode` is `.vscode` on APFS) and
composed or decomposed forms alike. `pkg`, `PKG` and `Pkg` are one folder.

**The disk has the last word.** The rules above are this code's knowledge of
how the disk folds names, and that knowledge can be incomplete. So after
every publish the desktop lists what is really under `files/`, by the names
the filesystem gives back, and judges that: whatever the mirror wrote that
is, there, inside a Git directory, a pointer to one, tool configuration or
a secret is removed again, counted (`onDisk`), and never written again.
Only the mirror's own files are removed. The same check runs when a publish
fails part of the way, for the files that did land. A folder left holding nothing but
Finder's `.DS_Store` is removed with its files, so empty `objects/` and
`refs/` do not wait for a later `HEAD`.

And on this computer:

- Every mirrored file gets the `com.apple.quarantine` attribute on macOS.
- A mirror is never a project. The folder is refused as a local project and
  as an agent's working directory, in the app and in the CLI, with the
  reason. It is for reading.
- The rules are applied on the runtime when it lists and again on the
  desktop before it writes.

**What this does not do.** It lowers the risk of a hostile workspace; it
does not make the copy safe.

- Nothing in the copy is marked executable, and macOS asks before opening a
  quarantined file. It asks; it does not prevent. An HTML page, a
  `.terminal` file or a `.jar` opens once the person agrees.
- An editor or language server opened on the folder may build or index it:
  rust-analyzer runs `build.rs`, some linters load configuration written as
  code, a package manager may run install scripts. Opening the folder in
  such a tool runs the workspace's code on this computer.
- The lists are names known today. A tool that reads a configuration file
  not on them is not covered.

Not covered by the policy, and so still mirrored: `Makefile`,
`package.json` scripts, `CLAUDE.md`/`AGENTS.md`, build scripts, and any
other file that only does something when a person runs a command on it.
Point 5 (a mirror is never a project or an agent's working directory) is
what stands between those and an agent.

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

## When it syncs: never by waking compute

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
  unchanged workspace answers the same `manifestId` and nothing is read;
  only local changes are checked, which asks the workspace nothing.
- Turning the mirror on while the workspace is not connected copies nothing:
  it stays paused until someone opens the workspace.
- `src/lib/cloudMirror.ts` imports neither `retainCloudConnection` nor
  `wakeCloudConnection`. Its tests fail if either is called, and check that
  no timer is left once the connection is gone.

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
    workspace's versions. The choice covers what was there when it was
    made: a file edited again before the next sync is a new divergence.
  - **Export, then discard**: the local versions are first copied to
    `exports/<time>/` beside the mirror.
- Local files the workspace has no file for, at paths it does not use, are
  left alone: never uploaded, never deleted, not a conflict.
- The answer covers exactly the paths that were divergent when it was given.
  A change made afterwards is a new divergence.
- Turning the mirror off keeps the files. Removing the local copy is a
  separate, explicit choice, and it keeps `exports/`.

## When the copy is removed

The mirrored copy goes with the access to the workspace (point 6 of the
policy, decided):

- when the organization's list no longer has the workspace for this person:
  it was deleted, or it is no longer shared with them (role `none`);
- when the person leaves the organization;
- at sign-out, every mirror;
- when the app next sees a different account, or nobody, than the one the
  mirrors were made under: a sign-out while the app was closed, or a direct
  switch of account.

Whose the mirrors are is recorded as a hash in `cloud-mirrors/owner`. The
owner is the account's own id (the user and cloud profile), not the email,
which can change or be reused.

- **Not knowing is not a sign-out.** When the saved session cannot be read
  (a Keychain failure at launch), the account status says so
  (`sessionUnreadable`) and nothing is removed. Syncing stops until the
  account is known again. A signed-out status that only carries an error (a
  sign-in that timed out) is a real signed-out.
- **An owner file from before the id.** It holds the hash of the email. The
  claim is given the email too, only for this: a file that holds it for the
  same person is rewritten to the account id and their mirrors are kept. A
  file that holds anyone else's is another account's, as before.
- **No sync without a confirmed owner.** A workspace that connects syncs its
  mirror only after the claim for the signed-in account has succeeded. If
  the claim fails, nothing is read into the mirror; it is tried again the
  next time the account is reported, and a workspace still connected then
  starts.

The recorded hash is of the account id. It is
written when a mirror is turned on, so a mirror made in the middle of a
session has an owner too. Mirrors found with no owner recorded are nobody's:
they are removed, never adopted, even for the same address. Nobody signed in
cannot turn a mirror on.

Removal is by the record only (`cloud_mirror_purge`): every file the mirror
wrote, its staging, journal and record. A mirrored file the person edited is
their work and is moved to `exports/<time>/` instead of deleted. Files they
added to the folder and the copies they kept when resolving a divergence
stay. It connects to nothing. The dialog says so before the mirror is turned
on.

"Remove local copy…" in the dialog is different: it is the person's own
choice, asks again, and removes the whole mirrored tree.

## In the app

- **Opt-in:** the workspace menu on a cloud session's location chip has
  "Local mirror…". The dialog says what the mirror is and is not, that the
  files should be treated like a download, that no file is marked executable
  and macOS asks before opening one, that an editor or build tool opened on
  the folder may still run the workspace's code, that the folder cannot be a
  project or an agent's working directory, and when the copy is removed. It has "Turn on for this
  computer". Off is the default, per workspace, per device.
- **Not mirrored:** the dialog lists what was left out and why, from both
  sides: secrets, tool settings that run commands, folders Git would treat
  as a repository, names taken by another file on this disk, names too long,
  links, files over 32 MB.
- **State:** off, paused, waiting, copying (files so far), synced, failed
  (with the reason), local changes, or "runtime too old". The last
  successful revision stays on screen through a failure or a divergence:
  time, file count and size, and each repository's branch and commit "with
  the workspace's uncommitted files".
- **Divergence:** the divergent paths with what happened to each, and two
  buttons: "Keep a copy, then use the workspace's files" and "Discard my
  changes". Opening the dialog resolves nothing.
- **Off and remove:** "Turn off" keeps the files. "Remove local copy…" asks
  again, says that files the person added to the folder go too, and keeps
  the copies made when resolving.
- **Badge:** a chip in the session header, absent while the mirror is off.
  It says "Files mirrored" and its tooltip "A copy of files only; commands
  still run in the cloud workspace, and it is not a backup." It never says
  synced without "files", and never anything about running locally.
- **Terminals by location:** the new-tab menu says "Terminal · on this
  computer" in a local session and "Terminal · on the VM" in a cloud one.
  A terminal tab's own title is unchanged.

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
  configuration list, Git directories under any name and case, one split
  across two folders, names the disk folds (long s, Kelvin sign), one folder
  under three spellings.
- `packages/portable/src/workspaceMirror.test.ts`: paging, restart, an
  incomplete manifest refused, odd names left out and counted, a listing
  that never ends, a cursor that does not move, a runtime without
  `mirror/1`.
- `src/lib/cloudMirror.test.ts`: off does nothing; sync on connect and
  every 30 s; no connection opened and no wake; only a manifest request and
  relative paths are sent; divergence stops and resumes only on the person's
  answer; a failure keeps the last revision and retries; an old runtime;
  the copy removed on lost access, deletion and sign-out.
- `src/components/cloud/CloudMirrorDialog.test.tsx`: the opt-in and its
  wording, the revision, what is not mirrored, divergence resolved only by
  choice, off against remove, the chip's wording.
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
  a mirror refused as a project. On this machine's own filesystem: a Git
  directory split across two folders, long-s and Kelvin spellings, one
  folder under three spellings, the check of the disk after a publish
  taking back what landed in a Git directory, an edit after discard, a
  `.DS_Store` not keeping a folder alive, long s against `s` as one file.
