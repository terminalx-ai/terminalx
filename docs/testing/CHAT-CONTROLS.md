# Chat table and code controls (#624)

The layout regression uses the production-built app and Markdown renderer with
synthetic transcript events supplied through the existing WebKit Tauri bridge
harness. It does not test against private conversations or native stores.

```sh
pnpm build
pnpm exec playwright install webkit
pnpm test:webkit-chat-controls
node scripts/webkit/chat-wrapping.mjs
node scripts/webkit/chat-links.mjs
```

On an exclusively assigned disposable macOS guest, run the same test visibly
and verify actual system clipboard contents (this replaces the guest clipboard):

```sh
WEBKIT_CONTROLS_HEADED=1 WEBKIT_CONTROLS_CLIPBOARD=1 \
  WEBKIT_LAYOUT_SCREENSHOTS=/tmp/tx624/screenshots \
  node scripts/webkit/chat-controls.mjs
```

The seven scenarios cover main chat at 1100px, with its side panel open, at
760px, and at 760px with 150% CSS zoom; floating chat at 1100px, 360px, and
640px with 150% zoom. Every scenario checks:

- Actual menu bounds, one-line text ranges, hit targets and viewport anchoring.
- Repeated fullscreen entry with the menu open and closed, modal coverage by
  hit testing, keyboard focus containment, Escape behavior and focus restoration.
- Cell/link wrapping, an 80-row / 24-column table's scrolling, reachable controls,
  and absence of horizontal conversation overflow.
- Exact table CSV/Markdown downloads, the expanded stress table's CSV, and table
  clipboard text; exact code downloads/copy including trailing newlines for
  ordinary and linked code, plus horizontal code scrolling.

## Investigation and validation, 2026-10-24

On the original production build, WebKit measured the Download menu at 38.28px
wide with `min-width: 0px`; the Markdown option was 176px tall. Streamdown's
`min-w-[120px]` utility was missing because its distributed JavaScript was not
included in Tailwind source scanning. Its animation stylesheet alone does not
supply these utilities.

The supplied synthetic table did not reproduce the original displaced fullscreen
fragment at default size. The replacement viewer uses the application's dialog
layer and a body portal, with its own scrolling surface and focus lifecycle.
It therefore does not depend on a transcript row's clipping/containing block or
Streamdown's standalone fullscreen stacking/focus behavior. Its rendered bounds
and coverage are checked at every size above. The table serializers are still
Streamdown's; Markdown exports preserve the existing plain-cell serialization,
not the original Markdown emphasis/link syntax.

The first portalled menu implementation exposed a second measurable failure at
150% CSS zoom: its right edge reached 1003.5px in a 760px viewport. A transformed,
viewport-sized portal container gives Floating UI the correct scaled containing
block without changing prose wrapping or shared application menus.

Local WebKit and headed WebKit on the assigned `local:terminalx-cua-macos` guest
(macOS 26.5.2, arm64) passed the matrix. The guest checks also read back the real
macOS clipboard. Screenshots and logs were kept under `/tmp/tx624` during the run.
Cua also verified a native WebKit browser-window resize to 640×728, keyboard
opening of Download, and entry into the table viewer through the accessibility
control; window screenshots showed readable menus and the complete table.
The existing #623 wrapping matrix and chat-link interaction checks passed.

This is real WebKit rendering and native browser-window validation of the built
frontend with a stubbed Tauri bridge, not a packaged TerminalX application test.
The exact original screenshot sequence remains unknown; no native backend,
production session, credentials or live TerminalX instance was used.
