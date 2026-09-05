#!/usr/bin/env node
// Smoke test for `terminalx computer …` against a running TerminalX.
//
//   pnpm smoke:computer                      snapshot the first running preferred app
//   pnpm smoke:computer -- --apps Finder,TextEdit --screenshot --actions
//
// --actions runs the action round trip the issue's acceptance criteria name:
// press-key Escape, hotkey CmdOrCtrl+A, scroll, and a set-value/type-text
// pair against TextEdit, Text Editor/gedit, or Notepad, checking that every
// action returns a fresh snapshot and verification metadata.
//
// Environment:
//   TERMINALX_COMPUTER_SMOKE_CLI   executable to run (default: terminalx on PATH)
//   TERMINALX_COMPUTER_SMOKE_APPS  comma-separated preferred apps
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

let cli = process.env.TERMINALX_COMPUTER_SMOKE_CLI ?? 'terminalx'
let cliPrefix = []
let failures = 0
resolveLauncher()
const args = new Set(process.argv.slice(2))
const includeScreenshot = args.has('--screenshot')
const runActions = args.has('--actions')
const requireTarget = args.has('--require-target') || runActions
const preferredApps = (
  valueFlag('--apps') ??
  process.env.TERMINALX_COMPUTER_SMOKE_APPS ??
  'Text Editor,gedit,Notepad,TextEdit,Finder,Calculator,Safari,Google Chrome,Microsoft Edge'
)
  .split(',')
  .map((app) => app.trim())
  .filter(Boolean)

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
    if (typeof state.screenshot?.path === 'string') {
      const png = readFileSync(state.screenshot.path)
      expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'screenshot file is a PNG')
      expect(png.length <= 900_000 && Math.max(state.screenshot.width, state.screenshot.height) <= 1280, 'screenshot respects the payload budget')
      expect(state.screenshot.scale > 0, 'screenshot reports a positive coordinate scale')
    }
  }
  if (runActions) {
    runActionSmoke(app, state)
  }
}

if (failures > 0) fail(`${failures} app snapshot smoke check(s) failed`)

function runActionSmoke(app, state) {
  const selector = state.snapshot.app.bundleId ?? app
  const windowFlags = state.snapshot.window.id != null && capabilities.supports.windows.targetById ? ['--window-id', String(state.snapshot.window.id)] : state.snapshot.window.index != null ? ['--window-index', String(state.snapshot.window.index)] : []
  const action = (verb, extra) => {
    const result = runCli(['computer', verb, '--app', selector, ...windowFlags, '--restore-window', '--no-screenshot', ...extra, '--json'], { allowFailure: true })
    expect(result.ok, result.ok ? `${verb} succeeds` : `${verb} succeeds (${JSON.stringify(result.error)})`)
    if (!result.ok) return null
    expect(typeof result.result.snapshot?.treeText === 'string', `${verb} returns a fresh snapshot`)
    expect(typeof result.result.action?.verification?.state === 'string', `${verb} reports verification`)
    console.log(`computer-use smoke: ${verb}: ${result.result.action.path}, ${result.result.action.verification.state}${result.result.action.verification.reason ? ` (${result.result.action.verification.reason})` : ''}`)
    return result.result
  }
  action('press-key', ['--key', 'Escape'])
  if (capabilities.supports.actions.hotkey) action('hotkey', ['--key', 'CmdOrCtrl+A'])
  action('scroll', ['--x', '40', '--y', '40', '--direction', 'down'])
  if (selector === 'com.apple.TextEdit' || ['textedit', 'text editor', 'gedit', 'notepad'].includes(app.toLowerCase())) {
    const fresh = runCli(['computer', 'get-app-state', '--app', selector, ...windowFlags, '--no-screenshot', '--json'])
    const line = String(fresh.snapshot.treeText).split('\n').find((l) => /^\s*\d+ (text(?: entry area| area| field)?|entry|edit|document)\b/i.test(l))
    const index = line?.match(/^\s*(\d+)\s/)?.[1]
    if (index) {
      action('click', ['--element-index', index])
      const refreshed = runCli(['computer', 'get-app-state', '--app', selector, ...windowFlags, '--no-screenshot', '--json'])
      const freshIndex = String(refreshed.snapshot.treeText).split('\n').find((l) => /^\s*\d+ (text(?: entry area| area| field)?|entry|edit|document)\b/i.test(l))?.match(/^\s*(\d+)\s/)?.[1]
      expect(Boolean(freshIndex), 'editable element remains after click')
      if (!freshIndex) return
      const set = action('set-value', ['--element-index', freshIndex, '--value', 'computer-use smoke'])
      expect(set?.action?.verification?.state === 'verified', 'set-value on a text field reports verified')
      const typed = action('type-text', ['--text', ' typed'])
      const afterTyping = runCli(['computer', 'get-app-state', '--app', selector, ...windowFlags, '--no-screenshot', '--json'])
      expect(String(afterTyping.snapshot?.treeText).includes('typed'), 'type-text content appears in the editor')
      // The helper reads the focused text back when it can; otherwise
      // synthetic input must be reported as unverified, never as success.
      if (capabilities.supports.actions.pasteText) {
        const pasted = action('paste-text', ['--text', ' pasted'])
        expect(pasted?.action?.verification?.reason === 'clipboard_paste', 'paste-text reports clipboard paste')
        expect(String(pasted?.snapshot?.treeText).includes('pasted'), 'paste-text content appears in the editor')
      }
      if (capabilities.supports.actions.drag) {
        const x = Math.max(1, Math.floor(state.snapshot.window.width / 3))
        const y = Math.max(1, Math.floor(state.snapshot.window.height / 2))
        action('drag', ['--from-x', String(x), '--from-y', String(y), '--to-x', String(x + 30), '--to-y', String(y)])
      }
      const v = typed?.action?.verification
      expect(v?.state === 'verified' || v?.reason === 'synthetic_input', 'type-text is verified by read-back or reported as synthetic input')
    } else {
      expect(false, `${app} has an editable text area for set-value`)
    }
  }
}

function valueFlag(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

function runCli(cliArgs, options = {}) {
  const child = spawnSync(cli, [...cliPrefix, ...cliArgs], { encoding: 'utf8', env: process.env, timeout: 70_000, maxBuffer: 20 * 1024 * 1024, windowsHide: true })
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

// Node cannot exec a .cmd file directly. Resolve only our known launchers to
// the executable they name, then pass argv without a command shell.
function resolveLauncher() {
  if (process.platform === 'win32') {
    const resolved = spawnSync('where.exe', [cli], { encoding: 'utf8', windowsHide: true })
    const path = resolved.status === 0 ? resolved.stdout.trim().split(/\r?\n/)[0] : cli
    if (path.toLowerCase().endsWith('.cmd')) {
      const contents = readFileSync(path, 'utf8')
      if (contents.includes('"%~dp0raccoon.exe" terminalx %*')) {
        cli = join(dirname(path), 'raccoon.exe')
      } else if (contents.includes('rem TerminalX CLI shim')) {
        cli = contents.match(/^"(.+)" terminalx %\*/m)?.[1]?.replaceAll('%%', '%') ?? fail('unrecognized TerminalX shim')
      } else fail('Set TERMINALX_COMPUTER_SMOKE_CLI to the TerminalX executable')
      cliPrefix = ['terminalx']
    }
  }
  if (/^raccoon(?:\.exe)?$/i.test(basename(cli))) cliPrefix = ['terminalx']
}
