# PRO-554: phone UI and UX test pass (iOS simulator)

**Build**
- Release simulator build of commit `4350972f572dfdbf1f6c3354afd7b3dada0a1bbe` (origin/main on 2026-11-24).
- Built with `pnpm --dir mobile ios:simulator --device <udid>`.
- App `com.terminalx.next.mobile` 0.1.3 (4).

**Devices**
- Simulator "TX PRO-554": iPhone 17 Pro, iOS 26.5.
- For phone sizes: "TX PRO-554 small" (iPhone SE 3rd gen) and "TX PRO-554 large" (iPhone 17 Pro Max).
- The other workers' simulators were not touched.

**Account and data**
- The owner's real accounts, signed in by the owner. Nothing was invented and no mock data was used.
- The owner created the organization Demo123, connected Agent37 and Codex, and launched the first workspace. I watched those steps in a screen recording.
- Everything after that I drove myself.

**Compared against**
- Boards 25.01–25.10 ("TerminalX · 25 Mobile cloud setup").
- 25.08 (beta access code, PRO-551) is left out because PRO-551 has not merged.

**Launch**
- No paid workspace was launched by me. I took the launch form to the spend confirmation and pressed Cancel.
- The launch itself is left for the live check (PRO-549).
- With the owner's permission, I started the owner's stopped workspace again to test steps 8 and 9.

The screenshots named below are kept outside the repository, because many show account email addresses. Redacted copies are attached to the Linear tickets.

## Defects filed

All 14 defects are under PRO-522 with the label "Mobile parity". None was fixed.

| Ticket | Severity | Defect |
| -- | -- | -- |
| PRO-557 | High | **+** always opens the first organization; with no compute there, you cannot switch organization |
| PRO-558 | Medium | Back button reads "(tabs)" on Compute, Agent logins and the login pages |
| PRO-559 | Medium | "Connect compute" on the launch form opens the organization page, not Compute; back reads "Account" |
| PRO-560 | Medium | The personal organization is not shown as personal: email in the button, no "Personal ·", Delete offered |
| PRO-561 | Medium | Once one organization has a workspace, setup can't be resumed from the Cloud tab |
| PRO-562 | Medium | The launch form never offers Model or Effort for the first task |
| PRO-563 | Medium | Large text sizes clip buttons, titles and badges |
| PRO-564 | Medium | The web sign-in refuses an address without beta access before the phone can ask for a code (seen in the owner's recording only) |
| PRO-565 | Low | Review repeats the machine size, and the form cuts it off |
| PRO-566 | Low | Cloud rows show "agent37" instead of "Agent37" |
| PRO-567 | Low | Setup page headers don't match the boards; Connect has no organization name |
| PRO-568 | Low | Compute and Connect wording differs from 25.03 |
| PRO-569 | Low | A second phone starts setup over at step 1 |
| PRO-570 | Low | VoiceOver says "Delivered to your Mac" in a cloud workspace |

### Found, then resolved during the pass

Yesterday the first workspace's ••• menu said "This workspace needs a newer runtime before a phone can start a conversation. Stop it and start it again." (`33-workspace-actions-menu`).

- **Why:** main CI had failed, so `release-serve` skipped publishing, and the newest runtime predated PRO-546 and PRO-548.
- **What changed:** at 03:18 today, runtime `runtime-v0.2.39-20261125031813-09533c8` was released, and it contains both.
- **Result:** after I started the workspace again, **New conversation** and **Add agent tab** appeared (`38-actions-after-restart`) and both worked.

No ticket was filed, because the app's sentence was correct and following it fixed the problem. One risk remains: a failing main CI quietly holds back runtime releases that the phone depends on.

## Screen by screen

The step numbers follow the walk order in PRO-554.

### 1. Sign in (Cloud tab signed out, sign-in sheet)

**Checked**
- Layout and wording against 25.01 "Signed out", in dark and light.
- Cancel at the iOS sign-in prompt, and closing the sheet.
- Killing the app during sign-in and opening it again.
- Larger text.
- Small and large phones.

**Screenshots:** `01`–`13`, `S1`, `S2`, `L1`.

**Passed**
- Cancel and closing the sheet both return quietly to the signed-out tab.
- A relaunch during sign-in comes back cleanly signed out.
- The light palette matches the boards.

**Defects**
- PRO-563 (the "Sign in" label is clipped at large text).
- PRO-564 (the web page refuses an address without beta access).

**Notes, no ticket**
- The board's line "New to TerminalX? The same page creates your account." is missing. The board marks it as question 1, waiting on PRO-524.
- The Settings tab's signed-out text mentions only machines. No board covers it.

### 2. First run (setup card)

**Checked**
- 25.01 "Signed in, nothing set up", "Came back half-way" and "With workspaces".
- VoiceOver labels of the steps.
- Relaunch mid-setup.
- Small and large phones.
- A second phone on the same account.

**Screenshots:** `23`, `24`, `S3`, `L2`, `L10`–`L12`.

**Passed**
- The four steps, the next-step accent and button names match the board.
- VoiceOver reads each step well, e.g. "Step 2 of 4, next: Connect compute. The provider account your workspaces run on."
- Relaunching on the same phone keeps the progress (`L12`).

**Defects:** PRO-561, PRO-569, PRO-563.

### 3. Create organization (Organization step, New organization)

**Checked**
- 25.02: choosing, the selected state, and the name rules.
- Name validation at 1 and 61 characters.
- Back.
- Keyboard.
- Light mode.
- Small and large phones.

**Screenshots:** `70`–`74`, `91`, `S4`, `S5`, `L3`, `L9`.

**Passed**
- Create is off below 2 characters and above 60, with "Use 2 to 60 characters."
- The selected row is announced as selected.
- The keyboard does not cover Create.

**Defects:** PRO-560, PRO-567.

**Not confirmed**
- 25.02 says "One field, with the keyboard up". The field takes focus (the caret shows), but in some captures the keyboard was not yet up. I could not tell whether that was the simulator or the app, so no ticket was filed.

### 4. Connect compute (Compute, Connect Agent37)

**Checked**
- 25.03: the provider list, the connect form, the ready, checking and rejected states, and the connected detail.
- Keyboard on the small phone.
- Light mode.
- Larger text.

**Screenshots:** `50`–`55`, `92`, `93`, `S6`, `S13`, `L4`, `L7`, `A3`.

**Passed**
- The list layout and status badges match the board.
- The rejection state matches the board.
- Connect stays off until the key and the billing switch are set.
- On the iPhone SE the keyboard does not cover the key field.

**Defects:** PRO-558, PRO-567, PRO-568, PRO-563, PRO-559 (reached from the launch form).

### 5. Sign agents in (Agent logins, Codex, Claude Code)

**Checked**
- 25.04: the list, Codex's two choices, and the Claude Code key form.
- Keyboard.
- Small and large phones.
- Larger text.

**Screenshots:** `60`–`63`, `94`, `S7`, `S9`, `S10`, `S14`, `L5`, `L8`, `A4`, `A6`.

**Passed**
- The layout and wording match the board.
- Save stays off until the key and the switch are set.
- The keyboard does not cover the fields on the SE.

**Defects:** PRO-558, PRO-567, PRO-563.

### 6. Launch form with a first task, Review, spend confirmation

**Checked**
- 25.05 and 25.09: every row, the First task section, typing a first task with the keyboard up, and Review price.
- The spend confirmation: Cancel only.
- Larger text.
- Light mode.
- The no-compute state.
- Small and large phones.

**Screenshots:** `40`, `41`, `80`–`87`, `95`, `S8`, `L6`, `A5`.

**Passed**
- The keyboard leaves the task field and Review price in view (`85`).
- Review lists every choice, the task and the price, with a countdown on how long the price holds.
- The confirmation "Launch and start spending?" appears, and Cancel returns to Review with nothing launched.

**Defects:** PRO-557, PRO-559, PRO-562, PRO-565, PRO-563.

**Notes, no ticket**
- The confirmation sentence "Your cloud provider bills this machine directly, not TerminalX." differs from 25.05's. The board marks that wording as open (Q10).
- The launch itself is left for the live check (PRO-549).

### 7. Open the conversation (workspace screen)

**Checked**
- 25.06 and 25.07: the header, the state line, the driver bar, the transcript, permission cards, the ••• menu, and Stopped then Start.
- VoiceOver labels.
- Larger text.

**Screenshots:** `30`–`38`.

**Passed**
- Permission cards could be allowed, and they then show "Allowed".
- Start asks "Start this workspace?" with the billing sentence, then goes Starting → Live in about 20 seconds.
- The back, Sharing, Workspace actions, state line, composer and Send controls all have clear labels.

**Defect:** PRO-570.

### 8. Start a second conversation

**Checked**
- 25.10: ••• → New conversation, the sheet's four rows read from the workspace, typing with the keyboard up, Start conversation, and the new tab.

**Screenshots:** `100`–`104`.

**Passed**
- The sheet reads Codex, GPT-6.1 Sol, Low, Ask every time from the workspace.
- With the keyboard up, the rows scroll away and the field and button stay in view.
- The new conversation opened as a second tab and the agent answered "hello".

**Notes, no ticket**
- With no first message, Start conversation is off, and the board's line "With no first message, the agent starts and waits for one." is not shown. This is deliberate: the code waits on `PROVEN_BY_LIVE_CHECK.emptyFirstMessageStartsAgent`, which belongs to PRO-549.

### 9. Add an agent tab

**Checked**
- 25.10: ••• → Add agent tab, the sheet ("Opens beside the tab you are on."), Add tab, and the new empty tab.

**Screenshots:** `105`–`107`.

**Passed**
- "Agent 3" was added beside the others.
- It shows "No conversation yet / This tab has not published any turns." with the composer, as on the board.

## Across the flow

**Dark and light**
- Every signed-in screen was shot in dark (`20`–`87`) and light (`90`–`96`). The light palette matches the board's light frames.
- The app's default theme is Den (gold accent), while the board's dark frames use Ember (salmon). That is a theme choice, not a defect.

**Phone sizes**
- iPhone SE (`S*`) and 17 Pro Max (`L*`). Nothing overflowed at the default text size.

**Larger text:** PRO-563.

**Back and cancel**
- Back works on every page.
- Cancel works on the sign-in prompt, the spend confirmation, the workspace actions and the start confirmation.
- Back labels are wrong in two places: PRO-558 and PRO-559.

**Closing and reopening mid-flow**
- During sign-in: comes back signed out (`13`).
- During setup: keeps the step (`L11`, `L12`).
- Relaunch opens on the Machines tab, which is the app's default.

## Not tested, and why

- **Offline and slow network.** The simulator shares the Mac's network. Network Link Conditioner or hosts-file changes would also cut off the other workers' simulators on this Mac, so the "No network" and "could not be read" states of 25.01 were not exercised.
- **The launch itself.** Left for the live check (PRO-549). The first workspace was launched by the owner, so I saw it only in a recording.
- **The first-run card before any organization existed, and creating Demo123, Agent37 and Codex.** Done by the owner while I recorded, so they were seen, not driven.
- **Beta access code (25.08).** PRO-551 has not merged.
- **A member's view** (25.01 "A member, not an admin", and "Not a manager" in 25.10). Both accounts are owners.
- **The key-rejected state on the Cloud tab** (25.01 "A connected key stopped working"). That needs a stored key that the provider later rejects; I won't break the owner's real key.
- **VoiceOver with the screen reader running.** Labels were read from the accessibility tree, not spoken by VoiceOver. The tab bar's icons show up in the tree with their symbol names ("laptopcomputer", "mostly cloudy"). Whether VoiceOver reads them as well as the tab names needs a check on a device, so no ticket was filed.
- **Ember theme frames.** Not shot one by one; the board compare used Den, since the palette is the only difference.
