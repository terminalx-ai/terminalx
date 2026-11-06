# Repository action and preview URL editors (PRO-155)

This is the independent portion of [PRO-155](https://linear.app/procyonlabs/issue/PRO-155/add-actions-and-preview-urls-settings-pages-for-each-repository). At implementation time neither prerequisite had landed on `main`:

- **PRO-131**, per-repository settings, is open as [PR #804](https://github.com/terminalx-ai/terminalx/pull/804). The settings store and Repositories navigation are not available.
- **PRO-243**, named run actions and port blocks, is absent from `main`. There is no action runner, Run menu, Command-R binding or allocated local session port block to connect to.

The components are deliberately not mounted in Settings yet: showing a working Save button without the repository store would misrepresent persistence. No alternate browser-local settings store, repository file format, runner or port allocator is introduced. Full ticket acceptance remains pending those integrations.

## Components and integration contract

- `RepositoryActionsSettings` takes an ordered `actions` array and async `onChange`. It adds, edits, hides, shows, deletes and moves actions. Its dialog has inline validation, a searchable icon picker, a multiline command editor, Command-Enter (also Control-Enter), Run after setup and Allow several at once. Command text is preserved exactly; names are trimmed and must be unique after case/Unicode normalization, including hidden actions.
- `RepositoryPreviewUrlsSettings` takes an ordered `urls` array and async `onChange`. It adds, edits, deletes and moves named HTTP(S) URL templates with inline validation.
- Both parents must persist the new array and publish the result through the controlled prop before resolving `onChange`. Reject on failure; the editor retains its draft, displays the error and supports retry. Writes are serialized by disabling controls while a write is pending. Mount with `key={project.path}` so switching repositories discards that repository's draft.
- Supply Actions' optional `onReset` only when repository-file resolution is available. It must remove the local override, reread the repository file and publish the resulting actions before resolving. It must not write the repository file or silently substitute an empty list on a read error.
- `IconPicker` and `RepositoryIcon` are shared UI components, suitable for repository icon selection as well as actions. They use stable string IDs and a searchable, curated set of app icons. Unknown IDs render a fallback and are preserved until explicitly changed.
- The interfaces in `repositoryActions.ts` describe editor values only. Adapt them to the eventual Rust/config model; they do not establish a persisted schema. IDs identify entries across renames and reorder operations.

## Remaining wiring

Once PRO-131 lands, mount these editors under Settings → Repositories → project → Actions / Preview URLs and connect them to its native store. Reset additionally needs the repository-file configuration layer.

Once PRO-243 lands, use `visibleActions` in both the Run menu and action palette entries, preserving array order. Command-R's default is the first entry of that filtered list, or none when all are hidden. Pass the action's command, concurrent and run-after-setup choices to that ticket's runner.

For preview palette entries, label each `Open <name>` in saved order. At invocation time, call `expandPreviewUrl` with the **active session's** actual allocated ports, then open its returned URL using the existing TerminalX browser-tab path. Surface an expansion error without opening anything. Do not invent ports, reuse another session's block or treat cloud-forwarded loopback ports as local allocations.

The expansion contract uses `$PORT` and `$PORT_1` for the first port, `$PORT_2` for the second, and so on. Repeated variables and multi-digit indices work. Literal URLs require no allocation. Invalid/missing ports, unsupported variables, non-HTTP(S) URLs and embedded credentials return an error; a literal dollar sign must be encoded as `%24`. This is tested as a pure helper; active-session and browser integration is not yet implemented.

## Verification

Vitest covers the dialogs, inline validation, exact multiline command preservation, keyboard saves, cancellation, pending/failed writes, concurrent deletion, reset callbacks, ordering, visibility, icon search and URL expansion. The tests use controlled parents to exercise successful and failed persistence callbacks without pretending to implement the missing native store.

Screenshots show the real components and app styles in a temporary component fixture, rendered by headless Chrome inside a local Lume macOS VM. The fixture uses neutral example values and temporary React state; it is not a mounted Settings page or a persistence implementation.

| View | Light | Dark |
| --- | --- | --- |
| Ordered lists | [Light](screenshots/pro-155/lists-light.png) | [Dark](screenshots/pro-155/lists-dark.png) |
| Action dialog | [Light](screenshots/pro-155/action-light.png) | [Dark](screenshots/pro-155/action-dark.png) |
| Preview URL dialog | [Light](screenshots/pro-155/preview-light.png) | [Dark](screenshots/pro-155/preview-dark.png) |
