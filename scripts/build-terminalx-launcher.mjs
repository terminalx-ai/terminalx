#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
const root = path.resolve(import.meta.dirname, '..')

export function buildPlan(args, env, host) {
  let explicit, dev = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dev') dev = true
    else if (args[i] === '--target' && args[i + 1] && !args[i + 1].startsWith('-')) explicit = args[++i]
    else throw new Error(`Invalid launcher build argument: ${args[i]}`)
  }
  if (env.TAURI_ENV_DEBUG && !['true', 'false'].includes(env.TAURI_ENV_DEBUG)) throw new Error('Invalid Tauri debug profile')
  if (dev && env.TAURI_ENV_DEBUG === 'false') throw new Error('Launcher profile must match Tauri')
  if (explicit && env.TAURI_ENV_TARGET_TRIPLE && explicit !== env.TAURI_ENV_TARGET_TRIPLE) throw new Error('Launcher target must match Tauri')
  const target = explicit ?? env.TAURI_ENV_TARGET_TRIPLE ?? env.CARGO_BUILD_TARGET ??
    (env.TAURI_ENV_PLATFORM === 'darwin' && env.TAURI_ENV_ARCH ? `${env.TAURI_ENV_ARCH}-apple-darwin` : host)
  const macos = /^(aarch64|x86_64|universal)-apple-darwin$/.test(target)
  const platform = macos ? 'darwin' : /-linux-(gnu|musl)$/.test(target) ? 'linux' : /-windows-(msvc|gnu)$/.test(target) ? 'windows' : undefined
  if (!platform || (env.TAURI_ENV_PLATFORM && env.TAURI_ENV_PLATFORM !== platform) ||
      (env.TAURI_ENV_ARCH && env.TAURI_ENV_ARCH !== target.split('-')[0])) throw new Error('Unsupported or mismatched launcher target')
  return { target, targets: target === 'universal-apple-darwin' ? ['aarch64-apple-darwin', 'x86_64-apple-darwin'] : [target],
    debug: dev || env.TAURI_ENV_DEBUG === 'true', skip: !macos }
}
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.signal || result.status}`)
  return result.stdout.trim()
}
export function build(args = process.argv.slice(2), env = process.env) {
  const rustc = env.RUSTC || 'rustc'
  const host = run(rustc, ['-vV'], env).match(/^host: (.+)$/m)?.[1]
  const plan = buildPlan(args, env, host)
  // Platform overlays omit this sidecar and retain their existing CLI installers.
  if (plan.skip) return plan
  const buildEnv = { ...env, SDKROOT: run('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], env) }
  const directory = path.join(root, 'src-tauri/binaries')
  mkdirSync(directory, { recursive: true })
  const staging = path.join(directory, `.terminalx-${randomUUID()}`)
  const slices = plan.targets.map((_, i) => `${staging}-${i}`)
  try {
    plan.targets.forEach((target, i) => {
      run(rustc, ['--edition=2021', '--crate-name', 'terminalx_launcher', '--target', target,
        '-C', `opt-level=${plan.debug ? 0 : 2}`, path.join(root, 'native/terminalx-launcher/main.rs'), '-o', slices[i]], buildEnv)
    })
    run('lipo', ['-create', ...slices, '-output', staging], buildEnv)
    run('lipo', [staging, '-verify_arch', ...plan.targets.map(t => t.startsWith('aarch64') ? 'arm64' : 'x86_64')], buildEnv)
    renameSync(staging, path.join(directory, `terminalx-${plan.target}`))
  } finally {
    for (const file of [staging, ...slices]) rmSync(file, { force: true })
  }
  return plan
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(build()) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
