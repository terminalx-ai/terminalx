import { test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync, copyFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { buildPlan } from './build-terminalx-launcher.mjs'

const host = 'aarch64-apple-darwin'
test('full target wins over host ABI and cross-platform overlays keep their own installers', () => {
  expect(buildPlan([], { CARGO_BUILD_TARGET: 'x86_64-unknown-linux-musl', TAURI_ENV_PLATFORM: 'linux', TAURI_ENV_ARCH: 'x86_64' }, 'x86_64-unknown-linux-gnu')).toMatchObject({ target: 'x86_64-unknown-linux-musl', skip: true })
  expect(buildPlan([], { TAURI_ENV_TARGET_TRIPLE: 'x86_64-pc-windows-msvc', TAURI_ENV_PLATFORM: 'windows' }, host).skip).toBe(true)
  expect(buildPlan(['--target', 'x86_64-apple-darwin'], {}, host).targets).toEqual(['x86_64-apple-darwin'])
})
test('universal plans both slices and debug profile follows Tauri', () => {
  expect(buildPlan([], { TAURI_ENV_TARGET_TRIPLE: 'universal-apple-darwin', TAURI_ENV_ARCH: 'universal', TAURI_ENV_DEBUG: 'true' }, host)).toMatchObject({ targets: [host, 'x86_64-apple-darwin'], debug: true, skip: false })
  expect(() => buildPlan(['--dev'], { TAURI_ENV_DEBUG: 'false' }, host)).toThrow(/profile/)
  expect(() => buildPlan([], { TAURI_ENV_DEBUG: 'other' }, host)).toThrow(/profile/)
})
test('reject target mismatches and malformed flags before generating any executable', () => {
  for (const env of [{ TAURI_ENV_ARCH: 'x86_64' }, { TAURI_ENV_PLATFORM: 'linux' }, { TAURI_ENV_TARGET_TRIPLE: 'wasm32-unknown-unknown' }]) {
    expect(() => buildPlan(['--target', host], env, host)).toThrow()
  }
  for (const args of [['--target'], ['--profile', 'release'], ['--other']]) expect(() => buildPlan(args, {}, host)).toThrow()
})

const nativeTest = process.platform === 'win32' ? test.skip : test
let directory, launcher
beforeAll(() => {
  if (process.platform === 'win32') return
  directory = mkdtempSync(path.join(tmpdir(), 'tx467-launcher-test-'))
  launcher = path.join(directory, 'terminalx')
  const result = spawnSync('rustc', ['--edition=2021', 'native/terminalx-launcher/main.rs', '-o', launcher], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  writeFileSync(path.join(directory, 'raccoon'), '#!/usr/bin/python3\nimport os,sys,json,signal,time\nif sys.argv[-1]=="signal":\n print(os.getpid(),flush=True)\n time.sleep(30)\nelse:\n print(json.dumps({"argv":sys.argv[1:],"cwd":os.getcwd(),"env":os.environ.get("TX467_TEST"),"input":sys.stdin.read(),"pid":os.getpid()}))\n print("fixture-stderr",file=sys.stderr)\n sys.exit(23)\n', { mode: 0o755 })
}, 15000)
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })
nativeTest('exec preserves argv, stdin/out/err, cwd, environment and exit code through a symlink', () => {
  const link = path.join(directory, 'symlink with spaces')
  symlinkSync(launcher, link)
  const result = spawnSync(link, ['', 'spaces and "quotes"', '$literal', 'λ'], { cwd: tmpdir(), input: 'fixture stdin\n', env: { ...process.env, TX467_TEST: 'sentinel' }, encoding: 'utf8' })
  expect(result.status).toBe(23)
  expect(result.stderr).toBe('fixture-stderr\n')
  expect(JSON.parse(result.stdout)).toMatchObject({ argv: ['terminalx', '', 'spaces and "quotes"', '$literal', 'λ'], env: 'sentinel', input: 'fixture stdin\n' })
  // macOS normalizes /var to /private/var; compare real paths separately.
  expect(JSON.parse(result.stdout).cwd).toBe(realpathSync(tmpdir()))
})
nativeTest('exec retains PID and signal termination rather than leaving a forwarding parent', async () => {
  const child = spawn(launcher, ['signal'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const exit = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))
  try {
    const pid = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture readiness timeout')), 5000)
      child.stdout.once('data', data => { clearTimeout(timer); resolve(Number(data.toString().trim())) })
      child.once('error', reject)
    })
    expect(pid).toBe(child.pid)
    child.kill('SIGTERM')
    expect(await exit).toEqual({ code: null, signal: 'SIGTERM' })
  } finally { child.kill('SIGKILL'); await exit }
})
nativeTest('missing and non-executable sibling fail explicitly with shell-compatible exit codes', () => {
  const isolated = mkdtempSync(path.join(directory, 'missing-'))
  const copy = path.join(isolated, 'terminalx'); copyFileSync(launcher, copy); chmodSync(copy, 0o755)
  const missing = spawnSync(copy, [], { encoding: 'utf8' })
  expect(missing.status).toBe(127); expect(missing.stderr).toMatch(/cannot execute sibling raccoon/)
  writeFileSync(path.join(isolated, 'raccoon'), 'not executable', { mode: 0o600 })
  expect(spawnSync(copy).status).toBe(126)
})

nativeTest('non-UTF8 Unix arguments and environment reach the CLI without lossy conversion', () => {
  const bridge = path.join(directory, 'raw-argv.py')
  writeFileSync(bridge, 'import os,sys\nos.environb[b"TX467_TEST"]=bytes([254])\nos.execv(os.fsencode(sys.argv[1]),[b"terminalx",bytes([255])])\n')
  const result = spawnSync('/usr/bin/python3', [bridge, launcher], { encoding: 'utf8', input: '' })
  expect(result.status).toBe(23)
  expect(JSON.parse(result.stdout)).toMatchObject({ argv: ['terminalx', '\udcff'], env: '\udcfe' })
})
