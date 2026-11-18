# Runtime Environment info foundation (PRO-203)

This change supplies the runtime report and an unplaced, reusable popover. It does not complete PRO-203 or claim a curated image is installed. It selectively adapts `origin/raccoon/pro-203-curated-provider-images` and the owned-file foundation from `raccoon/pro-203-pro-203-runtime-environment-repo`, without merging either branch; current privacy, RPC and collaboration behavior is retained.

## Runtime contract

`environment/1` negotiates `environment.report` and `environment.cancel`. Both accept exactly `{requestId: <UUID>}`; UUIDs are normalized. Callers cannot supply commands, paths, tools or environment values. Reports are live reads, never idempotent mutations or persisted image manifests. Existing attachment, capability, authority and participant member-list gates apply; Manage authority is required: desktop/owner connections may read, listed viewers and drivers may not. The report retains the current privacy admission ticket and checks its validity, attachment disconnection and authorization between tools and every 50 ms while a tool runs. `environment.report` runs off the relay socket task, so cancellation remains responsive.

One report runs per runtime process. A new request waits up to one second for cleanup/the slot. Each caller may hold one live request and at most one cancelled request still cleaning up; additional requests receive `environment_busy`. The UI retries `environment_busy` once after 350 ms with a fresh request ID. Cancellation belongs to the requesting attachment and UUID. At most 128 early cancellations are retained for 30 seconds to cover cancellation before a spawned report task starts. Every tool has a two-second deadline, 4096-byte stdout ceiling and bounded 250 ms cleanup. Timeout, cancellation and dropped futures kill the owned process group (Unix) while the child remains unreaped. Cleanup never signals a cached group ID after wait has reaped the child. There is no shell interpolation in production probes.

The fixed tools are Node.js, npm, pnpm, Python 3, git, gh, jq, ripgrep, git-lfs, tmux and vim. Each is invoked directly with fixed version arguments from approved directories, in order: `/opt/terminalx/agent-cli/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`, `/bin`. Python uses `python3`. The report deliberately does not search inherited PATH or user/project shim directories. `missing` means no candidate in these directories; a present executable that fails, emits unexpected output or exceeds limits is `error`/`timeout`, never an invented version. Candidate directory entries are checked with `symlink_metadata` before execution: missing interpreters/loaders, denied permissions and dangling executable symlinks report `error`. Any spawn failure after finding a candidate is an error, including a race where it disappears. A broken earlier executable is not hidden by falling back to another installation.

Each subprocess has a cleared environment, a fixed PATH containing only those directories, `/nonexistent` HOME, `/` working directory, no stdin and discarded stderr. npm configuration/update checks and pnpm update checks are disabled; Corepack network downloads and prompts are disabled. On macOS, `/usr/bin/git` and `/usr/bin/python3` are skipped unless Command Line Tools exist or the bounded, noninteractive `xcode-select -p` check succeeds; the probe never launches the developer-tools installer. No inherited credential, project configuration, environment dump, executable path, stderr or raw version output is returned. Only bounded numeric versions (one optional tmux letter suffix), fixed IDs and statuses leave the runtime.

The response is `{version: 1, observedAt: <runtime milliseconds>, tools: [...]}`. There is exactly one row per allowlisted tool: `{id, status: "installed", version}` or `{id, status: "missing" | "error" | "timeout"}`. The frontend validates the entire set and strips additional fields. No telemetry or persistence is added.

## Reusable UI contract

`EnvironmentInfo` accepts an existing `WorkspaceRpcClient`, its current `WorkspaceConnectionState`, and a required `scopeKey` identifying account, organization and workspace. The integrating caller must change that key on identity replacement, subscribe to connection/member changes, and decide rollout visibility. The component has no SaaS flag dependency and is not mounted by this change. It never requests activation or wakes compute. Reports are requested only while opened and connected with the capability and readable membership.

The Radix popover uses existing Button and theme tokens, an accessible title, tool description list, Close and Refresh controls, and a bounded scroll area. States cover loading, unavailable/unsupported runtime, disconnected, revoked access, missing tools, timeout, errors, and stale reports. Errors use fixed copy rather than raw RPC messages. Reports older than 60 seconds by runtime or receipt time, from another generation/epoch, or retained across disconnect/refresh failure are marked stale. Scope changes reset the surface; client replacement hides prior results. Closing, unmounting, identity replacement, runtime replacement or access loss cancels in-flight work and ignores late replies.

## Remaining ticket acceptance and owner decisions

- Provider/image owners: build Hetzner snapshots, Docker/Boat images; pin the agreed tool versions; include the agreed desktop packages; rebuild on releases/schedule; retire images; handle Boat persistence/reinstallation. No image pipeline or provider files are changed here.
- SaaS/provider owners: image ID per offering, missing-image install-at-create fallback, rollout/kill-switch wiring and API delivery. No SaaS files or production flags are changed here.
- Provider acceptance: Docker tests proving every required tool is on PATH for each provider, real new-workspace/resume tests, and before/after first-boot measurements remain unperformed.
- Placement owners: integrate the link beside the organization install script and project setup script using the correct runtime, identity scope and activation policy. No header/settings/project placement is included.
- Product/design owners must settle the supplied screen differences: Bun/Rust additions versus the ticket tool set, npm/git-lfs/vim omissions, differing desktop package lists, and Chrome in the image versus the install script. This foundation uses the ticket's 11-tool inventory and adds no base-image summary or desktop claims. The opened popover is not drawn in the supplied screens; its layout/states are provisional existing-component composition, not a claim of screen matching. A material placement/design difference must be resolved before that UI integration proceeds.
- Native/design certification remains: real attached-runtime transport, account/workspace switching, cancellation/revocation under native lifecycle, keyboard/focus/viewport behavior and visual comparison against all three linked screens. This foundation uses the screen descriptions and differences supplied in the task; no visual match is asserted.

## Verification

Run at repository root:

```sh
pnpm vitest run src/lib/environmentInfo.test.ts src/components/cloud/EnvironmentInfo.test.tsx
pnpm exec tsc --noEmit
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib remote::environment:: -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib remote::server::environment_tests:: -- --test-threads=1
```

The Rust environment tests exercise real installed executables as well as controlled process fixtures: sanitized output, cleared environment, size/deadline limits, authorization cancellation, attachment-scoped cancellation, and missing-interpreter/permission/dangling-symlink regressions. Server tests check handshake, namespace and member gates. These tests are foundation evidence, not provider-image or final native acceptance.

Avoid the broad `environment` Cargo filter in this restricted run: it also selects existing `cloud_environment` fixture tests that invoke local Git push. Those fixtures are outside this foundation and were not changed.
