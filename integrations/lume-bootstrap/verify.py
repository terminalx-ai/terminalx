#!/usr/bin/env python3
"""Offline checks only: apply to disposable source, parse/typecheck, fixture IPC.

No swift package resolve/build, dependency install, VM or profile activation.
"""
from pathlib import Path
import argparse
import json
import os
import shutil
import subprocess
import tempfile
from make_patch import HERE, PINS, render

def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',required=True,type=Path,help='Read-only exact libs/lume source root')
    args=parser.parse_args()
    assert render(args.source)==(HERE/'bootstrap.patch').read_text(), 'Regenerate candidate after source edits'
    env=dict(os.environ);env.pop('LIBRARY_PATH',None)
    with tempfile.TemporaryDirectory(prefix='tx-lume-source-',dir='/private/tmp') as temp:
        root=Path(temp);candidate=root/'libs/lume'
        for name in PINS:
            target=candidate/name;target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(args.source/name,target)
        run('git','apply','--check',str(HERE/'bootstrap.patch'),cwd=root)
        run('git','apply',str(HERE/'bootstrap.patch'),cwd=root)
        changed=[candidate/n for n in PINS if n!='Package.swift']
        sources=sorted((candidate/'src/TerminalXBootstrap').glob('*.swift'))
        run('swiftc','-frontend','-parse',*map(str,changed+sources),env=env)
        run('swiftc','-swift-version','6','-warnings-as-errors','-typecheck',*map(str,sources),str(HERE/'Tests/TypecheckStubs.swift'),env=env)
        binary=root/'protocol-fixture'
        run('swiftc','-swift-version','6','-warnings-as-errors','-D','TERMINALX_BOOTSTRAP_FIXTURES',*map(str,sources),str(HERE/'Tests/Main.swift'),'-o',str(binary),env=env)
        run('python3',str(HERE/'Tests/protocol_test.py'),str(binary),env=env)
    print(json.dumps({'patchAppliesToPinnedSource':True,'patchedSwiftParsed':True,'ownerAndAppleAdapterTypechecked':True,'nativeProtocolFixtures':'passed','fullUpstreamBuildVerified':False,'profileInstalled':False,'consoleEnabled':False,'liveAcceptanceVerified':False}))

if __name__=='__main__':main()
