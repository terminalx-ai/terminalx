# Changelog

## 0.1.0

First runnable build, assembled checkpoint by checkpoint.

- Sessions are git worktrees; each session holds tabs, and each tab is an agent conversation.
- Claude Code over stream-json, Codex over its app-server, Cursor over ACP, OpenCode over its local server.
- Streaming transcript with tool calls, diffs, permission cards and question cards; follow pin that never hides the composer.
- Composer with `@` file mentions, `/` slash commands, image drop and paste, queued follow-ups while a turn runs.
- Right panel: changes for the last turn or the whole session, repository status and history, pull requests through the GitHub CLI, and a file tree.
- Terminal dock (⌘J) with shells in the session's checkout that survive switching sessions.
- Editor tabs with a gutter against HEAD, save, and a banner when the file changes on disk; ⌘P quick open and ⌘⇧F project search.
- Notifications graded by attention: desktop banner, in-app notice, or just the tone; dock badge.
- A pixel raccoon that potters about an empty session and runs along the composer while an agent works.
- Worktree lifecycle: settle after a merge, fork a session, guarded delete.
- Themes (den, slate, moss, ember) with light and dark modes and window vibrancy.
- Dictation from the composer, using the Mac's own on-device speech recognition; nothing is downloaded and audio never leaves the machine.
- File explorer beside the transcript (⌘⇧E) with Material file icons, git status badges, keyboard navigation and a right-click menu.
- Issues from GitHub and Linear (⌘I): browse, read, and start a session on one; the worktree is named after the issue and the header links back to it.
- Files open in an editor pane beside the chat with their own tabs; markdown renders as a preview with a Source toggle.
