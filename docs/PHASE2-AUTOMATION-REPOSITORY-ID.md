# Selected repository identity for automation

The existing organization `github-app` response supplies `id` as the selected
repository database row ID. Native `SelectedRepository` preserves this value
through its serialized response, and `CloudSelectedRepository.id` exposes it as
an optional nullable string. Older responses may omit it or send null; non-string
IDs are rejected rather than coerced. No identifier is inferred from the numeric
GitHub repository ID, full name, or clone URL.

A future trigger editor must offer only accessible repositories with a nonempty
authoritative row ID, and send that exact ID as `githubTrigger.repositoryId`.
This projection does not alter authorization or the existing production
activation hold. The focused native HTTP and serde compatibility test is named
`phase2_automation_repository_identity_http_and_serde_compatibility`.

Checks are unrun under the source-only allocation.
