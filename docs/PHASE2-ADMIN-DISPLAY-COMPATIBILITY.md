# Existing Admin display compatibility — source only

The two preserved changed files from `admin-display-pro167-existing-admin-row`
are integrated with the guarded transport and lead CURRENT 133/137 API source.
No changes to the optional cloudCollab, accountRoles or cloudLifecycle helpers
were needed for this display compatibility.

Existing manager shares display Admin in read-only rows and as a disabled
current value in the existing role selector. New-person choices remain Viewer
and Driver. Existing role demotion/revoke behavior is retained. Manager approval
true cannot be switched off in the dialog; manager false is never silently
upgraded. The local put guard refuses manager false, while native transport holds
manager true in production. Approval remains independent for Viewer and Driver.
Creator text also respects the actual approval boolean.

Effective manager access alone does not identify an organization owner/admin.
Creator wording requires creator identity evidence; known organization roles
retain their wording, ordinary members say Workspace Admin, and unknown
provenance says Admin. Delayed roster evidence can refine that label. This does
not infer organization authority from a workspace share.

Tests preserve legacy role updates and author regressions for existing manager
selection, disabled approval, read-only false approval, truthful provenance,
delayed roster evidence and exact last-admin/unsupported feedback. All tests
in THIS COMBINATION are UNRUN; the earlier ten-test transport success does not
certify the combined source.

Broader Admin new-grant controls, Save/autosave workflow, redesign and general
access remain PENDING. No option, Save flow, route, approval protocol, runtime
capability or production activation is added. Accepted server source e9f619fb
is available but production remains held. Fresh serial allocation and the
wave6 grant are required before checks or hooks. Root validates after collection.
