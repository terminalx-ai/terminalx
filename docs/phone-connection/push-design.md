# End-to-end encrypted Apple push notifications

Part of the phone connection research (#989). This is a design, not shipped
code. It answers the push questions in #989 and builds on the notification
settings in #990 (Superdesign board 22.07, approved 2026-11-15).

## Summary

- The Mac encrypts every notification for the phone with HPKE. The relay
  passes the sealed bytes to Apple. A Notification Service Extension on the
  phone opens them and writes the real text. The relay and Apple only ever see
  a fixed placeholder ("TerminalX", "New activity on your Mac") and ciphertext
  of a fixed size.
- The phone gets a new key pair for push only. Its private key is readable
  after first unlock, so the extension can use it on a locked phone. It is not
  the transport key, which stays readable only while the phone is unlocked.
- The relay holds three things per registration: the Mac's relay host id, the
  phone's relay device id, and the APNs device token. It never holds keys,
  text, session or project names, or the phone's account.
- The phone registers its APNs token with the relay itself, using the relay
  credential it already has. This works for a phone paired by QR code without
  an account. It does not work for an "Only this network" pairing, which has no
  relay credential.
- The person's choices from #990 are kept on the Mac, per device, while push is
  on. The Mac filters before it sends. The phone applies the lock screen level.
- Approve, Deny and question options can be answered from the notification.
  The action asks iOS to unlock the phone first, then the app answers over the
  normal end-to-end encrypted connection. The relay holds nothing that could
  forge an answer.
- With data privacy mode on, the Mac sends nothing, and nothing is queued for
  later.

## What exists today

- The phone and the Mac run E2EE v2 over a direct or relay path. The relay
  "may see identities, relay/device ids, routing metadata, socket metadata,
  and plaintext E2EE handshake frames" and nothing inside
  ([ACCOUNTS.md](../ACCOUNTS.md), "Relay director and cell").
- The Mac's host key is a long-lived X25519 key in the macOS Keychain. The
  phone pins its public key from the pairing offer
  ([ACCOUNTS.md](../ACCOUNTS.md), "Host identity and account binding").
- HPKE `HPKE-Base-X25519-HKDF-SHA256-ChaCha20Poly1305` is already used for
  account pairing: the Mac seals in `src-tauri/src/pairing/crypto.rs`
  (`seal_account_offer`) and the phone opens in `mobile/src/pairing/hpke.ts`
  (`openAccountPairingEnvelope`).
- The phone's E2EE key (`mobile/src/transport/e2ee-keypair.ts`) and every other
  secret are stored with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
- The Mac makes three notices today: turn finished, permission requested,
  question asked (`background_notice`, `src-tauri/src/local_runtime.rs:71`).
  The phone receives them only over its live connection
  (`notifications.subscribe`, `mobile/src/notifications/local.ts`).
- `expo-notifications` is in the plugin list in `mobile/app.json`, which adds
  the `aps-environment` entitlement. `mobile/app.config.js` removes it for
  builds signed with a free personal team.
- The relay server has no push endpoint today.

## Decisions

### 1. What the relay holds, and what it never sees

The relay holds, per registration:

| Field | Why |
| --- | --- |
| `relayHostId` | Which Mac may send to this phone. |
| `relayDeviceId` | Which paired phone of that Mac. The relay already stores it for the relay credential. |
| APNs device token | Where Apple delivers. |
| APNs environment (`development` or `production`) | Which APNs server to call. |
| Registered at, last sent at, send counters | Expiry and rate limits. |

The relay does not need the phone's account. A phone paired by QR code may
have none. The relay already knows which account owns the Mac, from the host
proof; push adds nothing to that.

The relay never sees: notification titles or text, question text or options,
permission reasons, transcripts, prompts, project, session, tab or worktree
names or ids, the event kind, the phone's push key or any private key, the
device token used for E2EE auth, or the person's notification choices.

The Mac never learns the APNs device token. It names the phone by
`relayDeviceId`, which it already has.

### 2. Encrypting on the Mac, decrypting in the extension

**Keys.** On first use of push the phone makes a new X25519 key pair, the
*push key*. It is separate from the transport key for two reasons:

- The extension must read it on a locked phone. `WhenUnlockedThisDeviceOnly`
  data "can be accessed only while the device is unlocked by the user"
  ([kSecAttrAccessibleWhenUnlockedThisDeviceOnly](https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly)).
  Most pushes arrive while the phone is locked.
- `AfterFirstUnlockThisDeviceOnly` data stays readable "until the next
  restart" after the first unlock, and is "recommended for items that need to
  be accessed by background applications"
  ([kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly)).
  Lowering the transport key to that level would weaken the live connection.
  A separate key limits the loss to notification text.

The push private key is stored with `AfterFirstUnlockThisDeviceOnly` in a
keychain access group shared by the app and the extension. Apple: "Any app in a
given group can share keychain items with all the other apps in the same
group", set with the `keychain-access-groups` entitlement and prefixed with the
team id
([Sharing access to keychain items](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps)).
The item never leaves the device and is not in backups.

A small local Expo module (like `mobile/modules/paste-image`) creates and
writes the key from Swift, so the app and the extension use the same keychain
query. `expo-secure-store` also has an iOS `accessGroup` option, but its
internal item naming would then have to be copied into the extension.

**Sealing.** The phone sends its push public key to each Mac inside E2EE
(`push.register`, below). The Mac seals each notification with HPKE in
**Auth** mode: same suite (X25519, HKDF-SHA256, ChaCha20-Poly1305), with the
Mac's host key as the sender's static key. Auth mode proves the Mac sent it.
The phone already pins that host key from pairing. Base mode, as used for
account pairing, would let anyone who learned the push public key forge a
notification.

- Rust: the `hpke` crate used by `crypto.rs` has an Auth mode
  (`OpModeS::Auth`). Same code shape as `seal_account_offer`.
- Extension: CryptoKit has HPKE with this exact suite
  ([HPKE.Ciphersuite.Curve25519_SHA256_ChachaPoly](https://developer.apple.com/documentation/cryptokit/hpke/ciphersuite/curve25519_sha256_chachapoly),
  iOS 17.0 and later) and an Auth mode recipient,
  `HPKE.Recipient.init(privateKey:ciphersuite:info:encapsulatedKey:authenticatedBy:)`
  ([HPKE.Recipient](https://developer.apple.com/documentation/cryptokit/hpke/recipient)).
  On iOS 16 the extension cannot open the payload and the placeholder shows.
- The TypeScript opener in `hpke.ts` is Base mode only. The app itself does not
  need to open pushes; only the extension does.
- `info` = `"terminalx-push.v1"` + `0x00` + host id. This separates push from
  every other use of the host key.

**Plaintext** (JSON, before sealing):

```json
{
  "v": 1,
  "hostId": "derived-host-id",
  "epoch": "notification-epoch",
  "seq": 42,
  "kind": "question",
  "title": "Session title",
  "body": "Question text",
  "sessionId": "public-session-id",
  "tabId": "public-tab-id",
  "requestId": "pending-request-id",
  "options": [{ "id": "opt-1", "label": "Stacked" }, { "id": "opt-2", "label": "Inline" }],
  "sentAt": 1763200000,
  "pad": "..."
}
```

`seq`, `epoch`, `title`, `body`, `sessionId` and `tabId` are today's
`HostNotification` fields. `kind` is #990's kind. `requestId` and `options`
are only for answerable kinds. `pad` fills the plaintext to exactly 2048 bytes,
so the size never tells the relay or Apple how long the text is. The Mac cuts
`body` short to fit.

**Size.** Apple: "For all other remote notifications, the maximum payload size
is 4 KB (4096 bytes)"
([Generating a remote notification](https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification)).
Sealed: 32 bytes encapsulated key + 2048 + 16 byte tag = 2096 bytes, 2795
characters in base64url. With the placeholder `aps` block the payload is about
2.95 KB.

**The payload the relay sends to Apple:**

```json
{
  "aps": {
    "alert": { "title": "TerminalX", "body": "New activity on your Mac" },
    "mutable-content": 1,
    "sound": "default"
  },
  "tx": { "v": 1, "h": "relayHostId", "e": "base64url sealed envelope" }
}
```

No `category`, `thread-id` or `interruption-level` in `aps`: each would tell
Apple and the relay the event kind or the session. The extension sets
`categoryIdentifier`, `threadIdentifier` and `interruptionLevel` on the
content it returns. Every push uses `apns-push-type: alert` and
`apns-priority: 10`, so the priority does not leak the kind either.

**The extension.** It runs only when two conditions hold: "The payload must
include the `mutable-content` key with a value of `1`" and "The payload must
include an `alert` dictionary with title, subtitle, or body information"
([Modifying content in newly delivered notifications](https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications)).
It does not run if alerts are off for the app.

Steps in `didReceive(_:withContentHandler:)`:

1. Read the push private key and the host's pinned public key (by `h`) from the
   shared keychain group and app group.
2. Open the envelope with HPKE Auth. Check `hostId` matches.
3. Check `(epoch, seq)` is newer than the watermark for that host in the app
   group. A replay or an older one shows the placeholder.
4. Apply the lock screen level from #990, read from the app group:
   *Everything* shows title and body and sets the category (action buttons);
   *Session name only* shows the session name, no body, no category;
   *Nothing* keeps the placeholder text and no category.
5. Set `threadIdentifier` to the session id, `interruptionLevel` to
   `time-sensitive` for question and approval and `active` otherwise, and put
   `sessionId`, `tabId`, `requestId` in `userInfo` so a tap opens the tab.
6. Write the new watermark and call the content handler.

**Limits.** "Your `didReceive(_:withContentHandler:)` method has only about 30
seconds to modify the payload and call the provided completion handler. If
your code takes longer than that, the system calls the
`serviceExtensionTimeWillExpire()` method"
([Modifying content in newly delivered notifications](https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications)).
The work above is one keychain read, one X25519 operation and one AEAD open:
milliseconds, no network. On timeout the extension returns the placeholder.

Apple does not publish a memory figure for this extension. It says "Memory
limits for running app extensions are significantly lower than the memory
limits imposed on a foreground app"
([App Extension Programming Guide, Creating an App Extension](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionCreation.html)).
So the extension is plain Swift with CryptoKit and Security only. No React
Native, no JavaScript runtime, no network.

**Dropping a notification.** Without an extra entitlement the extension cannot
hide a push; it can only change the text. With
`com.apple.developer.usernotifications.filtering`, "after you receive
permission to use the entitlement", the extension can "silence push
notifications after your extension receives them" by returning empty content
([Filtering entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.usernotifications.filtering)).
Recommendation: ask Apple for it, to drop replays and pushes that arrive after
the question was answered. The design works without it: those show the
placeholder.

**Stale questions.** Each answerable push gets an `apns-collapse-id`, a random
22 character id the Mac makes per request (opaque, under the 64 byte limit,
[Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)).
When the request is answered elsewhere, the Mac sends an "answered" push with
the same collapse id, which replaces the shown notification.

**Offline phone.** Apple "stores only one notification per bundle ID" while a
device is offline, and may keep it "for 30 days or less, depending on the date
you specify in the `apns-expiration` header"
([Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)).
So push is a nudge, not a log. The Mac sets `apns-expiration` to 24 hours. When
the app opens it catches up with `notifications.missedSince`, as today.

**Double alerts.** The phone tells the Mac when it goes to the background or
comes back (`device.appState`, below). The Mac sends over the live
subscription while the app is in the foreground, and pushes otherwise. Both
paths share the watermark in the app group (moved from AsyncStorage), so the
same `(epoch, seq)` is shown once.

### 3. Which events, and how the choices are kept

**Events.** The Mac pushes the kinds from #990:

| Kind | From | Answerable |
| --- | --- | --- |
| `question` | `QuestionsAsked` (exists) | Yes, options |
| `approval` | `PermissionRequested` (exists) | Yes, Allow or Deny |
| `finished` | `TurnCompleted` (exists) | No |
| `failed` | new in #990 (failed or stopped on an error) | No |
| `usage_limit` | new in #990 | No |
| `pr_checks_failed`, `pr_merged` | new in #990 | No |
| `answered` | Mac, to replace a stale question or approval | No |

**Choices.** #990 says the Mac keeps no record of the choices beyond the live
subscription. That cannot hold for push: when the phone is suspended there is
no live subscription, and the Mac must still decide what to send. So:

- When push is on, the phone sends its choices to each Mac inside E2EE with
  `push.register`: the same kinds, session scope and per-session overrides that
  #990 sends with `notifications.subscribe`, plus quiet hours and the phone's
  time zone.
- The Mac stores them on the device's record (`DeviceEntry`,
  `src-tauri/src/pairing/model.rs`), with the push public key. It is local to
  the Mac, never sent to the relay, and deleted on revoke, on
  `push.unregister`, and when the phone turns push off for that machine.
- The phone sends them again whenever a choice changes and on every connect.
  The Mac keeps the last one.
- The Mac filters by kind, session scope, override and quiet hours before it
  seals anything. Nothing is sent for a filtered event, so the relay cannot
  even count it.
- The lock screen level stays on the phone (app group), applied by the
  extension.
- A machine switched off on the phone sends `push.unregister` to that Mac.

Quiet hours move to the Mac for push because the extension cannot hide a
notification without the filtering entitlement. If Apple grants it, quiet
hours can move back to the phone.

### 4. Answering from the notification

**What iOS offers.** "When the user selects an action, the system launches
your app in the background and calls the delegate's
`userNotificationCenter(_:didReceive:withCompletionHandler:)` method"
([Handling notifications and notification-related actions](https://developer.apple.com/documentation/usernotifications/handling-notifications-and-notification-related-actions)).
Actions are grouped in categories, which the app must declare "at launch time"
([Declaring your actionable notification types](https://developer.apple.com/documentation/usernotifications/declaring-your-actionable-notification-types)).
A text action lets "the user provide a custom text-based response"
([UNTextInputNotificationAction](https://developer.apple.com/documentation/usernotifications/untextinputnotificationaction)).

**Categories.**

- `tx.approval`: Allow, Deny. The Mac maps them to the request's own option ids
  and puts both ids in the sealed plaintext.
- `tx.question`: for a single question with up to four options, one button per
  option. Option labels change per question, while categories are declared at
  launch. The plan is for the extension to register a per-request category
  before returning; this is not documented by Apple and needs a device test
  (follow-up 6). The fallback is one "Answer in TerminalX" button with the
  `foreground` option, which "causes the app to launch in the foreground"
  ([foreground](https://developer.apple.com/documentation/usernotifications/unnotificationactionoptions/foreground)).
- A question with several questions, multi-select, or free text uses the
  fallback.

**Authentication.** Every answer action uses `authenticationRequired`: "The
action can be performed only on an unlocked device. When the user selects an
action with this option, the system prompts the user to unlock the device.
After unlocking, the system notifies your app of the selected action. You
might use option to perform actions that require accessing data that is
encrypted while the device is locked"
([authenticationRequired](https://developer.apple.com/documentation/usernotifications/unnotificationactionoptions/authenticationrequired)).

So:

1. The person taps Allow. iOS asks for Face ID or the passcode.
2. iOS starts the app in the background. The phone is unlocked, so the
   transport key, device token and relay credential (all
   `WhenUnlockedThisDeviceOnly`) are readable.
3. The app opens the usual E2EE connection (direct or relay) and calls the
   existing `permission.respond` or `questions.respond` with the session id,
   tab id and request id from `userInfo` (see [MOBILE.md](../MOBILE.md),
   "Terminal, steering, and permissions").
4. The Mac checks as today: device scope is driver, request is still pending,
   option id is valid. A request answered first elsewhere is refused.
5. On success the app removes the notification. On failure it posts a local
   notification: "Could not reach your Mac. Open TerminalX to answer."

What authenticates the answer: the E2EE channel bound to the pinned host key
and the phone's transport key, and the device token inside `e2ee_auth`. The
relay holds none of these. A relay that replays an old push can at most show
an old question; answering it hits "no longer open" on the Mac. The push key
cannot answer anything: it only opens notifications.

Apple does not state how long the app may run in the background to handle the
action. The connect time is the part to measure (the cold-start numbers are in
the reconnect piece of #989). Whether Expo starts the JavaScript runtime for a
background action response also needs a test (follow-up 7).

With "Session name only" or "Nothing" on the lock screen, no category is set,
so there are no buttons, as #990 asks.

### 5. Apple and Expo requirements

| Need | Detail |
| --- | --- |
| Push capability | `aps-environment`, "development or production". "Xcode sets the value of the entitlement based on your app's current provisioning profile" ([aps-environment](https://developer.apple.com/documentation/bundleresources/entitlements/aps-environment)). `expo-notifications` already adds it; `app.config.js` already removes it for personal team builds. |
| APNs auth key (.p8) | Token-based auth. Use environment-specific team-scoped keys: "These keys restrict usage to either Sandbox or Production" and "Each environment can have a maximum of two keys". Refresh the JWT "no more than once every 20 minutes and no less than once every 60 minutes" ([Establishing a token-based connection to APNs](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)). |
| Where the key lives | Only in the relay service's secret store. Never in this repository, the app, a Mac or CI logs. The key id and team id are relay configuration, not committed. Rotation uses the second key slot, then revokes the old key. |
| APNs servers | `api.push.apple.com:443` and `api.sandbox.push.apple.com:443`, HTTP/2 ([Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)). The phone tells the relay which one its token belongs to. |
| Dead tokens | 410 `Unregistered`: "There is no need to send further pushes to the same device token" ([Handling notification responses from APNs](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns)). The relay deletes the registration. |
| Extension target | Notification Service Extension, bundle id `com.terminalx.next.mobile.NotificationService`. `NSExtensionPointIdentifier` is `com.apple.usernotifications.service` ([UNNotificationServiceExtension](https://developer.apple.com/documentation/usernotifications/unnotificationserviceextension)). Deployment target iOS 17.0 for CryptoKit HPKE. |
| Keychain sharing | `keychain-access-groups` on the app and the extension, one shared group, team prefixed ([Sharing access to keychain items](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps)). |
| App group | `com.apple.security.application-groups` on both, for the watermark, the lock screen level and the pinned host keys. "App groups that you register in your Apple Developer profile also act as keychain access groups" ([App Groups entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.application-groups)). |
| Filtering (optional) | `com.apple.developer.usernotifications.filtering`, requested from Apple (section 2). |
| Time sensitive | `interruptionLevel` `timeSensitive` "can break through system controls such as Notification Summary and Focus. The user can turn off the ability for time sensitive notification interruptions" ([timeSensitive](https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel/timesensitive)). Enable the Time Sensitive Notifications capability. Not `critical`, which "requires an approved entitlement" ([critical](https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel/critical)). |
| Device token | `getDevicePushTokenAsync()`, which "Returns a native FCM, APNs token". Not `getExpoPushTokenAsync()`, which routes through "Expo's push notifications service", a third party that would also see the token ([Expo Notifications](https://docs.expo.dev/versions/latest/sdk/notifications/)). |
| Expo prebuild | `ios/` is generated and not committed, so the extension target, its Swift sources, entitlements and the shared groups come from a local config plugin run by prebuild. EAS must know the extension "before the build starts" to generate its credentials: `extra.eas.build.experimental.ios.appExtensions` ([Expo app extensions](https://docs.expo.dev/build-reference/app-extensions/)). The personal team variant in `app.config.js` skips the extension and the groups. |

**App Store review notes.** Guideline 4.5.4: "Push Notifications must not be
required for the app to function, and should not be used to send sensitive
personal or confidential information"
([App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)).
Notes for the reviewer:

- Push is optional. It is off until the person turns on Allow notifications,
  and the app works fully without it.
- Notification text is end-to-end encrypted from the person's own Mac. Apple
  and our servers see only "TerminalX / New activity on your Mac". The
  extension decrypts it on the device.
- No marketing or promotional pushes are sent.
- The reviewer needs a paired Mac to see a real push. Provide a demo video and
  a test Mac setup in the review notes.

### 6. Phone paired by QR code without an account

Push depends on the relay credential, not on an account.

- **QR code, TerminalX Relay mode.** The Mac is signed in (relay mode
  "requires sign-in", [ACCOUNTS.md](../ACCOUNTS.md)). The phone need not be. The
  phone has a relay credential, so it can register its token and receive push.
  Signing the phone out of an account leaves QR pairings and their push in
  place.
- **Automatic (account) pairing.** Same path. Signing out removes the pairing,
  the Mac revokes the relay device, and the relay deletes the registration.
- **QR code, "Only this network".** No relay credential and no relay
  connection, so no push. The Notifications page says, for that machine:
  "Alerts while TerminalX is closed need TerminalX Relay." The live
  subscription still works while the app is open.
- **Mac signed out later.** The Mac has no relay control socket, so it cannot
  push. Registrations stay on the relay until revoked or unused for 30 days.

### 7. Data privacy mode

With data privacy mode on, the Mac sends nothing: no `push-send`, no relay
traffic at all, as relay streams are already off in that mode
([DATA-PRIVACY.md](../DATA-PRIVACY.md)). Events in that time are not queued
for later push, so turning the mode off does not flood the phone. The Mac keeps
the device's push record, so push resumes when the mode is turned off. The
phone's registration on the relay stays, but nothing is sent to it. The phone
learns nothing new about the Mac while the mode is on. When the app is opened
and connects again it sees the missed notices with `notifications.missedSince`,
as today.

## Who can see what

"Content" is title, body, question text and options, permission reason, and
session, tab, project and worktree names and ids. "Timing" is when a push is
sent and its fixed size.

| Event | Phone | Mac | Relay | Apple |
| --- | --- | --- | --- | --- |
| Register | Its token, push key pair, choices | Push public key and choices (inside E2EE); not the token | APNs token, environment, `relayHostId`, `relayDeviceId`; not the push key or choices | Token and bundle id, as for any app; not which Mac |
| Question | Content and options after decrypting (per lock screen level) | All of it (it made it) | Timing, `relayHostId`, `relayDeviceId`, ciphertext; not the kind | Token, timing, placeholder text, ciphertext, opaque collapse id; not the kind |
| Approval | Content, Allow and Deny | All of it | Same as question | Same as question |
| Finished | Session name and summary | All of it | Same as question | Same as question |
| Failed | Session name and error summary | All of it | Same as question | Same as question |
| Answered (replace) | Which request was answered | All of it | Same as question | Same as question |
| Answer from notification | The answer | The answer, checked as today | Encrypted E2EE frames and connection metadata, as for any connection; not the answer | Nothing beyond the earlier push |
| Filtered out by a choice | Nothing | The event | Nothing | Nothing |
| Privacy mode on | Nothing | The event | Nothing | Nothing |
| Unregister or revoke | Its choice | Record deleted | Registration deleted | Nothing new |

The relay and Apple can tell that a Mac sent something to a phone at a given
time. They cannot tell what, or which kind.

## Sequence

```mermaid
sequenceDiagram
    autonumber
    participant P as Phone app
    participant X as Service extension
    participant M as Mac
    participant R as Relay
    participant A as APNs

    rect rgb(235, 240, 250)
    note over P,A: Register
    P->>A: registerForRemoteNotifications
    A-->>P: APNs device token
    P->>P: Make push key pair, store in shared keychain group
    P->>R: POST /v1/push/register (relayHostId, resume credential, token, environment)
    R-->>P: registered
    P->>M: push.register over E2EE (push public key, choices)
    M->>M: Store on DeviceEntry
    end

    rect rgb(235, 250, 240)
    note over P,A: Send
    M->>M: Agent asks a question; filter by choices
    M->>M: HPKE Auth seal to push key, pad to 2048 bytes
    M->>R: push-send on host control socket (relayDeviceId, envelope, collapse id)
    R->>R: Check device belongs to this host, rate limit
    R->>A: POST /3/device/token, placeholder alert, mutable-content 1
    A-->>R: 200, or 410 Unregistered
    R-->>M: push-sent (status)
    A->>X: Deliver
    X->>X: Open envelope, check watermark, apply lock screen level
    X-->>P: Show question with option buttons
    end

    rect rgb(250, 240, 235)
    note over P,A: Answer
    P->>P: Person taps an option; iOS asks to unlock
    P->>M: E2EE connect (direct or via relay), questions.respond
    M->>M: Check driver scope and request still open
    M-->>P: ok
    M->>R: push-send "answered" with the same collapse id
    R->>A: Replace the shown notification
    end
```

## Relay API

New relay endpoints. All strict schemas, version 1, unknown fields refused,
like the existing relay JSON.

**Phone, HTTPS.**

```
POST /v1/push/register
  { "v": 1, "relayHostId": "...", "resumeToken": "...",
    "apnsToken": "<hex>", "environment": "production" | "development" }
  -> 200 { "v": 1, "registered": true }
  -> 401 credential not current or grace; 429 with Retry-After
```

The relay checks the resume credential the same way `POST /v1/resolve` does,
finds the `relayDeviceId` it belongs to, and stores or replaces the
registration for `(relayHostId, relayDeviceId)`. The phone calls it on every
launch where the token or credential changed, since Apple asks apps to register
"each time your app launches"
([Registering your app with APNs](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns)).

```
POST /v1/push/unregister
  { "v": 1, "relayHostId": "...", "resumeToken": "..." }
  -> 200 { "v": 1, "registered": false }
```

**Mac, host control socket.**

```
{ "type": "push-send", "reqId": "...", "relayDeviceId": "...",
  "envelope": "<base64url, at most 2800 chars>",
  "collapseId": "<22 char base64url>" | absent,
  "expiresInSec": 1..86400 }
-> { "type": "push-sent", "reqId": "...",
     "status": "sent" | "not-registered" | "unregistered" | "rate-limited" }
```

The relay builds the whole APNs request itself: fixed placeholder `aps`,
`apns-push-type: alert`, `apns-priority: 10`, `apns-topic` the bundle id. The
Mac cannot set any `aps` field, so a Mac bug cannot leak text into the
placeholder.

```
{ "type": "push-status", "reqId": "...", "relayDeviceId": "..." }
-> { "type": "push-status", "reqId": "...", "registered": true | false }
```

For the Mac's Devices list ("Push on" or "Push off").

**Existing commands.** `deviceRevoke` also deletes that device's registration.
A 410 from Apple deletes it. Registrations unused for 30 days are deleted.

**Rate limit.** Per `(relayHostId, relayDeviceId)`, for example 60 pushes a
minute and 1,000 a day, answered with `rate-limited`. The numbers are
placeholders to set with the relay owners.

**New phone RPC to the Mac (inside E2EE).**

| Method | Params | Result |
| --- | --- | --- |
| `push.register` | `{ pushPublicKeyB64, choices }` (choices as in #990, plus quiet hours and time zone) | `{ ok: true }` |
| `push.unregister` | `{}` | `{ ok: true }` |
| `device.appState` | `{ state: "foreground" \| "background" }` | `{ ok: true }` |

The Mac announces `push: 1` in `sync.capabilities`. A Mac without it gets no
`push.register`, and the phone says push needs a newer TerminalX on that Mac.

## Follow-up issues

Sizes: S is a day or two, M up to a week, L more.

1. **Relay push endpoints** (L, relay server): register, unregister,
   `push-send`, `push-status`, APNs HTTP/2 client with token auth, .p8 in the
   secret store, 410 and expiry cleanup, rate limits.
2. **Mac push sender** (M): `push.register` and `push.unregister` RPCs, choices
   on `DeviceEntry`, filter, HPKE Auth seal with padding, `push-send` on the
   control socket, privacy mode gate, `answered` replacement, Devices list
   status.
3. **Notification Service Extension and config plugin** (M): Swift target,
   CryptoKit HPKE Auth opener with Rust test vectors, shared keychain group and
   app group, lock screen levels, watermark, EAS `appExtensions`.
4. **Phone push registration** (M): push key module, `getDevicePushTokenAsync`,
   relay register on launch, `push.register` per Mac, `device.appState`,
   watermark moved to the app group, "needs TerminalX Relay" state on the
   Notifications page.
5. **Answer from notification** (M, after #979 and #990 part 7): categories,
   `authenticationRequired` actions, background connect and respond, failure
   local notification.
6. **Spike: per-question option buttons** (S): can the extension register a
   category per request on a real device, and is it shown in time.
7. **Spike: background action handling in Expo** (S): does the JavaScript
   runtime start for a background action response, and how long it may run.
   Measure connect and answer time on Wi-Fi and mobile data.
8. **Request the filtering entitlement from Apple** (S, owner): then drop
   replays and answered pushes, and move quiet hours back to the phone.
9. **App Store submission notes** (S): reviewer notes above, demo video,
   check the export compliance answer now that an extension does encryption.

## Open points

- Whether iOS honours a `categoryIdentifier` set by the extension on remote
  content needs a device test with follow-up 3. Apple's page says categories
  decide whether the extension runs, which is a separate question.
- The minimum iOS version of the app under Expo SDK 58 was not checked. Phones
  below iOS 17 get the placeholder only.
- Which Mac process sends the push (the desktop app or `terminalx-serve`)
  follows whichever holds the relay control socket.
- The Time Sensitive capability's entitlement page could not be read
  (Apple returns not found); the level's behaviour is cited above.
