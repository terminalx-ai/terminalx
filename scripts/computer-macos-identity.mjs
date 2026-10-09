// The code identity of the macOS computer-use helper. Kept apart from the
// build script so it can be tested without building anything.

// Helpers released under these ids trust whoever starts them (PRO-90). The app
// takes their permissions away; nothing is ever built under them again.
export const legacyHelperBundleIds = ['com.terminalx.next.computer-use', 'com.terminalx.next.dev.computer-use']

export function helperBundleId({ dev, override }) {
  const id = override ?? (dev ? 'com.terminalx.next.dev.computer-use.v2' : 'com.terminalx.next.computer-use.v2')
  if (legacyHelperBundleIds.includes(id.trim().toLowerCase())) {
    throw new Error(`"${id}" is the id of a computer-use helper from before PRO-90 and must not be built again`)
  }
  return id
}
