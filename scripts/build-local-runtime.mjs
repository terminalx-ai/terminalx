#!/usr/bin/env node
// Build the headless owner separately: Cargo feature unification must not pull
// desktop/WebView dependencies into it. Cargo's artifact message, not a guessed
// target directory, identifies the executable to package.
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const root = path.resolve(import.meta.dirname, '..')

export function buildPlan(args, env, host) {
  let target
  let profile
  let dev = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dev') dev = true
    else if (args[i] === '--target' || args[i] === '--profile') {
      const option = args[i]
      const value = args[++i]
      if (!value || value.startsWith('-')) throw new Error(`${option} requires a value`)
      if (option === '--target') target = value
      else profile = value
    } else throw new Error(`Unknown argument: ${args[i]}`)
  }
  if (env.TAURI_ENV_PLATFORM && !['darwin', 'linux'].includes(env.TAURI_ENV_PLATFORM)) {
    throw new Error(`Local desktop runtime packaging is not supported for ${env.TAURI_ENV_PLATFORM}`)
  }
  if (env.TAURI_ENV_DEBUG && !['true', 'false'].includes(env.TAURI_ENV_DEBUG)) {
    throw new Error('Unrecognized Tauri debug profile')
  }
  if (dev && env.TAURI_ENV_DEBUG === 'false') throw new Error('The helper profile must match the Tauri build profile')
  // Tauri CLI Rust::env supplies the full target to hooks as
  // TAURI_ENV_TARGET_TRIPLE. Architecture/platform alone do not identify an ABI.
  const tauriTarget = env.TAURI_ENV_TARGET_TRIPLE
  if (target && tauriTarget && target !== tauriTarget) throw new Error('The helper target must match the Tauri target')
  const fallback = env.TAURI_ENV_ARCH && env.TAURI_ENV_PLATFORM === 'darwin'
    ? `${env.TAURI_ENV_ARCH}-apple-darwin`
    : env.TAURI_ENV_ARCH && env.TAURI_ENV_PLATFORM === 'linux'
      ? (host?.startsWith(`${env.TAURI_ENV_ARCH}-`) && host.includes('-linux-') ? host : `${env.TAURI_ENV_ARCH}-unknown-linux-gnu`) : host
  target ??= tauriTarget ?? env.CARGO_BUILD_TARGET ?? fallback
  const macos = ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'universal-apple-darwin'].includes(target)
  if (!macos && !/^(aarch64|x86_64)-unknown-linux-(gnu|musl)$/.test(target)) {
    throw new Error(`Local desktop runtime packaging is not supported for ${target}`)
  }
  if ((env.TAURI_ENV_ARCH && env.TAURI_ENV_ARCH !== target.split('-')[0]) ||
      (env.TAURI_ENV_PLATFORM && env.TAURI_ENV_PLATFORM !== (macos ? 'darwin' : 'linux'))) {
    throw new Error('The helper architecture and platform must match the Tauri target')
  }
  const debug = dev || env.TAURI_ENV_DEBUG === 'true'
  profile ??= debug ? 'dev' : 'release'
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(profile)) throw new Error('Invalid Cargo profile')
  if (env.TAURI_ENV_DEBUG && profile !== (debug ? 'dev' : 'release')) {
    throw new Error('The helper profile must match the Tauri build profile')
  }
  const identity = env.APPLE_SIGNING_IDENTITY || '-'
  const production = env.TERMINALX_MAC_RELEASE === '1'
  if (production && !macos) throw new Error('A macOS release requires a macOS helper target')
  if (production && identity === '-') throw new Error('A production runtime requires APPLE_SIGNING_IDENTITY; ad-hoc signing is insufficient')
  return {
    targets: target === 'universal-apple-darwin' ? ['aarch64-apple-darwin', 'x86_64-apple-darwin'] : [target],
    profile, identity, production, macos,
    identifier: dev ? 'com.terminalx.next.dev.local-runtime' : 'com.terminalx.next.local-runtime',
  }
}

export function cargoArtifact(output) {
  const artifacts = output.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(message => message.reason === 'compiler-artifact' && message.target?.name === 'terminalx-serve' && message.executable)
  if (artifacts.length !== 1) throw new Error('Cargo did not report exactly one terminalx-serve executable')
  return artifacts[0].executable
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status})`)
  return result.stdout
}

function main() {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('The local desktop helper requires macOS or Linux')
  const host = run('rustc', ['-vV']).match(/^host: (.+)$/m)?.[1]
  const plan = buildPlan(process.argv.slice(2), process.env, host)
  const env = { ...process.env, CARGO_BUILD_JOBS: '2' }
  if (plan.macos) env.SDKROOT = run('xcrun', ['--sdk', 'macosx', '--show-sdk-path']).trim()
  const executables = plan.targets.map(target => cargoArtifact(run('cargo', [
    'build', '--manifest-path', path.join(root, 'src-tauri/serve/Cargo.toml'),
    '--locked', '--features', 'local-ui', '--profile', plan.profile, '--target', target, '--message-format=json-render-diagnostics',
  ], { env, stdio: ['ignore', 'pipe', 'inherit'] })))
  const directory = path.join(root, 'src-tauri/target/local-runtime')
  mkdirSync(directory, { recursive: true })
  const staging = path.join(directory, `.terminalx-serve-${randomUUID()}`)
  const destination = path.join(directory, 'terminalx-serve')
  try {
    if (executables.length === 1) copyFileSync(executables[0], staging)
    else run('lipo', ['-create', ...executables, '-output', staging], { stdio: 'inherit' })
    chmodSync(staging, 0o755)
    if (plan.macos) {
      const signing = ['--force', '--sign', plan.identity, '--identifier', plan.identifier,
        '--options', 'runtime', '--entitlements', path.join(root, 'src-tauri/Entitlements.plist')]
      if (plan.production) signing.push('--timestamp')
      run('codesign', [...signing, staging], { stdio: 'inherit' })
      run('codesign', ['--verify', '--strict', staging], { stdio: 'inherit' })
    }
    renameSync(staging, destination)
    console.log(`Local runtime: ${destination} (${plan.targets.join(', ')}, ${plan.profile}, ${plan.macos ? (plan.production ? 'release signing' : 'development signing') : 'Linux executable'})`)
  } finally {
    rmSync(staging, { force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
