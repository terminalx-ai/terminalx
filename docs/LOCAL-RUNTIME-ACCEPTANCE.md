# Disposable packaged acceptance for #467

This is a prepared procedure, not a record of passing native acceptance. Use
only a coordinator-assigned named macOS guest. Do not install, launch, quit or
replace the host's running TerminalX application, and do not copy user accounts,
provider histories, tokens, keychains or configuration into the guest.

## Artifact and environment

Build an app bundle with the existing development config, the actual target and
profile, the normal helper build hook, and development signing. Override only the
disposable bundle identity/name and deep-link scheme (`com.terminalx.next.issue467.dev`,
`TerminalX 467 Dev`, `terminalx-467-dev`) so keychain and Launch Services lookups
cannot select another issue's app. Use a fresh `dev.terminalx.issue467.*` account
keychain service through the existing debug-only environment override. Disable updater
artifact generation in a disposable build config when no release signing key is
available; do not read or use a production updater key. Build the existing
computer-use helper's development variant for the dev config's resource mapping.
Record the Git head, dirty diff, app and helper SHA-256 hashes, bundle identifiers,
code-signature verification results and entitlements. Development/ad-hoc signing
is not production signing or notarization evidence.

Transfer only the built test bundle and fixture scripts to the assigned guest.
Use a new private guest HOME, TERMINALX_HOME, CLAUDE_CONFIG_DIR and ZDOTDIR. The
fixture CLI from `scripts/remote-runtime/fake-claude` exercises the real Claude
harness without an account; label its results as fixture-provider evidence.
Preserve a minimal PATH to system tools and the fixture executable. Do not use
an installed provider account to make the fixture appear authenticated.

Launch the disposable app with this explicit environment. Store the test app
outside /Applications under an unambiguous disposable directory. Capture the
actual desktop PID, owner PID/epoch, agent PID and shell PID using authenticated
control discovery in this private home. Never infer process survival solely
from a visible window, a stored status or a restored transcript.

## Lifecycle observations

Before the interactive cases, run `python3 scripts/local-runtime/native-lifetime.py
<bundled-terminalx-serve> --allocated-disposable-guest` inside that guest. This
starts the actual AppKit owner in new private homes and requires idle shutdown
and authenticated stop-all to exit without any mouse or keyboard event. Never
run this opt-in native UI regression on the host. Its JSON result includes the
helper hash and process exit timings; a headless suite does not cover this loop.

1. Start a delayed fixture turn and a plain terminal that writes numbered lines
   to its PTY and a disposable output file. Retain the starting event/byte cursor.
2. Quit with the first-choice dialog dismissed: verify the app remains attached
   and both processes continue. Repeat, select keep-running, and verify that the
   desktop process actually exits, the same owner and child PIDs remain, and
   exactly one tray remains with truthful counts and Open / Stop all actions.
3. Exercise the owner tray’s Quick Chat action during cold window startup and
   reattachment. Its first accepted dispatch after service registration must
   visibly open Quick Chat without repeating the action or using a delayed retry.
   Record this against the exact built head, separately from normal Open TerminalX.
   Let output and a permission request arrive while detached. Record background
   notification delivery if the guest grants notifications. Reopen through the
   tray; compare the full retained byte sequence and canonical turns against the
   numbered writer, confirm a pending permission can be answered exactly once,
   and verify there is no false recovery/closed-session message.
4. Test Cmd+Q, application menu, tray Quit and main-window close against the saved
   policy. Explicit Stop all and quit must override keep-running. A cancelled
   cleanup/quit dialog must not stop work. Confirm child process groups exit,
   not just that the window disappears. Repeat with saved stop-all policy.
5. Close the last view while a real shell remains alive: it must retain the
   runtime even when silent. With no live shell, turn, question, queued work or
   enabled standing automation, observe the configured idle grace and actual
   owner exit. Reopen and verify retained terminal tails are history, not live PIDs.
6. While a turn runs, exit the test desktop, replace only its disposable bundle
   with the next built test artifact, and reopen. Verify the same immutable owner
   executable/hash, PID/epoch and child PIDs, uninterrupted numbered output and
   retained questions. This checks bundle replacement. It does not by itself
   prove the signed production updater's install/relaunch path; record that
   separately when suitable signed test artifacts and an isolated updater feed
   are available. Never point the installed app at such a feed.
7. Terminate only this disposable owner (and separately log out/reboot only the
   assigned guest when authorized). On reopening, assert honest interruption and
   a new epoch; old pending answers and permits must fail. Do not claim machine
   restart coverage from a normal detach or an executable rename.

## Provider and authorization limits

Repeat lifecycle/permission cases with disposable ACP and OpenCode fixtures and
with supported real CLI configurations where credentials can be provisioned
without copying real accounts. Fixture tests cannot establish provider keychain
access, notification permission, real provider timeout behavior or production
signing. Record these gaps explicitly; no partial result closes #467.

The mobile transport remains window-owned. Test its owner-backed observation,
revocation, driver lease and permission cases while the disposable window is
attached, then confirm disconnection on quit. A phone being unable to connect
while closed must not remove the owner's pending permission card.

Record failures with exact step, expected/observed result, process identities and
bounded logs from the disposable home. Leave the guest and artifacts available
for independent security/review until the coordinator releases them.
