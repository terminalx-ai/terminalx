# Layered configuration (PRO-136, PRO-140)

TerminalX resolves supported keys in this order, highest first:

1. System managed policy (root-owned; fixed paths below)
2. `<primary checkout>/.terminalx/settings.local.json` (ignored and untracked)
3. `<primary checkout>/.terminalx/settings.json` (shared in Git)
4. `$TERMINALX_HOME/settings.json` and existing private user environment
5. Built-in defaults

| Layer | File | Schema | A problem in it |
| --- | --- | --- | --- |
| Managed | macOS `/Library/Application Support/TerminalX/managed-settings.json`, Linux `/etc/terminalx/managed-settings.json` | repository schema | blocks every launch that resolves it |
| Repository local | `<primary checkout>/.terminalx/settings.local.json` | repository schema | malformed, tracked or not ignored: blocks launches in that repository; a key it may not set is ignored |
| Repository shared | `<primary checkout>/.terminalx/settings.json` | repository schema | malformed: the whole file is ignored; a key it may not set is ignored |
| User | `$TERMINALX_HOME/settings.json` | user schema | each invalid entry keeps its last good value |
| Defaults | built in | — | — |

`TERMINALX_HOME` defaults to `~/.raccoon`. Each linked workspace inherits the
**primary checkout's** files, including local overrides; checking out a branch in
a workspace does not switch its executable configuration. Separate clones have
separate trust decisions. File changes apply on the next resolution/launch and
refresh the open Settings view automatically. Existing processes are not restarted.

## Supported keys and dependency scope

The native registry in `store/configuration.rs` explicitly declares repository,
managed-lock, and trust eligibility. Merely adding a field to `Settings` never
makes it repository-configurable.

| Key | Repository | Managed | Behavior |
| --- | --- | --- | --- |
| `branchPrefix` | Yes, requires trust when shared | Yes, locked | Prefix for new workspace branches and cleanup classification. Use a prefix such as `team/`, with ASCII letters, digits, hyphens, underscores and slash-separated components. An empty file value disables prefix-based branch cleanup. |
| `environment` | Yes, requires trust when shared | Yes, each supplied variable is locked | A map of literal variable names to strings; never expanded by TerminalX. Existing reserved-name and size limits apply. |
| `worktreeDir` | No | No | Existing machine-specific user setting; repository files cannot move filesystem/deletion boundaries. |

`$schema` is editor metadata in every file and never a setting. Unknown or
forbidden repository keys are ignored and logged without their values.
A malformed shared document is ignored with a warning. A malformed local document
or unreadable/invalid managed policy blocks resolution, rather than silently
removing overrides or administrative restrictions. Files are limited to 1 MiB;
symlinks and nonregular files are refused. Saves refuse malformed destinations,
preserve unrelated user keys, and replace files atomically. Unix files are written
owner-only. Repository-local saves add `/settings.local.json` to
`.terminalx/.gitignore` and verify that the file is untracked and ignored. Commit
that ignore rule alongside the shared settings.

Example shared file:

```json
{
  "branchPrefix": "team/",
  "environment": {
    "API_URL": "https://development.example.test",
    "LOG_LEVEL": "debug"
  }
}
```

A managed document uses the same shape. All eligible values it supplies are
locked; deleting a managed key restores inheritance. Managed policy is provisioned
outside the app at a fixed system location:

- macOS: `/Library/Application Support/TerminalX/managed-settings.json`
- Linux: `/etc/terminalx/managed-settings.json`

`TERMINALX_HOME`, `RACCOON_HOME` and repository files cannot relocate or replace
this policy. The file **and every ancestor directory** must be owned by root and
have no group/world write bits (typically file `0644`, directories `0755`). macOS
extended ACLs are conservatively refused, including read-only ACLs. Each component
is opened without following symlinks, and permissions are checked on the opened
descriptor before reading. An unsafe, unreadable or malformed policy fails closed;
a genuinely absent policy beneath protected parents means no managed overrides.
The old user-home `managed-settings.json` is ignored. Windows managed policy is
deferred until administrator ACL validation is implemented; it never falls back
to user-writable policy storage.

Existing Keychain user variables are below shared values. Existing repository
Keychain variables are local overrides: above shared, below explicit local-file
entries and managed entries. Their values never enter the config read APIs.
Private variables should continue to be saved through Settings → Environment.
File environment is authored explicitly; the app does not copy Keychain secrets
into repository files. A managed variable cannot be changed/deleted through that
existing editor. The Layered configuration view shows its lock and effective source.

**Scope:** the user layer is saved through `settings::file` (PRO-140). Reading
files-to-copy and setup/archive script settings from repository files is
follow-up work (PRO-131, PRO-149). `scripts` is deliberately unsupported and
cannot run. Changing any bytes, including an unsupported script field or a
`$schema`, invalidates a trust decision for effective shared settings.

## Schemas

Two JSON schemas are generated from the native validators and committed:

- `schemas/settings.schema.json` describes the user file. It comes from the
  settings template in `store/settings/file.rs` and the constraint table in
  `store/settings/schema.rs` that the file validator itself reads, so the schema
  and the app cannot disagree about a choice, range or type. Each key's
  description is its Settings row's (`schemas/settings-descriptions.json`, kept
  equal to `src/components/settings/settingsRegistry.tsx` by a test). The app
  bundles it and keeps `$TERMINALX_HOME/schemas/settings.schema.json` current at
  every start, writing only when the bytes differ.
- `schemas/repository-settings.schema.json` describes repository files and the
  managed policy: the keys of the registry in `store/configuration.rs` and the
  limits its validator reads. It is published from the main branch.

A file the app writes gets a `$schema` unless it already has one: the user file
`"./schemas/settings.schema.json"`, the local repository file
`"https://raw.githubusercontent.com/terminalx-ai/terminalx/main/schemas/repository-settings.schema.json"`.
The committed shared file does not: builds before PRO-140 count `$schema` there
as an unsupported setting and would warn every teammate on each resolve. Add
that reference to the shared file yourself once everyone runs a build that has
it. A `$schema` the person wrote is left alone. After changing a setting's type,
choices, range, registry entry or row description, regenerate both with
`TERMINALX_WRITE_SCHEMAS=1 cargo t --lib store::settings::schema` in `src-tauri`;
the same test fails while the committed files are stale.

## Problems, sources and reset

Every settings file's first problem is reported structured: its dotted key (none
when the JSON itself does not parse), its 1-based line, the parser's or
validator's own words, and what it does (`lastGood`, `ignoredKey`, `fileIgnored`,
`blocked`, as in the table above). Problems, statuses and events never carry a
value. The user file's status also lists the dotted keys it sets (`setKeys`),
names only, and its path with the home directory written as `~`.

`configuration_resolve` gives each value its `layers`: every layer that supplies
the key, highest first, the first being `source`. Environment values are
`value: null, redacted: true` in every layer. Private Keychain variables appear
as a user or repository-local layer by name.

Settings' row menu offers **Reset to inherited value** for a key the user file
sets: `reset_user_setting` removes that key (and any object it leaves empty) and
nothing else, so the value falls through to the defaults. Like every save, it is
refused while the file has an error: "Can't save: ~/.raccoon/settings.json has an
error on line N …". **Settings files** (`settings_files_list`) lists managed,
repository local, repository shared, user and defaults with each path, whether it
exists, its number of top-level keys, Git state (`committed`, `ignored`,
`untracked`) for repository files and its first problem.

## Consent and execution

The desktop asks before creating a session that would use shared environment or
branch settings. Environment variables can cause programs to execute code, and a
branch prefix changes which branches cleanup recognizes, so both require consent.
The prompt identifies the primary checkout, file, affected keys and their values.
Environment values are masked initially; Reveal/Hide stays in the native dialog
and never approves or resets its deadline. Values are escaped and bounded, with
an explicit truncation notice for large values. The prompt warns about code-loading
variables such as `NODE_OPTIONS`, `BASH_ENV` and `GIT_SSH_COMMAND`. Only its
explicit Trust button grants consent. Cancel, close, timeout, and a stale file hash
grant nothing. The existing bounded native-confirmation service prevents overlapping
prompts and computer-use approval of its own requests.

A decision is private, bound to the canonical Git common directory and SHA-256 of
the **exact bytes**. The file is read again after approval and at launch. Editing
it cannot reuse approval for previous bytes. CLI, phone, unattended starts and
existing-tab restarts fail with a Settings instruction when trust is needed; they
cannot grant it themselves. No shell or agent is launched by a trust review.
Config read/write commands also never grant trust implicitly. Only the primary
checkout's shared file is eligible for that decision.

## Read and write surfaces

Settings → General → Layered configuration selects a repository, shows sources and
locks, and defaults writes to User. Eligible keys offer “Save for this repository
(local)” and a shared-file destination, plus reset of the selected layer. Shared
writes still require trust. Saving or granting trust requires a compatible attached
local runtime; an older owner returns a restart instruction. Nonrecursive file
watchers refresh the open view after user, shared, local, managed, private-environment
index or trust-ledger changes, including atomic replacements and newly created
configuration directories. Watchers close with the editor/window. Draft edits
survive refresh unless a managed lock takes effect. Refresh is also available
manually if watching is unavailable.

Changing the branch prefix affects future branch names and cleanup classification;
it does not rename existing workspace branches. Existing branches with the old
prefix may need manual branch cleanup, and renaming those workspaces may fail
until the old prefix is restored. Automatic prefix migration is outside this change.

```text
terminalx config show --json
terminalx config show --project my-repository --json
```

The webview's `configuration_resolve` and the paired phone's
`configuration.resolve` return the same `values`, `registry`, `warnings` and
`trust` structure; the webview's values also carry `layers`. Phone requests take an optional opaque `projectId`, never a
filesystem path, and are advertised only by a runtime with
`layeredConfiguration: 1`. Each value has `source`, `locked`, and `redacted` flags.
Environment entries return `value: null, redacted: true` on every read surface.
The CLI and phone have no configuration-write or trust-grant endpoint.
