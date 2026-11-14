#!/usr/bin/env node
// Builds the macOS VM guest helper, validation probe and seed tool
// (native/vm-bootstrap) for arm64, offline from the locked crates, and writes a
// manifest of digests and signing state. It never signs: Developer ID signing
// and notarization are a separate, held release step, so these artifacts carry
// only the linker's ad hoc signature and the manifest says so.
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

export function build(out) {
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
    const bytes = readFileSync(file)
    const signing = parseCodesign(spawnSync('codesign', ['-dv', file], { encoding: 'utf8' }).stderr)
    return { name, path: file, bytes: bytes.length, sha256: sha256(bytes), archs, signing }
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
    developerIdSigned: artifacts.some(a => a.signing?.developerId),
    notarized: false,
    note: 'Built only. Not Developer ID signed, notarized, installed or run in a guest.',
  }
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: build-vm-bootstrap.mjs <new-output-directory>')
    console.log(JSON.stringify(build(path.resolve(process.argv[2])), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
