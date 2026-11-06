# PRO-125: organisation events and synced unread state

Flag: `team.events.v1`. Owner: the PRO-125 feature owner; rollout operator must be
named before internal enablement. Production status: **not enabled**. All
organisation IDs in automated tests are synthetic; no real internal or partner
organisation has been selected by this change.

This applies [the rollout checklist](CHECKLIST.md) to one of the first two
features. Infrastructure rehearsal is local; feature-owner UI/access tests and
production observation remain release gates.

- [x] Flag registered and migrated off at 0%.
- [x] Internal → partner → 10% → everyone → kill exercised by the evaluator tests.
- [x] Real PostgreSQL/API rehearsal covers scoped rules, default-off, global kill
  on the next capabilities build, stale-revision rejection and admin authorization.
- [x] A mounted hook consumer hides on the next capability snapshot in Vitest.
- [ ] Feature owner's full UI/subscriber/permissions tests pass with the shared gate.
- [ ] Operator, exact deployed commits, metric queries and real cohort IDs recorded.
- [ ] Internal observation and release note/docs published.
- [ ] Partner observation and release note/docs published.
- [ ] 10% observation and release note/docs published.
- [ ] Everyone observation and release note/docs published.

Metrics: Share-to-sidebar and read-to-other-device p95 ≤2 seconds while connected, zero duplicate application, zero events for inaccessible workspaces, reconnect recovery, SSE/fallback ratio and API error rate.

Rollback thresholds: Kill immediately for any inaccessible-workspace event. Pause if p95 exceeds 2 seconds for 15 minutes, duplicate application occurs, or feature API 5xx exceeds 1% over 15 minutes.

## Stage release notes and documentation

These are prepared stage notes, not claims of deployment. Publish the relevant
row with its actual date/version and evidence when that stage starts. Update
the feature docs at the same time; record links in the evidence column.

| Stage | Release note | Documentation update | Evidence |
| --- | --- | --- | --- |
| Internal | Internal preview: Share and read updates arrive live; catalog polling remains the recovery path. Available only to the internal organisation. | Gate behavior, two-device checks, known limits and kill procedure. | Pending real cohort |
| Design partners | Partner preview: Share and read updates arrive live; catalog polling remains the recovery path. Enabled for selected partner teams. | Partner walkthrough, support route and fallback behavior. | Pending |
| 10% | Limited release: Share and read updates arrive live; catalog polling remains the recovery path. Enabled for a stable 10% of organisations. | Eligibility, troubleshooting and refresh behavior. | Pending |
| Everyone | General availability: Share and read updates arrive live; catalog polling remains the recovery path. | Public walkthrough, permission rules and recovery steps. | Pending |

Rollback note: “We temporarily disabled organisation events and synced unread state while investigating a
regression. Existing work and saved data remain available. Availability updates
after the next account refresh.” Publish with the incident reference and next
update time if the kill switch is used.

Rehearsal evidence (2026-11-06): server
`src/services/featureFlags/evaluateFeatureFlags.test.ts`,
`src/controllers/desktop/buildDesktopSession.test.ts`,
`test/featureFlags.db.test.ts`; desktop `src/lib/featureFlags.test.tsx`.
Production promotion requires the unchecked gates above; the local rehearsal
does not substitute for them.
