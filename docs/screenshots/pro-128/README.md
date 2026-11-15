# PRO-128 roster and profiles

These WebKit screenshots exercise the production Share dialog, members list,
participants bar, header avatars, profile popover and styles in a component
integration harness. Native service responses and clipboard writes use fixtures;
the screenshots do not depict a live account. The fixture uses the deployed
roster contract, including membership `createdAt` as milliseconds since the epoch.

Regenerate the light and dark evidence with:

```sh
ROSTER_SHOTS=docs/screenshots/pro-128 pnpm test:webkit-roster
```

The test checks keyboard activation and Escape focus restoration, all four avatar
entry points, profile fields, copy feedback and clipboard contents, one roster
request across two Share opens and the other surfaces, removal on refresh, and
live rollout/data-privacy invalidation. It also checks viewport bounds, text
overflow, presence-dot styling and browser errors. It runs in the existing
`test:webkit-layout` suite.

| Surface | Light | Dark |
| --- | --- | --- |
| Share dialog | [Profile](share-profile-light.png) | [Profile](share-profile-dark.png) |
| Members list | [Profile](members-profile-light.png) | [Profile](members-profile-dark.png) |
| Participants bar | [Profile](participants-profile-light.png) | [Profile](participants-profile-dark.png) |
| Header avatars | [Profile](header-profile-light.png) | [Profile](header-profile-dark.png) |
| Copy feedback | [Toast](members-copy-light.png) | [Toast](members-copy-dark.png) |

The November 14 integration preserves main's organization-scoped settings and
managed data-privacy behavior. Enabling data privacy retires cached and in-flight
roster reads and unmounts profile/copy surfaces; external avatar images use the
shared privacy-aware image component. Disabling privacy restores the feature only
for organizations with `team.roster.v1` enabled.

The live PRO-128 issue has no separate Design section; its build requirements and
acceptance criteria, together with `docs/CLOUD-SHARING.md`, define this behavior.
The deployed server source at `c3e4f4961e0941df4c8eaf10d386e9a7f19633b7`
was checked on November 14, 2026: the roster contains user ID, name, email,
organization role, optional photo URL and membership `createdAt.getTime()`.
