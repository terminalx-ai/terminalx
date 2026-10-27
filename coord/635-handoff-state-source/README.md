# Issue 635 local source checkpoint

Scope: Continue in New Session sent-message/composer/Starting-dialog inconsistency.
Issue data: user-supplied full issue report and https://github.com/terminalx-ai/terminalx/issues/635. No provider/source-session contact or remote mutations.

Repository rules read: CONTRIBUTING.md and docs/CONTINUATION.md; no AGENTS.md found in this worktree or checked ancestor paths. User's explicit source-only restriction overrides the contribution guide's usual runtime/check requirements for this checkpoint. No subagents, host UI/browser/mic, tests, builds, app runtime, dependency installs/upgrades, shared cache changes, publishing, pushes, PRs, merges, issue closures or deployment performed. No changes to mobile selection 633 or helper delegation 634. Work stayed in the assigned issue worktree.

## Cause and change

The handoff seeded the destination composer before startup, then waited for confirmed provider delivery before removing that draft. The backend can expose the submitted message before that confirmation finishes. The dialog called both startup and the confirmation wait Starting. Additionally, pipeline preparation can append instructions to the submitted prompt, making the old success-time comparison against the seeded draft fail permanently.

Delivery now removes only the handoff-owned draft before invoking send, tracks composer edits throughout the pending send, and never clears subsequent edits on success. Failure restores the actual submitted prompt only when the composer has remained untouched. Editing and then clearing it, or typing text identical to the handoff while delivery is pending, is preserved. Error wording describes whether recovery text was restored or user edits preserved. The shared delivery path covers project moves without changing archive ordering.

An optional delivery callback marks the dialog's confirmation phase after startup. It displays Confirming delivery and explains the pending receipt, keeping Open New Session available. Creation/startup still displays Starting. Confirmed delivery closes the dialog; uncertain delivery still offers no automatic retry. The send call still requests confirmDelivery=true, and no retry/send loop was added. Launch failure retries the existing destination as before. Source session and launch selection semantics remain unchanged.

## Regression drafts (not executed)

- State tests: deferred creation, startup, and provider delivery with full-transcript prompt; no send before startup; empty handoff draft at send; one send; confirmed success.
- State tests: delayed failure restores recovery prompt; newer drafts survive success/failure, including edit-then-clear and text identical to the original prompt.
- State tests: pipeline-augmented prompt clears original composer seed and restores actual sent text on failure.
- Component tests: delayed creation shows Starting; delivery callback shows Confirming delivery; pending clicks cannot relaunch; confirmed success closes; uncertainty retains error/destination access without retry.
- Existing success/delivery expectations updated for pending composer emptiness and the new callback. Existing launch-failure, retry, dismissal/late-error, and move/archive tests remain as review targets.

Validation: source/diff inspection only. All regression additions are unexecuted drafts; compilation and runtime behavior are unverified this turn because issue 633 owns the heavy lane. Independent review should run the continuation and moveChat component/state tests, TypeScript checking, then the required repository checks in an authorized lane. No claim of passing tests or reproduced runtime behavior.
