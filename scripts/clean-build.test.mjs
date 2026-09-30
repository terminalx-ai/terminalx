import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPlan, findTargets, planClean, sizeOf } from './clean-build.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 30)
const crates = new Set(['raccoon_lib', 'raccoon'])

let target

/**
 * Writes a file (or makes a dir, for a trailing slash) last modified `daysAgo`.
 * Dirs it has to create get the same age; the dir it lands in keeps the age it
 * had, since adding an entry would otherwise stamp it with the real clock.
 */
function put(relative, daysAgo, bytes = 16) {
  const file = path.join(target, relative)
  const made = []
  let parent = path.dirname(file)
  while (!existsSync(parent)) {
    made.push(parent)
    parent = path.dirname(parent)
  }
  const parentTime = statSync(parent).mtime
  mkdirSync(path.dirname(file), { recursive: true })
  if (relative.endsWith('/')) mkdirSync(file)
  else writeFileSync(file, 'x'.repeat(bytes))
  const at = new Date(NOW - daysAgo * DAY_MS)
  for (const touched of [file, ...made]) utimesSync(touched, at, at)
  if (parent !== target) utimesSync(parent, parentTime, parentTime)
  return file
}

/** A profile dir as cargo lays it out, its own dirs last touched `daysAgo`. */
function profile(relative, daysAgo = 0) {
  for (const sub of ['.fingerprint/', 'deps/', 'incremental/']) put(`${relative}/${sub}`, daysAgo)
}

const hash = (n) => String(n).padStart(16, '0')
const ls = (relative) => readdirSync(path.join(target, relative)).sort()
const clean = (options = {}) => applyPlan(planClean(target, { crates, now: NOW, ...options }))

beforeEach(() => {
  target = mkdtempSync(path.join(tmpdir(), 'clean-build-'))
})

afterEach(() => {
  rmSync(target, { recursive: true, force: true })
})

describe('clean-build', () => {
  it('keeps the newest builds of our own crates and drops the rest with their fingerprints', () => {
    profile('debug')
    for (let n = 1; n <= 5; n++) {
      put(`debug/deps/libraccoon_lib-${hash(n)}.rlib`, n)
      put(`debug/deps/raccoon_lib-${hash(n)}.d`, n)
      put(`debug/.fingerprint/raccoon-${hash(n)}/lib-raccoon_lib.json`, n)
    }

    clean({ keep: 2 })

    expect(ls('debug/deps')).toEqual([
      `libraccoon_lib-${hash(1)}.rlib`,
      `libraccoon_lib-${hash(2)}.rlib`,
      `raccoon_lib-${hash(1)}.d`,
      `raccoon_lib-${hash(2)}.d`,
    ])
    expect(ls('debug/.fingerprint')).toEqual([`raccoon-${hash(1)}`, `raccoon-${hash(2)}`])
  })

  it('never touches a third-party crate, however many old builds it has', () => {
    profile('debug')
    for (let n = 1; n <= 6; n++) {
      put(`debug/deps/libserde-${hash(n)}.rlib`, 20 + n)
      put(`debug/deps/serde-${hash(n)}.serde.abc123-cgu.0.rcgu.o`, 20 + n)
    }
    // A dependency whose name only starts like ours is still not ours.
    put(`debug/deps/libraccoon_macros-${hash(7)}.rlib`, 29)
    put(`debug/deps/libraccoon_macros-${hash(8)}.rlib`, 28)

    expect(planClean(target, { crates, keep: 1, now: NOW })).toEqual([])
    expect(ls('debug/deps')).toHaveLength(14)
  })

  it("drops earlier builds' debug-info objects but keeps the unhashed library beside them", () => {
    profile('debug')
    put('debug/deps/libraccoon_lib.rlib', 0)
    put('debug/deps/libraccoon_lib.a', 0)
    for (const [build, daysAgo] of [['1aaaaaa', 0], ['1bbbbbb', 2], ['1cccccc', 15], ['1dddddd', 16]]) {
      for (const unit of ['000adn0786jak', 'f4worhswu9rox']) put(`debug/deps/raccoon_lib.${unit}.${build}.rcgu.o`, daysAgo)
    }

    clean({ keep: 2 })

    expect(ls('debug/deps')).toEqual([
      'libraccoon_lib.a',
      'libraccoon_lib.rlib',
      'raccoon_lib.000adn0786jak.1aaaaaa.rcgu.o',
      'raccoon_lib.000adn0786jak.1bbbbbb.rcgu.o',
      'raccoon_lib.f4worhswu9rox.1aaaaaa.rcgu.o',
      'raccoon_lib.f4worhswu9rox.1bbbbbb.rcgu.o',
    ])
  })

  it('keeps the newest incremental caches per crate, judged by their latest session', () => {
    profile('debug')
    // Made long ago but built into today: the session dir is what shows it.
    put('debug/incremental/raccoon_lib-0aaaaaaaaaaaa/', 29)
    put('debug/incremental/raccoon_lib-0aaaaaaaaaaaa/s-today/', 0)
    put('debug/incremental/raccoon_lib-0bbbbbbbbbbbb/s-old/', 10)
    put('debug/incremental/raccoon_lib-0cccccccccccc/s-older/', 20)
    put('debug/incremental/build_script_build-0dddddddddddd/s-only/', 25)

    clean({ keep: 1 })

    expect(ls('debug/incremental')).toEqual(['build_script_build-0dddddddddddd', 'raccoon_lib-0aaaaaaaaaaaa'])
  })

  it('removes temp dirs an interrupted rustc left, but not one a live rustc may own', () => {
    profile('debug')
    put('debug/deps/rmetaXvA4fx/full.rmeta', 3)
    put('debug/deps/rustcND1wlq/', 0)

    clean()

    expect(ls('debug/deps')).toEqual(['rustcND1wlq'])
  })

  it('removes a side target dir nobody has built into, and prunes one still in use', () => {
    profile('debug')
    profile('check/debug', 25)
    put(`check/debug/deps/libserde-${hash(1)}.rlib`, 25)
    profile('release-build/release', 2)
    for (let n = 1; n <= 3; n++) put(`release-build/release/deps/libraccoon_lib-${hash(n)}.rlib`, n + 1)
    put(`release-build/release/deps/libserde-${hash(9)}.rlib`, 9)
    put('tools/cmake/bin/cmake', 40)

    const done = clean({ keep: 1, idleDays: 14 })

    expect(ls('.')).toEqual(['debug', 'release-build', 'tools'])
    expect(ls('release-build/release/deps')).toEqual([`libraccoon_lib-${hash(1)}.rlib`, `libserde-${hash(9)}.rlib`])
    expect(done.find((step) => step.dir.endsWith('check')).why).toBe('idle 25 days, removed')
  })

  it('leaves alone any dir a running process is using', () => {
    profile('debug')
    for (let n = 1; n <= 3; n++) put(`debug/deps/libraccoon_lib-${hash(n)}.rlib`, n)
    profile('check/debug', 25)
    const busy = (dir) => dir === path.join(target, 'debug') || dir === path.join(target, 'check')

    const done = clean({ keep: 1, busy })

    expect(done.map((step) => step.skipped)).toEqual(['in use', 'in use'])
    expect(ls('debug/deps')).toHaveLength(3)
    expect(existsSync(path.join(target, 'check'))).toBe(true)

    expect(clean({ all: true, busy }).map((step) => step.skipped)).toEqual(['in use', 'in use'])
    expect(existsSync(path.join(target, 'debug'))).toBe(true)
  })

  it('--all removes every build dir and nothing else', () => {
    profile('debug')
    put(`debug/deps/libserde-${hash(1)}.rlib`, 1)
    profile('check/debug', 1)
    put('tools/cmake/bin/cmake', 40)
    put('CACHEDIR.TAG', 40)

    clean({ all: true })

    expect(ls('.')).toEqual(['CACHEDIR.TAG', 'tools'])
  })

  it('changes nothing on a dry run, and reports the same bytes a real run frees', () => {
    profile('debug')
    for (let n = 1; n <= 4; n++) put(`debug/deps/libraccoon_lib-${hash(n)}.rlib`, n, 8192)
    const steps = planClean(target, { crates, keep: 1, now: NOW })

    const dry = applyPlan(steps, { dryRun: true })
    expect(ls('debug/deps')).toHaveLength(4)

    const real = applyPlan(steps)
    expect(ls('debug/deps')).toHaveLength(1)
    expect(dry[0].bytes).toBe(real[0].bytes)
    expect(real[0].bytes).toBeGreaterThanOrEqual(3 * 8192)
  })

  it('counts a hard-linked file as freed only once its last link goes', () => {
    profile('debug')
    for (const [build, daysAgo] of [['1aaaaaa', 0], ['1bbbbbb', 5]]) {
      const object = put(`debug/deps/raccoon_lib.000adn0786jak.${build}.rcgu.o`, daysAgo, 8192)
      const session = put(`debug/incremental/raccoon_lib-0${build}aaaaa/s-one/`, daysAgo)
      const built = statSync(session).mtime
      linkSync(object, path.join(session, '000adn0786jak.o'))
      utimesSync(session, built, built)
    }

    // Both links of the older build go: its 8 KiB is freed, and counted once.
    const both = clean({ keep: 1 })[0].bytes
    expect(both).toBeGreaterThanOrEqual(8192)
    expect(both).toBeLessThan(2 * 8192)
    expect(ls('debug/deps')).toEqual(['raccoon_lib.000adn0786jak.1aaaaaa.rcgu.o'])

    // One link of two: the data stays on disk under the other name.
    const links = new Map()
    expect(sizeOf(path.join(target, 'debug/deps/raccoon_lib.000adn0786jak.1aaaaaa.rcgu.o'), links)).toBe(0)
    expect(sizeOf(path.join(target, 'debug/incremental/raccoon_lib-01aaaaaaaaaaa/s-one/000adn0786jak.o'), links)).toBeGreaterThanOrEqual(8192)
  })

  it('tells profile dirs, side target dirs and unrelated dirs apart', () => {
    profile('debug')
    profile('release')
    profile('aarch64-apple-darwin/release')
    put('tools/cmake/bin/cmake', 1)

    const found = findTargets(target)

    expect(found.profiles.map((dir) => path.basename(dir)).sort()).toEqual(['debug', 'release'])
    expect(found.sides.map((side) => path.basename(side.dir))).toEqual(['aarch64-apple-darwin'])
  })
})
