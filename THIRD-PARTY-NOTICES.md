# Third-party notices

Raccoon is MIT licensed (see `LICENSE`). It ships and links against the
third-party work listed here. Nothing below changes Raccoon's own licence;
each notice covers only the component it names.

This file records the components whose licences ask to be reproduced —
fonts, icon artwork, and the bundled C/C++ speech-recognition code — plus a
roll-up of every Rust crate and npm package the app depends on, grouped by
licence. The per-package licence text for those is in each package's own
directory (`node_modules/<pkg>/LICENSE`, or the crate source under
`~/.cargo/registry/src/`).

The transcription models Raccoon can download are **not** bundled with it and
are not covered here; each model carries its own licence, shown next to it in
Settings → Transcription and linked to its Hugging Face model card.

---

## Contents

- [Geist and Geist Mono (SIL OFL-1.1)](#geist-and-geist-mono-sil-ofl-11)
- [Coding-agent marks](#coding-agent-marks)
- [Material Icon Theme (MIT, two notices)](#material-icon-theme-mit-two-notices)
- [transcribe.cpp (MIT)](#transcribecpp-mit)
- [ggml (MIT)](#ggml-mit)
- [Rust crates](#rust-crates)
- [npm packages](#npm-packages)

---

## Geist and Geist Mono (SIL OFL-1.1)

Bundled as `@fontsource-variable/geist` and `@fontsource-variable/geist-mono`,
and used as the app's UI and monospace typefaces.

```
Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font)
Geist-Italic[wght].ttf: Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font)

Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font.git)
GeistMono-Italic[wght].ttf: Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font.git)
```

```
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

---

## Coding-agent marks

The Claude, Cursor, and OpenCode SVG paths are adapted from
[`simple-icons`](https://github.com/simple-icons/simple-icons), version
16.29.0 (the `claude`, `cursor`, and `opencode` icons), whose icon data is
released under
[CC0-1.0](https://github.com/simple-icons/simple-icons/blob/16.29.0/LICENSE.md).
The Claude mark is Anthropic's starburst and, where the app tints it, its
brand colour `#D97757`. CC0 does not affect any trademark rights in the
depicted brands. The Codex mark is the OpenAI mark published on the official
[OpenAI brand page](https://openai.com/brand/). These marks are used only to
identify their corresponding coding agents and do not imply endorsement.

---

## Material Icon Theme (MIT, two notices)

File and folder icons in the file tree come from the Material Icon Theme
artwork, reached through the `react-material-icon-theme` npm wrapper. Both
the wrapper and the upstream artwork are MIT, held by different people, so
both notices are reproduced.

### The npm wrapper — `react-material-icon-theme`

```
The MIT License (MIT)
Copyright (c) 2025 Qalxry

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### The upstream artwork — `material-extensions/vscode-material-icon-theme`

Originally by Philipp Kief (`PKief`), now maintained by the Material
Extensions team. The wrapper does not redistribute this licence file, so the
text below is the upstream `LICENSE` from
<https://github.com/material-extensions/vscode-material-icon-theme>.

```
The MIT License (MIT)
Copyright (c) 2025 Material Extensions

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## transcribe.cpp (MIT)

The on-device speech-recognition engine, linked in through the
`transcribe-cpp` and `transcribe-cpp-sys` crates. `transcribe-cpp-sys`
vendors and compiles the C/C++ sources, so the compiled code ships inside
the Raccoon binary.

```
MIT License

Copyright (c) 2026 The transcribe.cpp authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## ggml (MIT)

The tensor library transcribe.cpp is built on, vendored inside
`transcribe-cpp-sys` and compiled into the Raccoon binary. It is a separate
copyright holder from transcribe.cpp and carries its own notice.

```
MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Rust crates

The Rust dependency graph for the macOS build (`cargo metadata
--filter-platform aarch64-apple-darwin`, which includes build- and
dev-dependencies) resolves to 382 crates. The overwhelming majority are
dual-licensed MIT / Apache-2.0 or MIT-only; those are used under MIT and
their licence text lives in each crate's own source directory. The two
groups worth calling out are below.

### MPL-2.0 crates

Mozilla Public License 2.0 is a file-level copyleft: modifications to these
crates' own files must be published, which linking against them unmodified
does not trigger. Raccoon does not modify them. Full text:
<https://www.mozilla.org/en-US/MPL/2.0/>.

- `cssparser-macros` 0.6.1 — MPL-2.0 — <https://github.com/servo/rust-cssparser>
- `cssparser` 0.36.0 — MPL-2.0 — <https://github.com/servo/rust-cssparser>
- `dtoa-short` 0.3.5 — MPL-2.0 — <https://github.com/upsuper/dtoa-short>
- `nucleo-matcher` 0.3.1 — MPL-2.0 — <https://github.com/helix-editor/nucleo>
- `option-ext` 0.2.0 — MPL-2.0 — <https://github.com/soc/option-ext.git>
- `selectors` 0.36.1 — MPL-2.0 — <https://github.com/servo/stylo>

### Crates with no MIT alternative

These are used under Apache-2.0 (or the licence named), not MIT. Apache-2.0
full text: <https://www.apache.org/licenses/LICENSE-2.0>.

- `cpal` 0.17.3 — Apache-2.0
- `ring` 0.17.14 — Apache-2.0 AND ISC
- `serial2` 0.2.38 — BSD-2-Clause OR Apache-2.0
- `sync_wrapper` 1.0.2 — Apache-2.0
- `tao` 0.35.3 — Apache-2.0

Two further crates ship third-party root certificates rather than code:
`webpki-roots` (CDLA-Permissive-2.0), the Mozilla CA bundle used for TLS.

### Every licence in the Rust graph

```
  165 MIT OR Apache-2.0
  72 MIT
  39 Apache-2.0 OR MIT
  21 Zlib OR Apache-2.0 OR MIT
  19 MIT/Apache-2.0
  18 Unicode-3.0
  7 Unlicense OR MIT
  6 MPL-2.0
  3 BSD-3-Clause
  3 Apache-2.0
  2 Zlib
  2 Unlicense/MIT
  2 MIT OR Zlib OR Apache-2.0
  2 MIT OR Apache-2.0 OR Zlib
  2 ISC
  2 CDLA-Permissive-2.0
  2 Apache-2.0 OR ISC OR MIT
  1 CC0-1.0 OR MIT-0 OR Apache-2.0
  1 CC0-1.0
  1 BSD-3-Clause/MIT
  1 BSD-3-Clause AND MIT
  1 BSD-2-Clause OR MIT OR Apache-2.0
  1 BSD-2-Clause OR Apache-2.0 OR MIT
  1 BSD-2-Clause OR Apache-2.0
  1 Apache-2.0/MIT
  1 Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT
  1 Apache-2.0 AND MIT
  1 Apache-2.0 AND ISC
  1 Apache-2.0 / MIT
  1 0BSD OR MIT OR Apache-2.0
  1 (MIT OR Apache-2.0) AND Unicode-3.0
  1 (Apache-2.0 OR MIT) AND BSD-3-Clause
```

---

## npm packages

The production dependency graph (`pnpm licenses list --prod`) is almost
entirely MIT, with ISC, BSD-2-Clause, BSD-3-Clause and 0BSD tails. Each
package's licence text is in its own directory under `node_modules/`. The
non-MIT-family groups:

### MPL-2.0

- `lightningcss` 1.32.0 and `lightningcss-darwin-arm64` 1.32.0 — the CSS
  transformer Tailwind uses at build time. Not modified. Full text:
  <https://www.mozilla.org/en-US/MPL/2.0/>.

### Apache-2.0

- `@streamdown/code` 1.1.1
- `class-variance-authority` 0.7.1
- `detect-libc` 2.1.2
- `remend` 1.3.1
- `streamdown` 2.6.0

Full text: <https://www.apache.org/licenses/LICENSE-2.0>.

### SIL OFL-1.1

- `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` — reproduced
  in full at the top of this file.

### Other

- ISC: `@ungap/structured-clone`, `graceful-fs`, `lucide-react`, `picocolors`
- BSD-2-Clause: `entities`
- BSD-3-Clause: `source-map-js`
- 0BSD: `tslib`
- CC-BY-4.0 (build-time only, not shipped): `caniuse-lite`

---

## Regenerating this file

```sh
cargo metadata --format-version 1 --filter-platform aarch64-apple-darwin \
  | jq -r '.packages[] | "\(.license // "none")\t\(.name) \(.version)"' | sort
pnpm licenses list --prod --json
```
