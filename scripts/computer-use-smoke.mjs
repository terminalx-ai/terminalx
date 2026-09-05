#!/usr/bin/env node
// Smoke test for `terminalx computer …` against a running TerminalX.
//
//   pnpm smoke:computer                      snapshot the first running preferred app
//   pnpm smoke:computer -- --apps Finder,TextEdit --screenshot --actions
//
// --actions runs the action round trip the issue's acceptance criteria name:
// press-key Escape, hotkey CmdOrCtrl+A, scroll, and a set-value/type-text
// pair against TextEdit (only when TextEdit is running), checking that every
// action returns a fresh snapshot and verification metadata.
//
// Environment:
//   TERMINALX_COMPUTER_SMOKE_CLI   executable to run (default: terminalx on PATH)
//   TERMINALX_COMPUTER_SMOKE_APPS  comma-separated preferred apps
import { spawnSync } from 'node:child_process'

const cli = process.env.TERMINALX_COMPUTER_SMOKE_CLI ?? 'terminalx'
const args = new Set(process.argv.slice(2))
const includeScreenshot = args.has('--screenshot')
const runActions = args.has('--actions')
const requireTarget = args.has('--require-target')
const preferredApps = (
  valueFlag('--apps') ??
  process.env.TERMINALX_COMPUTER_SMOKE_APPS ??
  'Finder,TextEdit,Calculator,Safari,Google Chrome,Microsoft Edge,Slack,Spotify'
)
  .split(',')
  .map((app) => app.trim())
  .filter(Boolean)

let failures = 0
const status = runCli(['status', '--json'])
console.log(`computer-use smoke: app ${status.appVersion} (pid ${status.pid})`)
const capabilities = runCli(['computer', 'capabilities', '--json'])
console.log(`computer-use smoke: provider ${capabilities.provider} protocol ${capabilities.protocolVersion}`)
const permissions = runCli(['computer', 'permissions', '--json'])
console.log(
  `computer-use smoke: permissions ${permissions.permissions.map((p) => `${p.id}=${p.status}`).join(' ')}`
)

const list = runCli(['computer', 'list-apps', '--json'])
const apps = Array.isArray(list.apps) ? list.apps : []
const names = new Set(apps.map((app) => String(app.name ?? '').toLowerCase()))
const bundles = new Set(apps.map((app) => String(app.bundleId ?? '').toLowerCase()).filter(Boolean))
const targets = preferredApps.filter((app) => names.has(app.toLowerCase()) || bundles.has(app.toLowerCase()))
console.log(`computer-use smoke: ${apps.length} apps listed`)

const unknown = runCli(['computer', 'list-windows', '--app', 'definitely-not-an-app-xyz', '--json'], { allowFailure: true })
expect(unknown.ok === false && unknown.error?.code === 'app_not_found', `unknown app → app_not_found (got ${JSON.stringify(unknown.error)})`)

if (targets.length === 0) {
  const message = `no preferred apps are running (${preferredApps.join(', ')})`
  if (requireTarget) fail(message)
  console.log(`computer-use smoke: ${message}`)
  process.exit(0)
}

for (const app of targets) {
  const result = runCli(
    ['computer', 'get-app-state', '--app', app, '--restore-window', ...(includeScreenshot ? [] : ['--no-screenshot']), '--json'],
    { allowFailure: true }
  )
  if (!result.ok) {
    if (result.error?.code === 'window_not_found') {
      console.log(`computer-use smoke: ${app}: skipped (${result.error.message})`)
      continue
    }
    failures += 1
    console.log(`computer-use smoke: ${app}: failed: ${result.error?.code}: ${result.error?.message}`)
    continue
  }
  const state = result.result
  const tree = String(state.snapshot.treeText ?? '')
  const shot = state.screenshot
    ? `${state.screenshot.width}x${state.screenshot.height} scale ${state.screenshot.scale} at ${state.screenshot.path ?? 'inline'}`
    : state.screenshotStatus?.state
  console.log(
    `computer-use smoke: ${state.snapshot.app.name} | ${state.snapshot.elementCount} elements | ${tree.split('\n').filter(Boolean).length} lines | screenshot=${shot}`
  )
  if (includeScreenshot) {
    expect(state.screenshotStatus?.state === 'captured' && typeof state.screenshot?.path === 'string', 'screenshot path is reported')
  }
  if (runActions) {
    runActionSmoke(app, state)
  }
}

if (failures > 0) fail(`${failures} app snapshot smoke check(s) failed`)

function runActionSmoke(app, state) {
  const selector = state.snapshot.app.bundleId ?? app
  const windowFlags = state.snapshot.window.id != null ? ['--window-id', String(state.snapshot.window.id)] : []
  const action = (verb, extra) => {
    const result = runCli(['computer', verb, '--app', selector, ...windowFlags, '--no-screenshot', ...extra, '--json'], { allowFailure: true })
    expect(result.ok, result.ok ? `${verb} succeeds` : `${verb} succeeds (${JSON.stringify(result.error)})`)
    if (!result.ok) return null
    expect(typeof result.result.snapshot?.treeText === 'string', `${verb} returns a fresh snapshot`)
    expect(typeof result.result.action?.verification?.state === 'string', `${verb} reports verification`)
    console.log(`computer-use smoke: ${verb}: ${result.result.action.path}, ${result.result.action.verification.state}${result.result.action.verification.reason ? ` (${result.result.action.verification.reason})` : ''}`)
    return result.result
  }
  action('press-key', ['--key', 'Escape'])
  action('hotkey', ['--key', 'CmdOrCtrl+A'])
  action('scroll', ['--x', '40', '--y', '40', '--direction', 'down'])
  if (selector === 'com.apple.TextEdit' || app.toLowerCase() === 'textedit') {
    const fresh = runCli(['computer', 'get-app-state', '--app', selector, ...windowFlags, '--no-screenshot', '--json'])
    const line = String(fresh.snapshot.treeText).split('\n').find((l) => /\btext (entry area|area|field)\b/i.test(l) && /settable/.test(l))
    const index = line?.match(/^\s*(\d+)\s/)?.[1]
    if (index) {
      const set = action('set-value', ['--element-index', index, '--value', 'computer-use smoke'])
      expect(set?.action?.verification?.state === 'verified', 'set-value on a text field reports verified')
      const typed = action('type-text', ['--text', ' typed'])
      // The helper reads the focused text back when it can; otherwise
      // synthetic input must be reported as unverified, never as success.
      const v = typed?.action?.verification
      expect(v?.state === 'verified' || v?.reason === 'synthetic_input', 'type-text is verified by read-back or reported as synthetic input')
    } else {
      console.log('computer-use smoke: TextEdit has no settable text area in the tree; skipping set-value')
    }
  }
}

function valueFlag(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

function runCli(cliArgs, options = {}) {
  const child = spawnSync(cli, cliArgs, { encoding: 'utf8', env: process.env })
  if (child.error) fail(`could not run ${cli}: ${child.error.message}`)
  let parsed
  try {
    parsed = JSON.parse(child.stdout)
  } catch {
    fail(`could not parse CLI JSON for ${cliArgs.join(' ')}\n${child.stdout}${child.stderr}`)
  }
  if (options.allowFailure) return parsed
  if (!parsed.ok) fail(`${cliArgs.join(' ')} → ${parsed.error?.code}: ${parsed.error?.message}`)
  return parsed.result
}

function expect(condition, label) {
  if (condition) {
    console.log(`computer-use smoke: ok: ${label}`)
  } else {
    failures += 1
    console.log(`computer-use smoke: FAILED: ${label}`)
  }
}

function fail(message) {
  console.error(`computer-use smoke: ${message}`)
  process.exit(1)
}
