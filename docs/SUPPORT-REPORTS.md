# Scoped support reports

[TerminalX #1246](https://github.com/terminalx-ai/terminalx/issues/1246) adds a shared support-report flow. Paresh Dudhat owns the private support queue. The approved desktop design puts the form in Settings → About and the Help menu. PRO-142's standalone local Diagnostics page starts with versions and recent errors, with health checks and fixes deferred. [Recorded PRO-142 decision](https://linear.app/procyonlabs/issue/PRO-142/add-a-local-diagnostics-page-with-json-export-and-a-send-feedback-link#comment-c1e725d7)

## Send a report

1. Open **Support report** in desktop Settings → About, or **Send a support report** from desktop Help or mobile Settings. Choose the feature and symptom, then choose a 1-hour, 24-hour, or 7-day window ending when you prepare the report.
2. Select the relevant sources and choose **Prepare preview**. Sources start unselected. Review the window, source statuses, and the fields TerminalX Support would receive. Timestamps, platform, versions, and event codes may reveal usage patterns. Cancel before **Send** to discard the local draft. A preview expires on the server after 15 minutes and creates no support-queue entry.
3. Choose **Send to TerminalX Support**. The app displays the support reference after the service commits the report. If delivery is uncertain, use **Retry same report**. If the service is unavailable, you can copy the reviewed local report as JSON. Treat that copy as private and share it only with the intended recipient.
4. To include another device, sign in to the same account on that device, choose **Add to a report**, and enter the support reference. Select, preview, and send that device's contribution explicitly. It uses the original window and requires at least one device event. On mobile, the attempted report remains available for retry if you leave and reopen the form during the same app run. The reference alone grants no access, and pairing never grants access to the other device's diagnostic data.

The structured problem description accepts a fixed feature and symptom. Report attachments and free-text descriptions would require a separate consent design. The app blocks desktop delivery while Data Privacy Mode is on, including against managed settings.

## Sources and privacy

| Source | Included when selected and available |
| --- | --- |
| Desktop app and runtime connections | App version, platform, capture time, and typed close events from the app's current run. The buffer is scoped to the signed-in desktop account, cloud profile, and reachable organizations. The report omits organization and workspace identifiers. [Cloud diagnostics](ACCOUNTS.md#cloud-diagnostics-and-export) |
| Mobile app and connections | App version and build when available, platform, capture time, and typed connection stages, path classes, and failure classes from the current app run. The source covers saved, account-bound pairings. The phone's local connection log stays on the phone. |
| TerminalX SaaS account | Service version, capture time, and typed pairing audit actions where the signed-in account was both owner and actor. The query projects the action and timestamp. SaaS organization, worker, and relay-service events are recorded as unavailable. [Pairing audit schema](https://github.com/dudhatparesh/terminalx-saas/blob/522e6dce9772d28ce444f64ef788a34e4b00daca/apps/api/src/db/schema/accountPairingAuditEvents.ts) |

The report identifies the missing device, disabled sources, empty results, and collection failures. Desktop startup history is listed as unavailable because the existing local history lacks a report-safe account binding. The organization-wide cloud diagnostics export is a separate admin-authorized surface. [Local startup diagnostics](testing/startup-stalls.md), [Cloud diagnostics contract](https://github.com/dudhatparesh/terminalx-saas/blob/522e6dce9772d28ce444f64ef788a34e4b00daca/apps/api/docs/cloud-workspace-remote-runtime-contract.md#22-diagnostics-pro-38)

Each source uses a versioned allowlist. SaaS validates the submitted schema again and strips fields outside the projection. The report and export omit credentials, environment values and hashes, personal and device identifiers, addresses, paths, prompts, terminal output, and raw logs. The limit is 100 recent events or 64 KiB per source and 256 KiB per report, including the second device. Device coverage shows the retained interval within the requested window. Unobserved time can fall outside the interval after an app restart or buffer eviction. A null interval means no part of the selected window is known to be covered. Desktop copy and send recheck the organization access used for the preview.

## Support queue and deletion

- The clients send reports to the signed-in SaaS API over HTTPS. The authenticated preview key binds the report window, reviewed server snapshot, account, and app session. The service returns the existing receipt when an identical submission is retried successfully within 24 hours. A request for a missing, expired, or already attached device contribution returns a refusal.
- The [Support reports console](https://console.terminalx.ai/support-reports) lists the newest reports for authorized support staff. Staff select a reason before listing or opening a report. The audit records the actor, action, reference where applicable, time, and result count. A failed audit write prevents delivery of staff results. Staff can use the reference to locate a specific report and compare event times and versions across its sources.
- The submitter can delete a report from **Manage report** or by entering its reference in the console. Deletion and 30-day expiry remove report data and block further access. Account deletion cascades to report data and preview attempts. Payload-free audit records expire after 90 days. Exported copies are managed by whoever saved them.
- Keep intake disabled until the SaaS owner has applied the companion migration, configured the named support staff account IDs, verified the retention job and database encryption, and confirmed the backup expiry and deletion-on-restore procedure. Then enable `SUPPORT_REPORTS_ENABLED`. Report inputs and diagnostic values must remain out of operational logs.

## Release acceptance

Exercise a deliberate synthetic submission from a supported desktop build and a supported phone build against the staging service. Attach from the second device, confirm the same reference in the staff queue, verify an audit record, and delete the fixture. Keep the evidence free of user data. [PRO-456 physical-device evidence](https://github.com/terminalx-ai/terminalx/issues/1206) is a separate acceptance item.
