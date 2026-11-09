# Where a merged workspace's clean-up is told

**Decision (Nov 2026):** when clean-up keeps a merged workspace instead of
deleting it, that is said in three quiet places, and never as a pop-up:

1. **The session's Branch tab**, first thing under the branch name: "Merged,
   kept: 2 unpushed commits", the reason in full, and the buttons for it
   (Keep, Delete…). The branch's own next step sits under it, so the fix for
   the reason (Push, Commit) is one click away.
2. **Its sidebar row**: the merged tick on the branch icon turns amber, and the
   tooltip says why.
3. **One line under the projects**: "Clean up 3 merged workspaces", shown only
   while there are some, opening the clean-up list with all of them.

Only what has a short window to answer still pops up: a deletion coming
(Keep workspace) and one just done (Undo).

The code: `src/components/changes/MergedWorkspaceStep.tsx` (the Branch tab
card), `BranchGlyph` and `CleanupLine` in `src/components/layout/SessionSidebar.tsx`,
and the filter in `src/components/ui/MergedCleanupNotices.tsx`.

## Why

- **It is about a branch, so it goes where the branch is followed.** The
  Branch tab already shows the road to done (commit, push, pull request,
  merge). Cleaning up the workspace is that road's last step, and the reader
  looks there for "what happens to this branch now". The same reasoning put
  Autopilot there (docs/AUTOPILOT-PLACEMENT.md).
- **Kept is not urgent.** Nothing is broken and nothing is lost by waiting: a
  kept workspace stays as it is. A notice over the conversation interrupts for
  something that can wait, and a stack of them covered the composer.
- **Not under Files, not red.** Files is the project's files, not its
  workspaces, and most kept workspaces belong to other sessions. Red reads as
  an error; clean-up being careful is not one. The marker is amber, the colour
  the app uses for "needs a look".
- **Seen at a glance, handled in one place.** The amber tick shows which
  branches are done but still on disk without opening each; the one Clean up
  line handles many at once.
