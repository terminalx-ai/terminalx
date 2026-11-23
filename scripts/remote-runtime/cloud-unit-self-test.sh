#!/usr/bin/env bash
# cloud-unit-self-test.sh <terminalx-serve>
#
# Runs the runtime's self-test the way a cloud workspace runs the runtime:
# as its own system user, from /, under the sandbox of the systemd unit the
# server installs (terminalx-server, cloudWorkspaceServeRuntime.ts):
# ProtectHome=true, ProtectSystem=strict, PrivateTmp=true, writable state
# only under its own directory. A plain self-test as the CI user missed a
# runtime that could not start there: with /home closed, a startup probe of
# a path under /home failed with "Permission denied", and every new cloud
# workspace's bootstrap failed.
#
# Linux only; needs systemd and passwordless sudo (GitHub's Ubuntu runners).
set -euo pipefail

binary=${1:?usage: cloud-unit-self-test.sh <terminalx-serve>}
user=tx-unit-probe
state=/var/lib/$user
# Outside /home: the sandbox closes it, as it does on a workspace.
installed=/opt/$user/terminalx-serve

id "$user" >/dev/null 2>&1 || sudo useradd --system --home-dir "$state" --shell /usr/sbin/nologin "$user"
sudo install -d -m 0700 -o "$user" -g "$user" "$state" "$state/probe" "$state/tmp"
sudo install -D -m 0755 "$binary" "$installed"

unit() {
    sudo systemd-run --wait --pipe --collect --quiet \
        -p User="$user" -p Group="$user" -p WorkingDirectory=/ \
        -p ProtectHome=true -p ProtectSystem=strict -p PrivateTmp=true \
        -p ReadWritePaths="$state" \
        -E HOME="$state" -E SHELL=/bin/bash -E TMPDIR="$state/tmp" -E PATH=/usr/local/bin:/usr/bin:/bin \
        "$@"
}

# The check proves nothing where systemd cannot apply the sandbox (a
# container without mount namespaces runs the unit unprotected, silently).
if unit /bin/ls /home >/dev/null 2>&1; then
    echo "::error::systemd did not close /home for the probe unit here; this check needs a host that applies ProtectHome"
    exit 1
fi

out=$(mktemp)
status=0
unit "$installed" --self-test --project-root "$state/probe" --data-dir "$state/probe" >"$out" 2>&1 || status=$?
cat "$out"
if [ "$status" -ne 0 ] || ! grep -q '"pty":"ok"' "$out"; then
    echo "::error::terminalx-serve did not pass its self-test under the cloud workspace unit's sandbox (exit $status)"
    exit 1
fi
