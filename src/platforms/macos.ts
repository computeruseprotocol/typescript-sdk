/**
 * macOS platform adapter.
 *
 * Uses JXA (JavaScript for Automation via osascript) for window enumeration,
 * screen info, and foreground detection. Tree capture uses a compiled Swift
 * helper that walks the AXUIElement tree and outputs compact JSON.
 *
 * Ported from python-sdk/cup/platforms/macos.py
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import type { PlatformAdapter } from "../base.js";
import type { CupNode, TreeStats, WindowInfo, WindowMetadata } from "../types.js";

const execFileAsync = promisify(execFile);

// Process names that are macOS system daemons with on-screen layer-0 windows
// but should NOT appear in user-facing app lists.
const SYSTEM_OWNER_NAMES = new Set([
  "WindowServer",
  "Dock",
  "SystemUIServer",
  "Control Center",
  "Notification Center",
  "loginwindow",
  "Window Manager",
  "Spotlight",
]);

// ---------------------------------------------------------------------------
// JXA helpers
// ---------------------------------------------------------------------------

async function runJxa(script: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "osascript",
    ["-l", "JavaScript", "-e", script],
    { timeout: 10000 },
  );
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Screen info
// ---------------------------------------------------------------------------

async function macosScreenInfo(): Promise<[number, number, number]> {
  const result = await runJxa(`
    ObjC.import('AppKit');
    const screen = $.NSScreen.mainScreen;
    const frame = screen.frame;
    const scale = screen.backingScaleFactor;
    JSON.stringify({
      w: frame.size.width,
      h: frame.size.height,
      scale: scale,
    });
  `);
  const info = JSON.parse(result);
  return [Math.round(info.w), Math.round(info.h), info.scale];
}

// ---------------------------------------------------------------------------
// Window enumeration via CGWindowList (always fresh from window server)
// ---------------------------------------------------------------------------

interface CgWindowApp {
  pid: number;
  owner: string;
}

/**
 * Return apps with on-screen, normal-layer (layer 0) windows via
 * CGWindowListCopyWindowInfo. This is always fresh from the window server,
 * unlike NSWorkspace.runningApplications() which can be stale in
 * long-running processes without an NSRunLoop.
 */
async function cgWindowApps(): Promise<CgWindowApp[]> {
  try {
    const result = await runJxa(`
      ObjC.import('CoreGraphics');
      const wins = $.CGWindowListCopyWindowInfo(
        $.kCGWindowListOptionOnScreenOnly, 0
      );
      const apps = [];
      const seenPids = {};
      for (let i = 0; i < wins.count; i++) {
        const w = wins.objectAtIndex(i);
        const layer = ObjC.unwrap(w.objectForKey('kCGWindowLayer'));
        if (layer !== 0) continue;
        const pid = ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID'));
        const owner = ObjC.unwrap(w.objectForKey('kCGWindowOwnerName'));
        if (!pid || !owner) continue;
        if (seenPids[pid]) continue;
        seenPids[pid] = true;
        apps.push({ pid: pid, owner: owner });
      }
      JSON.stringify(apps);
    `);
    return JSON.parse(result);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Foreground app
// ---------------------------------------------------------------------------

async function macosForegroundApp(): Promise<{
  pid: number;
  name: string;
  bundleId: string | null;
}> {
  const result = await runJxa(`
    ObjC.import('AppKit');
    const ws = $.NSWorkspace.sharedWorkspace;
    const app = ws.frontmostApplication;
    JSON.stringify({
      pid: app.processIdentifier,
      name: ObjC.unwrap(app.localizedName) || '',
      bundleId: ObjC.unwrap(app.bundleIdentifier) || null,
    });
  `);
  return JSON.parse(result);
}

// ---------------------------------------------------------------------------
// Visible apps (NSWorkspace + CGWindowList cross-check)
// ---------------------------------------------------------------------------

async function macosVisibleApps(): Promise<
  Array<{ pid: number; name: string; bundleId: string | null }>
> {
  // Strategy 1: NSWorkspace.runningApplications() — has bundle IDs
  const nsResult = await runJxa(`
    ObjC.import('AppKit');
    const ws = $.NSWorkspace.sharedWorkspace;
    const running = ws.runningApplications;
    const apps = [];
    for (let i = 0; i < running.count; i++) {
      const a = running.objectAtIndex(i);
      if (a.activationPolicy === $.NSApplicationActivationPolicyRegular) {
        apps.push({
          pid: a.processIdentifier,
          name: ObjC.unwrap(a.localizedName) || '',
          bundleId: ObjC.unwrap(a.bundleIdentifier) || null,
        });
      }
    }
    JSON.stringify(apps);
  `);
  const apps: Array<{ pid: number; name: string; bundleId: string | null }> =
    JSON.parse(nsResult);

  // Strategy 2: Cross-check with CGWindowList for fresh data
  const seenPids = new Set(apps.map((a) => a.pid));
  const cgApps = await cgWindowApps();
  for (const cg of cgApps) {
    if (!seenPids.has(cg.pid) && !SYSTEM_OWNER_NAMES.has(cg.owner)) {
      apps.push({ pid: cg.pid, name: cg.owner, bundleId: null });
      seenPids.add(cg.pid);
    }
  }

  return apps;
}

// ---------------------------------------------------------------------------
// AXRole -> CUP role mapping (ported from Python SDK)
// ---------------------------------------------------------------------------

const CUP_ROLES: Record<string, string> = {
  AXApplication: "application",
  AXWindow: "window",
  AXButton: "button",
  AXCheckBox: "checkbox",
  AXRadioButton: "radio",
  AXComboBox: "combobox",
  AXPopUpButton: "combobox",
  AXTextField: "textbox",
  AXTextArea: "textbox",
  AXStaticText: "text",
  AXImage: "img",
  AXLink: "link",
  AXList: "list",
  AXOutline: "tree",
  AXTable: "table",
  AXTabGroup: "tablist",
  AXSlider: "slider",
  AXProgressIndicator: "progressbar",
  AXMenu: "menu",
  AXMenuBar: "menubar",
  AXMenuBarItem: "menuitem",
  AXMenuItem: "menuitem",
  AXToolbar: "toolbar",
  AXScrollBar: "scrollbar",
  AXScrollArea: "generic",
  AXGroup: "group",
  AXSplitGroup: "group",
  AXSplitter: "separator",
  AXHeading: "heading",
  AXWebArea: "document",
  AXCell: "cell",
  AXRow: "row",
  AXColumn: "columnheader",
  AXSheet: "alertdialog",
  AXDrawer: "complementary",
  AXGrowArea: "generic",
  AXValueIndicator: "generic",
  AXIncrementor: "spinbutton",
  AXHelpTag: "tooltip",
  AXColorWell: "button",
  AXDisclosureTriangle: "button",
  AXDateField: "textbox",
  AXBrowser: "tree",
  AXBusyIndicator: "progressbar",
  AXRuler: "generic",
  AXRulerMarker: "generic",
  AXRelevanceIndicator: "progressbar",
  AXLevelIndicator: "slider",
  AXLayoutArea: "group",
  AXLayoutItem: "generic",
  AXHandle: "generic",
  AXMatte: "generic",
  AXUnknown: "generic",
  AXListMarker: "text",
  AXMenuButton: "button",
  AXRadioGroup: "group",
};

// Subrole refinements: key is "AXRole:AXSubrole" -> CUP role
const CUP_SUBROLE_OVERRIDES: Record<string, string> = {
  "AXGroup:AXApplicationAlert": "alert",
  "AXGroup:AXApplicationDialog": "dialog",
  "AXGroup:AXApplicationStatus": "status",
  "AXGroup:AXLandmarkNavigation": "navigation",
  "AXGroup:AXLandmarkSearch": "search",
  "AXGroup:AXLandmarkRegion": "region",
  "AXGroup:AXLandmarkMain": "main",
  "AXGroup:AXLandmarkComplementary": "complementary",
  "AXGroup:AXLandmarkContentInfo": "contentinfo",
  "AXGroup:AXLandmarkBanner": "banner",
  "AXGroup:AXDocument": "document",
  "AXGroup:AXWebApplication": "application",
  "AXGroup:AXTab": "tabpanel",
  "AXWindow:AXDialog": "dialog",
  "AXWindow:AXFloatingWindow": "dialog",
  "AXWindow:AXSystemDialog": "dialog",
  "AXWindow:AXSystemFloatingWindow": "dialog",
  "AXButton:AXCloseButton": "button",
  "AXButton:AXMinimizeButton": "button",
  "AXButton:AXFullScreenButton": "button",
  "AXRadioButton:AXTabButton": "tab",
  "AXMenuItem:AXMenuItemCheckbox": "menuitemcheckbox",
  "AXMenuItem:AXMenuItemRadio": "menuitemradio",
  "AXTextField:AXSearchField": "searchbox",
  "AXTextField:AXSecureTextField": "textbox",
  "AXStaticText:AXApplicationStatus": "status",
  "AXRow:AXOutlineRow": "treeitem",
  "AXCheckBox:AXToggle": "switch",
  "AXCheckBox:AXSwitch": "switch",
};

// Roles that accept text input
const TEXT_INPUT_ROLES = new Set(["textbox", "searchbox", "combobox", "document"]);

// Roles representing toggle-like elements
const TOGGLE_ROLES = new Set(["checkbox", "switch", "menuitemcheckbox"]);

// AX roles where AXExpanded is semantically meaningful
const EXPANDABLE_AX_ROLES = new Set([
  "AXComboBox",
  "AXPopUpButton",
  "AXOutline",
  "AXDisclosureTriangle",
  "AXMenu",
  "AXMenuItem",
  "AXMenuBarItem",
  "AXRow",
  "AXBrowser",
  "AXSheet",
  "AXDrawer",
  "AXTabGroup",
]);

// AX roles where action list is skipped for performance
const SKIP_ACTIONS_AX_ROLES = new Set([
  "AXStaticText",
  "AXHeading",
  "AXColumn",
  "AXScrollArea",
  "AXSplitGroup",
  "AXSplitter",
  "AXGrowArea",
  "AXValueIndicator",
  "AXRuler",
  "AXRulerMarker",
  "AXLayoutArea",
  "AXLayoutItem",
  "AXHandle",
  "AXMatte",
  "AXUnknown",
  "AXListMarker",
  "AXBusyIndicator",
  "AXRelevanceIndicator",
  "AXLevelIndicator",
  "AXWebArea",
]);

// Roles where value is emitted
const VALUE_ROLES = new Set([
  "textbox", "searchbox", "combobox", "spinbutton",
  "slider", "progressbar", "document",
]);

// ---------------------------------------------------------------------------
// Swift AX tree capture helper — compiled once and cached
// ---------------------------------------------------------------------------

let _axHelperPath: string | null = null;

/**
 * Swift source for AXUIElement tree walking.
 *
 * Compiled to a binary on first use and cached in a temp directory.
 * Accepts: <pid> [maxDepth] [screenW] [screenH]
 * Outputs: JSON array of flat nodes with depth, mirroring the Windows C# helper pattern.
 *
 * Each node is a compact JSON object with abbreviated keys to minimize IPC overhead.
 */
const AX_HELPER_SWIFT = `
import Cocoa
import ApplicationServices

// MARK: - JSON helpers

var nodeCounter = 0
var sb = ""
var firstNode = true

func jsonEscape(_ s: String) -> String {
    var r = ""
    r.reserveCapacity(s.count)
    for c in s {
        switch c {
        case "\\"": r += "\\\\\\\""
        case "\\\\": r += "\\\\\\\\"
        case "\\n": r += "\\\\n"
        case "\\r": r += "\\\\r"
        case "\\t": r += "\\\\t"
        default:
            if c.asciiValue != nil && c.asciiValue! < 0x20 {
                r += String(format: "\\\\u%04x", c.asciiValue!)
            } else {
                r.append(c)
            }
        }
    }
    return r
}

func truncate(_ s: String, _ maxLen: Int) -> String {
    if s.count <= maxLen { return s }
    return String(s.prefix(maxLen))
}

// MARK: - AX attribute reading

func getAttr(_ el: AXUIElement, _ attr: String) -> AnyObject? {
    var value: AnyObject?
    let err = AXUIElementCopyAttributeValue(el, attr as CFString, &value)
    guard err == .success else { return nil }
    return value
}

func getStringAttr(_ el: AXUIElement, _ attr: String) -> String? {
    guard let val = getAttr(el, attr) else { return nil }
    if let s = val as? String { return s }
    return nil
}

func getBoolAttr(_ el: AXUIElement, _ attr: String) -> Bool? {
    guard let val = getAttr(el, attr) else { return nil }
    if let n = val as? NSNumber { return n.boolValue }
    if let b = val as? Bool { return b }
    return nil
}

func getNumberAttr(_ el: AXUIElement, _ attr: String) -> NSNumber? {
    guard let val = getAttr(el, attr) else { return nil }
    if let n = val as? NSNumber { return n }
    return nil
}

func getActions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    let err = AXUIElementCopyActionNames(el, &names)
    guard err == .success, let actions = names as? [String] else { return [] }
    return actions
}

func isSettable(_ el: AXUIElement, _ attr: String) -> Bool {
    var settable: DarwinBoolean = false
    let err = AXUIElementIsAttributeSettable(el, attr as CFString, &settable)
    return err == .success && settable.boolValue
}

// MARK: - Bounds extraction

struct Bounds {
    var x: Int
    var y: Int
    var w: Int
    var h: Int
}

func getBounds(_ el: AXUIElement) -> Bounds? {
    guard let posVal = getAttr(el, kAXPositionAttribute as String),
          let sizeVal = getAttr(el, kAXSizeAttribute as String) else { return nil }

    var point = CGPoint.zero
    var size = CGSize.zero

    guard AXValueGetValue(posVal as! AXValue, .cgPoint, &point),
          AXValueGetValue(sizeVal as! AXValue, .cgSize, &size) else { return nil }

    return Bounds(x: Int(point.x), y: Int(point.y), w: Int(size.width), h: Int(size.height))
}

// MARK: - Tree walker

let skipActionsRoles: Set<String> = [
    "AXStaticText", "AXHeading", "AXColumn", "AXScrollArea", "AXSplitGroup",
    "AXSplitter", "AXGrowArea", "AXValueIndicator", "AXRuler", "AXRulerMarker",
    "AXLayoutArea", "AXLayoutItem", "AXHandle", "AXMatte", "AXUnknown",
    "AXListMarker", "AXBusyIndicator", "AXRelevanceIndicator", "AXLevelIndicator",
    "AXWebArea"
]

let expandableRoles: Set<String> = [
    "AXComboBox", "AXPopUpButton", "AXOutline", "AXDisclosureTriangle",
    "AXMenu", "AXMenuItem", "AXMenuBarItem", "AXRow", "AXBrowser",
    "AXSheet", "AXDrawer", "AXTabGroup"
]

var screenW = 99999
var screenH = 99999

func walkTree(_ el: AXUIElement, depth: Int, maxDepth: Int, path: [Int]) {
    if depth > maxDepth { return }

    // Read core attributes via batch
    let attrs: [String] = [
        kAXRoleAttribute as String,           // 0
        kAXSubroleAttribute as String,        // 1
        kAXTitleAttribute as String,          // 2
        kAXDescriptionAttribute as String,    // 3
        kAXHelpAttribute as String,           // 4
        kAXIdentifierAttribute as String,     // 5
        kAXValueAttribute as String,          // 6
        kAXEnabledAttribute as String,        // 7
        kAXFocusedAttribute as String,        // 8
        kAXSelectedAttribute as String,       // 9
        kAXExpandedAttribute as String,       // 10
        "AXElementBusy",                      // 11
        kAXModalAttribute as String,          // 12
        kAXPositionAttribute as String,       // 13
        kAXSizeAttribute as String,           // 14
        "AXRequired",                         // 15
        "AXIsEditable",                       // 16
        kAXChildrenAttribute as String,       // 17
    ]

    var values: CFArray?
    let batchErr = AXUIElementCopyMultipleAttributeValues(el, attrs as CFArray, 0, &values)
    let vals: [AnyObject?]
    if batchErr == .success, let arr = values as? [AnyObject?] {
        vals = arr.map { v in
            // Check for error sentinels
            if v == nil { return nil }
            if let axVal = v as? AXValue {
                let t = AXValueGetType(axVal)
                if t.rawValue == 5 { return nil }  // kAXValueAXErrorType
            }
            return v
        }
    } else {
        return  // Can't read element
    }

    guard vals.count >= 18 else { return }

    // Unpack core
    guard let axRole = vals[0] as? String else { return }
    let axSubrole = vals[1] as? String
    let title = vals[2] as? String
    let desc = vals[3] as? String
    let help = vals[4] as? String
    let axIdentifier = vals[5] as? String
    let rawValue = vals[6]

    // Name
    var name = title ?? desc ?? ""
    if name.isEmpty && (axRole == "AXStaticText" || axRole == "AXHeading") {
        if let s = rawValue as? String { name = s }
    }

    // Bounds
    var bounds: Bounds? = nil
    if let posVal = vals[13], let sizeVal = vals[14] {
        var point = CGPoint.zero
        var size = CGSize.zero
        if let pv = posVal as? AXValue, let sv = sizeVal as? AXValue {
            if AXValueGetValue(pv, .cgPoint, &point) && AXValueGetValue(sv, .cgSize, &size) {
                bounds = Bounds(x: Int(point.x), y: Int(point.y), w: Int(size.width), h: Int(size.height))
            }
        }
    }

    // State booleans
    let isEnabledVal = vals[7]
    let isEnabled: Bool = {
        if let n = isEnabledVal as? NSNumber { return n.boolValue }
        return true
    }()
    let isFocused = (vals[8] as? NSNumber)?.boolValue ?? false
    let isSelected = (vals[9] as? NSNumber)?.boolValue ?? false
    let isBusy = (vals[11] as? NSNumber)?.boolValue ?? false
    let isModal = (vals[12] as? NSNumber)?.boolValue ?? false
    let isRequired = (vals[15] as? NSNumber)?.boolValue ?? false
    let isEditableRaw = (vals[16] as? NSNumber)?.boolValue ?? false

    // Expanded state
    let expandedVal = vals[10]
    let hasExpanded = expandableRoles.contains(axRole) && expandedVal != nil
    let isExpanded: Bool? = hasExpanded ? ((expandedVal as? NSNumber)?.boolValue ?? false) : nil

    // Value string
    var valStr = ""
    if let v = rawValue {
        if let s = v as? String { valStr = s }
        else if let n = v as? NSNumber { valStr = n.stringValue }
    }

    // Editable
    var isEditable = isEditableRaw

    // Offscreen
    var isOffscreen = false
    if let b = bounds {
        if b.w <= 0 || b.h <= 0 || b.x + b.w <= 0 || b.y + b.h <= 0 || b.x >= screenW || b.y >= screenH {
            isOffscreen = true
        }
    }

    // Actions
    let skipActions = skipActionsRoles.contains(axRole) || (axRole == "AXGroup" && name.isEmpty)
    let axActionList: [String] = skipActions ? [] : getActions(el)

    // Emit JSON node
    let nodeId = "e\\(nodeCounter)"
    nodeCounter += 1

    if !firstNode { sb += "," }
    firstNode = false

    sb += "{"
    sb += "\\"id\\":\\"\\(nodeId)\\",\\"d\\":\\(depth)"
    sb += ",\\"p\\":[\\(path.map { String($0) }.joined(separator: ","))]"
    sb += ",\\"ar\\":\\"\\(jsonEscape(axRole))\\""
    if let sr = axSubrole { sb += ",\\"asr\\":\\"\\(jsonEscape(sr))\\"" }
    if !name.isEmpty { sb += ",\\"nm\\":\\"\\(jsonEscape(truncate(name, 200)))\\""  }
    if let d = desc, !d.isEmpty, d != name { sb += ",\\"ds\\":\\"\\(jsonEscape(truncate(d, 200)))\\""  }
    if let h = help, !h.isEmpty { sb += ",\\"hl\\":\\"\\(jsonEscape(truncate(h, 200)))\\""  }
    if let ai = axIdentifier, !ai.isEmpty { sb += ",\\"axi\\":\\"\\(jsonEscape(ai))\\""  }
    if !valStr.isEmpty { sb += ",\\"val\\":\\"\\(jsonEscape(truncate(valStr, 200)))\\""  }
    if let b = bounds { sb += ",\\"bx\\":[\\(b.x),\\(b.y),\\(b.w),\\(b.h)]" }
    if !isEnabled { sb += ",\\"en\\":0" }
    if isFocused { sb += ",\\"fo\\":1" }
    if isSelected { sb += ",\\"sel\\":1" }
    if isBusy { sb += ",\\"busy\\":1" }
    if isModal { sb += ",\\"mod\\":1" }
    if isRequired { sb += ",\\"req\\":1" }
    if isOffscreen { sb += ",\\"os\\":1" }
    if hasExpanded { sb += ",\\"exp\\":\\(isExpanded! ? 1 : 0)" }
    if isEditable { sb += ",\\"ed\\":1" }

    // Text input settable check (only for text roles)
    let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox"]
    if textRoles.contains(axRole) && !isEditable {
        if isSettable(el, kAXValueAttribute as String) {
            sb += ",\\"ed\\":1"
            isEditable = true
        }
    }

    // Actions array
    if !axActionList.isEmpty {
        let filtered = axActionList.filter { $0 != "AXScrollToVisible" && $0 != "AXShowMenu" }
        if !filtered.isEmpty {
            sb += ",\\"acts\\":["
            sb += filtered.map { "\\"\\(jsonEscape($0))\\"" }.joined(separator: ",")
            sb += "]"
        }
    }

    // Role-specific attributes
    if axRole == "AXRow", let dl = getNumberAttr(el, "AXDisclosureLevel") {
        sb += ",\\"lvl\\":\\(dl.intValue + 1)"
    }

    let rangeRoles: Set<String> = ["AXSlider", "AXProgressIndicator", "AXIncrementor", "AXScrollBar", "AXLevelIndicator"]
    if rangeRoles.contains(axRole) {
        if let mn = getNumberAttr(el, "AXMinValue") { sb += ",\\"rmn\\":\\(mn.doubleValue)" }
        if let mx = getNumberAttr(el, "AXMaxValue") { sb += ",\\"rmx\\":\\(mx.doubleValue)" }
        if let rv = rawValue as? NSNumber { sb += ",\\"rvl\\":\\(rv.doubleValue)" }
    }

    let inputRoles: Set<String> = ["AXTextField", "AXComboBox"]
    if inputRoles.contains(axRole) {
        if let ph = getStringAttr(el, "AXPlaceholderValue"), !ph.isEmpty {
            sb += ",\\"ph\\":\\"\\(jsonEscape(truncate(ph, 200)))\\""
        }
    }

    if axRole == "AXLink" {
        if let url = getAttr(el, "AXURL") {
            let urlStr = "\\(url)"
            if !urlStr.isEmpty {
                sb += ",\\"url\\":\\"\\(jsonEscape(truncate(urlStr, 500)))\\""
            }
        }
    }

    let orientRoles: Set<String> = ["AXScrollBar", "AXSlider", "AXSplitter", "AXToolbar", "AXTabGroup"]
    if orientRoles.contains(axRole) {
        if let ori = getStringAttr(el, "AXOrientation") {
            if ori.contains("Vertical") { sb += ",\\"ori\\":\\"v\\"" }
            else if ori.contains("Horizontal") { sb += ",\\"ori\\":\\"h\\"" }
        }
    }

    sb += "}"

    // Walk children
    if depth < maxDepth {
        if let childrenArr = vals[17] as? [AXUIElement] {
            for (i, child) in childrenArr.enumerated() {
                walkTree(child, depth: depth + 1, maxDepth: maxDepth, path: path + [i])
            }
        }
    }
}

// MARK: - Main

let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("Usage: cup-ax-helper <pid> [maxDepth] [screenW] [screenH]\\n", stderr)
    exit(1)
}

let pid = pid_t(Int32(args[1]) ?? 0)
let maxDepth = args.count >= 3 ? (Int(args[2]) ?? 999) : 999
screenW = args.count >= 4 ? (Int(args[3]) ?? 99999) : 99999
screenH = args.count >= 5 ? (Int(args[4]) ?? 99999) : 99999

let appRef = AXUIElementCreateApplication(pid)

// Try focused window first, fall back to main window, then all windows
var windowRefs: [AXUIElement] = []
if let focused = getAttr(appRef, kAXFocusedWindowAttribute as String) as! AXUIElement? {
    windowRefs.append(focused)
} else if let main = getAttr(appRef, kAXMainWindowAttribute as String) as! AXUIElement? {
    windowRefs.append(main)
} else if let wins = getAttr(appRef, kAXWindowsAttribute as String) as? [AXUIElement] {
    windowRefs = wins
}

sb = "["
firstNode = true
// Get all windows list to determine each window's index
var allWindows: [AXUIElement] = []
if let wins = getAttr(appRef, kAXWindowsAttribute as String) as? [AXUIElement] {
    allWindows = wins
}

for (winIdx, win) in windowRefs.enumerated() {
    // Find this window's index in the full windows list
    var windowIndex = winIdx
    for (i, w) in allWindows.enumerated() {
        if CFEqual(w, win) { windowIndex = i; break }
    }
    walkTree(win, depth: 0, maxDepth: maxDepth, path: [windowIndex])
}
sb += "]"

print(sb)
`;

async function getAxHelper(): Promise<string> {
  if (_axHelperPath && fs.existsSync(_axHelperPath)) {
    return _axHelperPath;
  }

  const cacheDir = path.join(os.tmpdir(), "cup-swift-helpers");
  fs.mkdirSync(cacheDir, { recursive: true });

  const srcPath = path.join(cacheDir, "cup-ax-helper.swift");
  const binPath = path.join(cacheDir, "cup-ax-helper");

  // Check if already compiled
  if (fs.existsSync(binPath)) {
    _axHelperPath = binPath;
    return binPath;
  }

  // Write and compile
  fs.writeFileSync(srcPath, AX_HELPER_SWIFT);
  try {
    await execFileAsync("swiftc", [
      "-O", "-o", binPath, srcPath,
      "-framework", "Cocoa",
      "-framework", "ApplicationServices",
    ], { timeout: 120000 });
  } catch (err) {
    throw new Error(`Failed to compile Swift AX helper: ${err}`);
  }

  _axHelperPath = binPath;
  return binPath;
}

// ---------------------------------------------------------------------------
// Raw node from Swift helper JSON → CUP node builder
// ---------------------------------------------------------------------------

interface RawAxNode {
  id: string;
  d: number;       // depth
  p: number[];     // path (child index chain from app ref)
  ar: string;      // axRole
  asr?: string;    // axSubrole
  nm?: string;     // name
  ds?: string;     // description
  hl?: string;     // help
  axi?: string;    // axIdentifier
  val?: string;    // value
  bx?: [number, number, number, number]; // bounds
  en?: 0;          // 0 = disabled
  fo?: 1;          // focused
  sel?: 1;         // selected
  busy?: 1;        // busy
  mod?: 1;         // modal
  req?: 1;         // required
  os?: 1;          // offscreen
  exp?: 0 | 1;     // expanded (0=collapsed, 1=expanded, absent=N/A)
  ed?: 1;          // editable
  acts?: string[]; // AX actions
  lvl?: number;    // tree item level
  rmn?: number;    // range min
  rmx?: number;    // range max
  rvl?: number;    // range value
  ph?: string;     // placeholder
  url?: string;    // link URL
  ori?: "h" | "v"; // orientation
}

function buildCupNodeFromAx(raw: RawAxNode): CupNode {
  const axRole = raw.ar;
  const axSubrole = raw.asr ?? null;

  // Role mapping: subrole override first, then primary mapping
  let role: string;
  if (axSubrole) {
    const overrideKey = `${axRole}:${axSubrole}`;
    role = CUP_SUBROLE_OVERRIDES[overrideKey] ?? CUP_ROLES[axRole] ?? "generic";
  } else {
    role = CUP_ROLES[axRole] ?? "generic";
  }

  const name = (raw.nm ?? "").slice(0, 200);
  const isEnabled = raw.en !== 0;
  const isEditable = raw.ed === 1;
  const hasExpanded = raw.exp !== undefined;
  const isExpanded = raw.exp === 1;
  const valStr = raw.val ?? "";

  // States
  const states: string[] = [];
  if (!isEnabled) states.push("disabled");
  if (raw.fo === 1) states.push("focused");
  if (raw.os === 1) states.push("offscreen");
  if (raw.sel === 1) states.push("selected");
  if (raw.busy === 1) states.push("busy");
  if (raw.mod === 1) states.push("modal");
  if (raw.req === 1) states.push("required");

  if (hasExpanded) {
    states.push(isExpanded ? "expanded" : "collapsed");
  }

  // Checked/mixed for toggles
  if (TOGGLE_ROLES.has(role) && valStr) {
    const intVal = parseInt(valStr, 10);
    if (intVal === 1) states.push("checked");
    else if (intVal === 2) states.push("mixed");
  }

  if (isEditable) states.push("editable");
  else if (TEXT_INPUT_ROLES.has(role) && !isEditable) states.push("readonly");

  // Actions — map from AX action names to CUP canonical actions
  const actions: string[] = [];
  const axActions = raw.acts ?? [];
  for (const axAct of axActions) {
    if (axAct === "AXPress") {
      if (TOGGLE_ROLES.has(role)) {
        actions.push("toggle");
      } else if (["listitem", "option", "tab", "treeitem", "menuitem", "menuitemcheckbox", "menuitemradio"].includes(role)) {
        actions.push("select");
      } else {
        actions.push("click");
      }
    } else if (axAct === "AXIncrement") {
      actions.push("increment");
    } else if (axAct === "AXDecrement") {
      actions.push("decrement");
    } else if (axAct === "AXCancel") {
      actions.push("dismiss");
    } else if (axAct === "AXRaise") {
      actions.push("focus");
    } else if (axAct === "AXConfirm") {
      actions.push("click");
    } else if (axAct === "AXPick") {
      if (!actions.includes("select")) actions.push("select");
    }
  }

  // Text input actions
  if (TEXT_INPUT_ROLES.has(role) && isEditable) {
    if (!actions.includes("setvalue")) actions.push("setvalue");
    if (!actions.includes("type")) actions.push("type");
  }

  // Expand/collapse from expanded state
  if (hasExpanded) {
    if (!actions.includes("expand")) actions.push("expand");
    if (!actions.includes("collapse")) actions.push("collapse");
  }

  // Scroll areas
  if (axRole === "AXScrollArea" && !actions.includes("scroll")) {
    actions.push("scroll");
  }

  // Fallback: focusable
  if (actions.length === 0 && isEnabled) {
    actions.push("focus");
  }

  // Attributes
  const attrs: Record<string, unknown> = {};
  if (raw.lvl !== undefined) attrs.level = raw.lvl;
  if (raw.rmn !== undefined) attrs.valueMin = raw.rmn;
  if (raw.rmx !== undefined) attrs.valueMax = raw.rmx;
  if (raw.rvl !== undefined) attrs.valueNow = raw.rvl;
  if (raw.ph) attrs.placeholder = raw.ph.slice(0, 200);
  if (raw.url && role === "link") attrs.url = raw.url.slice(0, 500);
  if (raw.ori) {
    const orientableRoles = new Set(["scrollbar", "slider", "separator", "toolbar", "tablist"]);
    if (orientableRoles.has(role)) {
      attrs.orientation = raw.ori === "v" ? "vertical" : "horizontal";
    }
  }

  // Build CUP node
  const node: CupNode = {
    id: raw.id,
    role,
    name,
  };

  // Description: use help text, or description if title was used as name
  const descText = raw.hl || ((raw.nm && raw.ds) ? raw.ds : "") || "";
  if (descText) node.description = descText.slice(0, 200);

  if (valStr && VALUE_ROLES.has(role)) {
    node.value = valStr.slice(0, 200);
  }
  if (raw.bx) {
    node.bounds = { x: raw.bx[0], y: raw.bx[1], w: raw.bx[2], h: raw.bx[3] };
  }
  if (states.length) node.states = states;
  if (actions.length) node.actions = actions;
  if (Object.keys(attrs).length) node.attributes = attrs as CupNode["attributes"];

  // Platform extension
  const pm: Record<string, unknown> = { axRole };
  if (axSubrole) pm.axSubrole = axSubrole;
  if (raw.axi) pm.axIdentifier = raw.axi;
  if (axActions.length) pm.axActions = axActions;
  node.platform = { macos: pm };

  return node;
}

// ---------------------------------------------------------------------------
// Build hierarchical tree from flat depth-ordered array
// ---------------------------------------------------------------------------

function buildTreeFromFlat(flatNodes: RawAxNode[]): CupNode[] {
  if (flatNodes.length === 0) return [];

  const cupNodes = flatNodes.map(buildCupNodeFromAx);

  const roots: CupNode[] = [];
  const stack: Array<{ node: CupNode; depth: number }> = [];

  for (let i = 0; i < cupNodes.length; i++) {
    const node = cupNodes[i];
    const depth = flatNodes[i].d;

    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      const parent = stack[stack.length - 1].node;
      if (!parent.children) parent.children = [];
      parent.children.push(node);
    }

    stack.push({ node, depth });
  }

  return roots;
}

// ---------------------------------------------------------------------------
// MacosAdapter
// ---------------------------------------------------------------------------

export class MacosAdapter implements PlatformAdapter {
  private _initialized = false;

  get platformName(): string {
    return "macos";
  }

  async initialize(): Promise<void> {
    if (this._initialized) return;
    // Pre-compile AX helper on first init
    await getAxHelper();
    this._initialized = true;
  }

  async getScreenInfo(): Promise<[number, number, number]> {
    return macosScreenInfo();
  }

  async getForegroundWindow(): Promise<WindowMetadata> {
    const fg = await macosForegroundApp();
    return {
      handle: { pid: fg.pid },
      title: fg.name,
      pid: fg.pid,
      bundle_id: fg.bundleId,
    };
  }

  async getAllWindows(): Promise<WindowMetadata[]> {
    const apps = await macosVisibleApps();
    return apps.map((a) => ({
      handle: { pid: a.pid },
      title: a.name,
      pid: a.pid,
      bundle_id: a.bundleId,
    }));
  }

  async getWindowList(): Promise<WindowInfo[]> {
    const fg = await macosForegroundApp();
    const apps = await macosVisibleApps();
    const seen = new Set<number>();
    const results: WindowInfo[] = [];

    for (const a of apps) {
      if (seen.has(a.pid)) continue;
      seen.add(a.pid);
      results.push({
        title: a.name,
        pid: a.pid,
        bundle_id: a.bundleId,
        foreground: a.pid === fg.pid,
        bounds: null,
      });
    }

    return results;
  }

  async getDesktopWindow(): Promise<WindowMetadata | null> {
    const apps = await macosVisibleApps();
    const finder = apps.find((a) => a.bundleId === "com.apple.finder");
    if (finder) {
      return {
        handle: { pid: finder.pid },
        title: "Desktop",
        pid: finder.pid,
        bundle_id: finder.bundleId,
      };
    }
    return null;
  }

  async captureTree(
    windows: WindowMetadata[],
    options?: { maxDepth?: number },
  ): Promise<[CupNode[], TreeStats, Map<string, unknown>]> {
    await this.initialize();

    const maxDepth = options?.maxDepth ?? 999;
    const [screenW, screenH] = await this.getScreenInfo();
    const helperBin = await getAxHelper();

    const stats: TreeStats = { nodes: 0, max_depth: 0, roles: {} };
    const refs = new Map<string, unknown>();
    const tree: CupNode[] = [];

    // Collect unique PIDs from windows
    const pids = new Set<number>();
    for (const win of windows) {
      const handle = win.handle as { pid: number };
      if (handle?.pid) pids.add(handle.pid);
    }

    // Walk each app's tree via the Swift helper
    for (const pid of pids) {
      try {
        const { stdout } = await execFileAsync(helperBin, [
          String(pid),
          String(maxDepth),
          String(screenW),
          String(screenH),
        ], { timeout: 30000, maxBuffer: 50 * 1024 * 1024 });

        const rawNodes: RawAxNode[] = JSON.parse(stdout.trim() || "[]");

        // Accumulate stats
        for (const raw of rawNodes) {
          stats.nodes++;
          stats.max_depth = Math.max(stats.max_depth, raw.d);
          const roleKey = raw.asr ? `${raw.ar}:${raw.asr}` : raw.ar;
          stats.roles[roleKey] = (stats.roles[roleKey] ?? 0) + 1;
        }

        // Build hierarchical tree
        const roots = buildTreeFromFlat(rawNodes);
        for (const root of roots) tree.push(root);

        // Store refs: element IDs → { pid, path, bounds } for action execution.
        // The action handler uses pid + path to navigate to the AX element via JXA.
        for (const raw of rawNodes) {
          refs.set(raw.id, {
            pid,
            path: raw.p,
            bounds: raw.bx ? { x: raw.bx[0], y: raw.bx[1], w: raw.bx[2], h: raw.bx[3] } : undefined,
          });
        }
      } catch {
        // App may have quit or accessibility denied, skip
        continue;
      }
    }

    return [tree, stats, refs];
  }
}
