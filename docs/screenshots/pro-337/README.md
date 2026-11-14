# Orchestrate from an issue, and a session that only started others (PRO-337)

1100 × 700 (issue page; 800 px for the narrow row) and 1440 × 900 (sidebar) captures
of the built app in Playwright WebKit, light and dark. Issues, sessions and runs are
synthetic Tauri bridge fixtures (`scripts/webkit/orchestrate-start.mjs`); no tracker
is contacted and no agent starts. Files:
[`pr-media/pro-337`](https://github.com/terminalx-ai/terminalx/tree/pr-media/pro-337/PRO-337).

## Issue page

With Settings → Experimental → Orchestration runs on, **Orchestrate** sits beside
**Start session**, the same size and style. With it off, or for a cloud project or a
folder, it is not there.

| | GitHub issue | Linear issue |
| --- | --- | --- |
| Switch on, light | ![GitHub issue, switch on, light](https://raw.githubusercontent.com/terminalx-ai/terminalx/c566540fdaa7e6837afa37150ef8656ef4572c4d/PRO-337/01-issue-github-switch-on-light.png) | ![Linear issue, switch on, light](https://raw.githubusercontent.com/terminalx-ai/terminalx/c566540fdaa7e6837afa37150ef8656ef4572c4d/PRO-337/03-issue-linear-switch-on-light.png) |
| Switch on, dark | ![GitHub issue, switch on, dark](https://raw.githubusercontent.com/terminalx-ai/terminalx/c566540fdaa7e6837afa37150ef8656ef4572c4d/PRO-337/02-issue-github-switch-on-dark.png) | ![Linear issue, switch on, dark](https://raw.githubusercontent.com/terminalx-ai/terminalx/c566540fdaa7e6837afa37150ef8656ef4572c4d/PRO-337/04-issue-linear-switch-on-dark.png) |
| Switch off | ![GitHub issue, switch off, light](https://raw.githubusercontent.com/terminalx-ai/terminalx/c566540fdaa7e6837afa37150ef8656ef4572c4d/PRO-337/05-issue-github-switch-off-light.png) | ![Linear issue, switch off, dark](https://raw.githubusercontent.com/terminalx-ai/terminalx/c566540fdaa7e6837afa37150ef8656ef4572c4d/PRO-337/06-issue-linear-switch-off-dark.png) |

Narrow pane, switch on:

![GitHub issue, switch on, 800 px](https://raw.githubusercontent.com/terminalx-ai/terminalx/c566540fdaa7e6837afa37150ef8656ef4572c4d/PRO-337/07-issue-github-switch-on-narrow-light.png)

## The session Orchestrate starts

It opens on its Run tab. The project here asks for no approval, but the session was
started with Orchestrate, so the Run tab says a run waits for approval.

| Light | Dark |
| --- | --- |
| ![Orchestrated session on its Run tab, light](https://raw.githubusercontent.com/terminalx-ai/terminalx/c566540fdaa7e6837afa37150ef8656ef4572c4d/PRO-337/08-orchestrated-session-run-tab-light.png) | ![Orchestrated session on its Run tab, dark](https://raw.githubusercontent.com/terminalx-ai/terminalx/c566540fdaa7e6837afa37150ef8656ef4572c4d/PRO-337/09-orchestrated-session-run-tab-dark.png) |

## Sidebar

"Move settings reads to the typed store" leads a run: the lead glyph, and folded,
pieces done out of total. "Try both parser rewrites" only started the two sessions
under it: its own status mark, the quieter fork mark ("Started these sessions"),
and no run summary.

| | Light | Dark |
| --- | --- | --- |
| Open | ![Sidebar, open, light](https://raw.githubusercontent.com/terminalx-ai/terminalx/c566540fdaa7e6837afa37150ef8656ef4572c4d/PRO-337/10-sidebar-lead-and-starter-light.png) | ![Sidebar, open, dark](https://raw.githubusercontent.com/terminalx-ai/terminalx/c566540fdaa7e6837afa37150ef8656ef4572c4d/PRO-337/11-sidebar-lead-and-starter-dark.png) |
| Folded | ![Sidebar, folded, light](https://raw.githubusercontent.com/terminalx-ai/terminalx/c566540fdaa7e6837afa37150ef8656ef4572c4d/PRO-337/12-sidebar-folded-light.png) | ![Sidebar, folded, dark](https://raw.githubusercontent.com/terminalx-ai/terminalx/c566540fdaa7e6837afa37150ef8656ef4572c4d/PRO-337/13-sidebar-folded-dark.png) |
