# PRO-128: roster caching and teammate profiles

Flag: `team.roster.v1`. Owner: the PRO-128 feature owner; rollout operator must be
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

Metrics: Roster requests per repeated Share open (one until refresh), roster fetch p95, popover rendering failures, stale-member removals and cross-organisation data checks.

Rollback thresholds: Kill immediately for cross-organisation data. Pause if removed members remain after a successful refresh, repeated Share opens fetch twice, or roster API 5xx exceeds 1% over 15 minutes.

## Stage release notes and documentation

These are prepared stage notes, not claims of deployment. Publish the relevant
row with its actual date/version and evidence when that stage starts. Update
the feature docs at the same time; record links in the evidence column.

| Stage | Release note | Documentation update | Evidence |
| --- | --- | --- | --- |
| Internal | Internal preview: People can open a teammate profile from an avatar and copy user details; repeated Share opens reuse the organisation roster. Available only to the internal organisation. | Gate behavior, two-device checks, known limits and kill procedure. | Pending real cohort |
| Design partners | Partner preview: People can open a teammate profile from an avatar and copy user details; repeated Share opens reuse the organisation roster. Enabled for selected partner teams. | Partner walkthrough, support route and fallback behavior. | Pending |
| 10% | Limited release: People can open a teammate profile from an avatar and copy user details; repeated Share opens reuse the organisation roster. Enabled for a stable 10% of organisations. | Eligibility, troubleshooting and refresh behavior. | Pending |
| Everyone | General availability: People can open a teammate profile from an avatar and copy user details; repeated Share opens reuse the organisation roster. | Public walkthrough, permission rules and recovery steps. | Pending |

Rollback note: “We temporarily disabled roster caching and teammate profiles while investigating a
regression. Existing work and saved data remain available. Availability updates
after the next account refresh.” Publish with the incident reference and next
update time if the kill switch is used.

Rehearsal evidence (2026-11-06): server
`src/services/featureFlags/evaluateFeatureFlags.test.ts`,
`src/controllers/desktop/buildDesktopSession.test.ts`,
`test/featureFlags.db.test.ts`; desktop `src/lib/featureFlags.test.tsx`.
Production promotion requires the unchecked gates above; the local rehearsal
does not substitute for them.
