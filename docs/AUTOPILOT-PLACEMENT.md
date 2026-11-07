# Where Autopilot lives

**Decision (Nov 2026):** Autopilot, the session pipeline that opens a pull
request, reviews it, resolves conflicts and merges when green, is set up and
followed in a section of the side panel's **Branch** tab, directly under the
next-step card. It is not a dialog opened from the session header, and the
Branch tab is not split into nested tabs to hold it.

The code: `src/components/changes/BranchAutopilot.tsx`, placed by
`BranchTab.tsx`; the switches themselves are `SessionPipelineControls.tsx`.

## What changed

| Before | After |
| --- | --- |
| An always-present "Automation" label in the session header opened a modal "Session pipeline" dialog. | Nothing in the header while Autopilot is off. |
| The same dialog showed a running pipeline. | A running pipeline keeps its status chip in the header; clicking it opens the Branch tab. |
| Setup and status lived only in that dialog. | The Branch tab has an **Autopilot** line: "Off · Set up ›" opens the switches in place; once on, the line is the live status and the panel is shown under it. |
| "Enable automation", greyed out with the reason in faint text above it. | "Turn on autopilot", with why it cannot be pressed written beside it. |

## Why here

1. **It is the same path, run for you.** The Branch tab already shows the
   branch's road to done: commit → push → pull request → merge, with the one
   next step on top. Autopilot is that road driven automatically. Controls
   belong where the reader already thinks about the thing they control
   (match between the system and the real world; proximity). Someone asking
   "what happens to this branch next?" looks at the Branch tab, not the header.

2. **Its status should be seen, not looked for.** "This branch will merge
   itself when checks pass" changes what the reader should do. It belongs
   beside the pull request and checks it depends on, always visible while it
   runs (visibility of system status). A dialog shows it only while open.

3. **No modal for a setting.** A modal covers the conversation the reader is
   working in and must be dismissed to get back to it. Two switches do not
   need to take over the screen; an inline section that expands in place
   keeps the context (avoid interrupting the primary task).

4. **Progressive disclosure, not hiding.** Off, it costs one line. On, it
   opens by default. The reader sees that it exists without its controls
   taking room they do not need.

5. **A quieter header.** The header is for the conversation's identity and
   its few constant actions. A label that is there in every git session,
   whether or not anyone uses it, is noise; the running chip appears only
   when there is something to report.

6. **One name per idea.** "Automation" in the header collided with
   **Automations** in the sidebar, which are scheduled runs: a different
   feature. "Autopilot" says what this one does and cannot be mistaken for it.

7. **Say why a control is disabled, next to it.** A greyed button with the
   reason in faint text elsewhere reads as broken. The reason now sits beside
   the button ("Turn on a switch above first.").

## Alternatives considered

- **Keep the header dialog.** Rejected for 1–3 and 5 above.
- **Nested tabs in the Branch tab (Overview · Settings · Changes).**
  Rejected:
  - *Changes twice.* The side panel already has a top-level Changes tab; a
    second one inside Branch leaves the reader unsure which to use and
    whether they differ.
  - *A tab for two switches hides them.* A Settings tab puts Autopilot one
    click away and out of sight, the opposite of point 2. Its state is
    exactly what should be on screen.
  - *Depth.* The panel already has a row of tabs, and Browser and Computer
    add a second. A third level costs the reader the work of remembering
    where they are, for a tab that is short enough to read in one scroll.
- **The project's settings page.** Right for defaults that apply to every
  session (and the project's defaults stay there), wrong for "this branch,
  now".

## When to revisit

If the Branch tab grows to hold several independent parts (reviews, checks,
deployments…), turn its parts into collapsible sections of the one scroll
before reaching for tabs. Tabs become reasonable only when parts are used
separately and rarely together, which is not true of a branch's state and
what will happen to it.
