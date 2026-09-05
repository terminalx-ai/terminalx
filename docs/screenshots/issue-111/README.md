# Issue 111 visual verification

Captured on macOS on 2026-09-05 at 1360×860 and 1000×700 using the actual
`StatsUsageView`, `statsUsageStore`, application styles, and Den dark theme.
A temporary Vite harness supplied the captured summary from the isolated QA
installation's `stats-activity.json`: 33 starts, 9,445,747 ms (displayed as
2h 37m), 13 PRs, tracking since September 2, 2026. No provider snapshot was
supplied, exercising lifetime activity before any successful provider scan.

`activity-*.png` show the clean state. `provider-error-*.png` inject the error
“Provider history could not be read” at the API boundary to verify that a
provider failure remains visible alongside the same known lifetime totals.
The error is a QA injection, not an observed failure in the copied profile.

All four screenshots were read back. Metric cards, date, lifetime definition,
recovery caveat, error, and Retry control fit without clipping or horizontal
overflow at both sizes. The browser DOM confirmed the requested dimensions,
matching document width, and the expected alert contents.

Method: installed Browser Use CLI over CDP to an isolated installed Chromium
headless shell, Vite on port 1427, and a disposable browser profile. The harness
and processes were removed after capture. This verifies component layout in
Chromium; native Tauri window chrome, traffic lights, and WKWebView rendering
were not verified by these captures.
