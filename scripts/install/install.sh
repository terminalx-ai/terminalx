#!/bin/sh
# Install the TerminalX runtime (terminalx-serve) on a headless server:
#
#   curl -fsSL https://terminalx.ai/install.sh | sh
#
# It finds the newest signed runtime release of terminalx-ai/terminalx,
# verifies SHA256SUMS.sig against the key below with ssh-keygen and the
# binary against SHA256SUMS, installs it as
# ~/.terminalx/versions/<version>/terminalx-serve, points ~/.terminalx/current
# at it (an atomic swap), links ~/.local/bin/terminalx-serve and runs
# `terminalx-serve service install`. A download that does not verify is
# refused, and nothing under ~/.terminalx is touched until everything has
# verified. It needs curl, ssh-keygen (OpenSSH 8.1 or later) and sha256sum or
# shasum, and never root. See docs/HEADLESS-SERVER.md.
#
# For tests and pinning only (each prints a warning when used):
#   TERMINALX_INSTALL_TAG              install this runtime release tag
#   TERMINALX_INSTALL_API_URL          the releases list (GitHub API JSON)
#   TERMINALX_INSTALL_BASE_URL         where <tag>/<asset> is downloaded from
#   TERMINALX_INSTALL_ALLOWED_SIGNERS  an allowed_signers file to trust
#                                      instead of the key below
#
# The whole script is one function called on its last line, so a download cut
# short runs nothing.

set -u

# The key runtime releases are signed with. Kept equal to
# scripts/install/allowed_signers and RUNTIME_SIGNING_KEY in
# src-tauri/src/serve_cli/mod.rs (scripts/install/test.sh checks).
TRUSTED_SIGNERS='release@terminalx namespaces="terminalx-runtime" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ17UcQnKdE/Sp6oQBa8SGenmiS0ufw6xO8CrY6J/MEU'
SIGNER_PRINCIPAL='release@terminalx'
SIGNATURE_NAMESPACE='terminalx-runtime'

DEFAULT_API_URL='https://api.github.com/repos/terminalx-ai/terminalx/releases?per_page=100'
DEFAULT_BASE_URL='https://github.com/terminalx-ai/terminalx/releases/download'
# runtime-v<version>-<yyyymmddHHMMSS>-<sha7>, as .github/workflows/release-serve.yml tags them.
TAG_PATTERN='^runtime-v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*-[0-9]\{14\}-[0-9a-f]\{7\}$'

TMP_DIR=
STAGE_DIR=

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then rm -rf "$STAGE_DIR"; fi
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required: $2"
}

# The release asset for this machine, or a refusal for one there is no build for.
detect_asset() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux)
      case "$arch" in
        x86_64 | amd64) echo terminalx-serve-linux-x64 ;;
        aarch64 | arm64) echo terminalx-serve-linux-arm64 ;;
        *) fail "there is no TerminalX runtime for Linux on $arch; it is built for x86-64 and arm64" ;;
      esac
      ;;
    Darwin)
      # A shell under Rosetta reports x86_64 on Apple silicon.
      if [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
        arch=arm64
      fi
      case "$arch" in
        arm64 | aarch64) echo terminalx-serve-macos-arm64 ;;
        *) fail "there is no TerminalX runtime for Intel Macs; it runs on Macs with Apple silicon only" ;;
      esac
      ;;
    *) fail "there is no TerminalX runtime for $os; it runs on Linux (x86-64, arm64) and macOS (Apple silicon)" ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

# OpenSSH 8.1 added `ssh-keygen -Y verify`. Checked from `ssh -V` when the
# client is there; otherwise the verify step itself says what went wrong.
check_openssh() {
  command -v ssh >/dev/null 2>&1 || return 0
  version=$(ssh -V 2>&1 </dev/null | sed -n 's/^OpenSSH_\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p')
  [ -n "$version" ] || return 0
  # shellcheck disable=SC2086 # split "major minor"
  set -- $version
  if [ "$1" -lt 8 ] || { [ "$1" -eq 8 ] && [ "$2" -lt 1 ]; }; then
    fail "OpenSSH 8.1 or later is needed to verify the release signature (this is $(ssh -V 2>&1 </dev/null))"
  fi
}

fetch() {
  # $1 url, $2 output file
  # shellcheck disable=SC2086 # CURL_PROTO is two words
  curl -fsSL $CURL_PROTO --retry 3 -o "$2" "$1" </dev/null
}

# Whether one of the URLs in $1 ends in $2.
has_url() {
  printf '%s\n' "$1" | awk -v s="$2" 'length($0) >= length(s) && substr($0, length($0) - length(s) + 1) == s { found = 1 } END { exit !found }'
}

# Tags of signed runtime releases that carry $1, newest first, read from the
# GitHub releases list in $2. A release is signed when it has SHA256SUMS.sig.
signed_tags() {
  asset=$1
  list=$2
  # One JSON token per line, so each URL is on a line of its own.
  # shellcheck disable=SC2020 # each of these characters becomes a newline
  urls=$(tr ',{}[]' '\n\n\n\n\n' <"$list" | sed -n 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  printf '%s\n' "$urls" | sed -n 's#.*/download/\([^/]*\)/SHA256SUMS\.sig$#\1#p' | sort -u | while IFS= read -r tag; do
    printf '%s\n' "$tag" | grep -q "$TAG_PATTERN" || continue
    has_url "$urls" "/download/$tag/$asset" || continue
    has_url "$urls" "/download/$tag/SHA256SUMS" || continue
    # Sort key: the commit timestamp in the tag.
    printf '%s %s\n' "$(printf '%s\n' "$tag" | sed 's/^runtime-v[0-9.]*-\([0-9]*\)-.*/\1/')" "$tag"
  done | sort -r | awk '{ print $2 }'
}

# The expected SHA-256 of $1 in SHA256SUMS file $2, or nothing.
listed_hash() {
  awk -v name="$1" '($2 == name || $2 == "*" name) && $1 ~ /^[0-9a-f]+$/ && length($1) == 64 { print $1; exit }' "$2"
}

verify_listed() {
  # $1 asset name, $2 file, $3 SHA256SUMS
  expected=$(listed_hash "$1" "$3")
  [ -n "$expected" ] || fail "SHA256SUMS of $TAG does not list $1; nothing was installed"
  actual=$(sha256_of "$2")
  [ "$actual" = "$expected" ] || fail "$1 of $TAG does not match its signed SHA-256 (expected $expected, got $actual); the download was refused and nothing was installed"
}

# Point $1 (a symlink) at $2 in one rename: GNU `mv -T`, BSD `mv -h`.
swap_link() {
  link=$1
  target=$2
  next="$link.next.$$"
  rm -f "$next"
  ln -s "$target" "$next" || fail "cannot create $next"
  if mv -T "$next" "$link" 2>/dev/null; then return 0; fi
  if mv -h "$next" "$link" 2>/dev/null; then return 0; fi
  rm -f "$next"
  fail "cannot swap $link to $target"
}

main() {
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  umask 077

  need curl "install it with your package manager (apt install curl)"
  need ssh-keygen "install OpenSSH 8.1 or later (apt install openssh-client)"
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    fail "sha256sum or shasum is required (apt install coreutils)"
  fi
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] || fail "HOME is not set to a directory"
  # Root may install and run it (PRO-487): the installer never creates or
  # switches to another user. It says what that means.
  if [ "$(id -u)" = 0 ]; then
    warn "installing as root: the runtime will run as root, so every paired computer and every agent on this server will act as root."
    warn "To avoid that, stop now (Ctrl-C) and run this installer as another user; docs/HEADLESS-SERVER.md, \"Which user to run as\", describes the set-ups."
  fi
  check_openssh

  ASSET=$(detect_asset) || exit 1

  API_URL=${TERMINALX_INSTALL_API_URL:-$DEFAULT_API_URL}
  BASE_URL=${TERMINALX_INSTALL_BASE_URL:-$DEFAULT_BASE_URL}
  CURL_PROTO="--proto =https --tlsv1.2"
  if [ -n "${TERMINALX_INSTALL_API_URL:-}" ] || [ -n "${TERMINALX_INSTALL_BASE_URL:-}" ]; then
    warn "downloading from a test location ($BASE_URL); signatures are still checked"
    CURL_PROTO="--proto =https,http"
  fi

  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/terminalx-install.XXXXXX") || fail "cannot create a temporary directory"
  SIGNERS="$TMP_DIR/allowed_signers"
  SIGNER_LABEL="TerminalX release key"
  if [ -n "${TERMINALX_INSTALL_ALLOWED_SIGNERS:-}" ]; then
    SIGNER_LABEL="test signing key"
    warn "trusting the test signing key in $TERMINALX_INSTALL_ALLOWED_SIGNERS instead of the TerminalX release key"
    cp "$TERMINALX_INSTALL_ALLOWED_SIGNERS" "$SIGNERS" || fail "cannot read $TERMINALX_INSTALL_ALLOWED_SIGNERS"
  else
    printf '%s\n' "$TRUSTED_SIGNERS" >"$SIGNERS"
  fi

  if [ -n "${TERMINALX_INSTALL_TAG:-}" ]; then
    TAG=$TERMINALX_INSTALL_TAG
    warn "installing the pinned runtime release $TAG"
    printf '%s\n' "$TAG" | grep -q "$TAG_PATTERN" || fail "$TAG is not a runtime release tag (runtime-v<version>-<timestamp>-<commit>)"
  else
    say "Finding the newest signed TerminalX runtime for $ASSET..."
    fetch "$API_URL" "$TMP_DIR/releases.json" || fail "cannot list releases from $API_URL"
    TAG=$(signed_tags "$ASSET" "$TMP_DIR/releases.json" | head -n 1)
    [ -n "$TAG" ] || fail "no signed TerminalX runtime release with $ASSET was found; try again later"
  fi

  say "Downloading $TAG..."
  url="$BASE_URL/$TAG"
  fetch "$url/SHA256SUMS" "$TMP_DIR/SHA256SUMS" || fail "cannot download SHA256SUMS of $TAG"
  fetch "$url/SHA256SUMS.sig" "$TMP_DIR/SHA256SUMS.sig" \
    || fail "$TAG has no signature (SHA256SUMS.sig) and is refused; nothing was installed"

  if ! ssh-keygen -Y verify -f "$SIGNERS" -I "$SIGNER_PRINCIPAL" -n "$SIGNATURE_NAMESPACE" \
    -s "$TMP_DIR/SHA256SUMS.sig" <"$TMP_DIR/SHA256SUMS" >"$TMP_DIR/verify.log" 2>&1; then
    cat "$TMP_DIR/verify.log" >&2
    fail "the signature of $TAG does not verify against the TerminalX release key; the download was refused and nothing was installed"
  fi
  say "Signature of SHA256SUMS: good ($SIGNER_LABEL)."

  fetch "$url/terminalx-serve.json" "$TMP_DIR/terminalx-serve.json" || fail "cannot download terminalx-serve.json of $TAG"
  verify_listed terminalx-serve.json "$TMP_DIR/terminalx-serve.json" "$TMP_DIR/SHA256SUMS"
  fetch "$url/$ASSET" "$TMP_DIR/$ASSET" || fail "cannot download $ASSET of $TAG"
  verify_listed "$ASSET" "$TMP_DIR/$ASSET" "$TMP_DIR/SHA256SUMS"
  say "SHA-256 of $ASSET: good."

  # shellcheck disable=SC2020 # each of these characters becomes a newline
  VERSION=$(tr ',{}' '\n\n\n' <"$TMP_DIR/terminalx-serve.json" | sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  printf '%s\n' "$VERSION" | grep -q '^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$' \
    || fail "terminalx-serve.json of $TAG has no usable version; nothing was installed"
  case "$TAG" in
    "runtime-v$VERSION-"*) ;;
    *) fail "$TAG carries version $VERSION in terminalx-serve.json, which does not match its tag; nothing was installed" ;;
  esac

  ROOT="$HOME/.terminalx"
  mkdir -p "$ROOT/versions" || fail "cannot create $ROOT"
  chmod 700 "$ROOT"
  STAGE_DIR=$(mktemp -d "$ROOT/versions/.install.XXXXXX") || fail "cannot stage the install in $ROOT/versions"
  if ! cp "$TMP_DIR/$ASSET" "$STAGE_DIR/terminalx-serve" || ! chmod 755 "$STAGE_DIR/terminalx-serve"; then
    fail "cannot write $STAGE_DIR/terminalx-serve"
  fi
  chmod 755 "$STAGE_DIR"

  # It must run here (glibc 2.35 or later on Linux) and be the version it says.
  ran=$("$STAGE_DIR/terminalx-serve" --version </dev/null 2>&1) \
    || fail "the downloaded runtime does not run on this machine: $ran (Linux needs glibc 2.35 or later); nothing was changed"
  [ "$ran" = "terminalx-serve $VERSION" ] \
    || fail "the downloaded runtime reports \"$ran\", not terminalx-serve $VERSION; nothing was changed"

  dest="$ROOT/versions/$VERSION"
  if [ -e "$dest" ]; then
    # The same version again (another build of it): replace the binary in one
    # rename, so a running service keeps the file it started from.
    mv -f "$STAGE_DIR/terminalx-serve" "$dest/terminalx-serve" || fail "cannot replace $dest/terminalx-serve"
    rmdir "$STAGE_DIR"
  else
    mv "$STAGE_DIR" "$dest" || fail "cannot create $dest"
  fi
  STAGE_DIR=

  if [ -e "$ROOT/current" ] && [ ! -L "$ROOT/current" ]; then
    fail "$ROOT/current is not a symbolic link; move it away and run the installer again"
  fi
  swap_link "$ROOT/current" "versions/$VERSION"
  say "Installed terminalx-serve $VERSION in $dest ($ROOT/current points at it)."

  BIN_DIR="$HOME/.local/bin"
  (umask 022 && mkdir -p "$BIN_DIR") || fail "cannot create $BIN_DIR"
  if [ -e "$BIN_DIR/terminalx-serve" ] && [ ! -L "$BIN_DIR/terminalx-serve" ]; then
    warn "$BIN_DIR/terminalx-serve exists and is not a link; left as it is (the runtime is $ROOT/current/terminalx-serve)"
  else
    swap_link "$BIN_DIR/terminalx-serve" "$ROOT/current/terminalx-serve"
  fi

  say "Installing the user service..."
  if ! "$ROOT/current/terminalx-serve" service install </dev/null; then
    fail "terminalx-serve is installed, but \`terminalx-serve service install\` failed (above); fix that and run it again"
  fi

  say ""
  say "TerminalX $VERSION is installed, with a user service (what it runs now is said above)."
  # The commands to run next come first, in a form that works as printed:
  # by name when ~/.local/bin is on PATH, by full path when it is not.
  case ":${PATH:-}:" in
    *":$BIN_DIR:"*) SERVE=terminalx-serve ;;
    *) SERVE="$ROOT/current/terminalx-serve" ;;
  esac
  say "Next, sign it in to your TerminalX account and pair it with your computer:"
  say ""
  say "  $SERVE login"
  say "  $SERVE pair"
  say ""
  say "\`pair\` asks where this server should listen. The default opens no port: your computer reaches it"
  say "through the TerminalX relay, which is what \`login\` is for. It then shows a code: enter it in TerminalX"
  say "under Settings → Machines → Add a machine → Headless server."
  if [ "$SERVE" != terminalx-serve ]; then
    say ""
    say "The full path is used above because $BIN_DIR is not on your PATH. To run \`terminalx-serve\` by name, add it:"
    say ""
    say "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.profile && . ~/.profile"
    say ""
    say "(use ~/.bashrc or ~/.zshrc if your shell reads that instead)."
  fi
}

main "$@"
