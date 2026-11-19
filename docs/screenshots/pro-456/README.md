# PRO-456 Cloud list simulator evidence

## Acceptance decision

For the evidence follow-up, the owner directed us to use the iPhone simulator and publish the comparison through a pull request. The simulator comparison is the accepted publication evidence for [GitHub issue #1206](https://github.com/terminalx-ai/terminalx/issues/1206). The original physical iPhone 17 Pro Max check remains an author-reported observation in [PR #1186](https://github.com/terminalx-ai/terminalx/pull/1186).

## Verification

The Release simulator build used TerminalX source `4e792341097ab6ef9b04b26cc526aeb9c09800b8` on an iPhone 17 Pro Max simulator running iOS 27.0. The checked-in [Cloud fixture](../../../mobile/scripts/phone-fixture/README.md) supplies synthetic organizations and workspaces to the app's Cloud catalog.

- ACME showed the stopped `Warm-up run` workspace from `fixture-compute`. Tapping it opened the correct stopped workspace and displayed its saved conversation.
- The footer showed five empty organizations. Expanding it listed Globex, Initech, Umbrella, Hooli, and Vandelay. ACME and Northwind appeared in the workspace list.
- The two PRO-456 catalog regression tests passed. They exercise a synthetic Agent37 Demo response and verify one workspace row, exclusion from the empty-organizations footer, and a footer count of ten.

The left panel shows design frame 22.06-2 from the [original design comparison in PR #1015](https://github.com/terminalx-ai/terminalx/pull/1015). The right panel shows the simulator's Cloud list in the Ember theme.

![Design frame 22.06-2 alongside TerminalX on the iPhone 17 Pro Max simulator with synthetic Cloud data](22.06-2-simulator-comparison.png)
