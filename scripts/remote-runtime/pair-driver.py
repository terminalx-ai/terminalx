#!/usr/bin/env python3
"""The person at the server in scripts/remote-runtime/e2e-install-linux.sh.

Runs `terminalx-serve pair` over `ssh -tt` in a pseudo-terminal of its own,
answers "y" to turning hosting on and "Local network" to where it listens, hands the printed code to the operating
computer (`install_e2e`, step `pair`), checks that the request names that
computer with the fingerprint, and answers "y" to Allow.

  pair-driver.py <code file> <ssh command...> -- <operating computer command...>

The code carries the device token, so it is written to <code file> only and
shown redacted.
"""
import os
import pty
import re
import select
import subprocess
import sys
import time

ANSI = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]")
CODE = re.compile(r"txm2\.[A-Za-z0-9_-]+")

code_file = sys.argv[1]
split = sys.argv.index("--")
ssh, computer = sys.argv[2:split], sys.argv[split + 1:]

pid, fd = pty.fork()
if pid == 0:
    os.execvp(ssh[0], ssh)

screen = b""


def text():
    return ANSI.sub(b"", screen).decode("utf-8", "replace").replace("\r", "")


def show(chunk):
    sys.stdout.write(CODE.sub("txm2.<redacted>", ANSI.sub(b"", chunk).decode("utf-8", "replace")))
    sys.stdout.flush()


consumed = 0


def wait_for(needle, seconds):
    """Wait until `needle` appears after what earlier waits matched; return
    the screen from there."""
    global screen, consumed
    deadline = time.time() + seconds
    while needle not in text()[consumed:]:
        left = deadline - time.time()
        if left <= 0:
            sys.exit(f"pair-driver: timed out waiting for {needle!r}")
        ready, _, _ = select.select([fd], [], [], min(left, 0.5))
        if ready:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                chunk = b""
            if not chunk:
                sys.exit(f"pair-driver: pair ended before {needle!r}")
            screen += chunk
            show(chunk)
    seen = text()[consumed:]
    consumed += seen.index(needle) + len(needle)
    return seen


def type_line(line):
    os.write(fd, line.encode() + b"\r")


wait_for("Let other computers operate this server? [y/N]", 60)
type_line("y")
# Where to listen (PRO-487): the server's private address, which the operating
# computer's container reaches. Nothing more is asked for that choice.
wait_for("Choice [1]:", 60)
type_line("3")
seen = wait_for("Waiting for a computer to pair", 60)
codes = CODE.findall(seen)
if not codes:
    sys.exit("pair-driver: no code was shown")
with open(code_file, "w") as out:
    out.write(codes[-1])
operating = subprocess.Popen(computer)
seen = wait_for("Allow? [y/N]", 120)
asking = [line for line in seen.splitlines() if "asks to operate this server" in line]
if not asking or "E2E Laptop" not in asking[-1] or "Fingerprint" not in asking[-1]:
    sys.exit(f"pair-driver: the request does not name the computer and its fingerprint: {asking}")
type_line("y")
wait_for("may now operate this server", 60)
if operating.wait(timeout=120) != 0:
    sys.exit("pair-driver: the operating computer did not pair")
_, status = os.waitpid(pid, 0)
if os.waitstatus_to_exitcode(status) != 0:
    sys.exit(f"pair-driver: pair exited with {os.waitstatus_to_exitcode(status)}")
print("pair-driver: paired")
