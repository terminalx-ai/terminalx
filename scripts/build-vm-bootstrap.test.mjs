import { test, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { build, parseCodesign, requireSigned, sha256, signArguments, signingIdentity, teamOf, BINARIES, IDENTIFIERS, PLISTS } from './build-vm-bootstrap.mjs'

const IDENTITY = 'Developer ID Application: Example Maker (ABCDE12345)'
// As `codesign -d --verbose=4` reports a Developer ID signature with the hardened runtime.
const signedReport = (changes = {}) => {
  const fields = { Identifier: 'com.terminalx.next.vm-bootstrap', flags: 'flags=0x10000(runtime)', Authority: IDENTITY,
    TeamIdentifier: 'ABCDE12345', Timestamp: 'Nov 15, 2026 at 5:00:00 PM', ...changes }
  return [`Executable=/x/terminalx-vm-bootstrap`, fields.Identifier === null ? null : `Identifier=${fields.Identifier}`,
    `CodeDirectory v=20500 size=1 ${fields.flags} hashes=1+7 location=embedded`,
    fields.Authority === null ? null : `Authority=${fields.Authority}`, 'Authority=Developer ID Certification Authority', 'Authority=Apple Root CA',
    fields.Timestamp === null ? null : `Timestamp=${fields.Timestamp}`, `TeamIdentifier=${fields.TeamIdentifier}`, ''].filter(l => l !== null).join('\n')
}

test('codesign reports are read as ad hoc or Developer ID without guessing', () => {
  expect(parseCodesign('Executable=/x\nCodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0\nSignature=adhoc\nTeamIdentifier=not set\n'))
    .toEqual({ signature: 'adhoc', teamIdentifier: null, flags: 'adhoc,linker-signed', developerId: false })
  expect(parseCodesign('CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+7\nAuthority=Developer ID Application: Example (ABCDE12345)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=ABCDE12345\n'))
    .toEqual({ signature: 'Developer ID Application: Example (ABCDE12345)', teamIdentifier: 'ABCDE12345', flags: 'runtime', developerId: true })
  expect(parseCodesign('/x: code object is not signed at all\n')).toEqual({ signature: null, teamIdentifier: null, flags: null, developerId: false })
})

test('signing takes only the release identity it is handed, and asks for the runtime, a timestamp and the fixed identifier', () => {
  expect(signingIdentity({ APPLE_SIGNING_IDENTITY: ` ${IDENTITY}\n` })).toBe(IDENTITY)
  expect(teamOf(IDENTITY)).toBe('ABCDE12345')
  for (const named of [undefined, '', '-', 'Apple Development: Example Maker (ABCDE12345)', 'Developer ID Application: Example Maker',
    'Developer ID Application: Example Maker (abcde12345)', 'Developer ID Installer: Example Maker (ABCDE12345)', `"${IDENTITY}"`]) {
    expect(() => signingIdentity({ APPLE_SIGNING_IDENTITY: named }), String(named)).toThrow(/release identity in APPLE_SIGNING_IDENTITY.*release\.py vm-bootstrap/)
  }
  expect(signArguments(IDENTITY, 'terminalx-vm-seed', '/out/terminalx-vm-seed')).toEqual(['--force', '--sign', IDENTITY,
    '--options', 'runtime', '--timestamp', '--identifier', 'com.terminalx.next.vm-seed', '/out/terminalx-vm-seed'])
  expect(Object.keys(IDENTIFIERS)).toEqual(BINARIES)
  expect(new Set(Object.values(IDENTIFIERS)).size).toBe(BINARIES.length)
  // The helper and the probe are identified by their launchd labels, the plists' names.
  expect(PLISTS).toEqual([`${IDENTIFIERS['terminalx-vm-bootstrap']}.plist`, `${IDENTIFIERS['terminalx-vm-validation-probe']}.plist`])
  // An identity that is not the release's form signs nothing, and nothing is built for it.
  expect(() => build('/nonexistent/never-created', { identity: '-' })).toThrow(/Developer ID Application identity is required/)
})

test('a signed executable must report exactly the release identity, team, identifier, runtime and timestamp', () => {
  expect(requireSigned(signedReport(), IDENTITY, 'terminalx-vm-bootstrap'))
    .toEqual({ signature: IDENTITY, teamIdentifier: 'ABCDE12345', flags: 'runtime', developerId: true })
  const refused = [
    [{ Authority: 'Developer ID Application: Another Maker (ZYXWV98765)', TeamIdentifier: 'ZYXWV98765' }, /not signed by the release identity, has team ZYXWV98765/],
    [{ TeamIdentifier: 'ZYXWV98765' }, /has team ZYXWV98765/],
    [{ Authority: null }, /not signed by the release identity/],
    [{ Identifier: 'terminalx_vm_bootstrap-5555' }, /is not identified as com\.terminalx\.next\.vm-bootstrap/],
    [{ flags: 'flags=0x0(none)' }, /lacks the hardened runtime/],
    [{ flags: 'flags=0x2(adhoc)' }, /lacks the hardened runtime/],
    [{ Timestamp: null }, /has no secure timestamp/],
  ]
  for (const [change, message] of refused) expect(() => requireSigned(signedReport(change), IDENTITY, 'terminalx-vm-bootstrap'), JSON.stringify(change)).toThrow(message)
  // The linker's own signature is none of these.
  expect(() => requireSigned('Identifier=terminalx_vm_bootstrap-5555\nCodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0\nSignature=adhoc\nTeamIdentifier=not set\n',
    IDENTITY, 'terminalx-vm-bootstrap')).toThrow(/not signed by the release identity, has team none.*lacks the hardened runtime, has no secure timestamp/)
  // The report for one executable does not pass for another.
  expect(() => requireSigned(signedReport(), IDENTITY, 'terminalx-vm-seed')).toThrow(/is not identified as com\.terminalx\.next\.vm-seed/)
})

test('the command line refuses --sign without the release identity before it builds anything', () => {
  const script = path.join(import.meta.dirname, 'build-vm-bootstrap.mjs')
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'tx-vm-bootstrap-cli-')), 'out')
  try {
    const env = { ...process.env }
    delete env.APPLE_SIGNING_IDENTITY
    for (const [args, identity, message] of [
      [[out, '--sign'], undefined, /release identity in APPLE_SIGNING_IDENTITY/],
      [['--sign', out], '-', /release identity in APPLE_SIGNING_IDENTITY/],
      [[out, '--sign', 'extra'], IDENTITY, /usage: build-vm-bootstrap\.mjs <new-output-directory> \[--sign\]/],
      [['--notarize', out], undefined, /usage:/],
      [[], undefined, /usage:/],
    ]) {
      const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: identity === undefined ? env : { ...env, APPLE_SIGNING_IDENTITY: identity } })
      expect(result.status, args.join(' ')).toBe(1)
      expect(result.stderr, args.join(' ')).toMatch(message)
      expect(() => readFileSync(path.join(out, 'manifest.json')), args.join(' ')).toThrow()
    }
  } finally { rmSync(path.dirname(out), { recursive: true, force: true }) }
})

// A full offline release build; run with `pnpm test:vm-bootstrap`.
test.skipIf(process.platform !== 'darwin' || process.env.TX_VM_BOOTSTRAP_BUILD !== '1')('release build is arm64, ad hoc only and matches its manifest', () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'tx-vm-bootstrap-')), 'out')
  try {
    const manifest = build(out)
    expect(manifest.artifacts.map(a => a.name)).toEqual([...BINARIES, ...PLISTS])
    for (const artifact of manifest.artifacts) expect(sha256(readFileSync(artifact.path))).toBe(artifact.sha256)
    for (const artifact of manifest.artifacts.slice(0, BINARIES.length)) {
      expect(artifact.archs).toBe('arm64')
      expect(artifact.signing).toMatchObject({ signature: 'adhoc', teamIdentifier: null, developerId: false })
    }
    expect(manifest).toMatchObject({ developerIdSigned: false, notarized: false, target: 'aarch64-apple-darwin' })
    expect(manifest.signingTeam).toBeUndefined()
    expect(manifest.note).toMatch(/^Built only\. Not Developer ID signed/)
    expect(() => build(out)).toThrow(/new or empty/)
  } finally { rmSync(path.dirname(out), { recursive: true, force: true }) }
}, 600000)

// The same build, signed with the release identity. It runs only where that
// identity is: `TX_VM_BOOTSTRAP_SIGN=1` with APPLE_SIGNING_IDENTITY set, as
// `scripts/release/release.py vm-bootstrap` sets it. It uses the keychain's
// key and Apple's timestamp service, so it is never part of an ordinary run.
test.skipIf(process.platform !== 'darwin' || process.env.TX_VM_BOOTSTRAP_SIGN !== '1' || !process.env.APPLE_SIGNING_IDENTITY)('signed build carries the release identity, runtime, timestamp and identifiers, and its manifest says so', () => {
  const identity = signingIdentity(process.env)
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'tx-vm-bootstrap-signed-')), 'out')
  try {
    const manifest = build(out, { identity })
    for (const artifact of manifest.artifacts.slice(0, BINARIES.length)) {
      expect(sha256(readFileSync(artifact.path))).toBe(artifact.sha256)
      expect(artifact.sha256).not.toBe(artifact.unsigned.sha256)
      expect(artifact).toMatchObject({ archs: 'arm64', identifier: IDENTIFIERS[artifact.name],
        signing: { signature: identity, teamIdentifier: teamOf(identity), developerId: true } })
      expect(spawnSync('codesign', ['--verify', '--strict', artifact.path]).status).toBe(0)
      const report = spawnSync('codesign', ['-d', '--verbose=4', artifact.path], { encoding: 'utf8' }).stderr
      expect(requireSigned(report, identity, artifact.name)).toEqual(artifact.signing)
    }
    expect(manifest).toMatchObject({ developerIdSigned: true, signingTeam: teamOf(identity), notarized: false })
    expect(manifest.note).toMatch(/^Developer ID signed.*Not notarized/)
  } finally { rmSync(path.dirname(out), { recursive: true, force: true }) }
}, 600000)
