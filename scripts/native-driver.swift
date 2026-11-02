import AppKit
import ApplicationServices
import Foundation
import Vision

func emit(_ value: [String: Any]) {
  let bytes = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  FileHandle.standardOutput.write(bytes)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func abort(_ code: String, _ message: String) -> Never {
  let bytes = try! JSONSerialization.data(withJSONObject: ["code": code, "message": message])
  FileHandle.standardError.write(bytes)
  exit(1)
}

func visibleWindows(_ pid: pid_t) -> [[String: Any]] {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  return list.compactMap { record in
    guard (record[kCGWindowOwnerPID as String] as? Int) == Int(pid),
      (record[kCGWindowLayer as String] as? Int) == 0,
      let number = record[kCGWindowNumber as String] as? Int,
      let bounds = record[kCGWindowBounds as String] as? [String: Any],
      let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
    return ["id": number, "pid": Int(pid), "x": Double(rect.origin.x), "y": Double(rect.origin.y), "width": Double(rect.width), "height": Double(rect.height)]
  }
}

// macOS 14+ ignores activateIgnoringOtherApps from a background helper; an Accessibility-trusted
// client can still raise the owned app by setting its AXFrontmost attribute.
// NSWorkspace updates frontmostApplication from run-loop notifications; usleep would leave it stale.
func pump(_ seconds: Double) { RunLoop.current.run(until: Date(timeIntervalSinceNow: seconds)) }

func bringToFront(_ pid: pid_t) {
  if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return }
  NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateIgnoringOtherApps])
  pump(0.2)
  for _ in 0..<5 where NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
    AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    pump(0.2)
  }
  // Source links and Finder controls bring a browser or Finder forward, and neither yields focus.
  // Hiding only those apps (never quitting) lets the owned app come back to the front.
  if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != pid,
    ["com.apple.Safari", "com.google.Chrome", "com.apple.finder"].contains(front.bundleIdentifier ?? "") {
    front.hide()
    pump(0.4)
    NSRunningApplication(processIdentifier: pid)?.activate()
    pump(0.2)
    AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    pump(0.2)
  }
  // A just-activated window needs a moment to become key; a click before that only activates it.
  pump(0.4)
}

func requireOwnedFrontWindow(_ pid: pid_t, _ windowID: Int, _ point: CGPoint) {
  guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { abort("WRONG_FOREGROUND", "The owned native application is not foreground.") }
  guard visibleWindows(pid).contains(where: { ($0["id"] as? Int) == windowID }) else { abort("MISSING_WINDOW", "The owned input target is not visible.") }
  // A visible, click-through overlay (e.g. a window manager) can cover the
  // rectangle without owning input. Ask the public AX hit-test API instead.
  var hit: AXUIElement?
  guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success,
    let element = hit else { abort("HIT_TEST", "The native input destination could not be verified.") }
  var actualPID: pid_t = 0
  guard AXUIElementGetPid(element, &actualPID) == .success, actualPID == pid else { abort("OCCLUDED_TARGET", "The actual input destination is not the owned application.") }
}

@MainActor final class Probe: NSObject, NSApplicationDelegate {
  let stateFile: URL
  var window: NSWindow!
  var button: NSButton!
  var count = 0
  var eventTrace: [[String: Any]] = []
  var monitor: Any?

  init(stateFile: URL) { self.stateFile = stateFile }

  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSWindow(contentRect: NSRect(x: 120, y: 160, width: 420, height: 180),
      styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Mission Control input probe"
    window.isReleasedWhenClosed = false
    window.animationBehavior = .none
    let body = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 180))
    button = NSButton(title: "Count 0", target: self, action: #selector(clicked))
    button.frame = NSRect(x: 150, y: 65, width: 120, height: 44)
    button.bezelStyle = .rounded
    button.setAccessibilityIdentifier("mission-control-probe")
    body.addSubview(button)
    window.contentView = body
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .leftMouseDragged, .scrollWheel, .keyDown, .keyUp]) { [weak self] event in
      MainActor.assumeIsolated {
        if let self {
          self.eventTrace.append(["type": event.type.rawValue, "window": event.windowNumber,
            "x": event.locationInWindow.x, "y": event.locationInWindow.y,
            "cgX": event.cgEvent?.location.x ?? -1, "cgY": event.cgEvent?.location.y ?? -1,
            "button": event.type == .scrollWheel || event.type == .keyDown || event.type == .keyUp ? -1 : event.buttonNumber,
            "characters": event.type == .keyDown || event.type == .keyUp ? event.characters ?? "" : "",
            "deltaY": event.type == .scrollWheel ? event.scrollingDeltaY : 0])
          self.save()
        }
      }
      return event
    }
    save()
  }

  @objc func clicked() {
    count += 1
    button.title = "Count \(count)"
    save()
  }

  func save() {
    guard let body = window.contentView else { return }
    body.layoutSubtreeIfNeeded()
    window.displayIfNeeded()
    let imageURL = stateFile.deletingLastPathComponent().appendingPathComponent(count == 0 ? "probe-before.png" : "probe-after.png")
    guard let bitmap = body.bitmapImageRepForCachingDisplay(in: body.bounds) else { abort("PROBE_FRAME", "The probe view could not render a frame.") }
    body.cacheDisplay(in: body.bounds, to: bitmap)
    guard let png = bitmap.representation(using: .png, properties: [:]) else { abort("PROBE_FRAME", "The probe frame could not be encoded.") }
    do {
      try png.write(to: imageURL, options: .atomic)
      let state: [String: Any] = ["pid": Int(getpid()), "count": count, "windowId": window.windowNumber, "image": imageURL.path,
        "active": NSApp.isActive, "keyWindow": window.isKeyWindow, "events": eventTrace]
      let bytes = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
      try bytes.write(to: stateFile, options: .atomic)
    } catch { abort("PROBE_STATE", "The owned probe state could not be written.") }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { abort("USAGE", "Expected permissions, windows, click or probe-window.") }
switch command {
case "permissions":
  if args.contains("--request") { _ = CGRequestPostEventAccess() }
  emit(["accessibility": AXIsProcessTrusted(), "postEvents": CGPreflightPostEventAccess()])
case "windows":
  guard args.count == 2, let pid = Int32(args[1]), pid > 1 else { abort("INVALID_PID", "Expected a positive target PID.") }
  emit(["windows": visibleWindows(pid)])
case "focus":
  guard args.count == 2, let pid = Int32(args[1]), pid > 1, !visibleWindows(pid).isEmpty else { abort("INVALID_PID", "A visible owned application is required.") }
  bringToFront(pid)
  guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { abort("WRONG_FOREGROUND", "The owned keyboard destination could not be activated.") }
  emit(["pid": Int(pid), "foreground": true])
case "press":
  guard args.count == 3, let pid = Int32(args[1]), pid > 1, visibleWindows(pid).count == 1 else { abort("INVALID_PID", "Keyboard input needs one visible owned window.") }
  guard CGPreflightPostEventAccess() else { abort("INPUT_PERMISSION", "Native keyboard input has not been granted.") }
  let parts = args[2].lowercased().split(separator: "-").map(String.init)
  let key = parts.last ?? ""
  let codes: [String: CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,"7":26,"8":28,"0":29,"o":31,"u":32,"i":34,"p":35,"enter":36,"return":36,"l":37,"j":38,"k":40,"n":45,"m":46,"tab":48,"space":49,"backspace":51,"escape":53,"left":123,"right":124,"down":125,"up":126]
  guard let code = codes[key] else { abort("INVALID_KEY", "Unsupported native key.") }
  var flags: CGEventFlags = []
  for modifier in parts.dropLast() {
    switch modifier {
    case "cmd": flags.insert(.maskCommand)
    case "ctrl": flags.insert(.maskControl)
    case "alt": flags.insert(.maskAlternate)
    case "shift": flags.insert(.maskShift)
    default: abort("INVALID_KEY", "Unsupported native modifier.")
    }
  }
  bringToFront(pid)
  guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { abort("WRONG_FOREGROUND", "The owned keyboard destination is not foreground.") }
  // A private event source keeps synthetic modifiers out of the system's real modifier state;
  // the shared source can leave Shift/Control latched, turning every later click into a Control-click.
  let source = CGEventSource(stateID: .privateState)
  guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true), let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { abort("INPUT_EVENT", "Native key events could not be created.") }
  down.flags = flags; up.flags = flags
  down.post(tap: .cghidEventTap); usleep(30000)
  guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { abort("WRONG_FOREGROUND", "The owned keyboard destination changed.") }
  up.post(tap: .cghidEventTap); usleep(100000)
  if !flags.isEmpty, let release = CGEvent(source: source) { release.type = .flagsChanged; release.flags = []; release.post(tap: .cghidEventTap); usleep(30000) }
  emit(["pid": Int(pid), "key": args[2], "delivered": true])
case "accessibility":
  guard args.count == 2, let pid = Int32(args[1]), pid > 1, !visibleWindows(pid).isEmpty else { abort("INVALID_PID", "A visible owned application is required.") }
  let app = AXUIElementCreateApplication(pid)
  let manual = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  let enhanced = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
  emit(["pid": Int(pid), "manual": manual.rawValue, "enhanced": enhanced.rawValue])
case "ocr":
  guard args.count == 2 || args.count == 3 else { abort("INVALID_IMAGE", "An owned native screenshot is required.") }
  let url = URL(fileURLWithPath: args[1])
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = false
  request.recognitionLanguages = ["en-US"]
  do {
    try VNImageRequestHandler(url: url).perform([request])
    let query = args.count == 3 ? args[2] : nil
    var lines: [[String: Any]] = []
    var matches: [[String: Any]] = []
    func rect(_ box: CGRect) -> [String: Double] { ["x": box.minX, "y": 1 - box.maxY, "width": box.width, "height": box.height] }
    for observation in request.results ?? [] {
      guard let candidate = observation.topCandidates(1).first else { continue }
      lines.append(["text": candidate.string, "confidence": Double(candidate.confidence), "bounds": rect(observation.boundingBox)])
      if let query, !query.isEmpty {
        var range = candidate.string.startIndex..<candidate.string.endIndex
        while let found = candidate.string.range(of: query, options: [.caseInsensitive], range: range) {
          if let box = try candidate.boundingBox(for: found) {
            matches.append(["text": String(candidate.string[found]), "confidence": Double(candidate.confidence), "bounds": rect(box.boundingBox)])
          }
          if found.upperBound == candidate.string.endIndex { break }
          range = found.upperBound..<candidate.string.endIndex
        }
      }
    }
    emit(["lines": lines, "matches": matches])
  } catch { abort("OCR_FAILED", "The owned native screenshot could not be read.") }
case "activate-click":
  // When another app (e.g. Finder) will not yield focus, a click on the owned window activates it,
  // as it would for a user. The AX hit test proves the point belongs to the owned app first.
  guard args.count == 5, let pid = Int32(args[1]), pid > 1, let windowID = Int(args[2]),
    let x = Double(args[3]), let y = Double(args[4]), x.isFinite, y.isFinite else { abort("INVALID_TARGET", "Invalid PID/window/point.") }
  guard CGPreflightPostEventAccess() else { abort("INPUT_PERMISSION", "macOS has not granted native pointer input to this test helper.") }
  bringToFront(pid)
  let point = CGPoint(x: x, y: y)
  if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
    guard visibleWindows(pid).contains(where: { ($0["id"] as? Int) == windowID }) else { abort("MISSING_WINDOW", "The owned input target is not visible.") }
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(x), Float(y), &hit) == .success, let element = hit else { abort("HIT_TEST", "The native input destination could not be verified.") }
    var actualPID: pid_t = 0
    guard AXUIElementGetPid(element, &actualPID) == .success, actualPID == pid else { abort("OCCLUDED_TARGET", "The actual input destination is not the owned application.") }
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
      let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { abort("INPUT_EVENT", "Native pointer events could not be constructed.") }
    for event in [down, up] { event.setIntegerValueField(.mouseEventClickState, value: 1) }
    for _ in 0..<2 where NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
      down.post(tap: .cghidEventTap)
      usleep(30000)
      up.post(tap: .cghidEventTap)
      pump(0.8)
    }
  }
  guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { abort("WRONG_FOREGROUND", "The owned native application could not be activated.") }
  emit(["pid": Int(pid), "windowId": windowID, "foreground": true])
case "hover":
  // GPUI shows tooltips on pointer movement and hides them on mouse-down, so tooltip checks hover.
  guard args.count == 5, let pid = Int32(args[1]), pid > 1, let windowID = Int(args[2]),
    let x = Double(args[3]), let y = Double(args[4]), x.isFinite, y.isFinite else { abort("INVALID_TARGET", "Invalid PID/window/point.") }
  guard CGPreflightPostEventAccess() else { abort("INPUT_PERMISSION", "macOS has not granted native pointer input to this test helper.") }
  guard let window = visibleWindows(pid).first(where: { ($0["id"] as? Int) == windowID }),
    let left = window["x"] as? Double, let top = window["y"] as? Double,
    let width = window["width"] as? Double, let height = window["height"] as? Double,
    x >= left, y >= top, x < left + width, y < top + height else { abort("OUTSIDE_WINDOW", "The target point is outside the owned visible window.") }
  let point = CGPoint(x: x, y: y)
  bringToFront(pid)
  requireOwnedFrontWindow(pid, windowID, point)
  guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else { abort("INPUT_EVENT", "Pointer movement could not be constructed.") }
  move.post(tap: .cghidEventTap)
  usleep(100000)
  emit(["delivered": true, "transport": "owned-foreground-window-hid", "pid": Int(pid), "windowId": windowID, "x": x, "y": y])
case "click", "drag", "scroll":
  let expectedCount = command == "drag" ? 7 : 6
  guard args.count == expectedCount, let pid = Int32(args[1]), pid > 1, let windowID = Int(args[2]),
    let x = Double(args[3]), let y = Double(args[4]), x.isFinite, y.isFinite else { abort("INVALID_TARGET", "Invalid PID/window/point.") }
  guard CGPreflightPostEventAccess() else { abort("INPUT_PERMISSION", "macOS has not granted native pointer input to this test helper.") }
  guard let window = visibleWindows(pid).first(where: { ($0["id"] as? Int) == windowID }),
    let left = window["x"] as? Double, let top = window["y"] as? Double,
    let width = window["width"] as? Double, let height = window["height"] as? Double,
    x >= left, y >= top, x < left + width, y < top + height else { abort("OUTSIDE_WINDOW", "The target point is outside the owned visible window.") }
  let point = CGPoint(x: x, y: y)
  let right = command == "click" && args[5] == "right"
  if command == "click" && !["left", "right"].contains(args[5]) { abort("INVALID_BUTTON", "Only left and right pointer buttons are supported.") }
  let button: CGMouseButton = right ? .right : .left
  guard let down = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: point, mouseButton: button),
    let up = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: point, mouseButton: button) else { abort("INPUT_EVENT", "Native pointer events could not be constructed.") }
  for event in [down, up] {
    event.setIntegerValueField(.mouseEventClickState, value: 1)
  }
  bringToFront(pid)
  requireOwnedFrontWindow(pid, windowID, point)
  if command == "scroll" {
    guard let delta = Int32(args[5]), delta != 0, abs(Int64(delta)) <= 2000,
      let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0) else { abort("INVALID_SCROLL", "Scroll must be nonzero and bounded to 2000 pixels.") }
    // AppKit routes wheel input using the current pointer tracking target.
    // Refresh it after a drag before posting the wheel at the verified point.
    guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else { abort("INPUT_EVENT", "Pointer tracking could not be refreshed.") }
    move.post(tap: .cghidEventTap)
    usleep(100000)
    requireOwnedFrontWindow(pid, windowID, point)
    event.location = point
    event.post(tap: .cghidEventTap)
    usleep(100000)
    emit(["delivered": true, "transport": "owned-foreground-window-hid", "pid": Int(pid), "windowId": windowID, "deltaY": delta])
    break
  }
  // Normal WindowServer dispatch assigns the AppKit window/local coordinates.
  // Direct PID posts reached the probe with window=0 or invalid local coordinates.
  down.post(tap: .cghidEventTap)
  usleep(30000)
  var end = point
  if command == "drag" {
    guard let endX = Double(args[5]), let endY = Double(args[6]), endX.isFinite, endY.isFinite,
      endX >= left, endY >= top, endX < left + width, endY < top + height else { abort("OUTSIDE_WINDOW", "Drag destination lies outside the owned window.") }
    end = CGPoint(x: endX, y: endY)
    for step in 1...6 {
      let p = CGPoint(x: point.x + (end.x - point.x) * Double(step) / 6,
        y: point.y + (end.y - point.y) * Double(step) / 6)
      requireOwnedFrontWindow(pid, windowID, p)
      guard let event = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left) else { abort("INPUT_EVENT", "Drag event could not be constructed.") }
      event.post(tap: .cghidEventTap)
      usleep(30000)
    }
    up.location = end
  }
  requireOwnedFrontWindow(pid, windowID, end)
  up.post(tap: .cghidEventTap)
  emit(["delivered": true, "transport": "owned-foreground-window-hid", "pid": Int(pid), "windowId": windowID, "x": x, "y": y])
case "probe-window":
  guard args.count == 2 else { abort("USAGE", "A task-owned probe state path is required.") }
  MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = Probe(stateFile: URL(fileURLWithPath: args[1]))
    app.setActivationPolicy(.regular)
    app.delegate = delegate
    app.run()
    withExtendedLifetime(delegate) {}
  }
default:
  abort("USAGE", "Unknown native driver operation.")
}
