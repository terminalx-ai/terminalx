#!/usr/bin/env bash
# PRO-353: a fresh Ubuntu 24.04 server installs TerminalX with the install
# script, runs it as a user service, pairs a computer from its terminal and
# serves it a first session, all within five minutes; it refuses a release
# with a bad signature; and after a reboot the computer connects again and
# finds its session.
#
#   scripts/remote-runtime/e2e-install-linux.sh
#
# Two containers on one network stand in for the server and the operating
# computer. The server (systemd.Dockerfile) runs systemd, so the person's SSH
# login, the systemd user service, lingering and `docker restart` behave as on
# a real machine. The operating computer serves a release signed with a
# throwaway key over HTTP (the installer's TERMINALX_INSTALL_* test settings,
# which still check every signature), drives `terminalx-serve pair` through
# `ssh -tt` the way a person types (pair-driver.py), and connects with
# serve/tests/install_e2e.rs.
#
# terminalx-serve and the test client are built with e2e-linux.sh's toolchain
# (linux.Dockerfile) for this machine's architecture.
#   CPUS=2   CPU limit for the build container
#   KEEP=1   leave the containers running afterwards
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
out="${SERVE_OUT:-$here/target-linux}"
build_image="terminalx-serve-linux-e2e"
server_image="terminalx-server-e2e"
run_id="tx-install-$$"
network="$run_id"
server="$run_id-server"
client="$run_id-client"
# A fixed address, as a server has: the pairing code names it.
subnet="172.31.$(( $$ % 200 + 20 )).0/24"
server_ip="${subnet%.0/24}.10"
work="$(mktemp -d "${TMPDIR:-/tmp}/terminalx-install-e2e.XXXXXX")"

say() { printf '\n== %s\n' "$*"; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && docker inspect "$server" >/dev/null 2>&1; then
    echo "--- server: the service's journal and log" >&2
    docker exec "$server" sh -c 'journalctl --user-unit terminalx.service -M tester@ --no-pager 2>/dev/null | tail -40; tail -40 /home/tester/.terminalx/logs/runtime.log 2>/dev/null' >&2 || true
  fi
  if [ -z "${KEEP:-}" ]; then
    docker rm -f "$server" "$client" >/dev/null 2>&1 || true
    docker network rm "$network" >/dev/null 2>&1 || true
  else
    echo "kept: $server $client (network $network)" >&2
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

say "Build terminalx-serve and the operating computer for Linux"
mkdir -p "$out"
docker build -q -t "$build_image" -f "$here/scripts/remote-runtime/linux.Dockerfile" "$here/scripts/remote-runtime" >/dev/null
mounts=(-v "$here:/src" -v "$out:/out" -v terminalx-linux-cargo:/usr/local/cargo/registry -v terminalx-linux-rustup:/usr/local/rustup -v terminalx-linux-target:/target)
if [ -f "$here/.git" ]; then
  common="$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)"
  mounts+=(-v "$common:$common:ro")
fi
docker run --rm --init --cpus="${CPUS:-2}" "${mounts[@]}" -e CARGO_TARGET_DIR=/target -w /src/src-tauri/serve "$build_image" bash -c '
set -euo pipefail
cargo build --locked --bin terminalx-serve
client=$(cargo test --locked --no-run --test install_e2e 2>&1 | tee /dev/stderr | sed -n "s#.*Executable tests/install_e2e.rs (\(.*\))\$#\1#p" | tail -n 1)
[ -n "$client" ] || { echo "no install_e2e test binary was built" >&2; exit 1; }
install -m 0755 /target/debug/terminalx-serve /out/terminalx-serve
install -m 0755 "$client" /out/install_e2e
'
docker build -q -t "$server_image" -f "$here/scripts/remote-runtime/systemd.Dockerfile" "$here/scripts/remote-runtime" >/dev/null

say "Sign a release with a throwaway key"
version_line="$(docker run --rm -v "$out:/out:ro" "$server_image" /out/terminalx-serve --version)"
version="${version_line#terminalx-serve }"
case "$(docker run --rm "$server_image" uname -m)" in
  x86_64) asset=terminalx-serve-linux-x64 ;;
  aarch64) asset=terminalx-serve-linux-arm64 ;;
  *) fail "no runtime asset for this architecture" ;;
esac
commit="$(git -C "$here" rev-parse --short=7 HEAD)"
good="runtime-v$version-$(date -u +%Y%m%d%H%M%S)-$commit"
bad="runtime-v$version-20200101000000-0000000"
release="$work/release"
ssh-keygen -q -t ed25519 -N '' -C e2e-release -f "$work/release_key"
ssh-keygen -q -t ed25519 -N '' -C e2e-other -f "$work/other_key"
ssh-keygen -q -t ed25519 -N '' -C e2e-person -f "$work/person_key"
printf 'release@terminalx namespaces="terminalx-runtime" %s\n' "$(cut -d' ' -f1-2 "$work/release_key.pub")" >"$work/allowed_signers"
publish() {
  # $1 tag, $2 signing key
  dir="$release/download/$1"
  mkdir -p "$dir"
  cp "$out/terminalx-serve" "$dir/$asset"
  printf '{"version":"%s","asset":"%s"}\n' "$version" "$asset" >"$dir/terminalx-serve.json"
  (cd "$dir" && shasum -a 256 "$asset" terminalx-serve.json >SHA256SUMS)
  ssh-keygen -q -Y sign -n terminalx-runtime -f "$2" "$dir/SHA256SUMS"
}
publish "$good" "$work/release_key"
publish "$bad" "$work/other_key"
python3 - "$release" "$asset" "$good" "$bad" <<'PY'
import json, sys
release, asset, *tags = sys.argv[1:]
base = "http://CLIENT:8000/download"
listing = [{"tag_name": tag, "draft": False, "prerelease": True, "assets": [{"name": name, "browser_download_url": f"{base}/{tag}/{name}"} for name in (asset, "terminalx-serve.json", "SHA256SUMS", "SHA256SUMS.sig")]} for tag in tags]
open(f"{release}/releases.json", "w").write(json.dumps(listing))
PY
sed -i.bak "s/CLIENT/$client/g" "$release/releases.json" && rm "$release/releases.json.bak"
cp "$here/scripts/install/install.sh" "$release/install.sh"
cp "$work/allowed_signers" "$release/allowed_signers"

say "Start the server and the operating computer"
docker network create --subnet "$subnet" "$network" >/dev/null
docker run -d --name "$server" --hostname e2e-server --network "$network" --ip "$server_ip" \
  --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock "$server_image" >/dev/null
docker run -d --name "$client" --hostname e2e-laptop --network "$network" "$server_image" sleep infinity >/dev/null
booted() {
  for _ in $(seq 1 60); do
    case "$(docker exec "$server" systemctl is-system-running 2>/dev/null || true)" in
      running | degraded) return 0 ;;
    esac
    sleep 1
  done
  fail "the server did not boot"
}
booted
# The person can log in with their key, and has Claude Code (here its
# stand-in) installed.
docker exec -i "$server" sh -c 'install -d -m 700 -o tester -g tester /home/tester/.ssh && cat >/home/tester/.ssh/authorized_keys && chown tester:tester /home/tester/.ssh/authorized_keys && chmod 600 /home/tester/.ssh/authorized_keys' <"$work/person_key.pub"
docker cp "$here/scripts/remote-runtime/fake-claude" "$server:/usr/local/bin/claude"
docker exec "$server" chmod 755 /usr/local/bin/claude
docker exec "$client" mkdir -p /e2e/state
docker cp "$release" "$client:/e2e/release"
docker cp "$work/person_key" "$client:/e2e/person_key"
docker cp "$here/scripts/remote-runtime/pair-driver.py" "$client:/e2e/pair-driver.py"
docker cp "$out/install_e2e" "$client:/e2e/install_e2e"
docker exec "$client" chmod 600 /e2e/person_key
docker exec -d "$client" python3 -m http.server 8000 --bind 0.0.0.0 --directory /e2e/release
ssh_opts=(-i /e2e/person_key -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/e2e/known_hosts -o ConnectTimeout=10 -o LogLevel=ERROR)
# A command in the person's SSH login on the server (a login shell, so
# ~/.local/bin is on PATH as Ubuntu's ~/.profile puts it there).
on_server() { docker exec "$client" ssh "${ssh_opts[@]}" "tester@$server_ip" "bash -lc $(printf '%q' "$1")"; }
for _ in $(seq 1 30); do on_server true 2>/dev/null && break; sleep 1; done
operating() {
  docker exec -e TX_E2E_CODE_FILE=/e2e/state/code -e TX_E2E_STATE=/e2e/state -e TX_E2E_STEP="$1" "$client" \
    /e2e/install_e2e --ignored --exact operating_computer --nocapture
}
test_settings="TERMINALX_INSTALL_API_URL=http://$client:8000/releases.json TERMINALX_INSTALL_BASE_URL=http://$client:8000/download TERMINALX_INSTALL_ALLOWED_SIGNERS=\$HOME/test_signers"

started=$(date +%s)
say "A release signed by another key is refused, and nothing is installed"
on_server "curl -fsSL http://$client:8000/allowed_signers -o ~/test_signers"
if refused="$(on_server "curl -fsSL http://$client:8000/install.sh | TERMINALX_INSTALL_TAG=$bad $test_settings sh" 2>&1)"; then
  fail "the installer accepted a release signed by another key: $refused"
fi
echo "$refused" | tail -3
echo "$refused" | grep -q "does not verify against the TerminalX release key" || fail "the refusal does not say why"
on_server '[ ! -e ~/.terminalx/current ] && [ ! -e ~/.local/bin/terminalx-serve ]' || fail "a refused install left files behind"

say "Install"
on_server "curl -fsSL http://$client:8000/install.sh | $test_settings sh"
on_server 'terminalx-serve --version'
on_server 'terminalx-serve service status' || true
on_server 'systemctl --user is-enabled terminalx.service && loginctl show-user tester -p Linger | grep -qx Linger=yes' || fail "the service does not start at boot"

say "Pair from the server's terminal"
# The operating computer, started by the driver once the code is shown,
# inherits the step from its environment.
docker exec -e TX_E2E_CODE_FILE=/e2e/state/code -e TX_E2E_STATE=/e2e/state -e TX_E2E_STEP=pair "$client" \
  python3 /e2e/pair-driver.py /e2e/state/code \
  ssh -tt "${ssh_opts[@]}" "tester@$server_ip" "bash -lc 'terminalx-serve pair'" \
  -- /e2e/install_e2e --ignored --exact operating_computer --nocapture \
  || fail "pairing failed"
on_server 'terminalx-serve devices' | tee /dev/stderr | grep -q 'E2E Laptop' || fail "devices does not list the computer"

say "A project, and the first session"
on_server 'git init -q -b main ~/demo && terminalx-serve projects add ~/demo'
operating session || fail "the first session failed"
elapsed=$(( $(date +%s) - started ))
echo "install, pair and a first session took ${elapsed}s"
[ "$elapsed" -lt 300 ] || fail "it took ${elapsed}s, not under five minutes"

say "Reboot: the service starts with the server, and the computer connects again"
docker restart "$server" >/dev/null
booted
for _ in $(seq 1 60); do
  docker exec "$client" python3 -c "import socket; socket.create_connection(('$server_ip', 6768), 2)" 2>/dev/null && break
  sleep 1
done
operating reconnect || fail "the computer did not connect again after the reboot"
on_server 'terminalx-serve service status'

say "PASSED (install, pair and first session in ${elapsed}s)"
