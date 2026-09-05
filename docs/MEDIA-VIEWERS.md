# Local media in the file pane

Explorer clicks, its Open action, and Quick Open all use `openFile`. The tab store
classifies extensions using `src/lib/mediaTypes.json` before mounting a surface.
That table also supplies the Rust stream's MIME type and the text-write guard.
SVG, Markdown, TypeScript (`.ts` and `.mts` included), and other text files keep
using the existing editor. The table identifies media candidates, not a promise
that every OS can decode every listed format or codec.

Images have fit, actual-size, zoom in/out, dimensions, and a checkerboard for
transparency. Audio and video use the WebView's native playback controls. Video
fullscreen is available where the runtime supports it. Media surfaces never
register a CodeMirror buffer or Save action, and the tab store refuses to mark
them dirty. The Rust text writer also rejects recognized media extensions,
including damaged files that happen to contain valid text.

## Local transport and lifecycle

`media.rs` starts an HTTP listener on `127.0.0.1` with an OS-assigned port when
first needed. `open_media_file(root, rel)` canonicalizes and validates the selected
file inside its workspace, then returns a random, per-viewer URL. The listener
serves only those grants: it has no directory listing, arbitrary path route,
CORS grant, or write endpoint. No workspace-wide asset scope is added. This works
with worktrees and custom `RACCOON_HOME` locations, independently of attachments.

Responses include the format's MIME type, length, and byte-range support. Both
full and partial responses stream with backpressure in 64 KiB chunks. Large
files never enter text decoding or base64 JSON IPC. CSP allows the loopback URLs
only as image/media sources; the existing connect policy stays unchanged.

Switching file tabs, hiding the pane, hiding the document, or unmounting a player
pauses playback. Closing unloads the decoder, revokes its grant, and cancels any
active response streams. Late results from an already-closed tab are revoked too.
Reopening an existing file focuses its original tab. Different project roots
have distinct tab identities even when their relative paths match.

Visible viewers check file modification time every two seconds. Changes offer
Reload and pause playback; deletion or decoder failure shows an error with the
filename, Retry, and Reveal file. Reload gets a fresh URL rather than displaying
cached bytes. Unsupported binary files in the text reader also have a readable
fallback and the existing Reveal action.

## Verification on macOS

On September 5, 2026, an isolated **packaged debug `.app`**, using production-built
frontend assets, was exercised on macOS 26.3.1 (Apple silicon, WKWebView), with
`RACCOON_HOME` under `/tmp/terminalx-media-118/app-data`. A temporary frontend
bootstrap drove the real tab store, DOM elements, Tauri commands, and local
streaming endpoint. It is not included in the shipping frontend.

| Real fixture | Verified in packaged WebView |
| --- | --- |
| Transparent PNG with spaces/non-ASCII filename; JPEG; GIF | Decode, visible dimensions, aspect ratio, fit, actual size, zoom/reset, checkerboard |
| MP3, 12 seconds | Duration, play/time advancing, seek to 6 seconds, volume, pause on tab switch/collapse, no automatic resume, cleanup |
| PCM WAV, 80 seconds / 6.7 MiB | Same playback checks, beyond the text limit |
| MP4 with H.264 video and AAC audio, 12 seconds | Same playback checks plus decoded 640×360 picture; fullscreen capability present |
| MP4 with H.264/AAC, 11 MiB | Same checks, beyond the text limit |
| Corrupt MP4; nonexistent PNG | Named error, Retry, Reveal file |
| SVG; Markdown | SVG edit/save/restore and Markdown preview/source toggle |

SHA-256 hashes of all ten fixture files were unchanged after verification
(including restoring the intentionally edited SVG). Runtime results and logs
were captured under `/tmp/terminalx-media-118` during development.

Automated tests cover all three opening routes, tab reuse, read-only enforcement,
SVG saving, unsaved-buffer protection, late-open cleanup, decoder failures,
external-change reload, missing files, byte ranges, independent grant revocation,
a 512 MiB sparse file, and workspace/symlink escapes.

**Manual verification remains:** clicking the native playback/volume controls,
visually inspecting playback and transparency, entering/exiting fullscreen, and
trying alternate codecs/containers on each supported OS. The packaged assertions
exercise the real decoders and playback APIs, but do not replace these manual
checks. Alternate formats use the same named error/Retry/Reveal fallback whenever
the runtime cannot decode them. Windows and Linux were not verified.

To repeat the manual checks, create fixtures in a disposable Git repository with
FFmpeg (PNG with alpha, JPEG/GIF, MP3, PCM WAV, H.264/AAC MP4), including a file
larger than 4 MiB and filenames containing spaces and non-ASCII characters. Open
that repository in a separately built app using a temporary `RACCOON_HOME`.
Exercise Explorer/Open/Quick Open; switch, collapse, and close playing tabs;
modify/delete a fixture externally and retry; and compare file hashes afterward.
