// アプリのメインウィンドウの ID と位置（点）を `ID X Y W H` で出す。無ければ何も出さない。
import CoreGraphics
import Foundation

let owner = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "unnotator"
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list {
  guard (w["kCGWindowOwnerName"] as? String) == owner,
    let b = w["kCGWindowBounds"] as? [String: Any],
    let width = b["Width"] as? Double, let height = b["Height"] as? Double,
    width > 500, height > 300
  else { continue }
  print(w["kCGWindowNumber"] ?? 0, b["X"] ?? 0, b["Y"] ?? 0, width, height)
  break
}
