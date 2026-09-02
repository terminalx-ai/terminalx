# Security policy

## Reporting a vulnerability

**Do not open a public issue.** Email **dudhatparesh@gmail.com** with:

- what the problem is and where in the code it lives,
- how to reproduce it, ideally as a minimal case,
- what an attacker gets out of it,
- and how you would like to be credited, if at all.

You should get an acknowledgement within **3 working days**. If you have not
heard anything in a week, assume the mail went astray and send it again.

Raccoon is one person's side project, not a company with a security team.
There is no bug bounty and no formal SLA beyond what is written here — but
reports are read and taken seriously.

## Disclosure

Please give it **90 days** from your first report before disclosing publicly.
If a fix ships sooner, we can agree a shorter window; if it is taking longer
than 90 days you are free to publish, and it would be good to hear from you
first so the advisory and the fix can go out together.

Fixed issues are credited in `CHANGELOG.md` unless you would rather not be
named.

## Supported versions

Only the **latest release** is supported. Fixes go into the next release; there
are no backport branches, and older `.dmg` builds are not patched. If you are
running an older version, the fix is to update — Settings → About → Check for
updates.

## Scope

In scope, roughly in the order that matters:

- Anything that lets a repository, a git worktree, an agent's output, or a
  GitHub or Linear issue **run code or escalate permissions** it was not
  granted — for example content that escapes the permission mode a tab is in,
  or that reaches the hook socket.
- **The hook bridge**: `$RACCOON_HOME/run/hooks.sock` and everything that
  speaks over it. It is created `0600` inside a `0700` directory and is meant
  to be reachable only by the user running the app.
- **Credential handling**: the Linear API key in `$RACCOON_HOME/settings.json`,
  and the symlinks in the managed Codex home that point at your real
  `~/.codex/auth.json`.
- **The updater**: signature verification, the endpoint, and anything that
  could get an unsigned or substituted artifact installed.
- **Model downloads**: revision pinning and SHA-256 verification of
  transcription weights.
- Any **unexpected outbound connection**. Raccoon has no telemetry; a build
  that talks to something not listed in the README's "What leaves your
  machine" is a bug worth reporting.

Out of scope:

- Vulnerabilities in `claude`, `codex`, or `gh` themselves — report those
  upstream. Raccoon runs the CLIs you already have installed.
- Anything that requires an attacker to already have local code execution as
  your user. At that point they can read `~/.claude.json` and `~/.codex`
  directly and Raccoon is not the weak link.
- The build being ad-hoc signed rather than notarized. That is a known,
  documented property of the current release process, not a finding.
- Bypass permission mode doing exactly what it says on the label.
