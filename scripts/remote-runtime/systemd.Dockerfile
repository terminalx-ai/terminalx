# A fresh Ubuntu 24.04 server for scripts/remote-runtime/e2e-install-linux.sh
# (PRO-353): systemd as PID 1, so an SSH login, a user service, lingering and
# a reboot (`docker restart`) behave as on a real machine. Only what a stock
# Ubuntu server image has (OpenSSH, curl, git), plus python3 for fake-claude
# and the test's HTTP server and terminal driver. The person installing is
# `tester`, with no sudo: the installer must not need root. The same image,
# run without systemd, is the operating computer.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        systemd systemd-sysv dbus dbus-user-session libpam-systemd polkitd \
        openssh-server openssh-client ca-certificates curl python3 git procps \
    && rm -rf /var/lib/apt/lists/* \
    && find /etc/systemd/system /lib/systemd/system -path '*.wants/*' \
        \( -name '*getty*' -o -name '*udev*' -o -name 'systemd-timesyncd*' \) -delete \
    && systemctl enable ssh.service \
    && useradd --create-home --shell /bin/bash tester
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
