// キーを 1 回押す。使い方: swift key.swift KEYCODE [FLAGS]（FLAGS: cmd=1048576, shift=131072）
import CoreGraphics
import Foundation

let code = CGKeyCode(UInt16(CommandLine.arguments[1])!)
let flags = CommandLine.arguments.count > 2
  ? CGEventFlags(rawValue: UInt64(CommandLine.arguments[2])!) : []
for down in [true, false] {
  let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
  e?.flags = flags
  e?.post(tap: .cghidEventTap)
  usleep(30_000)
}
