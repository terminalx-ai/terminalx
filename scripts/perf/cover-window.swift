// Covers the main window of process <pid> with a plain window for <seconds>,
// without activating anything: how a window is when another one is in front
// of it. For the benchmark's occluded-window scenario (issue #232).
//   swift scripts/perf/cover-window.swift <pid> <seconds>
import AppKit
import CoreGraphics

let arguments = CommandLine.arguments
guard arguments.count == 3, let pid = Int(arguments[1]), let seconds = Double(arguments[2]) else {
  FileHandle.standardError.write("usage: cover-window.swift <pid> <seconds>\n".data(using: .utf8)!)
  exit(2)
}
let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
var target: CGRect? = nil
for window in windows where (window[kCGWindowOwnerPID as String] as? Int) == pid && (window[kCGWindowLayer as String] as? Int) == 0 {
  let bounds = CGRect(dictionaryRepresentation: window[kCGWindowBounds as String] as! CFDictionary)!
  if bounds.width > 600 && bounds.height > 300 { target = bounds }
}
guard let bounds = target, let screen = NSScreen.screens.first else {
  FileHandle.standardError.write("no window of that process\n".data(using: .utf8)!)
  exit(1)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// CoreGraphics counts from the top of the main screen, AppKit from its bottom.
let frame = NSRect(x: bounds.minX - 20, y: screen.frame.height - bounds.maxY - 20, width: bounds.width + 40, height: bounds.height + 40)
let cover = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
cover.isOpaque = true
cover.backgroundColor = .darkGray
cover.orderFrontRegardless()
print("covering")
fflush(stdout)
DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { exit(0) }
app.run()
