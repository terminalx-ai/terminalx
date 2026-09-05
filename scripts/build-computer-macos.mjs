#!/usr/bin/env node
// Builds the macOS computer-use helper ("TerminalX Computer Use.app") from
// native/computer-use-macos and signs it.
//
// The helper is its own app bundle on purpose: macOS keys Accessibility and
// Screen Recording consent to the bundle's code identity, so granting them
// once to the helper lets the TerminalX app, the terminalx CLI, and any agent
// shell use computer use without holding those permissions themselves.
//
//   node scripts/build-computer-macos.mjs          release identity (com.terminalx.next.computer-use)
//   node scripts/build-computer-macos.mjs --dev    dev identity (com.terminalx.next.dev.computer-use)
//
// Environment:
//   TERMINALX_COMPUTER_MACOS_UNIVERSAL=1      build arm64 + x86_64 and lipo them
//   TERMINALX_COMPUTER_MACOS_SIGN_IDENTITY    codesign identity ("-" for ad hoc)
//   TERMINALX_MAC_RELEASE=1                   hardened runtime, timestamp, entitlements
//   TERMINALX_COMPUTER_MACOS_SKIP=1           do nothing (CI jobs without Xcode)
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const packagePath = path.join(repoRoot, 'native', 'computer-use-macos')
const dev = process.argv.includes('--dev')
const outputDirName = dev ? 'release-dev' : 'release'
const outputDir = path.join(packagePath, '.build', outputDirName)
const binaryPath = path.join(outputDir, 'terminalx-computer-use-macos')
export const appName = 'TerminalX Computer Use.app'
const appPath = path.join(outputDir, appName)
const appExecutablePath = path.join(appPath, 'Contents', 'MacOS', 'terminalx-computer-use-macos')
const appIconPath = path.join(appPath, 'Contents', 'Resources', 'AppIcon.icns')
const iconSource = path.join(repoRoot, 'src-tauri', dev ? 'icons-dev' : 'icons', 'icon.icns')
const entitlementsPath = path.join(repoRoot, 'src-tauri', 'Entitlements.computer-use.plist')
const bundleId =
  process.env.TERMINALX_COMPUTER_MACOS_BUNDLE_ID ??
  (dev ? 'com.terminalx.next.dev.computer-use' : 'com.terminalx.next.computer-use')
const displayName = dev ? 'TerminalX Dev Computer Use' : 'TerminalX Computer Use'
const universal = process.env.TERMINALX_COMPUTER_MACOS_UNIVERSAL === '1'

if (process.platform !== 'darwin' || process.env.TERMINALX_COMPUTER_MACOS_SKIP === '1') {
  process.exit(0)
}
if (!existsSync(path.join(packagePath, 'Package.swift'))) {
  console.error(`build-computer-macos: missing Swift package at ${packagePath}`)
  process.exit(1)
}

const signingIdentity = resolveSigningIdentity()
buildBinary()
chmodSync(binaryPath, 0o755)
createHelperApp()
console.log(`build-computer-macos: ${appPath} (${bundleId}, signed as ${signingIdentity})`)

function buildBinary() {
  mkdirSync(outputDir, { recursive: true })
  if (universal) {
    const triples = ['arm64-apple-macosx', 'x86_64-apple-macosx']
    const built = triples.map((triple) => {
      run('swift', ['build', '-c', 'release', '--package-path', packagePath, '--triple', triple])
      return path.join(packagePath, '.build', triple, 'release', 'terminalx-computer-use-macos')
    })
    run('lipo', ['-create', ...built, '-output', binaryPath])
    return
  }
  run('swift', ['build', '-c', 'release', '--package-path', packagePath])
  const built = path.join(packagePath, '.build', 'release', 'terminalx-computer-use-macos')
  if (built !== binaryPath) {
    copyFileSync(built, binaryPath)
  }
}

function createHelperApp() {
  rmSync(appPath, { recursive: true, force: true })
  mkdirSync(path.dirname(appExecutablePath), { recursive: true })
  mkdirSync(path.dirname(appIconPath), { recursive: true })
  copyFileSync(binaryPath, appExecutablePath)
  chmodSync(appExecutablePath, 0o755)
  if (existsSync(iconSource)) {
    copyFileSync(iconSource, appIconPath)
  }
  writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), infoPlist(), 'utf8')
  run('codesign', codesignArgs(signingIdentity, appPath))
  run('codesign', ['--verify', '--deep', '--strict', appPath])
}

function codesignArgs(identity, targetPath) {
  const args = ['--force', '--deep', '--sign', identity]
  if (process.env.TERMINALX_MAC_RELEASE === '1' && identity !== '-') {
    args.push('--options', 'runtime', '--timestamp', '--entitlements', entitlementsPath)
  }
  args.push(targetPath)
  return args
}

// A real Apple Development identity gives the helper a designated requirement
// that survives rebuilds, so TCC keeps its grants across dev iterations. Ad hoc
// signing works too but every rebuild is a new identity to macOS.
function resolveSigningIdentity() {
  const explicit = process.env.TERMINALX_COMPUTER_MACOS_SIGN_IDENTITY ?? process.env.APPLE_SIGNING_IDENTITY
  if (explicit) {
    return explicit
  }
  const identities = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  if (identities.status !== 0 || !identities.stdout) {
    return '-'
  }
  // Sign by certificate hash: a keychain can hold two certificates with the
  // same name, and codesign refuses an ambiguous name.
  const byKind = (kind) => identities.stdout.match(new RegExp(`([0-9A-F]{40}) "[^"]*${kind}:[^"]+"`))?.[1]
  const development = byKind('Apple Development')
  if (process.env.TERMINALX_MAC_RELEASE !== '1' && development) {
    return development
  }
  return byKind('Developer ID Application') ?? byKind('Apple Distribution') ?? development ?? '-'
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>terminalx-computer-use-macos</string>
  <key>CFBundleIdentifier</key>
  <string>${escapePlist(bundleId)}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleName</key>
  <string>${escapePlist(displayName)}</string>
  <key>CFBundleDisplayName</key>
  <string>${escapePlist(displayName)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAccessibilityUsageDescription</key>
  <string>${escapePlist(displayName)} needs Accessibility permission to read and interact with app interfaces when you ask TerminalX to use apps.</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>${escapePlist(displayName)} needs Screen Recording permission to capture app windows when you ask TerminalX to inspect your screen.</string>
</dict>
</plist>
`
}

function escapePlist(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
