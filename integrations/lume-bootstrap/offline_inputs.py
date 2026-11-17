#!/usr/bin/env python3
"""Read-only preflight. Never runs SwiftPM, fetches, resolves or installs inputs."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
SOURCE = '3350f504014c85416009a90fcb339fe556ce02fc'
LOCK_SHA = 'b954aab87b35bfa16422dad4563abfd4d4d61df0d45e62d084923fa22246465b'

def git(path, *args):
    result = subprocess.run(['git', '-C', str(path), *args], stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True)
    return result.stdout.strip() if result.returncode == 0 else None

def inspect(source, caches):
    raw = (HERE / 'Upstream.Package.resolved').read_bytes()
    if hashlib.sha256(raw).hexdigest() != LOCK_SHA:
        raise ValueError('Exact upstream lockfile changed')
    lock = json.loads(raw)
    missing_files = [name for name in ['Package.resolved', 'Sources/CZlib/module.modulemap',
                     'src/Resources/unattended-presets', 'tests'] if not (source / name).exists()]
    source_head = git(source, 'rev-parse', 'HEAD')
    clean = git(source, 'status', '--porcelain', '--untracked-files=no') == ''
    source_verified = source_head == SOURCE and clean and not missing_files
    if (source / 'Package.resolved').is_file():
        source_verified = source_verified and (source / 'Package.resolved').read_bytes() == raw
    # Only explicit standard cache/checkouts roots are inspected. A manifest
    # cache or similarly named directory does not establish a pinned revision.
    repositories = []
    for root in caches:
        for location in [root, root/'repositories', root/'checkouts', root/'SourcePackages/checkouts']:
            if location.is_dir():
                repositories.extend(p for p in location.iterdir() if p.is_dir())
    dependencies = []
    for pin in lock['pins']:
        revision = pin['state']['revision']
        matches = []
        for repository in repositories:
            if git(repository, 'rev-parse', '--verify', revision + '^{commit}') == revision:
                matches.append(str(repository))
        dependencies.append({'identity': pin['identity'], 'location': pin['location'],
                             'revision': revision, 'availableRepositories': matches,
                             'missing': not matches})
    return {'sourceCommit': SOURCE, 'observedSourceHead': source_head,
            'sourcePath': str(source), 'fullExactSourceAvailable': source_verified,
            'missingSourcePaths': missing_files, 'upstreamLockSha256': LOCK_SHA,
            'cacheRootsChecked': [str(p) for p in caches], 'dependencies': dependencies,
            'missingPinnedDependencyCount': sum(d['missing'] for d in dependencies),
            'offlineInputsComplete': source_verified and all(not d['missing'] for d in dependencies),
            'fullUpstreamBuildAttempted': False, 'fullUpstreamBuildVerified': False,
            'packagesResolvedOrInstalled': False,
            'note': 'Presence is only preflight evidence, never a build result. Missing inputs are not fetched.'}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path, help='Exact libs/lume source directory')
    parser.add_argument('--cache', action='append', type=Path)
    args = parser.parse_args()
    caches = args.cache or [Path.home()/'.swiftpm/cache', Path.home()/'Library/Caches/org.swift.swiftpm',
                            args.source/'.build']
    print(json.dumps(inspect(args.source, caches), indent=2))
