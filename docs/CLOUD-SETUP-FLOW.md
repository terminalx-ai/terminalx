# Guided cloud setup (PRO-191)

Home → Set up cloud computer opens a full-window flow. Settings → Organizations
also offers it. Get started selects or creates an organization; Cloud computer
reuses provider controls; Connect GitHub reuses the installation/repository
picker; Agents embeds OrganizationAgentLogins. Each Continue validates the
server facts. The last step uses the existing idempotent setup workspace
creation and waits for its runtime before enabling Go to workspaces.

Enter on the step heading continues. Native buttons, selects and text fields
keep their own keyboard behavior. Escape returns to Settings; dialogs keep
Escape while they are open.

Guided creation keeps the environment-check prompt in the signed-in user's
organization setup record, with the workspace id. No launch prompt is sent.
The workspace offers an editable draft and a Send coach mark. Send creates the
chosen agent tab and uses the existing cloud mailbox; a send failure retains
the draft and tab id. Dismissing the coach mark is remembered for that setup.
Signing out clears these records with the existing setup cleanup.

The organization roster carries `computerColor`: blue (default), violet, pink,
orange, green, or teal. `POST /v1/desktop/orgs/:orgId/computer-color` accepts
`{computerColor}` and returns the saved value. Only current owners/admins may
write; nonmembers receive 404. The desktop command fences by account context,
updates its account snapshot and renders the shared accent on cloud rows and
headers. Teammates receive it through normal account refresh. Older servers
omit the property and show blue. Deploy server migration
`0104_organization_computer_color` before enabling the desktop color picker.

The environment page guards navigation for local edits and saved changes that
still need building. A build of the current revision releases the saved-change
guard, while unsaved edits stay guarded. The prompt preserves the requested
destination; Cancel keeps the draft. Browser unload uses its native prompt.
The change summary names changed fields, Discard restores the saved template,
and Copy logs copies the complete fetched log including phase labels.

Validation: Vitest covers each step, validation refusals, keyboard dispatch,
organization selection, the leave guard, color preview/rollback, draft sending,
and the guided creation path. `pnpm test:webkit-cloud-setup` exercises Enter,
focused controls and Escape in WebKit against the normal built app and bridge
fixture. The server route tests cover manager writes, member/nonmember refusal,
invalid colors, and revoked authority at the write.

The setup draft sends to the tab named by the workspace launch response, which already owns the selected repository checkout. It never creates another tab. A send remains owned by the account and setup record when the view closes. A changed account, profile or manager role fences late writes; an uncertain response retains the sending marker and directs the person to the normal session message queue instead of replaying the prompt.

Member callouts read `cloudComputerReady` from the organization roster. The server checks whether the organization has a ready or suspended, undeleted workspace, independently of the member's access to its contents. An older server without this field supplies no readiness assertion.

The paired server change includes the unchanged `0103_feature_flags` migration from PRO-252 before `0104_organization_computer_color`. Both incremental paths (PRO-252 first, or this complete chain first) must retain the feature-flag tables and color column. Deploy the server before the desktop.
