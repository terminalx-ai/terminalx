# The Linux toolchain for scripts/remote-runtime/e2e-linux.sh (PRO-12): Rust to
# build terminalx-serve and its relay e2e, bun for the terminalx-saas relay
# harness, Redis for the relay registry and python3 for fake-claude. The GTK,
# WebKit and ALSA headers (the CI list) are only for the library's unit tests,
# whose dev-dependencies include Tauri; terminalx-serve itself links none.
ARG BUN_IMAGE=oven/bun:1.3.2
FROM ${BUN_IMAGE} AS bun

FROM rust:1-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends redis-server \
        libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libasound2-dev clang cmake \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ENV SHELL=/bin/bash
