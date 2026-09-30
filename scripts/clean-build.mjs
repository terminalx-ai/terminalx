#!/usr/bin/env node
// Prunes Cargo's build cache under src-tauri/target. Cargo never trims it, so
// it grows by every build of this repo's own crates until the disk is full.
//
// What goes, and why nothing that remains has to be rebuilt:
//
//   - Older builds of this repo's crates. Each build leaves a hashed artifact
//     set in deps/, and on macOS a dev build also leaves its object files
//     there: they carry the debug info (split-debuginfo=unpacked), and Cargo
//     does not remove the previous build's. The newest few are kept.
//   - Incremental caches of those older builds.
//   - Temp dirs an interrupted rustc left in deps/.
//   - Side target dirs (target/check, target/release-build, ...) nobody has
//     built into for a while. CONTRIBUTING.md and docs/RELEASING.md tell you to
//     give clippy and release builds their own CARGO_TARGET_DIR; each is a
//     whole second cache.
//
// Third-party crates are never touched: a dependency compiled a month ago is
// still the one in use, and removing it means a cold build.
//
//   node scripts/clean-build.mjs              prune
//   node scripts/clean-build.mjs --dry-run    report what would go
//   node scripts/clean-build.mjs --all        remove every build dir; a cold build follows
//
//   --keep <n>          builds to keep per crate (default 3)
//   --idle-days <n>     drop a side target dir idle this long (default 14)
//   --target-dir <dir>  default $CARGO_TARGET_DIR, else src-tauri/target
//   --quiet             print only when something was removed, never fail
//
// A profile dir a running process is using (rustc writing into it, the dev
// app running out of it) is left alone. `pnpm tauri:dev` runs this first.
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(import.meta.dirname, '..')
const DAY_MS = 24 * 60 * 60 * 1000
const TEMP_DIR = /^(?:rmeta|rustc)[A-Za-z0-9]{6}$/
const INCREMENTAL_DIR = /^(.+)-[0-9a-z]{8,}$/

function entries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function mtime(file) {
  try {
    return lstatSync(file).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Bytes that removing `file` frees, by blocks. Cargo hard-links object files
 * between deps/ and incremental/, and those are only freed with their last
 * link: `links` counts the ones met so far, across calls.
 */
export function sizeOf(file, links = new Map()) {
  let stat
  try {
    stat = lstatSync(file)
  } catch {
    return 0
  }
  if (stat.isDirectory()) {
    let total = stat.blocks * 512
    for (const entry of entries(file)) total += sizeOf(path.join(file, entry.name), links)
    return total
  }
  if (stat.nlink > 1) {
    const inode = `${stat.dev}:${stat.ino}`
    const met = (links.get(inode) ?? 0) + 1
    links.set(inode, met)
    if (met < stat.nlink) return 0
  }
  return stat.blocks * 512
}

function isProfileDir(dir) {
  return existsSync(path.join(dir, '.fingerprint')) && existsSync(path.join(dir, 'deps'))
}

/**
 * The profile dirs of the main target dir, and the side target dirs nested in
 * it: any child that holds profile dirs of its own, which is what a
 * CARGO_TARGET_DIR under target/ (or a --target triple) looks like.
 */
export function findTargets(targetDir) {
  const profiles = []
  const sides = []
  for (const entry of entries(targetDir)) {
    if (!entry.isDirectory()) continue
    const dir = path.join(targetDir, entry.name)
    if (isProfileDir(dir)) {
      profiles.push(dir)
      continue
    }
    const nested = entries(dir)
      .filter((e) => e.isDirectory() && isProfileDir(path.join(dir, e.name)))
      .map((e) => path.join(dir, e.name))
    if (nested.length) sides.push({ dir, profiles: nested })
  }
  return { profiles, sides }
}

/** When a build last wrote into a side target dir: adding or removing an artifact touches these. */
function lastBuilt(side) {
  let newest = 0
  for (const profile of side.profiles) {
    for (const sub of ['', 'deps', '.fingerprint', 'incremental']) {
      newest = Math.max(newest, mtime(path.join(profile, sub)))
    }
  }
  return newest
}

/** Everything past the newest `keep` groups, newest first by the group's latest file. */
function stale(groups, keep) {
  return [...groups.values()].sort((a, b) => b.mtime - a.mtime).slice(keep)
}

function group(map, key) {
  let found = map.get(key)
  if (!found) map.set(key, (found = { mtime: 0, paths: [] }))
  return found
}

/**
 * What to remove from one profile dir (target/debug, target/check/debug, ...).
 * `crates` are this repo's own crate names as they appear in file names.
 */
export function planProfile(profileDir, { crates, keep, now }) {
  const names = [...crates].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  // libraccoon_lib-0123456789abcdef.rlib, raccoon-0123456789abcdef.d
  const hashed = new RegExp(`^(?:lib)?(${names})-([0-9a-f]{16})(?:\\..*)?$`)
  // raccoon_lib.<codegen unit>.<build>.rcgu.o: one build's debug-info objects share <build>
  const object = new RegExp(`^(${names})\\.[0-9a-z]+\\.([0-9a-z]+)\\.rcgu\\.(?:o|dwo)$`)

  const plan = { builds: [], objects: [], incremental: [], temp: [] }
  const builds = new Map()
  const objects = new Map()
  const deps = path.join(profileDir, 'deps')
  for (const entry of entries(deps)) {
    const file = path.join(deps, entry.name)
    if (entry.isDirectory()) {
      // A live rustc owns a fresh one; a day-old one was abandoned.
      if (TEMP_DIR.test(entry.name) && now - mtime(file) > DAY_MS) plan.temp.push(file)
      continue
    }
    const build = crates.size ? hashed.exec(entry.name) : null
    const obj = !build && crates.size ? object.exec(entry.name) : null
    if (!build && !obj) continue
    const byCrate = build ? builds : objects
    const crate = (build ?? obj)[1]
    if (!byCrate.has(crate)) byCrate.set(crate, new Map())
    const g = group(byCrate.get(crate), (build ?? obj)[2])
    g.mtime = Math.max(g.mtime, mtime(file))
    g.paths.push(file)
    g.hash = build?.[2]
  }

  const goneHashes = new Set()
  for (const groups of builds.values()) {
    for (const g of stale(groups, keep)) {
      plan.builds.push(...g.paths)
      goneHashes.add(g.hash)
    }
  }
  for (const groups of objects.values()) {
    for (const g of stale(groups, keep)) plan.objects.push(...g.paths)
  }
  // The fingerprint of a build whose outputs are gone says nothing useful.
  const fingerprints = path.join(profileDir, '.fingerprint')
  for (const entry of entries(fingerprints)) {
    const hash = /-([0-9a-f]{16})$/.exec(entry.name)?.[1]
    if (hash && goneHashes.has(hash)) plan.builds.push(path.join(fingerprints, entry.name))
  }

  // Only local crates build incrementally, so every dir here is ours.
  const caches = new Map()
  const incremental = path.join(profileDir, 'incremental')
  for (const entry of entries(incremental)) {
    const crate = INCREMENTAL_DIR.exec(entry.name)?.[1]
    if (!crate || !entry.isDirectory()) continue
    const dir = path.join(incremental, entry.name)
    if (!caches.has(crate)) caches.set(crate, new Map())
    const g = group(caches.get(crate), entry.name)
    // Each build adds a session dir, which touches the cache dir itself.
    g.mtime = Math.max(mtime(dir), ...entries(dir).map((e) => mtime(path.join(dir, e.name))))
    g.paths.push(dir)
  }
  for (const groups of caches.values()) {
    for (const g of stale(groups, keep)) plan.incremental.push(...g.paths)
  }
  return plan
}

/**
 * The whole plan for a target dir: a list of steps, each naming the paths to
 * remove and why. `busy(dir)` says a running process is using that dir.
 */
export function planClean(targetDir, { crates, keep = 3, idleDays = 14, all = false, now = Date.now(), busy = () => false }) {
  const { profiles, sides } = findTargets(targetDir)
  const steps = []
  if (all) {
    for (const dir of [...profiles, ...sides.map((s) => s.dir)]) {
      if (busy(dir)) steps.push({ dir, skipped: 'in use' })
      else steps.push({ dir, paths: [dir], why: 'removed' })
    }
    return steps
  }
  const prune = (dir) => {
    if (busy(dir)) return steps.push({ dir, skipped: 'in use' })
    const plan = planProfile(dir, { crates, keep, now })
    const paths = [...plan.builds, ...plan.objects, ...plan.incremental, ...plan.temp]
    if (!paths.length) return
    const parts = [
      plan.builds.length + plan.objects.length && 'old builds',
      plan.incremental.length && `${plan.incremental.length} incremental caches`,
      plan.temp.length && `${plan.temp.length} abandoned temp dirs`,
    ].filter(Boolean)
    steps.push({ dir, paths, why: parts.join(', ') })
  }
  for (const dir of profiles) prune(dir)
  for (const side of sides) {
    const idle = Math.floor((now - lastBuilt(side)) / DAY_MS)
    if (idle < idleDays) side.profiles.forEach(prune)
    else if (busy(side.dir)) steps.push({ dir: side.dir, skipped: 'in use' })
    else steps.push({ dir: side.dir, paths: [side.dir], why: `idle ${idle} days, removed` })
  }
  return steps
}

/** Removes what the plan names and returns the bytes freed per step. */
export function applyPlan(steps, { dryRun = false } = {}) {
  const links = new Map()
  return steps.map((step) => {
    if (step.skipped) return { ...step, bytes: 0 }
    let bytes = 0
    for (const file of step.paths) {
      bytes += sizeOf(file, links)
      if (!dryRun) rmSync(file, { recursive: true, force: true })
    }
    return { ...step, bytes }
  })
}

/** This repo's crate names as rustc writes them into file names. */
export function localCrates(manifestPath) {
  const result = spawnSync('cargo', ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', manifestPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`cargo metadata failed: ${(result.stderr || result.error?.message || '').trim()}`)
  }
  const crates = new Set()
  for (const pkg of JSON.parse(result.stdout).packages) {
    for (const target of pkg.targets) {
      if (!target.kind.includes('custom-build')) crates.add(target.name.replaceAll('-', '_'))
    }
  }
  return crates
}

/** A dir is in use when a running process names a path inside it: rustc's --out-dir, or the dev binary. */
function busyDirs() {
  const ps = spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const commands = ps.status === 0 ? ps.stdout.split('\n') : []
  return (dir) => commands.some((command) => command.includes(dir + path.sep))
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  return `${Math.round(bytes / 1e6)} MB`
}

function option(args, name, fallback) {
  const i = args.indexOf(name)
  if (i === -1) return fallback
  const value = args[i + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

function count(args, name, fallback) {
  const value = Number(option(args, name, fallback))
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a whole number of at least 1`)
  return value
}

function main(args) {
  const quiet = args.includes('--quiet')
  const dryRun = args.includes('--dry-run')
  const all = args.includes('--all')
  const keep = count(args, '--keep', 3)
  const idleDays = count(args, '--idle-days', 14)
  const targetDir = path.resolve(option(args, '--target-dir', process.env.CARGO_TARGET_DIR ?? path.join(repoRoot, 'src-tauri', 'target')))
  if (!existsSync(targetDir)) {
    if (!quiet) console.log(`clean-build: nothing at ${targetDir}`)
    return
  }
  const steps = planClean(targetDir, {
    crates: all ? new Set() : localCrates(path.join(repoRoot, 'src-tauri', 'Cargo.toml')),
    keep,
    idleDays,
    all,
    busy: busyDirs(),
  })
  const done = applyPlan(steps, { dryRun })
  const freed = done.reduce((sum, step) => sum + step.bytes, 0)
  if (quiet && !freed) return
  console.log(`clean-build: ${targetDir}${dryRun ? ' (dry run)' : ''}`)
  for (const step of done) {
    const name = path.relative(targetDir, step.dir)
    if (step.skipped) {
      if (!quiet) console.log(`  ${name}: ${step.skipped}, left alone`)
    } else {
      console.log(`  ${name}: ${step.why} (${formatBytes(step.bytes)})`)
    }
  }
  console.log(freed ? `${dryRun ? 'would free' : 'freed'} ${formatBytes(freed)}` : 'nothing to remove')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  try {
    main(args)
  } catch (error) {
    console.error(`clean-build: ${error.message}`)
    // Housekeeping ahead of `tauri dev` must not be what stops the app starting.
    process.exit(args.includes('--quiet') ? 0 : 1)
  }
}
