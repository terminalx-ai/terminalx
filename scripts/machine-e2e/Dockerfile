# The dev-server of the two-machine tests (PRO-358,
# src-tauri/serve/tests/machines_e2e.rs): a headless Linux machine that runs
# the terminalx-serve built on the CI runner. Nothing is copied in: the test
# bind-mounts the binary, scripts/remote-runtime (fake-claude) and its own
# temporary directories at the same paths, and runs the container as the
# runner's uid and gid.
#
# ubuntu:24.04 because the binary is built on CI's Linux runner (24.04): glibc
# 2.39 or newer, and OpenSSL 3 (libssl3t64), which native-tls links. python3
# runs fake-claude, git serves the project, procps gives the runtime `ps`.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 git libssl3t64 ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*
