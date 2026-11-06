# Rollout checklist template

Copy this file per feature. Record the feature key, owner, server/desktop commits,
dashboard/query links, internal organisation ID and approved partner IDs. Never
check a production stage from a local test. No real rollout has occurred merely
because the infrastructure is merged.

- [ ] Definition exists with switch off and 0%; older-server and missing-field paths stay off.
- [ ] All new UI, open dialogs, subscribers and mutations are gated; permissions still apply.
- [ ] Tests cover internal, partner, 10%, everyone, scoped deny and global kill.
- [ ] Kill an already visible feature; next capabilities refresh removes it without restart.
- [ ] Verify scoped rules cannot expose another organisation's data.
- [ ] Record baseline metric window and rollback thresholds before enabling.

| Stage | Configuration | Minimum observation | Required record |
| --- | --- | --- | --- |
| Internal | Global on, 0%; internal organisation 100% | 24 hours with two accounts and two devices | Exact IDs/commits, checklist evidence, internal release note and updated feature docs |
| Design partners | Keep internal; add approved partner organisations at 100% | 48 hours and partner confirmation | Partner IDs, support feedback, partner release note and docs links |
| 10% | Global 10%; retain explicit pilot exceptions | 48 hours with representative load | Cohort counts, baseline comparison, limited-release note and docs links |
| Everyone | Global 100%; remove obsolete exceptions deliberately | 7 days monitoring | General release note, public docs and support/rollback owner |

At every stage: verify the enabled cohort and control cohort with real membership
accounts; exercise one normal path and one permission refusal; record errors,
latency and privacy results; publish the stage's release note and documentation;
then sign and date the stage. Any unauthorized disclosure or access is an
immediate kill. Pause on missing metrics or an unexplained regression.

Rollback: turn the global switch off, save the new revision, force one
capabilities refresh on an affected running client, confirm the feature hides,
confirm feature API writes are refused, and watch the error rate return to
baseline. Keep data intact for recovery. Record the incident and rollback note.
Re-enabling starts again at internal after the fix has independent review.
