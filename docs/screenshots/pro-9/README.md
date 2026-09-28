# PRO-9 computer-use evidence

Captured on 2026-09-21 using the `computer-use` skill and `terminalx computer` accessibility actions/screenshots against an isolated Brave profile. Each PNG has a matching `.txt` accessibility snapshot. Screenshots are unedited.

The page is the **changed production `ProviderControls` component**, imported by `scripts/fixtures/pro-9/main.tsx`, served from the changed desktop worktree at `http://127.0.0.1:1549/scripts/fixtures/pro-9/index.html`. The fixture replaces native API methods with controlled synthetic responses. This is fixture UI evidence, not an installed-app test, native secure-dialog test, integrated desktop-to-SaaS test, or live-provider evidence. No real credentials or resources were used.

| Scenario | Screenshot | Actual observed result |
| --- | --- | --- |
| Same-account rotation | [admin-rotation](admin-rotation.png) | After consent and Validate and save key, version advanced from 3 to 4. Original account and running workspace remained visible. |
| Member / invalidation | [member](member.png) | Organization-admin repair message appeared. Replace, validate, disconnect and account/version metadata were absent. |
| Wrong provider account | [account-mismatch](account-mismatch.png) | Replacement was rejected; version 3 and original ownership remained visible with cleanup/migration guidance. |
| Invalid replacement | [invalid-key](invalid-key.png) | Validation error appeared; saved version remained 3. |
| Revoked key during a job | [revoked-running-job](revoked-running-job.png) | Attention-required status appeared while the running operation/resource remained listed. |
| Unavailable cleanup credential | [cleanup-pending](cleanup-pending.png) | Disconnect pending and new provisioning blocked; failed cleanup and quoted charges remained visible. |
| Explicit disposition | [disconnect-decision](disconnect-decision.png) | Neither radio was preselected. Confirm disconnect remained disabled until retain or destroy was selected. |
| Failed cleanup retry | [cleanup-failed-retry](cleanup-failed-retry.png) | Selecting destroy and confirming retained the pending state and failed operation; retry control remained available. |
| Same-account repair during disconnect | [cleanup-repaired](cleanup-repaired.png) | Consent/validation advanced version to 4 while disconnect remained pending with its resources. |
| Cleanup recovery | [cleanup-completed](cleanup-completed.png) | After repair and a further destroy retry, the fixture displayed Provider disconnected and no unresolved resources; original account identity remained. |

To reproduce, run `pnpm exec vite --host 127.0.0.1 --port 1549` from the desktop worktree, open the URL above in an isolated browser profile, and use the scenario dropdown. For replacement scenarios click Replace / validate key, accept the billing/organization checkbox, then Validate and save key. For cleanup select Cleanup unavailable / retry, retry with an explicit destroy decision, repair via the replacement flow, then retry destroy. Provider calls and native key entry are simulated by the fixture.

The browser and local Vite instance were available during parent review; rerun the fixture after workspace cleanup. Use fresh `terminalx computer get-app-state` output before selecting accessibility indices. Actual helper actions used only `terminalx computer`; no scripted DOM actions supplied the observations.
