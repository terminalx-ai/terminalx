import { test, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build, parseCodesign, sha256, BINARIES, PLIST } from './build-vm-bootstrap.mjs'

test('codesign reports are read as ad hoc or Developer ID without guessing', () => {
  expect(parseCodesign('Executable=/x\nCodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0\nSignature=adhoc\nTeamIdentifier=not set\n'))
    .toEqual({ signature: 'adhoc', teamIdentifier: null, flags: 'adhoc,linker-signed', developerId: false })
  expect(parseCodesign('CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+7\nAuthority=Developer ID Application: Example (ABCDE12345)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=ABCDE12345\n'))
    .toEqual({ signature: 'Developer ID Application: Example (ABCDE12345)', teamIdentifier: 'ABCDE12345', flags: 'runtime', developerId: true })
  expect(parseCodesign('/x: code object is not signed at all\n')).toEqual({ signature: null, teamIdentifier: null, flags: null, developerId: false })
})

// A full offline release build; run with `pnpm test:vm-bootstrap`.
test.skipIf(process.platform !== 'darwin' || process.env.TX_VM_BOOTSTRAP_BUILD !== '1')('release build is arm64, ad hoc only and matches its manifest', () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'tx-vm-bootstrap-')), 'out')
  try {
    const manifest = build(out)
    expect(manifest.artifacts.map(a => a.name)).toEqual([...BINARIES, PLIST])
    for (const artifact of manifest.artifacts) expect(sha256(readFileSync(artifact.path))).toBe(artifact.sha256)
    for (const artifact of manifest.artifacts.slice(0, 2)) {
      expect(artifact.archs).toBe('arm64')
      expect(artifact.signing).toMatchObject({ signature: 'adhoc', teamIdentifier: null, developerId: false })
    }
    expect(manifest).toMatchObject({ developerIdSigned: false, notarized: false, target: 'aarch64-apple-darwin' })
    expect(() => build(out)).toThrow(/new or empty/)
  } finally { rmSync(path.dirname(out), { recursive: true, force: true }) }
}, 600000)
