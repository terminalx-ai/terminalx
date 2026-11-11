"""Running commands, and the JSON records each step leaves in the release directory."""
from __future__ import annotations

import datetime
import hashlib
import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Mapping, Sequence

from .config import ReleaseError


@dataclass
class Result:
    code: int
    output: str


@dataclass
class Runner:
    """Runs commands. A command marked ``mutates`` changes something outside this machine (a tag,
    a push, a GitHub release); in a dry run it is printed and not run, and reports success."""

    dry_run: bool = False
    mutations: list[list[str]] = field(default_factory=list)

    def run(self, args: Sequence[object], *, cwd: Path | None = None, env: Mapping[str, str] | None = None,
            check: bool = True, mutates: bool = False, log: IO[str] | None = None) -> Result:
        argv = [str(a) for a in args]
        if mutates:
            self.mutations.append(argv)
            if self.dry_run:
                print('[dry run] would run: ' + ' '.join(argv), flush=True)
                return Result(0, '')
        result = self.execute(argv, cwd=cwd, env=env, log=log)
        if check and result.code:
            raise ReleaseError(f'{" ".join(argv[:2])} exited {result.code}: {result.output[-2000:]}')
        return result

    def execute(self, argv: list[str], *, cwd: Path | None, env: Mapping[str, str] | None, log: IO[str] | None) -> Result:
        if log is not None:
            completed = subprocess.run(argv, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, text=True)
            return Result(completed.returncode, '')
        completed = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True)
        return Result(completed.returncode, (completed.stdout + completed.stderr).strip())

    def out(self, *args: object, **kwargs) -> str:
        return self.run(args, **kwargs).output


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def read_record(path: Path, step: str) -> dict:
    """A record another step wrote. Missing means that step has not run (or not passed)."""
    if not path.is_file():
        raise ReleaseError(f'{path.name} is missing: run the {step} step first')
    return json.loads(path.read_text())


def require(condition: object, message: str) -> None:
    if not condition:
        raise ReleaseError(message)
