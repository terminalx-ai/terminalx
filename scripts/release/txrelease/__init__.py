"""TerminalX desktop release pipeline: build, notarize, verify, scan and publish a macOS release.

Run it through ``scripts/release/release.py``; docs/RELEASING.md describes every step.
"""
import sys

# The oldest Python these scripts are tested on: the python3 that macOS ships (/usr/bin/python3) is 3.9.
MINIMUM_PYTHON = (3, 9)

if sys.version_info < MINIMUM_PYTHON:
    raise SystemExit(f'release: these scripts need Python {MINIMUM_PYTHON[0]}.{MINIMUM_PYTHON[1]} or newer; '
                     f'{sys.executable} is {sys.version.split()[0]}')
