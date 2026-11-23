# registries piece: shortcut actions, prefs and settings rows

Starting commit `b3f59b28`. Screens read: 09-14, 09-15, 09-16 (`~/.claude/reference/chief-of-staff/runs/phase-2-3-batch/screens/`).
The later pieces bind handlers by id with `useShortcut`/`matchesShortcut`; none hard-codes a key.

## Acceptance lines and the test that proves each

| Line | Proof |
| -- | -- |
| Every id the run fixed exists in `src/lib/shortcuts.ts`, in a group the Shortcuts tab shows | `shortcuts.test.ts` › "lists every one, in a group the Shortcuts tab shows"; the `grep` loop of the brief |
| The screens' keys: ⌘/, ⇧⌘/, ⇧Tab, ⇧⌘E, ↑, ↓, ⌥⌘K, ⌥⌘J, ⌃V, ⌥⌘R, ⌥⌘U, fork ⌥⌘↵ | `shortcuts.test.ts` › "keeps the screens' keys on macOS"; `scripts/webkit/shortcuts.mjs` › "the Phase 3 batch's rows in the Shortcuts tab" (built app) |
| `session.forkTab` keeps ⌥⌘↵ and reads "Fork to new tab" | same two; `ShortcutsTab.test.tsx` › "lists the composer's new actions and the relabelled fork" |
| A Review group, between Files and Issues, as screen 09-15 draws | `shortcuts.test.ts` (group list and order); `ShortcutsTab.test.tsx` › "lists a Review group between Files and Issues"; WebKit check (order in the built tab) |
| ⌃V and ⌥⌘R are macOS-only defaults (Ctrl+V pastes; Ctrl+Alt+R is `session.runAction` elsewhere) | `shortcuts.test.ts` › "gives ⌃V and ⌥⌘R to the review on macOS only…"; `ShortcutsTab.test.tsx` (jsdom is not a Mac: both read "Set one") |
| No default taken from main (⌘⌥O, ⌘O, ⌘⇧O, ⌥⌘C, ⌘⇧J, composer ↑↓, dictation) | `shortcuts.test.ts` › "takes none of the keys main already uses"; "lists every action once, each default binding owned by one action" on both platforms |
| `composer.togglePlanMode` may be Shift+Tab, in the composer only; Tab keeps moving focus elsewhere | `shortcuts.test.ts` › "allows Shift+Tab for the plan-mode toggle in the composer only, and Tab nowhere"; `hotkeys.test.ts` › "Shift+Tab, the plan-mode toggle's key" (handler runs in the composer, plain Tab is not prevented, a handler that returns `false` leaves Shift+Tab to the browser) |
| Every new row is recordable and persisted | `shortcuts.test.ts` › "lets the review's keys be recorded…"; `ShortcutsTab.test.tsx` › "records Shift+Tab for the plan-mode toggle…" and "refuses Shift+Tab for every other action"; WebKit › "recording Shift+Tab" |
| ↑ and ↓ are both the composer's and the review's | `shortcuts.test.ts` › "lets ↑ and ↓ be the composer's and the review's at once, but nothing else's"; `ShortcutsTab.test.tsx` › "shows ↑ for the review and the composer at once, with no conflict"; `hotkeys.test.ts` (both handlers run on their own focus) |
| Prefs `reviewModel`, `openInDefaultApp`, `openInRecent` exist, are validated, persist across a restart, and are not in `userPreferenceDefaults.json` | `prefs.test.ts` › "review model and Open in preferences (PRO-242, PRO-247)" |
| Experimental row "Fork chat to a new tab" is in the registry | `settingsRegistry.test.tsx` (every row declared, rendered, unique; snapshot of the ids); `settingsRegistry.tsx` `experimental.forkChatToTab` |
| Every row of the Shortcuts page has a registry row | `settingsRegistry.test.tsx` › "uses each keyboard action's own id instead of an array index" |

## Design decisions the other pieces need

- **Surfaces.** `ActionDef.surface` (`"composer" | "review"`) lets two actions hold the same key when their surfaces differ. The registry
  otherwise allows one owner per key, and ↑ ↓ were already `composer.historyPrevious/Next`. `resolveKeymap` and `conflictOf` use it; a
  window-wide action still cannot take a key a surface has. `composer.togglePlanMode` is also on the composer surface. The review
  piece must bind `review.previousFile/nextFile` only where the review has the focus (a non-`global` `useShortcut` skips editable
  targets already) and must return `false` when it is not the review's turn.
- **Shift+Tab.** Binder piece: `useShortcut("composer.togglePlanMode", handler, { global: true })` is needed (a textarea is editable and
  Shift+Tab is not a command chord); return `false` when the focus is not in the composer so Shift+Tab keeps moving focus.
  `bindingProblem` allows the chord for that id only; the recorder (`ShortcutsTab.tsx`) records Shift+Tab there, where plain Tab still leaves the box.
- **Experimental switch key.** The row's storage is `experimental.forkChatToTab`. Three files outside this piece must carry the same key: `ExperimentalSettings` in `src/lib/api.ts` (`forkChatToTab?: boolean`) and the Rust
  settings (backend piece), and `ExperimentalSettings.tsx` (chat-tab piece), which must render `<RegisteredSetting setting="experimental.forkChatToTab" …>`.
- **ShortcutsTab.tsx** needed only the Shift+Tab recorder change; the Review group appears because the tab renders `SHORTCUT_GROUPS`.

## Deliberate differences from the screens

- **Previous / next file is two rows.** Screen 09-15 draws one row "Previous or next file in the diff" with ↑ and ↓ keycaps. There are two
  actions with two ids, so two rows ("Previous file in the diff", "Next file in the diff"), each re-recordable on its own.
- **No "Open diff view" or "Send review comments to the agent" row.** Screen 09-15 draws ⇧⌘D and ⌘↵ rows in Review. ⇧⌘D is `composer.dictate`
  on main and the run fixed no id for either; adding them would be a row with no owner.
- **No Git or Terminal groups.** Screen 09-16 groups Commit and push … Show uncommitted changes under "Git", and 09-15 has a Terminal group.
  Main groups git actions under Session and has no terminal actions; `review.start` is in Review and `git.showUncommitted` in Session.
  Regrouping would move rows other tickets own. The screens' "N changed" counters, search box, "Press keys to find", "Use physical key"
  and "Reset both" notices are not part of this run's tickets and are not built.
- **Defaults chosen where no screen has a key** (all free on both platforms; checked by the uniqueness test):
  - `chat.expandAllToolCalls`: ⌥⌘E (Ctrl+Alt+E elsewhere). ⌘E is the right panel, ⌥⌘1–4 the panels.
  - `session.copyConciseTranscript`: none. A copy nobody presses by habit.
  - `files.openInDefault`, `files.openInMenu`: none. ⌘O, ⌥⌘O, ⌥⌘C and ⇧⌘J are taken and no free key reads as "open in".
  The reader can record any of them in Settings → Shortcuts.
- **⌃V on macOS is a default but cannot be re-recorded as a new binding.** Ctrl with a letter is a terminal key on macOS
  (`isTerminalReserved`), so `bindingProblem` refuses it for any action; the default stays and Reset restores it. In a terminal the binder
  already skips it.
- **Group heading and row text** use the app's real rows, not the screens' example data.

## Left for the lead (a file this piece does not own)

`pnpm test` has one failure caused by this piece's new rows: `src/lib/settingsSchemaDescriptions.test.ts` compares
`schemas/settings-descriptions.json` with the registry. Add these 16 keys (descriptions exactly as the registry rows say; the test prints
the whole expected file on failure) and regenerate the schema with `TERMINALX_WRITE_SCHEMAS=1 cargo t --lib store::settings::schema`:
`experimental.forkChatToTab` and `preferences.shortcuts.<id>` for `chat.expandAllToolCalls`, `composer.cycleEffort`,
`composer.openModelPicker`, `composer.toggleFast`, `composer.togglePlanMode`, `files.openInDefault`, `files.openInMenu`,
`git.showUncommitted`, `review.nextComment`, `review.nextFile`, `review.previousComment`, `review.previousFile`, `review.start`,
`review.toggleViewed`, `session.copyConciseTranscript`. Every other test in `pnpm test` passes (679 files).
