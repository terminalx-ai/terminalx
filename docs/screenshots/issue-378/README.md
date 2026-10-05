# App resources surface (#378)

The App resources popover now uses the opaque `--surface-card` token, matching
the adjacent usage popover. In macOS glass mode, `bg-popover` resolves to
`--veil-float`: 74% opacity in dark mode and 82% in light mode. Without a backdrop
filter, terminal text and selection colors showed through that surface.
The existing Radix portal and `--z-menu` layer were correctly above the content;
no stacking change was needed.

These are 1280 × 800 captures of the built app in Playwright WebKit. All session
names, output, process IDs and resource values are synthetic Tauri bridge
fixtures. The terminal is the app's real xterm with its canvas/WebGL renderer,
ANSI output and a mouse selection. The chat uses the real transcript components.

| View | Dark | Light |
| --- | --- | --- |
| Terminal, glass enabled | [Fixed](den-dark-terminal-glass.png) | [Fixed](den-light-terminal-glass.png) |
| Chat, glass enabled | [Fixed](den-dark-chat-glass.png) | [Fixed](den-light-chat-glass.png) |

The [original dark surface](before-den-dark-terminal-glass.png) reproduces the
overlap. The [hovered and keyboard-focused process row](den-dark-terminal-glass-row-focus.png)
shows the row highlight, focus ring and kill control over the opaque surface.

Validation passed for all 28 combinations: Den, Slate and Moss in light/dark,
Ember in dark, glass enabled/disabled, and terminal/chat backgrounds. Each checks:

- Fully opaque rendered background and full panel opacity.
- The shared menu layer and hit testing above the background.
- Visible hover and keyboard focus treatments.
- Identical pixels inside the panel before and after background output updates,
  including the highlighted process row. The background itself must repaint.
- A working refresh control and Escape dismissal.

The original code fails the opacity assertion (alpha 189/255 in dark glass mode).
Glass mode is exercised through the app's `data-glass` CSS state; native desktop
vibrancy outside the webview is not part of this browser check.

Reproduce from the repository root:

```sh
pnpm build
pnpm exec playwright install webkit
APP_RESOURCES_SHOTS=docs/screenshots/issue-378 pnpm test:webkit-app-resources
```

The check also runs as part of `pnpm test:webkit-layout`. The frontend build and
the full Vitest suite (190 files, 2,042 tests) passed for this change.
