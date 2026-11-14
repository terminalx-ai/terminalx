# Project actions and preview URLs (PRO-155, PRO-363)

A project's saved **actions** (dev server, tests, lint) and **preview URLs** are edited in Settings → Projects → <project>, and saved as `actions` and `previewUrls` on the project in `$TERMINALX_HOME/projects.json` through `update_project`. Actions have their own Actions page. Preview URLs are a section of the project's General page, with no nav entry. Setting ids keep their old `repositories.*` names, so `terminalx://settings/repositories.actions` and `…/repositories.previewUrls` links still work.

## Editors

- `RepositoryActionsSettings` edits an ordered list: add, edit, hide or show, delete and reorder. The dialog has the name, a multiline command (⌘↵ saves), "Run after setup", "Allow several at once" and "Reset to terminalx.json". Reset appears only when a repository-file source is passed in. There's no icon field and no "Can run in": actions are local only.
- `RepositoryPreviewUrlsSettings` edits an ordered list of named HTTP(S) URL templates.
- Validation: a name is required and unique (after case and Unicode normalization, hidden actions included), and a command can't be empty. An action id is at most 64 characters (`action_runner::MAX_ACTION_ID`), because its run's tab is named after it.
- Both editors keep the draft and show the error when a save fails. Mount them with `key={project.path}`.

## Running an action

- `action_run(sessionId, actionId, restart?)` runs an action as a terminal tab of the session's local workspace. The desktop forwards it to the runtime (`runtime.pty.actionRun`), so the runtime decides every run, for ⌘R and for Run after setup alike. The tab gets the workspace's environment layers and port block (`TERMINALX_PORT`, `TERMINALX_PORTS`), plus what a setup script gets and `TERMINALX_ACTION_ID`.
- `action_states(sessionId)` lists each open action tab: running, or exited with the program's exit code.
- **Single instance.** With "Allow several at once" off, a second run returns the running tab, and the UI focuses it and offers to restart. A restart stops the old run and waits for its process group to exit, then starts a new tab. If it hasn't exited within 5 s, nothing starts and the error says "<name> is still stopping". Only that action waits; the others aren't held up.
- **Run after setup** actions start once per workspace: after its setup script succeeds for the first time or, with no setup script, as soon as the new workspace is created. A rerun of setup doesn't start them again.

## Run menu, ⌘R and ⌘K

The workspace header has a Run menu with the visible actions in saved order and their state, and an Open button that opens the first preview URL in a TerminalX browser tab, with the others in its menu. ⌘R runs the only visible action; with several, it opens the Run menu as a picker. ⌘K lists "Run <name>" for each visible action and "Open <name>" for each preview URL. Hidden actions are in neither. Cloud sessions show neither control.

## Preview URL ports

`expandPreviewUrl` fills in `$PORT` with the session's first port and `$PORT_1` … `$PORT_9` with the ones after it, from `workspace_ports(sessionId)`: the same block the workspace's terminals get. A literal URL needs no ports. A missing port, an unsupported variable, a non-HTTP(S) URL or embedded credentials give an error and open nothing. A literal dollar sign is written `%24`.
