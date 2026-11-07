# Introduction and announcements (PRO-241)

The existing welcome screen shows three text-only slides until Finish or Skip.
`terminalx.intro.v1` in device-local webview storage saves each step and completion.
Help → Introduction (also in the command palette) opens that same welcome view.
Replaying never clears completion, including when the app quits during a replay.
Down advances; Enter advances the focused slide or activates the focused button.

The sidebar footer reads public release copy through the native
`announcements_current` command, which calls
`GET /announcements/current?appVersion=<desktop app version>` using the shared
account HTTP client. It sends no account token, organization, device identifier,
read receipt or dismissal to the service. React renders the title/body as text;
only HTTPS links without credentials are accepted. Responses are bounded to 16 KiB.
The server returns a current announcement or JSON `null`; malformed/missing app
versions receive 400. Stable releases exclude older prereleases. Publication,
expiry, optional exclusive maximum version and NEW expiry use server time.

Polling belongs to AppShell, so hiding the sidebar does not pause it. It runs on
startup, hourly, and when focus/online returns after a missed hour. An offline
request is quiet. A dismissed id stays hidden on this device across restarts;
a newly published id remains eligible. Reading successfully opens the changelog
and records the id/time in `terminalx.announcements.v1`; dismiss also acknowledges
it. NEW requires both the server flag and an unread local receipt. Storage changes
synchronize other open windows. Deleting app data resets these device preferences.

## Integration and release order

The paired server work lives in `terminalx-server-pro-241`, branch
`pro-241-announcements`. There is no migration or admin UI. Edit the versioned
`apps/api/src/services/announcements/source.ts` and publish a new id for new copy.
Corrections retain the id. The response is public; do not put private content in
it. `requiredFlag` optionally targets a capability in the active organization's
server-reported `cloud.flags`; absent/false flags and signed-out users hide that
announcement. No flag can grant permissions. PRO-252 still owns flag definitions,
rollout configuration and administration; this slice adds no flag implementation.

**PRO-244 native privacy support is a release dependency.** `src/lib/dataPrivacy.ts`
is the byte-identical shared prerequisite from PRO-244 head
`3925adead48556c97d71d0e3bed3f1dd77e410c9`, not another privacy policy. Polling fails
closed until its native status is ready and disabled, clears on activation, and
rejects stale in-flight replies. The existing `account::cloud_agent()` gains the
PRO-244 send-time middleware when that branch lands. Merge/runtime integration
must preserve that middleware before enabling this feature. No production toggle
is changed here. Older runtimes without privacy status do not poll.

Land the reviewed, validated server endpoint and PRO-244 privacy prerequisite
before releasing the desktop feature. A missing endpoint fails quietly and retries.
The server's normal merge poller owns deployment; never start a duplicate deploy.

## Checks

- `pnpm exec tsc --noEmit`
- `pnpm vitest run --maxWorkers=2`
- `pnpm build && pnpm test:webkit-intro` (Playwright WebKit must already be installed)
- `cargo clippy --all-targets -- -D warnings` and `cargo test -- --test-threads=2`
- Paired API: `vitest run src/routes/announcements.test.ts --maxWorkers=2`, API
  typecheck, and ESLint on the changed files.

The WebKit script exercises Down, Enter, resume after reload, Finish, Skip,
command-palette replay and quitting a replay. The native menu registry Vitest
assertion verifies Introduction is present in Help. Native tests cover URL
encoding and the server response contract. Vitest covers polling, receipts,
privacy revocation, stale replies, capability targeting and version boundaries.
