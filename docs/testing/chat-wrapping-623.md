# Chat plain-text wrapping (#623)

The regression runs the built application through `scripts/webkit/harness.mjs`,
with synthetic events at the Tauri bridge. It exercises the real transcript
projection, `Chat`, `TurnBlock`, `LinkedText` and Markdown rendering.

```sh
pnpm build
pnpm exec playwright install webkit
node scripts/webkit/chat-wrapping.mjs
```

The check is also included in `pnpm test:webkit-layout`. It asserts rendered
Range rectangles fit the text area, bubbles and the conversation do not
horizontally overflow, and DOM text and selected text equal the source. The
fixture includes 200 box-drawing separators, 200 underscores, an unbroken
identifier, paragraphs, blank lines, indentation, a link, an image and a fenced
code block. Code must retain its own horizontal scrolling.

The 16 cases cover prompt, absorbed mid-turn and queued messages in chat and
document layouts, main and floating frontends, resizing and CSS zoom at 150%.
Main widths include the configured native minimum of 760px; floating widths
reach 360px. The main sidebar remains open.

On a **disposable macOS guest only**, additionally run:

```sh
WEBKIT_WRAPPING_CLIPBOARD=1 \
WEBKIT_LAYOUT_SCREENSHOTS=/tmp/chat-wrapping-screenshots \
node scripts/webkit/chat-wrapping.mjs
```

This launches headed WebKit and replaces the guest clipboard with a sentinel
before each Cmd+C. `pbpaste` must then return the exact original UTF-8 source
for each of the three message paths, in every layout case. The default test
is headless and does not access the system clipboard.

## Results, 2026-10-24

Before the fix, the first main/chat case at 1100px failed: prompt and delivered
bubbles overflowed by 2895px, the queued bubble by 2558px, and the conversation
by 2839px. Source/selection equality already passed, establishing a layout
failure rather than text corruption.

After the fix, all 16 cases passed locally and in the assigned macOS 26.5.2
arm64 CUA VM (`local:terminalx-cua-macos`), using Playwright 1.63.0 WebKit.
All 48 guest system-clipboard checks passed. The existing `chat-links.mjs`
interaction regression also passed locally.

Only explicit build artifacts, browser dependencies and synthetic fixtures were
transferred to `/tmp/terminalx-623-validation` in the VM. No user histories,
accounts or credentials were used. These results cover the real frontend in
WebKit with a stubbed native bridge, not a launched Tauri app or its native
window manager. Zoom coverage uses CSS layout zoom, not a native webview zoom
command. The released host application was not controlled.
