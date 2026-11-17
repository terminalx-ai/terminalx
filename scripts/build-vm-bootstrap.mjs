#!/usr/bin/env node
// Builds the macOS VM guest helper, validation probe and seed tool
// (native/vm-bootstrap) for arm64, offline from the locked crates, and writes a
// manifest of digests and signing state.
//
// Without `--sign` the artifacts carry only the linker's ad hoc signature and
// the manifest says so. With it they are signed with the TerminalX release's
// Developer ID Application identity, hardened runtime and a secure timestamp.
// That identity is the release's own, and this script never looks one up: it
// takes it from APPLE_SIGNING_IDENTITY, which the release flow sets from its
// one resolver (scripts/release/txrelease/credentials.py) exactly as it does
// for the app build. Run a signed build through
//   python3 -I scripts/release/release.py vm-bootstrap <new-output-directory>
// which also checks the result. No key, certificate or password is read here
// or kept in the repository; codesign uses the keychain. Nothing is notarized.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(import.meta.dirname, '..')
const crate = path.join(root, 'native/vm-bootstrap')
const target = 'aarch64-apple-darwin'
export const BINARIES = ['terminalx-vm-bootstrap', 'terminalx-vm-validation-probe', 'terminalx-vm-seed']
export const PLISTS = ['com.terminalx.next.vm-bootstrap.plist', 'com.terminalx.next.vm-validation-probe.plist']
// Each executable's code signing identifier: with the team, its designated
// requirement. The helper's and the probe's are their launchd labels.
export const IDENTIFIERS = {
  'terminalx-vm-bootstrap': 'com.terminalx.next.vm-bootstrap',
  'terminalx-vm-validation-probe': 'com.terminalx.next.vm-validation-probe',
  'terminalx-vm-seed': 'com.terminalx.next.vm-seed',
}
const IDENTITY = /^Developer ID Application: [^"]+ \(([A-Z0-9]{10})\)$/

// The release identity as the release flow hands it over. The same form
// scripts/release/txrelease/credentials.py requires; anything else, an ad hoc
// `-` included, is refused before anything is built.
export function signingIdentity(env) {
  const named = (env.APPLE_SIGNING_IDENTITY ?? '').trim()
  if (!IDENTITY.test(named)) {
    throw new Error('--sign needs the release identity in APPLE_SIGNING_IDENTITY ("Developer ID Application: Name (TEAMID)"). '
      + 'Run `python3 -I scripts/release/release.py vm-bootstrap <new-output-directory>`, which reads it from where the release does.')
  }
  return named
}
export const teamOf = identity => identity.match(IDENTITY)[1]
export const signArguments = (identity, name, file) =>
  ['--force', '--sign', identity, '--options', 'runtime', '--timestamp', '--identifier', IDENTIFIERS[name], file]

// What `codesign -d --verbose=4` must report for an executable signed as
// `signArguments` asks: this identity and its team, the identifier, the
// hardened runtime and a secure timestamp.
export function requireSigned(report, identity, name) {
  const signing = parseCodesign(report)
  const problems = []
  if (!report.split('\n').includes(`Authority=${identity}`)) problems.push('is not signed by the release identity')
  if (signing.teamIdentifier !== teamOf(identity)) problems.push(`has team ${signing.teamIdentifier ?? 'none'}`)
  if (!report.split('\n').includes(`Identifier=${IDENTIFIERS[name]}`)) problems.push(`is not identified as ${IDENTIFIERS[name]}`)
  if (!(signing.flags ?? '').split(',').includes('runtime')) problems.push('lacks the hardened runtime')
  if (!/^Timestamp=.+$/m.test(report)) problems.push('has no secure timestamp')
  if (problems.length) throw new Error(`${name} ${problems.join(', ')}`)
  return signing
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.signal || result.status}`)
  return { stdout: result.stdout.trim(), stderr: result.stderr }
}
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

// `codesign -dv` reports on stderr.
export function parseCodesign(report) {
  const field = name => report.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1] ?? null
  const team = field('TeamIdentifier')
  const authorities = [...report.matchAll(/^Authority=(.*)$/gm)].map(m => m[1])
  return {
    signature: field('Signature') ?? (authorities[0] || null),
    teamIdentifier: team === 'not set' ? null : team,
    flags: report.match(/flags=0x[0-9a-f]+\(([^)]*)\)/)?.[1] ?? null,
    developerId: authorities.some(a => a.startsWith('Developer ID Application:')),
  }
}

// `identity`: the release's Developer ID Application identity to sign with, or
// null for an unsigned (linker ad hoc) build.
export function build(out, { identity = null } = {}) {
  if (identity !== null && !IDENTITY.test(identity)) throw new Error('A Developer ID Application identity is required to sign')
  if (existsSync(out) && readdirSync(out).length) throw new Error('Output directory must be new or empty')
  mkdirSync(out, { recursive: true })
  const targetDir = path.join(out, 'target')
  run('cargo', ['build', '--release', '--offline', '--locked', '--target', target,
    '--manifest-path', path.join(crate, 'Cargo.toml'), '--target-dir', targetDir])
  const artifacts = BINARIES.map(name => {
    const file = path.join(out, name)
    copyFileSync(path.join(targetDir, target, 'release', name), file)
    const archs = run('lipo', ['-archs', file]).stdout
    if (archs !== 'arm64') throw new Error(`${name} must be thin arm64, found ${archs}`)
    const built = readFileSync(file)
    // What the linker produced, before any signature replaces its own.
    const unsigned = { bytes: built.length, sha256: sha256(built) }
    if (identity) {
      run('codesign', signArguments(identity, name, file))
      run('codesign', ['--verify', '--strict', file])
    }
    const bytes = readFileSync(file)
    const report = spawnSync('codesign', ['-d', '--verbose=4', file], { encoding: 'utf8' }).stderr
    const signing = identity ? requireSigned(report, identity, name) : parseCodesign(report)
    return { name, path: file, bytes: bytes.length, sha256: sha256(bytes), archs, signing,
      ...(identity ? { identifier: IDENTIFIERS[name], unsigned } : {}) }
  })
  for (const name of PLISTS) {
    const plist = path.join(out, name)
    copyFileSync(path.join(crate, name), plist)
    run('plutil', ['-lint', plist])
    const plistBytes = readFileSync(plist)
    if (!plistBytes.equals(readFileSync(path.join(crate, name)))) throw new Error('Plist copy differs from source')
    artifacts.push({ name, path: plist, bytes: plistBytes.length, sha256: sha256(plistBytes) })
  }
  const manifest = {
    version: 1,
    crate: 'native/vm-bootstrap',
    source: { commit: run('git', ['rev-parse', 'HEAD']).stdout, cleanTree: run('git', ['status', '--porcelain']).stdout === '' },
    toolchain: { rustc: run('rustc', ['-V']).stdout, cargo: run('cargo', ['-V']).stdout, sdk: run('xcrun', ['--show-sdk-version']).stdout },
    cargoLockSha256: sha256(readFileSync(path.join(crate, 'Cargo.lock'))),
    target,
    artifacts,
    developerIdSigned: identity !== null && artifacts.filter(a => a.signing).every(a => a.signing.developerId),
    ...(identity ? { signingTeam: teamOf(identity) } : {}),
    notarized: false,
    note: identity
      ? 'Developer ID signed with the hardened runtime and a secure timestamp. Not notarized, installed or run in a guest.'
      : 'Built only. Not Developer ID signed, notarized, installed or run in a guest.',
  }
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const sign = args.includes('--sign')
    const rest = args.filter(a => a !== '--sign')
    if (rest.length !== 1 || rest[0].startsWith('-')) throw new Error('usage: build-vm-bootstrap.mjs <new-output-directory> [--sign]')
    // Refused before the build when the release identity is not given.
    const identity = sign ? signingIdentity(process.env) : null
    console.log(JSON.stringify(build(path.resolve(rest[0]), { identity }), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
