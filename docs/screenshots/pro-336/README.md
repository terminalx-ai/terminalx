# Readable text over panels (PRO-336)

1440 × 900 (sidebar, Run view) and 1100 × 760 captures of the built app in Playwright
WebKit with glass mode on (`data-glass`), the Mac look, light and dark. Before is
`main` at 4e223b88; after is this branch. Sessions, runs and transcripts are
synthetic Tauri bridge fixtures (`scripts/webkit/run-sidebar.mjs`,
`scripts/webkit/readable-panels.mjs`). Files:
[`pr-media/pro-336`](https://github.com/terminalx-ai/terminalx/tree/pr-media/pro-336/PRO-336).

## What changed in the look

- Tooltips, hover cards, menus, popovers, dialogs, toasts and the composer are
  opaque in glass mode: the card colour, as without glass. The sidebar and title
  bar keep the window's vibrancy. Nothing blurs behind a panel any more.
- Secondary text (`text-muted-foreground`) is lighter in dark mode (oklch L 0.66 → 0.70)
  and darker in light mode (0.48 → 0.46); tertiary text (`text-faint`) moved more
  (dark 0.50 → 0.63, light 0.62 → 0.53). Both now meet 4.5:1; the order strong over
  muted over faint holds in every palette.
- The folded lead's hover card opens outside the sidebar, level with the row,
  and hovering the row no longer brings its actions in, so its title keeps its width.
  The row's menu is still on right-click, on keyboard focus and when it is open.
- With Reduce transparency on, glass is off: the window paints solid and nothing blurs.

## Before and after

### Sidebar lead hover card

| | Before | After |
| --- | --- | --- |
| Dark | ![Sidebar lead hover card, dark, before](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/01-sidebar-lead-hover-card-dark-before.png) | ![Sidebar lead hover card, dark, after](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/02-sidebar-lead-hover-card-dark-after.png) |
| Light | ![Sidebar lead hover card, light, before](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/03-sidebar-lead-hover-card-light-before.png) | ![Sidebar lead hover card, light, after](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/04-sidebar-lead-hover-card-light-after.png) |

### Menu over the sidebar

| | Before | After |
| --- | --- | --- |
| Dark | ![Menu over the sidebar, dark, before](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/05-menu-over-the-sidebar-dark-before.png) | ![Menu over the sidebar, dark, after](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/06-menu-over-the-sidebar-dark-after.png) |
| Light | ![Menu over the sidebar, light, before](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/07-menu-over-the-sidebar-light-before.png) | ![Menu over the sidebar, light, after](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/08-menu-over-the-sidebar-light-after.png) |

### Composer

| | Before | After |
| --- | --- | --- |
| Dark | ![Composer, dark, before](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/09-composer-dark-before.png) | ![Composer, dark, after](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/10-composer-dark-after.png) |
| Light | ![Composer, light, before](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/11-composer-light-before.png) | ![Composer, light, after](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/12-composer-light-after.png) |

### Run view: summary cards and side panel

| | Before | After |
| --- | --- | --- |
| Dark | ![Run view: summary cards and side panel, dark, before](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/13-run-view-summary-cards-and-side-panel-dark-before.png) | ![Run view: summary cards and side panel, dark, after](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/14-run-view-summary-cards-and-side-panel-dark-after.png) |
| Light | ![Run view: summary cards and side panel, light, before](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/15-run-view-summary-cards-and-side-panel-light-before.png) | ![Run view: summary cards and side panel, light, after](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/16-run-view-summary-cards-and-side-panel-light-after.png) |

### Tooltip over the chat

| | Before | After |
| --- | --- | --- |
| Dark | ![Tooltip over the chat, dark, before](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/17-tooltip-over-the-chat-dark-before.png) | ![Tooltip over the chat, dark, after](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/18-tooltip-over-the-chat-dark-after.png) |
| Light | ![Tooltip over the chat, light, before](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/19-tooltip-over-the-chat-light-before.png) | ![Tooltip over the chat, light, after](https://raw.githubusercontent.com/terminalx-ai/terminalx/50e6a012bcd8f6835447866a010f6705559aee28/PRO-336/20-tooltip-over-the-chat-light-after.png) |
