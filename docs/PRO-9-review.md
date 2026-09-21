# PRO-9 review

Implemented admin provider replacement, validation and disconnect across the current desktop and its existing SaaS contracts. The backend now preserves the provider-account ownership anchor across disconnect, blocks provisioning during repair/cleanup, retains secret access while dependent operations need it, and finalizes revocation durably. No new HTTP endpoints were introduced.

## Review locations and dependency readiness

- Desktop: `raccoon/swift-bronze-mole`, base `526399f243811071de17ad3eeb8a474e3689848a` (includes PRO-7 #145 and PRO-10 #141).
- SaaS companion: `pro-9-provider-controls` in `/Users/pareshdudhat/code/ai/terminalx/terminalx-saas/.raccoon/worktrees/pro-9-provider-controls`.
- SaaS main `82144ba` did not contain required PRO-8/PRO-11 behavior. The isolated branch has local dependency merge `74eefc0`, incorporating `pro-11-durable-cloud-jobs-server` and PRO-8 protected credentials. PRO-8 and PRO-11 have since merged upstream (#93 and #94); the companion PR contains only PRO-9 changes above those dependencies.
- This report records the implementation validation before the user requested publication and merge. Completed targeted checks below have saved logs; subsequent PR checks record validation against current main.
- Original sibling SaaS and legacy working trees were not modified. Legacy provider dialog and SaaS service were inspected and reused. No applicable AGENTS.md was found in the changed trees; the legacy AGENTS.md was read before its reference inspection.

## Acceptance criteria and evidence

| Requirement | Implementation / validation | Coverage limit |
| --- | --- | --- |
| Admin-only replace, validate and disconnect; activate only after validation | Existing native secure-entry and consent flow; server authorization; safe admin version/account metadata; invalid/mismatched replacement preserves saved credential. Desktop, Rust and database tests; admin/member/error screenshots. | UI fixture simulates native entry. Native bridge uses HTTP fixtures, not live credentials. |
| Wrong-account replacement preserves ownership | Account hash survives disconnect; reconnect and rotation reject a different account, including retained resources. Original identity and cleanup/migration action are shown. Backend reconnect regression and mismatch UI evidence. | Account migration is not implemented; the original connection remains bound to its account. |
| Disconnect blocks provisioning with retain/destroy decision and remaining charges | Existing disconnect route accepts a validated disposition. Migration 0064 persists it. Tracked workspaces, runtimes, build resources, archives and unresolved references remain visible; quotes are estimates and missing rates are unknown. Failed cleanup is durable/retryable. | Unsupported destruction, archives and templates require explicit retention or provider-console cleanup; the service does not declare them destroyed. |
| Cleanup precedes secret revocation | Shared provider lock serializes requests/rotation/in-flight calls. Existing admitted workspace/runtime/build jobs can finish or clean up while new requests are blocked. Background finalizer waits for dependencies and disposition, clears generic and Machine0 envelopes, and retains account anchor. | No live-provider deletion or revocation was performed. |
| Invalidation directs members to organization admins; changes audited | Credential-invalid faults commit attention-required state and block both generic and Machine0 paths. Member UI exposes admin action without key controls. Administrative connect/rotate/revalidate/disconnect and finalization events are recorded. | Real provider expiry timing is not exercised. |
| Parent follow-ups | Machine0 mirror preserves `operationsBlocked`; pending-disconnect integration tests exercise actual protected runtime/build runners and reject new operation requests; migration includes column, CHECK and journal entry. | Existing admitted jobs are deliberately allowed to resolve after disconnect begins. |

## Completed checks

After integrating current main: desktop TypeScript/check passed **75 files, 471 tests**, desktop build passed, native provider tests passed **20 tests**, and the expanded backend suite passed **29 files, 325 tests** with API TypeScript. Cleanup-result visibility was adjusted for current private-workspace rules and verified to remain hidden from another administrator.

- Desktop `pnpm check`: **71 files, 434 tests passed**, including TypeScript. After final UI copy/cancel-code adjustment, focused ProviderControls/AccountPairingDisclosure checks passed **9 tests**; final `pnpm build` passed (existing large-chunk warning).
- Rust `cargo test --manifest-path src-tauri/Cargo.toml cloud_workspaces --lib`: **20 passed**. Default CLT SDK failed in the native transcription dependency; retry using installed Xcode MacOSX26.5 SDK and clang succeeded. No repository SDK settings were changed.
- SaaS API TypeScript and ESLint for all changed/new TypeScript files passed.
- Isolated PostgreSQL 18 on `127.0.0.1:55439`, database `pro9`: all migrations applied, including 0064; column and disposition CHECK verified.
- Focused backend suite: **28 files, 312 tests passed**, run serially against isolated DB. After final resource-inventory expansion, connection/runtime lifecycle suites passed again: **55 tests**. An earlier parallel run exposed shared-fixture interference; final runs used `--no-file-parallelism`.
- `git diff --check` passed in both worktrees.
- [Computer-use evidence](screenshots/pro-9/README.md): ten screenshots and accessibility snapshots cover admin/member, same-account rotation, account mismatch, invalid key, revoked running job, explicit disposition, failed cleanup, repair and completed cleanup.

Backend test command (local Bun 1.3.2 installed under `/tmp/pro9-bun`):

```sh
CLOUD_PROVIDER_CONNECTION_TEST_DATABASE_URL=postgresql://pro9@127.0.0.1:55439/pro9 \
CLOUD_WORKSPACE_TEST_DATABASE_URL=postgresql://pro9@127.0.0.1:55439/pro9 \
CLOUD_SESSION_RUNTIME_TEST_DATABASE_URL=postgresql://pro9@127.0.0.1:55439/pro9 \
/tmp/pro9-bun/node_modules/.bin/bun run --cwd apps/api test --no-file-parallelism \
src/services/cloudProviderConnections src/services/cloudWorkspaces src/services/sessionRuntimes \
src/controllers/desktop/cloudProviderConnections.test.ts
```

Native test environment:

```sh
SDKROOT=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.5.sdk \
CC=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang \
CXX=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang++ \
cargo test --manifest-path src-tauri/Cargo.toml cloud_workspaces --lib
```

Saved local logs: `/tmp/pro9-desktop-check.log`, `/tmp/pro9-ui-tests.log`, `/tmp/pro9-desktop-build.log`, `/tmp/pro9-rust-tests.log`, `/tmp/pro9-saas-typecheck.log`, `/tmp/pro9-saas-lint.log`, `/tmp/pro9-resource-lint.log`, `/tmp/pro9-saas-focused.log`, `/tmp/pro9-final-lifecycle-tests.log`.

## Release blockers and limits

PRO-8 and PRO-11 are merged upstream. The companion SaaS change and migration 0064 must be present before enabling the controls; the existing SaaS deployment runner applies migrations before service rollout. The desktop disables disconnect when resource/version metadata is absent. The SaaS monorepo precommit hook failed in unrelated web suites with Firebase `auth/invalid-api-key` due to missing test configuration; scoped commits used the validated API checks instead. Live-provider and integrated native-desktop-to-SaaS acceptance remain unverified; current evidence consists of controlled production-component UI checks, native HTTP-fixture tests and backend database/worker tests with synthetic encrypted credentials.

Validation used no real keys or resources and did not mark Linear done. This session did not start another issue. The user subsequently requested PR publication, merge, and workspace removal.

## Exact changed paths

Desktop paths are relative to the desktop worktree; SaaS paths are relative to the isolated SaaS worktree. The SaaS list is the PRO-9 delta above dependency merge `74eefc0`.

### Desktop

- [docs/PRO-9-review.md](../docs/PRO-9-review.md)
- [docs/screenshots/pro-9/README.md](../docs/screenshots/pro-9/README.md)
- [docs/screenshots/pro-9/account-mismatch.png](../docs/screenshots/pro-9/account-mismatch.png)
- [docs/screenshots/pro-9/account-mismatch.txt](../docs/screenshots/pro-9/account-mismatch.txt)
- [docs/screenshots/pro-9/admin-rotation.png](../docs/screenshots/pro-9/admin-rotation.png)
- [docs/screenshots/pro-9/admin-rotation.txt](../docs/screenshots/pro-9/admin-rotation.txt)
- [docs/screenshots/pro-9/cleanup-completed.png](../docs/screenshots/pro-9/cleanup-completed.png)
- [docs/screenshots/pro-9/cleanup-completed.txt](../docs/screenshots/pro-9/cleanup-completed.txt)
- [docs/screenshots/pro-9/cleanup-failed-retry.png](../docs/screenshots/pro-9/cleanup-failed-retry.png)
- [docs/screenshots/pro-9/cleanup-failed-retry.txt](../docs/screenshots/pro-9/cleanup-failed-retry.txt)
- [docs/screenshots/pro-9/cleanup-pending.png](../docs/screenshots/pro-9/cleanup-pending.png)
- [docs/screenshots/pro-9/cleanup-pending.txt](../docs/screenshots/pro-9/cleanup-pending.txt)
- [docs/screenshots/pro-9/cleanup-repaired.png](../docs/screenshots/pro-9/cleanup-repaired.png)
- [docs/screenshots/pro-9/cleanup-repaired.txt](../docs/screenshots/pro-9/cleanup-repaired.txt)
- [docs/screenshots/pro-9/disconnect-decision.png](../docs/screenshots/pro-9/disconnect-decision.png)
- [docs/screenshots/pro-9/disconnect-decision.txt](../docs/screenshots/pro-9/disconnect-decision.txt)
- [docs/screenshots/pro-9/invalid-key.png](../docs/screenshots/pro-9/invalid-key.png)
- [docs/screenshots/pro-9/invalid-key.txt](../docs/screenshots/pro-9/invalid-key.txt)
- [docs/screenshots/pro-9/member.png](../docs/screenshots/pro-9/member.png)
- [docs/screenshots/pro-9/member.txt](../docs/screenshots/pro-9/member.txt)
- [docs/screenshots/pro-9/revoked-running-job.png](../docs/screenshots/pro-9/revoked-running-job.png)
- [docs/screenshots/pro-9/revoked-running-job.txt](../docs/screenshots/pro-9/revoked-running-job.txt)
- [scripts/fixtures/pro-9/index.html](../scripts/fixtures/pro-9/index.html)
- [scripts/fixtures/pro-9/main.tsx](../scripts/fixtures/pro-9/main.tsx)
- [src-tauri/src/cloud_workspaces.rs](../src-tauri/src/cloud_workspaces.rs)
- [src-tauri/src/commands.rs](../src-tauri/src/commands.rs)
- [src-tauri/src/lib.rs](../src-tauri/src/lib.rs)
- [src/components/settings/AccountTab.tsx](../src/components/settings/AccountTab.tsx)
- [src/components/settings/ProviderControls.test.tsx](../src/components/settings/ProviderControls.test.tsx)
- [src/components/settings/ProviderControls.tsx](../src/components/settings/ProviderControls.tsx)
- [src/lib/api.ts](../src/lib/api.ts)

### SaaS companion

- `apps/api/docs/pro-9-provider-controls.md`
- `apps/api/drizzle/0064_provider_disconnect_disposition.sql`
- `apps/api/drizzle/meta/_journal.json`
- `apps/api/src/controllers/console/cloudProviderConnections.ts`
- `apps/api/src/controllers/desktop/cloudProviderConnections.test.ts`
- `apps/api/src/controllers/desktop/cloudProviderConnections.ts`
- `apps/api/src/db/schema/cloudProviderConnections.ts`
- `apps/api/src/index.ts`
- `apps/api/src/services/cloudProviderConnections/cloudProviderConnectionService.integration.test.ts`
- `apps/api/src/services/cloudProviderConnections/cloudProviderConnectionService.ts`
- `apps/api/src/services/cloudProviderConnections/providerDisconnectFinalizer.ts`
- `apps/api/src/services/cloudProviderConnections/providerResources.ts`
- `apps/api/src/services/cloudProviderConnections/providerSetupStatus.ts`
- `apps/api/src/services/cloudProviderConnections/runCloudProviderOperation.ts`
- `apps/api/src/services/cloudProviderConnections/types.ts`
- `apps/api/src/services/cloudWorkspaces/CloudWorkspaceController.ts`
- `apps/api/src/services/cloudWorkspaces/CloudWorkspaceError.ts`
- `apps/api/src/services/cloudWorkspaces/CloudWorkspaceWorker.ts`
- `apps/api/src/services/cloudWorkspaces/cloudWorkspace.integration.test.ts`
- `apps/api/src/services/cloudWorkspaces/index.ts`
- `apps/api/src/services/cloudWorkspaces/types.ts`
- `apps/api/src/services/sessionRuntimes/CloudSessionRuntimeBuildController.ts`
- `apps/api/src/services/sessionRuntimes/CloudSessionRuntimeBuildWorker.ts`
- `apps/api/src/services/sessionRuntimes/CloudSessionRuntimeController.ts`
- `apps/api/src/services/sessionRuntimes/CloudSessionRuntimeWorker.ts`
- `apps/api/src/services/sessionRuntimes/sessionRuntimes.integration.test.ts`
- `apps/api/src/ts/Types.ts`
