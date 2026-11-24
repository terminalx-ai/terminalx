# Runtime Environment info (PRO-203)

Environment info shows tool versions observed on a connected cloud workspace. The organization’s Environment settings place it beside Machine install script. The project’s Scripts settings open it from the existing Environment info control on the Setup card.

## Runtime contract

`environment/1` negotiates `environment.report` and `environment.cancel`. Both accept exactly `{requestId: <UUID>}`; UUIDs are normalized. Callers cannot supply commands, paths, tools or environment values. Reports are live reads, never idempotent mutations or persisted image manifests. Existing attachment, capability, authority and participant member-list gates apply; Manage authority is required: desktop/owner connections may read, listed viewers and drivers may not. The report retains the current privacy admission ticket and checks its validity, attachment disconnection and authorization between tools and every 50 ms while a tool runs. `environment.report` runs off the relay socket task, so cancellation remains responsive.

One report runs per runtime process. A new request waits up to one second for cleanup/the slot. Each caller may hold one live request and at most one cancelled request still cleaning up; additional requests receive `environment_busy`. The UI retries `environment_busy` once after 350 ms with a fresh request ID. Cancellation belongs to the requesting attachment and UUID. At most 128 early cancellations are retained for 30 seconds to cover cancellation before a spawned report task starts. Every tool has a two-second deadline, 4096-byte stdout ceiling and bounded 250 ms cleanup. Timeout, cancellation and dropped futures kill the owned process group (Unix) while the child remains unreaped. Cleanup never signals a cached group ID after wait has reaped the child. There is no shell interpolation in production probes.

The fixed tools are Node.js, npm, pnpm, Python 3, git, gh, jq, ripgrep, git-lfs, tmux and vim. Each is invoked directly with fixed version arguments from approved directories, in order: `/opt/terminalx/agent-cli/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`, `/bin`. Python uses `python3`. The report deliberately does not search inherited PATH or user/project shim directories. `missing` means no candidate in these directories; a present executable that fails, emits unexpected output or exceeds limits is `error`/`timeout`, never an invented version. Candidate directory entries are checked with `symlink_metadata` before execution: missing interpreters/loaders, denied permissions and dangling executable symlinks report `error`. Any spawn failure after finding a candidate is an error, including a race where it disappears. A broken earlier executable is not hidden by falling back to another installation.

Each subprocess has a cleared environment, a fixed PATH containing only those directories, `/nonexistent` HOME, `/` working directory, no stdin and discarded stderr. npm configuration/update checks and pnpm update checks are disabled; Corepack network downloads and prompts are disabled. On macOS, `/usr/bin/git` and `/usr/bin/python3` are skipped unless Command Line Tools exist or the bounded, noninteractive `xcode-select -p` check succeeds; the probe never launches the developer-tools installer. No inherited credential, project configuration, environment dump, executable path, stderr or raw version output is returned. Only bounded numeric versions (one optional tmux letter suffix), fixed IDs and statuses leave the runtime.

The response is `{version: 1, observedAt: <runtime milliseconds>, tools: [...]}`. There is exactly one row per allowlisted tool: `{id, status: "installed", version}` or `{id, status: "missing" | "error" | "timeout"}`. The frontend validates the entire set and strips additional fields. No telemetry or persistence is added.

## Settings placements

Both settings surfaces require the active organization’s explicit `cloud.environment-info.v1` key in the signed-in account projection and verified, disabled data privacy mode. The organization placement also requires management access and a template fetched for the current account context and provider. Without readiness, the machine script keeps its existing layout and the repository control opens its original setup help.

The app reuses the live cloud catalog for the current account and the existing connected client registry. The machine script matches the selected provider. The Setup card matches the local checkout’s GitHub origin to the repositories advertised by a workspace in the active organization. Local checkouts with an unknown origin or another Git host, and older workspace listings without repository identities, have no confirmed match. The selection excludes stopped, archived, deleting, restarting and preparation workspaces. It requires Manage authority, a current manager role when membership is reported, and the `environment/1` capability. The settings UI names the source workspace. When several qualify, workspace ID order gives a stable selection.

The settings read only existing connections. They never acquire a lease, attach, start a build or wake a workspace. The popover makes a report request on open or refresh and provides an unavailable message when no matching runtime is connected. Account, organization, project, provider, workspace, privacy and authorization changes drop the previous selection and its report.

The Radix popover uses the shared menu layer and theme, an accessible title, a tool description list, Close and Refresh controls, and a bounded scroll area. Reports older than 60 seconds by runtime or receipt time and reports retained across runtime generation, epoch or refresh failure are marked stale. Closing, unmounting, identity replacement, runtime replacement or access loss cancels in-flight work and ignores late replies.

## Design and remaining acceptance

- Screen 11.05 uses the Setup control for `setup.sh`. The existing Setup help stays available, including the project-variable link. Screens 12.12 and 14.14 place the machine entry under Cloud compute. The current app puts that editor in the organization’s **Environment** page, so the report sits there beside **Machine install script**. The screenshots specify the trigger, while the open state uses the shared app popover.
- The report supplies 11 tool observations and a timestamp. It has no OS version, image ID, template revision, image provenance, desktop package inventory, or evidence distinguishing image tools from runtime additions. Neither placement includes the screens’ Ubuntu base image line or claims that a running workspace reflects the current script, draft or published build. The report includes npm, git-lfs and Vim from the ticket, and has no rows for the screens’ Bun, Rust, Xvfb or VNC mentions. The ticket and 14.14 differ on whether Chrome belongs to the image or install script. Chrome and the window manager remain unverified.
- Provider and SaaS acceptance remains open for curated Hetzner snapshots, Docker and Boat images, pinned tools, desktop packages, per-offering image IDs, missing-image fallback, rebuild/retirement, and Boat persistence/reinstallation. Per-provider PATH tests, curated-image before/after first-boot measurements, new-workspace and resume certification, and native attached-runtime and full design comparison remain open. The audit records earlier Boat-only runtime-image fallback and timing work under PRO-46.
- The native account-projection whitelist is owned by the lead. Desktop tests explicitly enable the key with fixture data.

## Verification

Run at repository root:

```sh
pnpm install --frozen-lockfile && pnpm exec tsc --noEmit && pnpm vitest run src/components/cloud/EnvironmentInfo.test.tsx src/components/settings/OrganizationEnvironment.test.tsx src/components/settings/RepositoryScriptsTab.test.tsx
pnpm vitest run src/lib/environmentInfo.test.ts
pnpm build
node scripts/webkit/repository-scripts.mjs
node scripts/webkit/environment-info.mjs
node scripts/webkit/environment.mjs
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib remote::environment:: -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib remote::server::environment_tests:: -- --test-threads=1
```

The Rust environment tests exercise real installed executables as well as controlled process fixtures: sanitized output, cleared environment, size/deadline limits, authorization cancellation, attachment-scoped cancellation, and missing-interpreter/permission/dangling-symlink regressions. Server tests check handshake, namespace and member gates. These tests are foundation evidence, not provider-image or final native acceptance.

Avoid the broad `environment` Cargo filter in this restricted run: it also selects existing `cloud_environment` fixture tests that invoke local Git push. Those fixtures are outside this foundation and were not changed.
