**What this changes, and why**

<!-- What was wrong before, and what the reader gets now. -->

**Checks** — all four pass locally:

- [ ] `pnpm exec tsc --noEmit`
- [ ] `pnpm vitest run`
- [ ] `cargo clippy --all-targets -- -D warnings` (in `src-tauri`)
- [ ] `cargo test` (in `src-tauri`)

**Also:**

- [ ] No mock data, no stubbed-out path, no simplified stand-in for something
      that should be real. If it is not finished, it is not in the diff.
- [ ] Anything visual has a screenshot, in light and dark.
- [ ] Fixtures carry no account, machine or personal data.

<!-- Security impact? Do not open a PR. See SECURITY.md. -->
