# Standalone guest WKWebView presentation control

The blank terminal seen by #627 now has a reproduction **outside TerminalX, xterm
and Tauri** in the assigned macOS VM. This is diagnostic evidence, not a product
fix or visual acceptance. No third control run is authorized or queued.

## Control and provenance

Source/artifact prepared by #232 at a6b7f7b9 in
`/tmp/tx232-wk-presentation-control-20261024/`, independently reviewed by coordinator,
then executed only by guest owner #627 in `local:tx-queue-232`. #232 never launched
this GUI on host or entered the guest. Product worktrees were unchanged.

`control-source-build.tgz` preserves complete Objective-C, HTML, Python launcher,
manifest and invocation. One opaque ordinary NSWindow; public default WKWebView
configuration except a nonpersistent data store and message logger. Local HTML,
no network/accounts, private HOME/TMPDIR, no GPU flags, Tauri or xterm. Equal 256x192
DOM/2D/WebGL2 content; a finite two-second rAF loop then stable visible result;
one synchronous center readback immediately after its first GL draw. Native timer
exits after25 seconds, launcher has a separately reported fallback watchdog.

Built arm64 on macOS27.0/26A428 with macOS26.5 SDK, minimum OS13.0. Host compilation,
JS/Python syntax checks and development ad-hoc signature verification passed; no
host GUI launch. Guest source/all11 file hashes, executable and signature were
verified by #627. Host compilation is not guest visual validation.

- Source archive SHA256: `212c28e0644036c7cc418f8547d5fa3ab7ad2573b2a266d5d236ed210e35d926`
- Executable SHA256: `4b65c925fc963415500cbba973c6c1be88a70a25178cf60090bba57ff496f0d7`
- Guest: macOS26.5.2 build25F84 arm64, hostname Apple-Virtual-Machine-1.local.
- UA reported AppleWebKit605.1.15 with compatibility Intel/Mac10_15_7 tokens; this
  is not an exact engine version or actual host-architecture declaration.

## Run01: preserved failure of observation

Private PID93270 ran and exited0, watchdogfalse. Shaders/link/readback succeeded,
85frames/2009ms. CUA exec buffered stdout until completion, so orchestration's
streaming assumption missed the live window. No exact-window or display capture.
This run is **visually inconclusive**. It does not count as a presentation pass.
`run01-missed-capture.tgz` SHA256:
`0ced6913b84e73963ea259162c1ba5396a2bdfd7d044c37b07fdbe5845ba164e`.

## Run02: one explicitly authorized corrective observation

Unchanged source/binary, fresh private output and PID93382. Owner used nonblocking
launch and independent identity-file lookup with capture commands prepared first;
there was no streaming-stdout assumption. Spawn2026-10-24T19:32:34.062467Z.

- Exact-window capture:19:32:40.135128–41.606771Z (spawn+6.073–7.544s).
- Full-display capture:19:32:41.607441–42.978841Z (+7.545–8.916s).
- Both lie within the prescribed5–15s interval, after draw completion.
- Both show green DOM/white text and yellow/blue2D with white cross correctly.
- The WebGL2 panel is white/blank: neither red triangle nor blue background appears.
- A notification in full display does not cover the GL panel; exact-window result
  also lacks GL imagery. Raw images are retained unchanged in the archive.

Context created; actual attributes alpha/antialias/depth/premultipliedAlpha true,
stencil/preserveDrawingBuffer false, default powerPreference. Both shaders compiled
and program linked with empty logs. Initial synchronous readback[255,0,0,255],
error0; drawing buffer256x192.93frames/2004ms, draw complete19:32:37.762Z. Native
25s deadline19:33:00.054Z, native exit00.057Z; launcher exit0/watchdogfalse/reapedtrue.
Owner confirmed only private control PID disappeared; existing approved/prior apps
91422/89559/88730/86208 remained unchanged. No restart or renderer change.

`run02-captured.tgz` SHA256:
`981afe07fdab7eaa75d77b0ab823817bebbc5a42d2a99456f6eb67ff0fbd2377`.
Host originals: `/tmp/tx627-control02-evidence/`,
`/tmp/tx627-control-capture02/window.png` and `display.png`.
The archive preserves source manifest, ledger, events, identity/completion,
capture metadata, timestamps and orchestration scripts.

## Interpretation and limits

This guest exhibits a WebGL drawing-versus-visible-presentation discrepancy in a
simple opaque default-public-settings WKWebView while DOM/2D presentation works.
TerminalX-specific CSS, xterm, Tauri and transparent-window embedding are not
necessary for **this control's** discrepancy. This makes a speculative TerminalX
renderer rewrite or CSS workaround unjustified on the current evidence.

Initial readback is not a measurement of the framebuffer at the later capture.
The result does not distinguish lost surface updates, default-buffer handling,
WebKit/driver/VM presentation behavior or all capture limitations. It does not
prove a compositor-only bug, a defect on physical macOS27, or absence of additional
TerminalX-specific bugs. The control uses different content/shaders/lifecycle and
attributes from xterm. It does not establish that every WebGL use on this VM fails.

Separate #627 demand capture established65 positive glyph draws and new synthetic
marker imagery while its app remained blank; its requested <=5s bound was not
certified (6.390s orchestration) and that deviation remains. The control neither
repairs nor erases that limitation, nor substitutes for #627 visual acceptance.

No safe product remedy follows. Retain this as a guest-environment presentation
limitation for validation planning and an upstream-ready minimal reproduction;
no report has been posted externally. Any further environment comparison needs
separate scope and is not queued. Both owners stopped experiments.

The physical memory cleanup+22.29% and faithful guest+68.46% failures are separate
and remain unresolved. No memory measurement, forced-GC acceptance, threshold
change or issue closure is implied.

## Evidence checks

#232 independently verified the corrective archive SHA256 and viewed both captured
images, ledger and runtime events. This documentation checkpoint adds no app code;
no application tests were run. Final-head full checks and independent review remain
required for an eventual completed issue. All three preserved archive hashes are
listed in manifest.json for offline verification.

## Existing renderer settings and alternate validation routes (source audit)

At this checkpoint no supported terminal-renderer preference or CLI renderer
selector was found in SettingsPage/settings components, terminal lifecycle, or
performance API. `terminalWebgl.ts` unconditionally attempts WebGL when a terminal
is shown. Existing DOM fallback is automatic on addon/context failure, or when a
hidden instance loses its budgeted context; it is not a selectable user mode.
Visible contexts are retried/recovered. In this guest WebGL creation succeeds and
lost/failed counters remain zero, so that fallback does not address silent blank
presentation. “Redraw terminal” replaces the addon and requests refresh; it does
not select DOM. Do not induce context loss, alter budgets or monkeypatch acquisition
to misrepresent that as an existing supported setting.

The repository's `scripts/webkit/harness.mjs` launches Playwright WebKit and
`tauri-stub.js` plus cloud/local-sharing stubs supply synthetic IPC. It can support isolated layout/fixture
regressions, but it is another browser/transport and cannot certify the native
203aa Chat-to-Terminal visual criterion. `terminalx-serve` is a supported headless
backend with no WebView (docs/HEADLESS-SERVE.md), so it cannot supply visible desktop
acceptance. Mobile/remote transcript rendering is a different client/path; chat,
buffer text, Inspector imagery or an external terminal cannot substitute for
visible pixels in the exact desktop app.

Thus no already-available app configuration was established that can complete
**default native** visual acceptance in this affected guest without a new change
or a separately authorized validation environment. A future explicit renderer
option, if independently designed/reviewed, would establish optional-configuration
acceptance only; it would not make the default WebGL failure pass. An independent
isolated macOS target capable of presenting default WKWebView WebGL could validate
the unchanged build, but no such target is verified or selected here, and neither
host GUI access nor changes to private GPU/profile settings are proposed.

This is a bounded source/docs assessment, not a request to run more controls or
implement a fallback. Both existing control runs remain the complete authorized
set. #232 also rechecked all11 artifact manifest files and raw result02 events plus
completion: expected readback, exit0, watchdogfalse, reapedtrue for PID93382.
