# Native parser control: failed reservation and repaired handshake

Update: the corrected comparison subsequently completed; see
[the measured result](wk-parser-control-result.md). This document preserves the
earlier preparation/failure record.

No comparative allocation result was obtained in the 13:51–13:56 UTC reservation
on 24 October 2026. The original production +68.46% failure remains unresolved.

## Reserved attempt

The coordinator confirmed #439's guest stopped and #467's actual heavy-job exit.
Own checks found no Cargo/rustc work, no guest process over 15% CPU, and host CPU
79.36–82.8% idle. Host UI processes were active, and seven swap-ins occurred in the
one-second host sample. These observations were retained, not called pristine
physical-host timing conditions. Probe and workload hashes matched preparation.

The outer command started at **13:51:54 UTC**; the driver created its result
directory at **13:51:55 UTC**. The control failed its 25-second baseline timeout.
The driver exited 1 at **13:52:20 UTC**, terminating its child. An actual process
check found no remaining probe. The parser process was **never launched**. The
reservation was released immediately after confirming exit, and both owners
received direct CLI messages at 13:52:49.315/322 UTC. No footprint sample was taken. The first driver
did not persist its child PID/start/exit record on early failure; the outer
bounds are retained honestly instead of inventing that missing precision.

## Bounded startup diagnosis, without memory sampling

The fixture loads into an offscreen, hidden WKWebView. An eight-second native
`evaluateJavaScript` check found `document.readyState=complete`, the expected core
and runner, and `visibilityState=hidden`; the pending baseline arrived when that
native evaluation ran. This is consistent with suspended/throttled hidden-page
JavaScript timers, rather than failure to load xterm. It is not a proof of the
specific internal WebKit scheduling policy.

Revision 2 moves both fixed five-second phase delays to native dispatch, waking
the page through public `evaluateJavaScript`. The baseline delay starts after
navigation completes; the endpoint delay starts after parser execution returns.
It does not extend an acceptance wait or introduce forced GC. The revised driver
also persists launch, PID, error and actual exit information on failure.

The first functional check of the revision delivered its baseline, then exposed
a separate WKWebView bridge error: returning the message-posting expression was
an unsupported JavaScript result type. The native evaluations now explicitly
return `null`. That failed check is preserved too.

The corrected functional checks took no footprint samples:

| Mode | Probe PID | Start UTC | Baseline UTC | Endpoint UTC | Actual exit UTC |
| --- | ---: | --- | --- | --- | --- |
| Control | 85210 | 13:55:27.084013 | 13:55:33.486 | 13:55:38.517 | 13:55:38.526089 |
| Parser | 85238 | 13:56:03.466428 | 13:56:09.916 | 13:56:15.085 | 13:56:15.095050 |

Both functional drivers exited 0 after verifying the two phase messages; each
then terminated only its own completed probe with SIGTERM (child status -15).
The parser verified real output from eight terminals and tracked 24 terminal/
buffer objects. **21 were still alive at the unforced five-second endpoint.**
This is not evidence of a persistent owner or leak. It demonstrates why the prior
forced-GC JSC snapshot attribution cannot simply be substituted for an unforced
WKWebView endpoint. Any future raw footprint growth in this fixture must retain
that liveness qualification; it cannot be called exclusively native cache growth.

## Next executable step

The corrected fixture is prepared and compiled in both host and assigned guest
at `/tmp/tx232-wk-parser-control-v2/`. A comparative run still needs a new bounded
quiet reservation; the old one was released and was not reused. The command is:

```sh
cua sandbox exec local:tx-queue-232 \
  'python3 /tmp/tx232-wk-parser-control-v2/run.py'
```

Maximum reservation: five minutes, released immediately after both actual child
exits. The same control/parser workload, fixed delays, no forced GC and raw-byte
categories apply. Record object liveness alongside allocation deltas. If objects
remain alive, the result bounds the parser's uncollected allocation contribution;
it does not attribute the production endpoint after all buffers collected.

`wk-parser-control-startup-evidence.tar.gz` and its manifest preserve the original
failed guest directory, reservation logs, startup probe, revised source, failed
and passing functional logs, and hashes. No production/runtime files changed.
The four runtime checks remain those passed for `a0880b80`; these diagnostic
sources were compiled in the guest, Python syntax-checked, and functionally run.
