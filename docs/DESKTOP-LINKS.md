# terminalx:// links

TerminalX opens links in its own scheme: `terminalx://` for release builds
(`terminalx-next://` is accepted too) and `terminalx-dev://` for the dev build.
Each build ignores the other's links.

| Link | Opens |
| --- | --- |
| `terminalx://session/<session-id>` | That session, on the agent tab and panel tab it was left on. |
| `terminalx://tab/<session-id>/<tab-id>` | One chat tab of a session (the tab menu's "Copy link to this tab"). |
| `terminalx://settings/<row-id>[?enable=1]` | Settings at that row; `enable=1` turns on a row that may be turned on from a link. |
| `terminalx://new?project=<path>&branch=<name>&prompt=<text>` | Asks "Start a session from a link?", then starts a session in that project, from that branch, with that first prompt. |
| `terminalx://new?linear=<KEY-123>[&project=<path>][&branch=<name>][&prompt=<text>]` | The same for a Linear issue: the issue's text is the prompt, with `prompt` added after it. |
| `terminalx://browser?url=<http(s)-url>` | The page in a Browser tab of the session on screen. |

Query values are URL-encoded (`%2F` or `/` for a slash, `%20` or `+` for a space,
`%0A` for a new line). For example:

```
terminalx://new?project=%2FUsers%2Fme%2Fcode%2Fweb&branch=main&prompt=Fix+the+flaky+archive+test
```

## What a `new` link may do

- Nothing is created until the person presses **Create session** in the dialog,
  which shows the project, the branch, the issue and the whole prompt. The
  dialog opens on Cancel, and Create works only once what it shows has been up
  for a moment; a link arriving meanwhile replaces it and starts that wait again.
- `project` must be the path of a project already open in TerminalX. A link
  never adds a folder. Without `project`, the project last worked in is used.
- Without `branch`, the session starts from the project's default branch.
- The session starts on the agent, model and permission mode last chosen in New
  Session, except Bypass: a session from a link always starts with the agent
  asking first, and never with Merge when green on.
- A prompt with control characters, invisible characters (zero-width, bidi,
  Unicode tags), more than two blank lines in a row, or a run of 40 spaces is
  refused, so nothing in it can hide from the dialog.
- At least `prompt` or `linear` is required. A name given twice, or any other
  name, makes the link invalid.

## Links that cannot be opened

The native side (`src-tauri/src/desktop_links.rs`) checks every link of the
build's scheme before the window sees it. The window is handed only what the
route needs (`{ kind, … }`), through one event (`desktop_link_requested`) and one
command (`desktop_link_take`), and follows it in one router (`src/lib/desktopLinks.ts`).

- An unknown route (`terminalx://sesion/…`) or a known route in the wrong shape
  shows "That terminalx:// link isn't valid", with the link and **Copy link**.
- A `browser` link to anything but `http://` or `https://` shows "Browser links
  need an http:// or https:// URL".
- Auth callbacks, `launch` and `join` links are handled natively and are not routes.

A new route is one more variant of `DesktopLink` in Rust and one more case of
`followDesktopLink` in the webview.
