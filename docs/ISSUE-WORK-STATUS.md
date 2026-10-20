# Who is working on an issue

Issue: [#441](https://github.com/terminalx-ai/terminalx/issues/441)

The Issues list shows who already works on an issue in TerminalX, and where,
so that two sessions are not started on the same issue by accident: by one
person on two machines, or by two people on a team.

## What the reader sees

| Chip | Means |
| -- | -- |
| You · this Mac | A session on this Mac is linked to the issue (what used to be the "Session" chip) |
| You · on *Studio* | A session on another of the reader's machines, named as in its Settings → Account |
| You · in the cloud | A session in one of the reader's cloud workspaces |
| *Alice* · working | A teammate's session. The teammate's machine is never named |
| *Alice* · 2 hours ago | Faded: was working on it, and has not been since |

With several, the first is shown with "+N". Hovering shows each: person,
machine (own machines only), session title, branch, state (agent working,
waiting for an answer, idle, has an open pull request), how the session was
linked when that was automatic, and when it was last active. The same list
is in the issue's detail pane, and the issue chip in a session's title bar
says who else works on that issue now.

The order is the most telling first: work now before work a while ago, and
teammates and other machines before this Mac.

The filter beside "Assigned to me" offers **Hide issues someone is working
on** (anyone working on it now, the reader included) and **Only mine** (the
reader's own work, on any machine, now or a while ago).

**Start session** on an issue someone works on now asks first: "*Alice* has
been working on this since 10:42, on branch alice/11-login." with **Start
anyway**, **Open the existing session** (when it is on this Mac) and
**Cancel**. It is a warning, never a lock.

## What counts as working on it

A session linked to the issue counts while its machine still refreshes it
and either an agent turn runs (or waits on the person) or it was active in
the last 30 minutes. Otherwise it fades to "was working on this, *time*
ago", and after a day without activity it is gone. A machine that goes
offline keeps its last state with its age; stale data never shows as
working now. Each machine's ages are measured on the server's clock, so a
wrong clock on one Mac does not age or freshen anything.

The claim goes at once when the session is archived, deleted or unlinked,
or set not to share. The indicator also goes at once for a closed issue
(the reader has its state), and the claim is withdrawn once its pull
request is seen merged (read every five minutes).

This Mac's own sessions always show, however old, as the "Session" chip
did: they can be opened.

## Linking sessions to issues

A session started from the Issues list (or `terminalx sessions create
--issue`) is linked to its issue, as before. Others are linked
automatically, once the tracker confirms the issue exists (on GitHub, as
an issue and not a pull request):

- **Branch or worktree name**: `441-fix`, `raccoon/441-…`, `fix/issue-441`,
  `gh-441`, `#441`, or a Linear identifier of a team the key can see
  (`me/eng-42-login`).
- **Pull request**: one the session's branch opened that closes the issue
  (GitHub's own link), or a Linear identifier in its title or after a
  closing word in its body.
- **First prompt**: the issue's URL, `fixes #441` (and the like) or a
  leading `#441`, or a Linear identifier.

Only sessions active in the last week are looked at, and each candidate is
asked about once; a lookup that failed is asked again two minutes later.
Linear's team keys are read once an hour, and so is a Linear that could not
say them (a revoked key, or offline at launch). Until they are known no
Linear identifier is recognised; the read that first has them looks at each
session again, its first prompt from what was read of it then, so a
Linear-named session can take up to an hour to be linked. An automatic link
says how it was made (in the title bar chip's tooltip and the menu), and
every link can be removed:

- **Link to issue…** in a session's menu (sidebar, conversation list, or the
  tab's right-click menu) picks an issue of its project.
- **Unlink** removes it; an issue unlinked by hand is never linked to that
  session again automatically.
- **Don't share this session** keeps its work status on this Mac.

## Who sees what

- **The same person on other machines**: always, once signed in on both.
- **Teammates**: only members of a non-personal organization that both
  belong to and that has work status on, and only on issues that are the
  organization's:
  - a GitHub issue whose repository the organization connected (one of its
    repositories selected for cloud workspaces, or any repository of a
    GitHub account its GitHub App is installed on for all repositories).
    What counts is the issue's repository, not the checkout's, so work in a
    personal fork on the organization's issue shows;
  - a Linear issue in a workspace the organization's admins named on its
    page in Settings → Organizations, worked on in a project whose
    repository the organization connected.

  Anything else, a personal project's work among it, is never shown to
  anyone else: asking for another repository or workspace answers nothing.
  Membership is read again on every request, so someone who leaves stops
  seeing at once.
- **What leaves the machine**: the issue (provider, id, identifier, and its
  repository or Linear workspace), the person (from the account token), a
  device id and this Mac's name, the session id and title, the branch, a
  coarse state, the project's normalised remote, whether it is a cloud
  session, whether teammates may see it, and how long ago it was last
  active. No prompt, transcript, path, diff or code. The server refuses
  any other field.
- **Controls**: Settings → Account → "Show my team what I'm working on"
  (own machines still see it), the per-session "Don't share this session",
  and, for an organization's owners and admins, "Work status in
  *organization*" and its Linear workspaces on the organization's page in
  Settings → Organizations, whichever organization is active.
- **Machine names** go only to their owner; teammates see the person.

## How it works

- **Publishing** (`src-tauri/src/work_claims/`): a background thread
  watches the session index (`store::index::revision`), and a few seconds
  after a change settles sends this Mac's whole claim set
  (`PUT /v1/desktop/work-claims/devices/<host id>`). The set is sent again
  every two minutes as a heartbeat; an unchanged set is not sent before
  then. Leaving a claim out withdraws it. Sign-out withdraws them all
  (`DELETE`) while the token still works. Failures back off up to five
  minutes.
- **Reading** (`work_claims_list`): the Issues list asks for the claims of
  the issues it shows (GitHub: the project's repository; Linear: the issues'
  workspaces) together with the list, and again every 20 seconds while it is
  open and the window visible. This Mac's own local claims are dropped from
  the answer: the window knows them better from its own sessions.
- **Identity across machines**: a project is matched by its normalised
  remote (`github.com/acme/widgets`, whatever the scheme, user info or
  `.git`), never its path. An issue is matched by provider, scope
  (`github.com/<owner>/<repo>` or `linear.app/<workspace>`, read from its
  address) and identifier (`#441`, `ENG-42`): two repositories' `#12` are
  two issues, on this Mac as on the server. A person's session carries an
  opaque key from the server, the same from each of their machines, so a
  cloud session published by two Macs shows once.
- **Limits**: the server keeps claims for at most ten of a person's devices
  at a time, takes one publish per device every two seconds (the desktop
  waits as long as it is asked), and shows at most 50 claims of one person
  in a read.
- **Device**: the pairing host id and its editable name from Settings →
  Account.
- **Cloud sessions**: a cloud session carries no issue reference, so the
  window hands the cloud sessions it knows about to the publisher
  (`src/lib/cloudWorkClaims.ts`), which finds the issue a session's branch
  names in its workspace's repository and publishes it as a cloud claim.
  Only sessions of workspaces the reader created are published. Each of the
  reader's machines may publish the same cloud session; the reader shows it
  once.
- **Signed out, offline, or a server without the capability**
  (`account.work-claims.v1`): the list works as before with this Mac's
  sessions, and says the shared status is unavailable.

| Where | What |
| -- | -- |
| `src-tauri/src/work_claims/claims.rs` | What a claim says, from the index alone; remote and scope normalisation |
| `src-tauri/src/work_claims/links.rs` | Automatic links from branch, pull request and first prompt |
| `src-tauri/src/work_claims/client.rs` | The account service's routes |
| `src-tauri/src/work_claims/mod.rs` | The publisher, the reader, link/unlink/private |
| `src/lib/issueWork.ts` | Local and remote work merged, aged, sorted and labelled; the polling hooks |
| `src/components/issues/IssueWork.tsx` | The chip, the detail list, the start warning |
| `src/components/session/LinkIssueDialog.tsx`, `IssueLinkMenuItems.tsx` | Link to issue…, Unlink, Don't share this session |
| `src/components/settings/WorkStatusSettings.tsx` | The person's switch (Settings → Account) and the organization's (its page in Settings → Organizations) |

## Server

The account service side is in terminalx-saas (branch
`raccoon/441-work-claims`, contract `apps/api/docs/work-claims.md`). A
snapshot of its two commits (`6c86414`, `1615d7c`) is in
[patches/441-terminalx-server.patch](patches/441-terminalx-server.patch),
based on server commit `3bb4d26`. It adds migration 0095
(`issue_work_claims`, and `organization_work_status_settings` with the
switch and the organization's Linear workspaces), the routes
`PUT`/`DELETE /v1/desktop/work-claims/devices/:deviceId`,
`GET /v1/desktop/work-claims` and `GET`/`POST /v1/desktop/orgs/:orgId/work-status`,
the `account.work-claims.v1` capability flag, and the limits above (409
`work_claims_device_limit`, 429 `work_claims_rate_limited` with
`Retry-After`). Deploy it before
releasing the desktop feature; until then the desktop shows this Mac only.

## Not done

- Mirroring a claim to the tracker itself (self-assign, or "In progress" on
  Linear) is left for later, off by default.
- A teammate's cloud session in a workspace someone else created is not
  attributed to them: the server does not say who started a cloud session.
- The list is read on a timer; the server has no push channel for it.
