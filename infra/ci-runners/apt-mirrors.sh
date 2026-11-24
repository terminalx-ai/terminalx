#!/usr/bin/env bash
# Points apt at the Azure mirror of the Ubuntu archive, with archive.ubuntu.com
# behind it, before a CI job installs packages. Run as root on a hosted runner.
#
# The runner image's sources read their mirror from /etc/apt/apt-mirrors.txt.
# On a runner in an AWS region that file names the EC2 mirror, which served
# 91 MB in 23 to 25 minutes (64 kB/s) where the Azure mirror took 5 s for the
# same files in the same run (docs/CI-RUNNERS-MEASUREMENTS.md). apt leaves a
# mirror only on an error, never for being slow, so no retry or stall limit
# helped. Every mirror serves the same signed archive, and apt checks what it
# downloads against that signature as before.
set -euo pipefail

mirrors=/etc/apt/apt-mirrors.txt
if ! [ -f "$mirrors" ]; then
  echo "no $mirrors on this runner: apt's sources are left as they are"
  exit 0
fi
echo "$mirrors was:"
cat "$mirrors"
printf '%s\tpriority:1\n%s\tpriority:2\n' http://azure.archive.ubuntu.com/ubuntu/ http://archive.ubuntu.com/ubuntu/ > "$mirrors"
echo "$mirrors is now:"
cat "$mirrors"
