import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '..')

function source(path) {
  return readFileSync(join(projectDir, path), 'utf8')
}

function sourceBetween(contents, startMarker, endMarker) {
  const start = contents.indexOf(startMarker)
  const end = contents.indexOf(endMarker, start + startMarker.length)
  if (start === -1 || end === -1) {
    throw new Error(`Missing source boundary: ${startMarker} → ${endMarker}`)
  }
  return contents.slice(start, end)
}

describe('computer-use mouse button routing', () => {




  it('keeps every platform from resolving a middle click through its accessibility path', () => {
    const windows = source('native/computer-use-windows/runtime.ps1')
    const windowsClick = sourceBetween(
      windows,
      '$handledByPattern = $false',
      'if (-not $handledByPattern)'
    )

    expect(windowsClick).toContain('$Operation.mouse_button -ne "middle"')

    const linux = source('native/computer-use-linux/runtime.py')
    const linuxClick = sourceBetween(linux, 'has_modifiers = bool(', 'if not handled:')

    expect(linuxClick).toContain('operation.get("mouse_button", "left") == "left"')
  })
})
