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
- Optional local transcription models (Parakeet, Nemotron, Canary, Whisper) downloaded on demand in Settings → Transcription, plus a microphone picker and mute-while-recording.
- File explorer beside the transcript (⌘⇧E) with Material file icons, git status badges, keyboard navigation and a right-click menu.
