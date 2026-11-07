# Layered configuration (PRO-136)

TerminalX resolves supported keys in this order, highest first:

1. `$TERMINALX_HOME/managed-settings.json` (read-only in the app)
2. `<primary checkout>/.terminalx/settings.local.json` (ignored and untracked)
3. `<primary checkout>/.terminalx/settings.json` (shared in Git)
4. `$TERMINALX_HOME/settings.json` and existing private user environment
5. Built-in defaults

`TERMINALX_HOME` defaults to `~/.raccoon`. Each linked workspace inherits the
**primary checkout's** files, including local overrides; checking out a branch in
a workspace does not switch its executable configuration. Separate clones have
separate trust decisions. File changes apply on the next resolution/launch; this
change does not add watchers or restart existing processes.

## Supported keys and dependency scope

The native registry in `store/configuration.rs` explicitly declares repository,
managed-lock, and trust eligibility. Merely adding a field to `Settings` never
makes it repository-configurable.

| Key | Repository | Managed | Behavior |
| --- | --- | --- | --- |
| `branchPrefix` | Yes, requires trust when shared | Yes, locked | Prefix for new workspace branches and cleanup classification. Use a prefix such as `team/`, with ASCII letters, digits, hyphens, underscores and slash-separated components. An empty file value disables prefix-based branch cleanup. |
| `environment` | Yes, requires trust when shared | Yes, each supplied variable is locked | A map of literal variable names to strings; never expanded by TerminalX. Existing reserved-name and size limits apply. |
| `worktreeDir` | No | No | Existing machine-specific user setting; repository files cannot move filesystem/deletion boundaries. |

Unknown or forbidden repository keys are ignored and logged without their values.
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
outside the app. This is an application policy, not protection against programs
already able to modify the user's files; admins must deploy filesystem protections
appropriate to their installation.

Existing Keychain user variables are below shared values. Existing repository
Keychain variables are local overrides: above shared, below explicit local-file
entries and managed entries. Their values never enter the config read APIs.
Private variables should continue to be saved through Settings → Environment.
File environment is authored explicitly; the app does not copy Keychain secrets
into repository files. A managed variable cannot be changed/deleted through that
existing editor. The Layered configuration view shows its lock and effective source.

**Dependency check:** PRO-131 (#804), PRO-140 (#812), and PRO-149 (#808) were open
and absent from `origin/main` at implementation. This standalone increment uses
the existing environment service and branch settings. Files-to-copy integration,
setup/archive script fields and runners, comprehensive preference migration,
settings-schema publication, per-row sources throughout Settings, and file watchers
remain with those changes. `scripts` is deliberately unsupported and cannot run;
this PR does not duplicate their editors or storage. Changing any bytes, including
an unsupported script field, invalidates a trust decision for effective shared
settings.

## Consent and execution

The desktop asks before creating a session that would use shared environment or
branch settings. Environment variables can cause programs to execute code, and a
branch prefix changes which branches cleanup recognizes, so both require consent.
The prompt identifies the primary checkout, file, and affected keys. Only its
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
local runtime; an older owner returns a restart instruction. Refresh reloads file changes without discarding them.

```text
terminalx config show --json
terminalx config show --project my-repository --json
```

The webview's `configuration_resolve` and the paired phone's
`configuration.resolve` return the same `values`, `registry`, `warnings` and
`trust` structure. Phone requests take an optional opaque `projectId`, never a
filesystem path, and are advertised only by a runtime with
`layeredConfiguration: 1`. Each value has `source`, `locked`, and `redacted` flags.
Environment entries return `value: null, redacted: true` on every read surface.
The CLI and phone have no configuration-write or trust-grant endpoint.
