import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { test } from 'vitest'
import { helperBundleId, legacyHelperBundleIds } from './computer-macos-identity.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..')

test('the helper is built under a new id, never an old one', () => {
  assert.equal(helperBundleId({ dev: false }), 'com.terminalx.next.computer-use.v2')
  assert.equal(helperBundleId({ dev: true }), 'com.terminalx.next.dev.computer-use.v2')
  assert.equal(helperBundleId({ dev: true, override: 'dev.terminalx.smoke-a.computer-use' }), 'dev.terminalx.smoke-a.computer-use')
  for (const legacy of legacyHelperBundleIds) {
    assert.ok(!legacyHelperBundleIds.includes(helperBundleId({ dev: legacy.includes('.dev.') })))
    assert.throws(() => helperBundleId({ dev: false, override: legacy }), /must not be built again/)
    assert.throws(() => helperBundleId({ dev: false, override: legacy.toUpperCase() }), /must not be built again/)
  }
})

test('the app clears exactly the ids the build script retired', () => {
  const rust = readFileSync(path.join(repoRoot, 'src-tauri/src/computer/permissions.rs'), 'utf8')
  const declared = rust.match(/LEGACY_HELPER_BUNDLE_IDS: \[&str; 2\] = \[([^\]]+)\]/)?.[1]
  assert.ok(declared, 'LEGACY_HELPER_BUNDLE_IDS not found')
  assert.deepEqual(declared.split(',').map((id) => id.trim().replaceAll('"', '')), legacyHelperBundleIds)
})

test('the build script verifies the assembled bundle and no other file names an old id as current', () => {
  const script = readFileSync(path.join(repoRoot, 'scripts/build-computer-macos.mjs'), 'utf8')
  assert.match(script, /rmSync\(appPath, \{ recursive: true, force: true \}\)/)
  assert.match(script, /legacyHelperBundleIds\.includes\(builtId\)/)
  assert.doesNotMatch(script, /'com\.terminalx\.next(\.dev)?\.computer-use'/)
})

test('an old helper id appears only in the reset code, its tests and the docs', () => {
  // The old ids, not followed by the new suffix.
  const old = /com\.terminalx\.next(\.dev)?\.computer-use(?!\.v2)(?![\w-])/i
  const allowed = new Set([
    'scripts/computer-macos-identity.mjs',
    'scripts/computer-macos-identity.test.mjs',
    'src-tauri/src/computer/permissions.rs',
    'src/components/settings/ComputerUseSettings.test.tsx',
    'docs/COMPUTER-USE.md',
    'skill-guides/computer-use.md',
    'skill-guides/terminalx-cli.md',
  ])
  const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
  const offenders = tracked.filter((file) => {
    if (allowed.has(file) || /\.(png|jpe?g|gif|icns|ico|woff2?|ttf|pdf|wasm|lock)$/i.test(file)) return false
    let text
    try {
      text = readFileSync(path.join(repoRoot, file), 'utf8')
    } catch {
      return false
    }
    return old.test(text)
  })
  assert.deepEqual(offenders, [])
  // The pattern does catch an old id and does not catch a new one.
  assert.ok(old.test('id com.terminalx.next.computer-use here'))
  assert.ok(old.test('com.terminalx.next.dev.computer-use'))
  assert.ok(!old.test('com.terminalx.next.computer-use.v2'))
  assert.ok(!old.test('com.terminalx.next.dev.computer-use.v2'))
})
