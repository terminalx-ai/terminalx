# PRO-141 chat mentions

Mentioning a teammate in a shared cloud session's chat makes them follow the
workspace and notifies them. The server only ever receives ids. Readiness is
`team.mentions.v1` (with `team.roster.v1` for the people list), per organization.
The saas side is described in its `docs/phase2/mentions-contract.md`.

## Sending (screens 13.02, 13.03, 14.07)

- `@` in a cloud session's composer lists **People** (the organization roster
  from the PRO-128 cache, minus oneself) above **Files**. Each row shows the
  person's avatar, email and, while they are in the workspace, their role and
  where they are. Local and machine tabs list files only, as before.
- A picked person goes into the text as plain `@Name`, so the agent reads it as
  typed. The composer shows a chip per mentioned person, and a chip's × removes
  every `@Name` for that person from the draft. In the transcript, a person's
  message draws `@Name` of an organization member as the same chip (with the
  avatar and name; a copy gives back `@Name`). Two members with the same name
  are never turned into chips.
- Before the message is sent, `POST …/cloud-workspaces/:id/mentions` with
  `check: true` asks who cannot watch the workspace. If anyone cannot, or the
  check fails, nothing is sent and nobody is told. The composer then shows
  14.07's warning with a **Share** button, which opens the workspace's Share
  dialog. The draft stays as it was.
- Once the sent message appears in the tab's transcript (its own
  `user_message` event after the send's sequence), the same route is called
  with `sessionId`, `tabId`, `messageId` and `userIds`. The body has no field
  for text: the native client denies unknown fields, and the server answers
  422 to any. If access changed between the check and the record, the server
  writes nothing and the warning appears again.

## Receiving (screens 13.03, 13.16, 17.06)

- The inbox asks for `mentions=1` alongside `presence=1`. A
  `workspace.mentioned` event (`actorId`, `sessionId`, `tabId`, `messageId`) is a
  notice event. It needs `team.mentions.v1` readiness for its organization and
  passes the same live-list access confirmation as a share grant before
  anything shows. It also refreshes the catalog, since the person now follows
  the workspace.
- A confirmed mention puts an `@` on the session's sidebar row and makes the
  title bold, unless the account's synced read marker for that session
  (PRO-125) is already at or past the mention. The marker is the read state
  for every device of the account. A mention replayed after signing in again
  or leaving data privacy mode does not come back once it was read, and a
  marker that arrives later, such as a read on another Mac, takes the `@`
  away. Reading the session here, by having it on screen or with Mark as read,
  moves the marker up to the mention so the other devices drop their `@` too.
  An `@` for the session already on screen goes as soon as it arrives. The
  marks are kept per account in local storage (ids and times only, never
  text), and are dropped when the share is removed.
- When the event arrives live (not in catch-up after sign-in), the session is
  not already read, and **Mention notifications** is on:
  - The in-app notification shows at once: "<name> mentioned you", the
    workspace name, **Open** and **Mark as read**. The quote is filled in once
    this device has the message, looked up by `messageId` in its own
    transcript: the loaded tab log, the saved cache, or the tab's encrypted
    checkpoint, decrypted here. The checkpoint list is read again first,
    because a new follower knows none of the workspace's tabs. A checkpoint
    saved before the message is tried again for about half a minute; after
    that the notification stays without a quote.
  - Only a message the transcript says the mentioning person wrote is quoted
    (its `user_message` `author.userId` is the event's `actorId`). The server
    takes `messageId` from the sender as given, so without this a mention
    could attach someone else's message to it. A message by anyone else, or
    with no author, gives no quote. Cloud agent tabs do not yet record an
    author on `user_message` (the runtime's mailbox keeps the sender on the
    command only), so until the runtime records it, cloud mentions show
    without a quote.
  - The macOS banner reads "<first name> mentioned you" with the workspace
    name. It never carries the message, because banners can show on the lock
    screen.
- With **Mention notifications** off (Settings › General), there is no notice
  and no banner. The server still adds the follower, and the `@` row mark
  still shows.

## Deliberate differences from the designs

- The 17.06 banner shows the quote; ours does not (lock-screen policy).
- 14.07 refers to the workspace as "#18"; ours uses the workspace's name and
  "them".
- 13.03 draws the chip inline in the text field. The composer is a plain
  textarea, so ours draws the chips in a row above the text, while the text
  keeps `@Name`.
- 13.16's dedicated Notifications panel, unread total and next-unread shortcut
  are still deferred (see PHASE2-DESKTOP-EVENTS.md). Mentions show as the
  in-app notification and as the row's `@` and bold title.
- There is no per-sender rate limit beyond the 10-people cap per message and
  the route's member and body limits.
