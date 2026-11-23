#!/bin/sh
# Offline test of scripts/install/install.sh and scripts/release/sign-runtime.py.
#
#   sh scripts/install/test.sh
#
# Generates throwaway ed25519 keys in a temp dir, builds fake runtime releases
# (stub terminalx-serve scripts, terminalx-serve.json, SHA256SUMS signed by
# sign-runtime.py --local-dir), serves them with python3 -m http.server on a
# free local port, and runs the installer against them with a fake `uname`
# (fixtures/) and a temp HOME. Needs sh, python3, ssh-keygen and curl; no
# network beyond 127.0.0.1.

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
INSTALL="$HERE/install.sh"
SIGN="$ROOT/scripts/release/sign-runtime.py"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/terminalx-install-test.XXXXXX")
SERVER_PID=
cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

PASSED=0
FAILED=0
pass() {
  PASSED=$((PASSED + 1))
  printf 'ok   %s\n' "$1"
}
bad() {
  FAILED=$((FAILED + 1))
  printf 'FAIL %s\n' "$1"
  if [ -n "${2:-}" ] && [ -f "$2" ]; then sed 's/^/     | /' "$2"; fi
}

sha256_line() {
  # "<sha256>  <name>" for file $1 named $2
  if command -v sha256sum >/dev/null 2>&1; then
    hash=$(sha256sum "$1" | awk '{ print $1 }')
  else
    hash=$(shasum -a 256 "$1" | awk '{ print $1 }')
  fi
  printf '%s  %s\n' "$hash" "$2"
}

# --- The embedded trust anchor is the one in allowed_signers ---------------

embedded=$(sed -n "s/^TRUSTED_SIGNERS='\\(.*\\)'\$/\\1/p" "$INSTALL")
listed=$(grep -v '^#' "$HERE/allowed_signers" | grep -v '^[[:space:]]*$')
if [ -n "$embedded" ] && [ "$embedded" = "$listed" ]; then
  pass "install.sh embeds the allowed_signers key"
else
  printf 'install.sh: %s\nallowed_signers: %s\n' "$embedded" "$listed" >"$WORK/anchor.log"
  bad "install.sh embeds the allowed_signers key" "$WORK/anchor.log"
fi

# --- Keys, fake commands, fake releases -------------------------------------

mkdir -p "$WORK/keys" "$WORK/bin" "$WORK/srv/download" "$WORK/home"
ssh-keygen -q -t ed25519 -N '' -C test-release -f "$WORK/keys/good"
ssh-keygen -q -t ed25519 -N '' -C test-wrong -f "$WORK/keys/wrong"
printf 'release@terminalx namespaces="terminalx-runtime" %s\n' "$(cut -d' ' -f1,2 "$WORK/keys/good.pub")" >"$WORK/allowed_signers"
printf 'release@terminalx namespaces="terminalx-runtime" %s\n' "$(cut -d' ' -f1,2 "$WORK/keys/wrong.pub")" >"$WORK/wrong_signers"
cp "$HERE/fixtures/uname" "$HERE/fixtures/sysctl" "$WORK/bin/"
chmod 755 "$WORK/bin/uname" "$WORK/bin/sysctl"

ASSETS="terminalx-serve-linux-x64 terminalx-serve-linux-arm64 terminalx-serve-macos-arm64"

# make_release <tag> <version> <key: good|wrong|none>
make_release() {
  dir="$WORK/srv/download/$1"
  mkdir -p "$dir"
  for asset in $ASSETS; do
    sed -e "s/@VERSION@/$2/g" -e "s/@ASSET@/$asset/g" "$HERE/fixtures/terminalx-serve.stub" >"$dir/$asset"
    chmod 755 "$dir/$asset"
  done
  printf '{\n  "version": "%s",\n  "protocol": 2,\n  "commit": "%s",\n  "builtAt": "2026-11-15T00:00:00Z"\n}\n' \
    "$2" "0000000000000000000000000000000000000000" >"$dir/terminalx-serve.json"
  : >"$dir/SHA256SUMS"
  for name in $ASSETS terminalx-serve.json; do sha256_line "$dir/$name" "$name" >>"$dir/SHA256SUMS"; done
  case "$3" in
    good) python3 -I "$SIGN" --local-dir "$dir" --key "$WORK/keys/good" --allowed-signers "$WORK/allowed_signers" "$1" >"$WORK/sign-$1.log" 2>&1 ;;
    wrong) python3 -I "$SIGN" --local-dir "$dir" --key "$WORK/keys/wrong" --allowed-signers "$WORK/wrong_signers" "$1" >"$WORK/sign-$1.log" 2>&1 ;;
    none) ;;
  esac
}

# make_listing <file> <tag>...: a GitHub releases list naming those tags' assets.
make_listing() {
  out="$WORK/srv/$1"
  shift
  python3 -I - "$out" "$PORT" "$WORK/srv/download" "$@" <<'PY'
import json, os, sys
out, port, root, tags = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
releases = []
for tag in tags:
    names = sorted(os.listdir(os.path.join(root, tag)))
    releases.append({
        "tag_name": tag,
        "prerelease": True,
        "draft": False,
        "assets": [
            {"name": name, "browser_download_url": f"http://127.0.0.1:{port}/download/{tag}/{name}"}
            for name in names
        ],
    })
with open(out, "w") as f:
    json.dump(releases, f, indent=2)
PY
}

# --- Serve them on a free local port ----------------------------------------

python3 -I -u -m http.server 0 --bind 127.0.0.1 --directory "$WORK/srv" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
PORT=
tries=0
while [ -z "$PORT" ] && [ "$tries" -lt 100 ]; do
  PORT=$(sed -n 's/.* port \([0-9][0-9]*\).*/\1/p' "$WORK/server.log" | head -n 1)
  [ -n "$PORT" ] || { tries=$((tries + 1)); python3 -c 'import time; time.sleep(0.1)'; }
done
[ -n "$PORT" ] || { cat "$WORK/server.log"; echo "the test server did not start" >&2; exit 1; }

A=runtime-v0.1.0-20261101000000-aaaaaaa
B=runtime-v0.2.0-20261102000000-bbbbbbb
UNSIGNED=runtime-v0.3.0-20261103000000-ccccccc
TAMPERED_BIN=runtime-v0.4.0-20261104000000-ddddddd
TAMPERED_SUMS=runtime-v0.4.1-20261104000001-eeeeeee
WRONG_KEY=runtime-v0.5.0-20261105000000-fffffff
MISMATCH=runtime-v0.6.0-20261106000000-1234567

make_release "$A" 0.1.0 good
make_release "$B" 0.2.0 good
make_release "$UNSIGNED" 0.3.0 none
make_release "$TAMPERED_BIN" 0.4.0 good
make_release "$TAMPERED_SUMS" 0.4.1 good
make_release "$WRONG_KEY" 0.5.0 wrong
make_release "$MISMATCH" 0.6.0 good

if [ -f "$WORK/srv/download/$A/SHA256SUMS.sig" ] && grep -q 'Signature verifies' "$WORK/sign-$A.log"; then
  pass "sign-runtime.py --local-dir signs and verifies a release"
else
  bad "sign-runtime.py --local-dir signs and verifies a release" "$WORK/sign-$A.log"
fi

# Tampered after signing: a binary changed; SHA256SUMS rewritten to match a changed binary.
printf 'echo pwned\n' >>"$WORK/srv/download/$TAMPERED_BIN/terminalx-serve-linux-x64"
printf 'echo pwned\n' >>"$WORK/srv/download/$TAMPERED_SUMS/terminalx-serve-linux-x64"
(
  cd "$WORK/srv/download/$TAMPERED_SUMS"
  : >SHA256SUMS.new
  for name in $ASSETS terminalx-serve.json; do sha256_line "$name" "$name" >>SHA256SUMS.new; done
  mv SHA256SUMS.new SHA256SUMS
)

# sign-runtime.py refuses to sign a release whose files do not match SHA256SUMS.
if python3 -I "$SIGN" --local-dir "$WORK/srv/download/$TAMPERED_BIN" --key "$WORK/keys/good" \
  --allowed-signers "$WORK/allowed_signers" "$TAMPERED_BIN" >"$WORK/sign-tampered.log" 2>&1; then
  bad "sign-runtime.py refuses a release that does not match SHA256SUMS" "$WORK/sign-tampered.log"
elif grep -q 'does not match SHA256SUMS' "$WORK/sign-tampered.log"; then
  pass "sign-runtime.py refuses a release that does not match SHA256SUMS"
else
  bad "sign-runtime.py refuses a release that does not match SHA256SUMS" "$WORK/sign-tampered.log"
fi
# ...and a key the allowed_signers file does not name.
if python3 -I "$SIGN" --local-dir "$WORK/srv/download/$A" --key "$WORK/keys/wrong" \
  --allowed-signers "$WORK/allowed_signers" "$A" >"$WORK/sign-wrong.log" 2>&1; then
  bad "sign-runtime.py refuses a key the installer does not trust" "$WORK/sign-wrong.log"
else
  pass "sign-runtime.py refuses a key the installer does not trust"
fi
# Put A's good signature back (the refused run above replaced it).
make_release "$A" 0.1.0 good

# The tag says 0.6.0 but the signed manifest says 0.6.1.
sed 's/"0.6.0"/"0.6.1"/' "$WORK/srv/download/$MISMATCH/terminalx-serve.json" >"$WORK/mismatch.json"
mv "$WORK/mismatch.json" "$WORK/srv/download/$MISMATCH/terminalx-serve.json"
(
  cd "$WORK/srv/download/$MISMATCH"
  : >SHA256SUMS
  for name in $ASSETS terminalx-serve.json; do sha256_line "$name" "$name" >>SHA256SUMS; done
  rm -f SHA256SUMS.sig
  ssh-keygen -q -Y sign -f "$WORK/keys/good" -n terminalx-runtime SHA256SUMS
)

make_listing only-a.json "$A"
make_listing a-b-unsigned.json "$UNSIGNED" "$B" "$A"
make_listing unsigned-only.json "$UNSIGNED"

# --- Running the installer ---------------------------------------------------

HOME_DIR="$WORK/home"
TX="$HOME_DIR/.terminalx"

# run_install <log> <listing> [VAR=value...]: the installer as `curl | sh` runs it.
# POSIX sh has no `local`: each helper's variables carry its own prefix.
run_install() {
  ri_log="$WORK/$1"
  ri_listing=$2
  shift 2
  env HOME="$HOME_DIR" PATH="$WORK/bin:$PATH" TMPDIR="$WORK" \
    TERMINALX_INSTALL_API_URL="http://127.0.0.1:$PORT/$ri_listing" \
    TERMINALX_INSTALL_BASE_URL="http://127.0.0.1:$PORT/download" \
    TERMINALX_INSTALL_ALLOWED_SIGNERS="$WORK/allowed_signers" \
    "$@" sh <"$INSTALL" >"$ri_log" 2>&1
}

# Everything the installer could change, to compare before and after a refusal.
snapshot() {
  (
    cd "$HOME_DIR"
    find . -print | LC_ALL=C sort
    for link in .terminalx/current .local/bin/terminalx-serve; do
      if [ -L "$link" ]; then printf '%s -> %s\n' "$link" "$(readlink "$link")"; fi
    done
    find . -type f -print | LC_ALL=C sort | while IFS= read -r file; do cksum "$file"; done
  )
}

current_target() { readlink "$TX/current" 2>/dev/null || true; }

# 1. A good release installs.
if run_install install-a.log only-a.json \
  && [ "$(current_target)" = versions/0.1.0 ] \
  && [ -x "$TX/versions/0.1.0/terminalx-serve" ] \
  && grep -q 'asset: terminalx-serve-linux-x64' "$TX/versions/0.1.0/terminalx-serve" \
  && [ "$("$TX/current/terminalx-serve" --version)" = "terminalx-serve 0.1.0" ] \
  && [ "$(readlink "$HOME_DIR/.local/bin/terminalx-serve")" = "$TX/current/terminalx-serve" ] \
  && grep -qx '0.1.0 service install' "$HOME_DIR/stub-calls.log" \
  && grep -q 'terminalx-serve pair' "$WORK/install-a.log" \
  && grep -q 'test signing key' "$WORK/install-a.log"; then
  pass "a good release installs, links current and ~/.local/bin, and runs service install"
else
  bad "a good release installs, links current and ~/.local/bin, and runs service install" "$WORK/install-a.log"
fi

if grep -q 'not on your PATH' "$WORK/install-a.log"; then
  pass "says how to put ~/.local/bin on PATH when it is missing"
else
  bad "says how to put ~/.local/bin on PATH when it is missing" "$WORK/install-a.log"
fi

# The commands that work as printed come first: by full path, before the PATH advice.
full_line=$(grep -n -F "  $TX/current/terminalx-serve pair" "$WORK/install-a.log" | head -n 1 | cut -d: -f1)
path_line=$(grep -n 'not on your PATH' "$WORK/install-a.log" | head -n 1 | cut -d: -f1)
if [ -n "$full_line" ] && [ -n "$path_line" ] && [ "$full_line" -lt "$path_line" ] \
  && grep -q -F "  $TX/current/terminalx-serve login" "$WORK/install-a.log" \
  && grep -q 'opens no port' "$WORK/install-a.log"; then
  pass "off PATH, the full-path login and pair commands come before the PATH advice"
else
  bad "off PATH, the full-path login and pair commands come before the PATH advice" "$WORK/install-a.log"
fi

if ! grep -q 'installing as root' "$WORK/install-a.log"; then
  pass "an ordinary user is not warned about root"
else
  bad "an ordinary user is not warned about root" "$WORK/install-a.log"
fi

if [ -n "$(find "$TX" -maxdepth 0 -type d -perm 700 -print)" ]; then
  pass "the install folder (.terminalx) is private to the user"
else
  ls -ld "$TX" >"$WORK/mode.log"
  bad "the install folder (.terminalx) is private to the user" "$WORK/mode.log"
fi

# 2. Discovery skips an unsigned newer release and installs the newest signed one; the old version stays.
if run_install install-b.log a-b-unsigned.json \
  && [ "$(current_target)" = versions/0.2.0 ] \
  && [ -x "$TX/versions/0.1.0/terminalx-serve" ] \
  && [ ! -e "$TX/versions/0.3.0" ] \
  && grep -q "$B" "$WORK/install-b.log" \
  && grep -qx '0.2.0 service install' "$HOME_DIR/stub-calls.log"; then
  pass "a second version swaps current and keeps the first folder; an unsigned newer release is skipped"
else
  bad "a second version swaps current and keeps the first folder; an unsigned newer release is skipped" "$WORK/install-b.log"
fi

if [ -z "$(find "$TX/versions" -name '.install.*' -print)" ] && [ -z "$(find "$WORK" -maxdepth 1 -name 'terminalx-install.*' -print)" ]; then
  pass "leaves no staging or temporary folders behind"
else
  find "$TX/versions" "$WORK" -maxdepth 1 >"$WORK/leftovers.log"
  bad "leaves no staging or temporary folders behind" "$WORK/leftovers.log"
fi

# 3. Each bad download is refused and changes nothing.
before="$WORK/before.txt"
snapshot >"$before"

# refused <name> <log> <expected message> [VAR=value...]
refused() {
  rf_name=$1
  rf_log=$2
  rf_message=$3
  shift 3
  if run_install "$rf_log" only-a.json "$@"; then
    bad "$rf_name: was installed" "$WORK/$rf_log"
  elif ! grep -q "$rf_message" "$WORK/$rf_log"; then
    bad "$rf_name: refused without saying \"$rf_message\"" "$WORK/$rf_log"
  elif ! snapshot | cmp -s - "$before"; then
    snapshot | diff "$before" - >"$WORK/$rf_log.diff" || true
    bad "$rf_name: refused, but the install changed" "$WORK/$rf_log.diff"
  else
    pass "$rf_name"
  fi
}

refused "a tampered binary is refused" tampered-bin.log 'does not match its signed SHA-256' \
  TERMINALX_INSTALL_TAG="$TAMPERED_BIN"
refused "a tampered SHA256SUMS is refused" tampered-sums.log 'does not verify' \
  TERMINALX_INSTALL_TAG="$TAMPERED_SUMS"
refused "a signature by another key is refused" wrong-key.log 'does not verify' \
  TERMINALX_INSTALL_TAG="$WRONG_KEY"
refused "a release with no signature is refused" unsigned.log 'has no signature' \
  TERMINALX_INSTALL_TAG="$UNSIGNED"
refused "a manifest version that does not match its tag is refused" mismatch.log 'does not match its tag' \
  TERMINALX_INSTALL_TAG="$MISMATCH"
refused "a listing with no signed release installs nothing" no-signed.log 'no signed TerminalX runtime release' \
  TERMINALX_INSTALL_API_URL="http://127.0.0.1:$PORT/unsigned-only.json"
refused "without a test key, only the TerminalX release key is trusted" release-key.log 'does not verify' \
  TERMINALX_INSTALL_ALLOWED_SIGNERS= TERMINALX_INSTALL_TAG="$A"
refused "an Intel Mac is told there is no build for it" intel-mac.log 'no TerminalX runtime for Intel Macs' \
  FAKE_UNAME_S=Darwin FAKE_UNAME_M=x86_64
refused "an unsupported system is refused" freebsd.log 'no TerminalX runtime for FreeBSD' \
  FAKE_UNAME_S=FreeBSD

# 4. The right asset for the machine.
if run_install arm64.log only-a.json FAKE_UNAME_M=aarch64 \
  && grep -q 'asset: terminalx-serve-linux-arm64' "$TX/versions/0.1.0/terminalx-serve" \
  && [ "$(current_target)" = versions/0.1.0 ] \
  && [ -x "$TX/versions/0.2.0/terminalx-serve" ]; then
  pass "Linux arm64 gets the arm64 build (reinstalling a version replaces its binary)"
else
  bad "Linux arm64 gets the arm64 build (reinstalling a version replaces its binary)" "$WORK/arm64.log"
fi
if run_install rosetta.log only-a.json FAKE_UNAME_S=Darwin FAKE_UNAME_M=x86_64 FAKE_TRANSLATED=1 \
  && grep -q 'asset: terminalx-serve-macos-arm64' "$TX/versions/0.1.0/terminalx-serve"; then
  pass "a shell under Rosetta on Apple silicon gets the macOS arm64 build"
else
  bad "a shell under Rosetta on Apple silicon gets the macOS arm64 build" "$WORK/rosetta.log"
fi

# 5. With ~/.local/bin on PATH, it goes straight to pairing.
if run_install on-path.log only-a.json PATH="$HOME_DIR/.local/bin:$WORK/bin:$PATH" \
  && ! grep -q 'not on your PATH' "$WORK/on-path.log" \
  && grep -qx '  terminalx-serve login' "$WORK/on-path.log" \
  && grep -qx '  terminalx-serve pair' "$WORK/on-path.log" \
  && grep -q 'Settings → Machines → Add a machine → Headless server' "$WORK/on-path.log"; then
  pass "with ~/.local/bin on PATH it says to run terminalx-serve pair"
else
  bad "with ~/.local/bin on PATH it says to run terminalx-serve pair" "$WORK/on-path.log"
fi

# 6. Root may install (PRO-487): it is warned what that means, nothing asks
# for another user, and the service is installed all the same.
mkdir -p "$WORK/rootbin"
cat >"$WORK/rootbin/id" <<'ID'
#!/bin/sh
if [ "${1:-}" = -u ]; then echo 0; else exec /usr/bin/id "$@"; fi
ID
chmod 755 "$WORK/rootbin/id"
: >"$HOME_DIR/stub-calls.log"
if run_install root.log only-a.json PATH="$WORK/rootbin:$WORK/bin:$PATH" \
  && grep -q 'warning: installing as root: the runtime will run as root, so every paired computer and every agent on this server will act as root' "$WORK/root.log" \
  && grep -q 'Which user to run as' "$WORK/root.log" \
  && grep -qx '0.1.0 service install' "$HOME_DIR/stub-calls.log" \
  && ! grep -q -i 'sudo\|useradd\|adduser' "$WORK/root.log" \
  && grep -q 'terminalx-serve pair' "$WORK/root.log"; then
  pass "installing as root works, warns that everything acts as root, and creates no user"
else
  bad "installing as root works, warns that everything acts as root, and creates no user" "$WORK/root.log"
fi

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
