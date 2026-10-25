import assert from 'node:assert/strict'
import { test } from 'vitest'
import { buildPlan, cargoArtifact } from './build-local-runtime.mjs'

const host = 'aarch64-apple-darwin'

test('Tauri target and debug mode override host build defaults', () => {
  const plan = buildPlan([], { TAURI_ENV_ARCH: 'x86_64', TAURI_ENV_PLATFORM: 'darwin', TAURI_ENV_DEBUG: 'true' }, host)
  assert.deepEqual(plan.targets, ['x86_64-apple-darwin'])
  assert.equal(plan.profile, 'dev')
  assert.throws(() => buildPlan(['--target', host], { TAURI_ENV_ARCH: 'x86_64', TAURI_ENV_PLATFORM: 'darwin' }, host), /match the Tauri target/)
})

test('universal builds require both slices and explicit custom profiles survive', () => {
  const plan = buildPlan(['--target', 'universal-apple-darwin', '--profile', 'test-runtime'], {}, host)
  assert.deepEqual(plan.targets, [host, 'x86_64-apple-darwin'])
  assert.equal(plan.profile, 'test-runtime')
  assert.throws(() => buildPlan(['--profile', 'test-runtime'], { TAURI_ENV_DEBUG: 'false' }, host), /match the Tauri build profile/)
})

test('production cannot silently fall back to an ad-hoc signature', () => {
  assert.throws(() => buildPlan([], { TERMINALX_MAC_RELEASE: '1' }, host), /ad-hoc/)
  assert.equal(buildPlan([], { TERMINALX_MAC_RELEASE: '1', APPLE_SIGNING_IDENTITY: 'fixture-certificate' }, host).identity, 'fixture-certificate')
  assert.match(buildPlan(['--dev'], {}, host).identifier, /\.dev\./)
})

test('reject unsupported targets and malformed options rather than packaging the host binary', () => {
  assert.throws(() => buildPlan([], { TAURI_ENV_PLATFORM: 'win32', TAURI_ENV_ARCH: 'x86_64' }, host), /not supported/)
  assert.throws(() => buildPlan(['--dev'], { TAURI_ENV_DEBUG: 'false' }, host), /match the Tauri build profile/)
  assert.throws(() => buildPlan([], { TAURI_ENV_DEBUG: 'unexpected' }, host), /Unrecognized/)

  for (const args of [['--target', 'x86_64-pc-windows-msvc'], ['--profile'], ['--unknown'], ['--profile', '../release']]) {
    assert.throws(() => buildPlan(args, {}, host))
  }
})

test('artifact selection uses the actual Cargo executable including custom target directories', () => {
  const artifact = { reason: 'compiler-artifact', target: { name: 'terminalx-serve' }, executable: '/private/custom/debug/terminalx-serve' }
  assert.equal(cargoArtifact([JSON.stringify({ reason: 'build-finished', success: true }), JSON.stringify(artifact)].join('\n')), artifact.executable)
  assert.throws(() => cargoArtifact(''), /exactly one/)
  assert.throws(() => cargoArtifact([JSON.stringify(artifact), JSON.stringify(artifact)].join('\n')), /exactly one/)
})

test('Linux desktop hooks select their actual target without Apple signing', () => {
  for (const target of ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-musl']) {
    const plan = buildPlan([], { TAURI_ENV_PLATFORM: 'linux', TAURI_ENV_ARCH: target.split('-')[0], TAURI_ENV_DEBUG: 'true' }, target)
    assert.deepEqual(plan.targets, [target])
    assert.equal(plan.profile, 'dev')
    assert.equal(plan.macos, false)
  }
  assert.throws(() => buildPlan(['--target', host], { TAURI_ENV_PLATFORM: 'linux', TAURI_ENV_ARCH: 'x86_64' }, 'x86_64-unknown-linux-gnu'), /match the Tauri target/)
})


test('full targets preserve a requested musl ABI on a GNU host', () => {
  const gnu = 'x86_64-unknown-linux-gnu'
  const musl = 'x86_64-unknown-linux-musl'
  const dimensions = { TAURI_ENV_PLATFORM: 'linux', TAURI_ENV_ARCH: 'x86_64' }
  for (const [args, env] of [
    [[], { ...dimensions, CARGO_BUILD_TARGET: musl }],
    [['--target', musl], dimensions],
    [['--target', musl], { ...dimensions, CARGO_BUILD_TARGET: gnu }],
    [[], { ...dimensions, TAURI_ENV_TARGET_TRIPLE: musl, CARGO_BUILD_TARGET: gnu }],
  ]) assert.deepEqual(buildPlan(args, env, gnu).targets, [musl])
  assert.throws(() => buildPlan(['--target', gnu], { ...dimensions, TAURI_ENV_TARGET_TRIPLE: musl }, gnu), /match the Tauri target/)
  assert.deepEqual(buildPlan([], dimensions, gnu).targets, [gnu])
  assert.deepEqual(buildPlan([], dimensions, musl).targets, [musl])
})

test('full targets must independently match the Tauri architecture and platform', () => {
  for (const target of ['aarch64-unknown-linux-musl', 'x86_64-apple-darwin']) {
    const dimensions = { TAURI_ENV_PLATFORM: 'linux', TAURI_ENV_ARCH: 'x86_64' }
    for (const [args, env] of [
      [['--target', target], dimensions],
      [[], { ...dimensions, CARGO_BUILD_TARGET: target }],
      [[], { ...dimensions, TAURI_ENV_TARGET_TRIPLE: target }],
    ]) assert.throws(() => buildPlan(args, env, 'x86_64-unknown-linux-gnu'), /match the Tauri target/)
  }
  assert.deepEqual(buildPlan([], { TAURI_ENV_TARGET_TRIPLE: 'universal-apple-darwin', TAURI_ENV_ARCH: 'universal', TAURI_ENV_PLATFORM: 'darwin' }, host).targets, [host, 'x86_64-apple-darwin'])
})
