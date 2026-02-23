/**
 * macOS action handler — AXUIElement + Quartz CGEvent action execution.
 *
 * Uses JXA (JavaScript for Automation via osascript) for AX accessibility
 * actions and a compiled Swift helper for low-level CGEvent keyboard/mouse
 * input. This mirrors the Python SDK's cup/actions/_macos.py implementation.
 */

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import type { ActionResult } from "../types.js";
import type { ActionHandler } from "./handler.js";
import { parseCombo } from "./keys.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Virtual keycode mapping for macOS (CGKeyCode values)
// ---------------------------------------------------------------------------

const VK_MAP: Record<string, number> = {
  enter: 0x24,
  return: 0x24,
  tab: 0x30,
  escape: 0x35,
  space: 0x31,
  backspace: 0x33,
  delete: 0x75,
  up: 0x7e,
  down: 0x7d,
  left: 0x7b,
  right: 0x7c,
  home: 0x73,
  end: 0x77,
  pageup: 0x74,
  pagedown: 0x79,
  f1: 0x7a,
  f2: 0x78,
  f3: 0x63,
  f4: 0x76,
  f5: 0x60,
  f6: 0x61,
  f7: 0x62,
  f8: 0x64,
  f9: 0x65,
  f10: 0x6d,
  f11: 0x67,
  f12: 0x6f,
  // Letters
  a: 0x00, b: 0x0b, c: 0x08, d: 0x02, e: 0x0e,
  f: 0x03, g: 0x05, h: 0x04, i: 0x22, j: 0x26,
  k: 0x28, l: 0x25, m: 0x2e, n: 0x2d, o: 0x1f,
  p: 0x23, q: 0x0c, r: 0x0f, s: 0x01, t: 0x11,
  u: 0x20, v: 0x09, w: 0x0d, x: 0x07, y: 0x10,
  z: 0x06,
  // Numbers
  "0": 0x1d, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15,
  "5": 0x17, "6": 0x16, "7": 0x1a, "8": 0x1c, "9": 0x19,
  // Punctuation / symbols
  "-": 0x1b, "=": 0x18, "[": 0x21, "]": 0x1e, "\\": 0x2a,
  ";": 0x29, "'": 0x27, ",": 0x2b, ".": 0x2f, "/": 0x2c,
  "`": 0x32,
  minus: 0x1b, equal: 0x18, plus: 0x18,
};

// Modifier flag bits for CGEventSetFlags
const MOD_FLAGS: Record<string, number> = {
  meta: 1 << 20,   // kCGEventFlagMaskCommand
  ctrl: 1 << 18,   // kCGEventFlagMaskControl
  alt: 1 << 19,    // kCGEventFlagMaskAlternate
  shift: 1 << 17,  // kCGEventFlagMaskShift
};

// Modifier virtual keycodes
const MOD_VK: Record<string, number> = {
  meta: 0x37,   // kVK_Command
  ctrl: 0x3b,   // kVK_Control
  alt: 0x3a,    // kVK_Option
  shift: 0x38,  // kVK_Shift
};

// ---------------------------------------------------------------------------
// Swift helper — compiled once and cached
// ---------------------------------------------------------------------------

let _swiftHelperPath: string | null = null;

/**
 * Swift source for low-level CGEvent operations.
 *
 * Compiled to a binary on first use and cached in a temp directory.
 * Supports: key_combo, type_string, mouse_click, mouse_scroll, mouse_longpress
 */
const SWIFT_HELPER_SOURCE = `
import Cocoa
import Foundation

// MARK: - Key combo

func sendKeyCombo(keycodes: [Int], flags: Int) {
    for vk in keycodes {
        let down = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(vk), keyDown: true)!
        if flags != 0 { down.flags = CGEventFlags(rawValue: UInt64(flags)) }
        down.post(tap: .cghidEventTap)
    }
    usleep(10000)
    for vk in keycodes.reversed() {
        let up = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(vk), keyDown: false)!
        if flags != 0 { up.flags = CGEventFlags(rawValue: UInt64(flags)) }
        up.post(tap: .cghidEventTap)
    }
    usleep(10000)
}

// MARK: - Type string (Unicode)

func typeString(_ text: String) {
    for char in text {
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)!
        let chars = Array(String(char).utf16)
        down.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
        down.post(tap: .cghidEventTap)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)!
        up.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
        up.post(tap: .cghidEventTap)
    }
    usleep(10000)
}

// MARK: - Mouse operations

func moveMouse(x: Double, y: Double) {
    let point = CGPoint(x: x, y: y)
    let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)!
    move.post(tap: .cghidEventTap)
    usleep(20000)
}

func mouseClick(x: Double, y: Double, button: String, count: Int) {
    let point = CGPoint(x: x, y: y)
    moveMouse(x: x, y: y)

    let isRight = button == "right"
    let downType: CGEventType = isRight ? .rightMouseDown : .leftMouseDown
    let upType: CGEventType = isRight ? .rightMouseUp : .leftMouseUp
    let mouseBtn: CGMouseButton = isRight ? .right : .left

    for i in 0..<count {
        let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: mouseBtn)!
        down.setIntegerValueField(.mouseEventClickState, value: Int64(i + 1))
        down.post(tap: .cghidEventTap)
        usleep(10000)
        let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: mouseBtn)!
        up.setIntegerValueField(.mouseEventClickState, value: Int64(i + 1))
        up.post(tap: .cghidEventTap)
        if i < count - 1 { usleep(20000) }
    }
    usleep(10000)
}

func mouseLongPress(x: Double, y: Double, durationMs: Int) {
    let point = CGPoint(x: x, y: y)
    moveMouse(x: x, y: y)
    let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)!
    down.post(tap: .cghidEventTap)
    usleep(UInt32(durationMs) * 1000)
    let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)!
    up.post(tap: .cghidEventTap)
    usleep(10000)
}

func mouseScroll(x: Double, y: Double, dx: Int, dy: Int) {
    let point = CGPoint(x: x, y: y)
    moveMouse(x: x, y: y)
    let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0)!
    event.location = point
    event.post(tap: .cghidEventTap)
    usleep(20000)
}

// MARK: - Main dispatch

let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("Usage: cup-helper <command> [args...]\\n", stderr)
    exit(1)
}

let command = args[1]

switch command {
case "key_combo":
    // key_combo <keycodes_csv> <flags>
    guard args.count >= 4 else { fputs("key_combo requires keycodes and flags\\n", stderr); exit(1) }
    let keycodes = args[2].split(separator: ",").compactMap { Int($0) }
    let flags = Int(args[3]) ?? 0
    sendKeyCombo(keycodes: keycodes, flags: flags)
    print("ok")

case "type_string":
    // type_string <text>
    guard args.count >= 3 else { fputs("type_string requires text\\n", stderr); exit(1) }
    let text = args[2]
    typeString(text)
    print("ok")

case "mouse_click":
    // mouse_click <x> <y> <button> <count>
    guard args.count >= 6 else { fputs("mouse_click requires x y button count\\n", stderr); exit(1) }
    let x = Double(args[2]) ?? 0
    let y = Double(args[3]) ?? 0
    let button = args[4]
    let count = Int(args[5]) ?? 1
    mouseClick(x: x, y: y, button: button, count: count)
    print("ok")

case "mouse_longpress":
    // mouse_longpress <x> <y> <duration_ms>
    guard args.count >= 5 else { fputs("mouse_longpress requires x y duration_ms\\n", stderr); exit(1) }
    let x = Double(args[2]) ?? 0
    let y = Double(args[3]) ?? 0
    let durationMs = Int(args[4]) ?? 800
    mouseLongPress(x: x, y: y, durationMs: durationMs)
    print("ok")

case "mouse_scroll":
    // mouse_scroll <x> <y> <dx> <dy>
    guard args.count >= 6 else { fputs("mouse_scroll requires x y dx dy\\n", stderr); exit(1) }
    let x = Double(args[2]) ?? 0
    let y = Double(args[3]) ?? 0
    let dx = Int(args[4]) ?? 0
    let dy = Int(args[5]) ?? 0
    mouseScroll(x: x, y: y, dx: dx, dy: dy)
    print("ok")

default:
    fputs("Unknown command: \\(command)\\n", stderr)
    exit(1)
}
`;

async function getSwiftHelper(): Promise<string> {
  if (_swiftHelperPath && fs.existsSync(_swiftHelperPath)) {
    return _swiftHelperPath;
  }

  const cacheDir = path.join(os.tmpdir(), "cup-swift-helpers");
  fs.mkdirSync(cacheDir, { recursive: true });

  const srcPath = path.join(cacheDir, "cup-helper.swift");
  const binPath = path.join(cacheDir, "cup-helper");

  // Check if already compiled
  if (fs.existsSync(binPath)) {
    _swiftHelperPath = binPath;
    return binPath;
  }

  // Write and compile
  fs.writeFileSync(srcPath, SWIFT_HELPER_SOURCE);
  await execFileAsync("swiftc", [
    "-O", "-o", binPath, srcPath,
    "-framework", "Cocoa",
  ], { timeout: 60000 });

  _swiftHelperPath = binPath;
  return binPath;
}

async function runSwiftHelper(...args: string[]): Promise<string> {
  const helper = await getSwiftHelper();
  const { stdout, stderr } = await execFileAsync(helper, args, { timeout: 10000 });
  if (stderr && stderr.trim()) {
    throw new Error(stderr.trim());
  }
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// JXA (JavaScript for Automation) helpers for AXUIElement operations
// ---------------------------------------------------------------------------

async function runJxa(script: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    "osascript",
    ["-l", "JavaScript", "-e", script],
    { timeout: 10000 },
  );
  return stdout.trim();
}

/**
 * Run JXA that operates on an AXUIElement via System Events.
 *
 * nativeRef is expected to be an object with:
 *   { pid: number, path?: number[] }
 * where path is the index chain from app → window → ... → element.
 */
interface MacosNativeRef {
  pid: number;
  path?: number[];
  bounds?: { x: number; y: number; w: number; h: number };
}

function getElementCenter(ref: MacosNativeRef): { x: number; y: number } | null {
  if (!ref.bounds) return null;
  return {
    x: ref.bounds.x + ref.bounds.w / 2,
    y: ref.bounds.y + ref.bounds.h / 2,
  };
}

// AX actions via JXA
async function axPerformAction(ref: MacosNativeRef, actionName: string): Promise<boolean> {
  if (!ref.pid || !ref.path) return false;
  try {
    const pathStr = JSON.stringify(ref.path);
    const script = `
      ObjC.import('ApplicationServices');
      const app = $.AXUIElementCreateApplication(${ref.pid});
      let el = app;
      const path = ${pathStr};
      for (const idx of path) {
        const childrenRef = Ref();
        const err = $.AXUIElementCopyAttributeValue(el, 'AXChildren', childrenRef);
        if (err !== 0) { "fail"; }
        const children = ObjC.unwrap(childrenRef[0]);
        if (!children || idx >= children.length) { "fail"; }
        el = children[idx];
      }
      const err2 = $.AXUIElementPerformAction(el, '${actionName}');
      err2 === 0 ? "ok" : "fail";
    `;
    const result = await runJxa(script);
    return result.includes("ok");
  } catch {
    return false;
  }
}

async function axSetAttribute(ref: MacosNativeRef, attr: string, value: string): Promise<boolean> {
  if (!ref.pid || !ref.path) return false;
  try {
    const pathStr = JSON.stringify(ref.path);
    const escapedValue = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
    const script = `
      ObjC.import('ApplicationServices');
      const app = $.AXUIElementCreateApplication(${ref.pid});
      let el = app;
      const path = ${pathStr};
      for (const idx of path) {
        const childrenRef = Ref();
        const err = $.AXUIElementCopyAttributeValue(el, 'AXChildren', childrenRef);
        if (err !== 0) { "fail"; }
        const children = ObjC.unwrap(childrenRef[0]);
        if (!children || idx >= children.length) { "fail"; }
        el = children[idx];
      }
      const err2 = $.AXUIElementSetAttributeValue(el, '${attr}', $('${escapedValue}'));
      err2 === 0 ? "ok" : "fail";
    `;
    const result = await runJxa(script);
    return result.includes("ok");
  } catch {
    return false;
  }
}

async function axSetFocus(ref: MacosNativeRef): Promise<void> {
  await axPerformAction(ref, "AXRaise");
  await axSetAttribute(ref, "AXFocused", "1");
}

// ---------------------------------------------------------------------------
// App launching helpers
// ---------------------------------------------------------------------------

function discoverApps(): Map<string, string> {
  const apps = new Map<string, string>();

  const appDirs = [
    "/Applications",
    "/Applications/Utilities",
    "/System/Applications",
    "/System/Applications/Utilities",
    path.join(os.homedir(), "Applications"),
  ];

  for (const appDir of appDirs) {
    try {
      if (!fs.existsSync(appDir)) continue;
      for (const entry of fs.readdirSync(appDir)) {
        if (entry.endsWith(".app")) {
          const appName = entry.slice(0, -4);
          apps.set(appName.toLowerCase(), path.join(appDir, entry));
        }
      }
    } catch {
      continue;
    }
  }

  // Also search via mdfind for Homebrew casks, etc.
  try {
    const result = execFileSync(
      "mdfind",
      ["kMDItemContentType == 'com.apple.application-bundle'"],
      { timeout: 5000, encoding: "utf-8" },
    );
    for (const line of result.trim().split("\n")) {
      const trimmed = line.trim();
      if (trimmed.endsWith(".app")) {
        const appName = path.basename(trimmed).slice(0, -4);
        if (!apps.has(appName.toLowerCase())) {
          apps.set(appName.toLowerCase(), trimmed);
        }
      }
    }
  } catch {
    // mdfind may not be available or may timeout
  }

  return apps;
}

function fuzzyMatch(
  query: string,
  candidates: string[],
  cutoff = 0.5,
): string | null {
  const queryLower = query.toLowerCase().trim();

  // Exact match
  if (candidates.includes(queryLower)) return queryLower;

  // Substring match — prefer shorter candidates
  const substringMatches = candidates.filter((c) => c.includes(queryLower));
  if (substringMatches.length > 0) {
    // Prefer word-boundary matches
    const pattern = new RegExp(`(?:^|[\\s\\-_])${queryLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[\\s\\-_])`);
    const wordBoundary = substringMatches.filter((c) => pattern.test(c));
    if (wordBoundary.length > 0) {
      return wordBoundary.reduce((a, b) => (a.length <= b.length ? a : b));
    }
    return substringMatches.reduce((a, b) => (a.length <= b.length ? a : b));
  }

  // Reverse substring
  for (const c of candidates) {
    if (queryLower.includes(c)) return c;
  }

  // Simple similarity score (Dice coefficient on bigrams)
  function bigrams(s: string): Set<string> {
    const b = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) b.add(s.slice(i, i + 2));
    return b;
  }
  function dice(a: string, b: string): number {
    const ba = bigrams(a);
    const bb = bigrams(b);
    if (ba.size === 0 && bb.size === 0) return 1;
    if (ba.size === 0 || bb.size === 0) return 0;
    let overlap = 0;
    for (const x of ba) if (bb.has(x)) overlap++;
    return (2 * overlap) / (ba.size + bb.size);
  }

  let bestMatch: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = dice(queryLower, c);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = c;
    }
  }

  return bestMatch && bestScore >= cutoff ? bestMatch : null;
}

// ---------------------------------------------------------------------------
// MacosActionHandler
// ---------------------------------------------------------------------------

export class MacosActionHandler implements ActionHandler {
  async execute(
    nativeRef: unknown,
    action: string,
    params: Record<string, unknown>,
  ): Promise<ActionResult> {
    const ref = nativeRef as MacosNativeRef | null;

    switch (action) {
      case "click":
        return this._click(ref);
      case "toggle":
        return this._toggle(ref);
      case "type":
        return this._type(ref, String(params.value ?? ""));
      case "setvalue":
        return this._setvalue(ref, String(params.value ?? ""));
      case "expand":
        return this._expand(ref);
      case "collapse":
        return this._collapse(ref);
      case "select":
        return this._select(ref);
      case "scroll":
        return this._scroll(ref, String(params.direction ?? "down"));
      case "increment":
        return this._increment(ref);
      case "decrement":
        return this._decrement(ref);
      case "rightclick":
        return this._rightclick(ref);
      case "doubleclick":
        return this._doubleclick(ref);
      case "focus":
        return this._focus(ref);
      case "dismiss":
        return this._dismiss(ref);
      case "longpress":
        return this._longpress(ref);
      default:
        return {
          success: false,
          message: "",
          error: `Action '${action}' not implemented for macOS`,
        };
    }
  }

  async pressKeys(combo: string): Promise<ActionResult> {
    try {
      const [modNames, keyNames] = parseCombo(combo);

      // Build modifier flags mask
      let flags = 0;
      for (const m of modNames) {
        flags |= MOD_FLAGS[m] ?? 0;
      }

      // Resolve main keycodes
      const mainKeys: number[] = [];
      for (const k of keyNames) {
        const vk = VK_MAP[k] ?? VK_MAP[k.toLowerCase()];
        if (vk !== undefined) mainKeys.push(vk);
      }

      // If only modifiers specified, treat them as key presses
      if (mainKeys.length === 0 && modNames.length > 0) {
        for (const m of modNames) {
          if (MOD_VK[m] !== undefined) mainKeys.push(MOD_VK[m]);
        }
        flags = 0;
      }

      if (mainKeys.length === 0) {
        return {
          success: false,
          message: "",
          error: `Could not resolve any key codes from combo: '${combo}'`,
        };
      }

      await runSwiftHelper("key_combo", mainKeys.join(","), String(flags));
      return { success: true, message: `Pressed ${combo}` };
    } catch (err) {
      return {
        success: false,
        message: "",
        error: `Failed to press keys '${combo}': ${err}`,
      };
    }
  }

  async launchApp(name: string): Promise<ActionResult> {
    if (!name || !name.trim()) {
      return {
        success: false,
        message: "",
        error: "App name must not be empty",
      };
    }

    try {
      const apps = discoverApps();
      if (apps.size === 0) {
        return {
          success: false,
          message: "",
          error: "Could not discover installed applications",
        };
      }

      const match = fuzzyMatch(name, [...apps.keys()]);
      if (!match) {
        return {
          success: false,
          message: "",
          error: `No installed app matching '${name}' found`,
        };
      }

      const appPath = apps.get(match)!;
      const displayName = match
        .split(/[\s-_]+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");

      // Launch via `open -a`
      await execFileAsync("open", ["-a", appPath], { timeout: 10000 });

      // Wait for the window to appear (poll for up to 8 seconds)
      const deadline = Date.now() + 8000;
      const pattern = new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      while (Date.now() < deadline) {
        try {
          const { stdout } = await execFileAsync(
            "osascript",
            [
              "-l", "JavaScript", "-e",
              `Application("System Events").processes.whose({backgroundOnly: false}).name()`,
            ],
            { timeout: 3000 },
          );
          if (pattern.test(stdout)) {
            return { success: true, message: `${displayName} launched` };
          }
        } catch {
          // ignore
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      return {
        success: true,
        message: `${displayName} launch sent, but window not yet detected`,
      };
    } catch (err) {
      return {
        success: false,
        message: "",
        error: `Failed to launch '${name}': ${err}`,
      };
    }
  }

  // -- individual actions --------------------------------------------------

  private async _click(ref: MacosNativeRef | null): Promise<ActionResult> {
    // Try AXPress first
    if (ref && await axPerformAction(ref, "AXPress")) {
      return { success: true, message: "Clicked" };
    }

    // Try AXConfirm
    if (ref && await axPerformAction(ref, "AXConfirm")) {
      return { success: true, message: "Clicked (confirm)" };
    }

    // Fallback: mouse click at element center
    const center = ref ? getElementCenter(ref) : null;
    if (center) {
      try {
        await runSwiftHelper("mouse_click", String(center.x), String(center.y), "left", "1");
        return { success: true, message: "Clicked (mouse fallback)" };
      } catch (err) {
        return { success: false, message: "", error: `Mouse click failed: ${err}` };
      }
    }

    return { success: false, message: "", error: "Element does not support click and has no bounds" };
  }

  private async _toggle(ref: MacosNativeRef | null): Promise<ActionResult> {
    if (ref && await axPerformAction(ref, "AXPress")) {
      return { success: true, message: "Toggled" };
    }
    return { success: false, message: "", error: "Element does not support toggle" };
  }

  private async _type(ref: MacosNativeRef | null, text: string): Promise<ActionResult> {
    try {
      // Focus the element first
      if (ref) {
        await axSetFocus(ref);
      }

      // Strategy 1: Set AXValue directly
      if (ref && await axSetAttribute(ref, "AXValue", text)) {
        return { success: true, message: `Typed: ${text}` };
      }

      // Strategy 2: Click to ensure focus, select all, then type via CGEvent
      const center = ref ? getElementCenter(ref) : null;
      if (center) {
        await runSwiftHelper("mouse_click", String(center.x), String(center.y), "left", "1");
        await new Promise((r) => setTimeout(r, 50));
      }

      // Select all then type
      await runSwiftHelper("key_combo", String(VK_MAP.a), String(MOD_FLAGS.meta));
      await new Promise((r) => setTimeout(r, 50));
      await runSwiftHelper("type_string", text);

      return { success: true, message: `Typed: ${text}` };
    } catch (err) {
      return { success: false, message: "", error: `Failed to type: ${err}` };
    }
  }

  private async _setvalue(ref: MacosNativeRef | null, text: string): Promise<ActionResult> {
    if (ref && await axSetAttribute(ref, "AXValue", text)) {
      return { success: true, message: `Set value to: ${text}` };
    }
    // Fallback: type
    return this._type(ref, text);
  }

  private async _expand(ref: MacosNativeRef | null): Promise<ActionResult> {
    if (ref && await axPerformAction(ref, "AXPress")) {
      return { success: true, message: "Expanded" };
    }
    return { success: false, message: "", error: "Element does not support expand" };
  }

  private async _collapse(ref: MacosNativeRef | null): Promise<ActionResult> {
    if (ref && await axPerformAction(ref, "AXPress")) {
      return { success: true, message: "Collapsed" };
    }
    return { success: false, message: "", error: "Element does not support collapse" };
  }

  private async _select(ref: MacosNativeRef | null): Promise<ActionResult> {
    if (ref && await axPerformAction(ref, "AXPick")) {
      return { success: true, message: "Selected" };
    }
    if (ref && await axPerformAction(ref, "AXPress")) {
      return { success: true, message: "Selected" };
    }
    // Fallback: click
    return this._click(ref);
  }

  private async _scroll(ref: MacosNativeRef | null, direction: string): Promise<ActionResult> {
    const center = ref ? getElementCenter(ref) : null;
    if (center) {
      try {
        const amount = 5;
        let dx = 0;
        let dy = 0;
        if (direction === "up") dy = amount;
        else if (direction === "down") dy = -amount;
        else if (direction === "left") dx = amount;
        else if (direction === "right") dx = -amount;

        await runSwiftHelper(
          "mouse_scroll",
          String(center.x), String(center.y),
          String(dx), String(dy),
        );
        return { success: true, message: `Scrolled ${direction}` };
      } catch (err) {
        return { success: false, message: "", error: `Scroll failed: ${err}` };
      }
    }
    return { success: false, message: "", error: "Element has no bounds for scroll target" };
  }

  private async _increment(ref: MacosNativeRef | null): Promise<ActionResult> {
    if (ref && await axPerformAction(ref, "AXIncrement")) {
      return { success: true, message: "Incremented" };
    }
    return { success: false, message: "", error: "Element does not support increment" };
  }

  private async _decrement(ref: MacosNativeRef | null): Promise<ActionResult> {
    if (ref && await axPerformAction(ref, "AXDecrement")) {
      return { success: true, message: "Decremented" };
    }
    return { success: false, message: "", error: "Element does not support decrement" };
  }

  private async _rightclick(ref: MacosNativeRef | null): Promise<ActionResult> {
    if (ref && await axPerformAction(ref, "AXShowMenu")) {
      return { success: true, message: "Right-clicked (context menu)" };
    }
    const center = ref ? getElementCenter(ref) : null;
    if (center) {
      try {
        await runSwiftHelper("mouse_click", String(center.x), String(center.y), "right", "1");
        return { success: true, message: "Right-clicked" };
      } catch (err) {
        return { success: false, message: "", error: `Right-click failed: ${err}` };
      }
    }
    return { success: false, message: "", error: "Element has no bounds for right-click" };
  }

  private async _doubleclick(ref: MacosNativeRef | null): Promise<ActionResult> {
    const center = ref ? getElementCenter(ref) : null;
    if (center) {
      try {
        await runSwiftHelper("mouse_click", String(center.x), String(center.y), "left", "2");
        return { success: true, message: "Double-clicked" };
      } catch (err) {
        return { success: false, message: "", error: `Double-click failed: ${err}` };
      }
    }
    return { success: false, message: "", error: "Element has no bounds for double-click" };
  }

  private async _focus(ref: MacosNativeRef | null): Promise<ActionResult> {
    if (ref) {
      await axSetFocus(ref);
      return { success: true, message: "Focused" };
    }
    return { success: false, message: "", error: "Failed to focus element" };
  }

  private async _dismiss(ref: MacosNativeRef | null): Promise<ActionResult> {
    if (ref && await axPerformAction(ref, "AXCancel")) {
      return { success: true, message: "Dismissed" };
    }
    // Fallback: send Escape
    try {
      if (ref) await axSetFocus(ref);
      await runSwiftHelper("key_combo", String(VK_MAP.escape), "0");
      return { success: true, message: "Dismissed (Escape)" };
    } catch (err) {
      return { success: false, message: "", error: `Failed to dismiss: ${err}` };
    }
  }

  private async _longpress(ref: MacosNativeRef | null): Promise<ActionResult> {
    const center = ref ? getElementCenter(ref) : null;
    if (center) {
      try {
        await runSwiftHelper("mouse_longpress", String(center.x), String(center.y), "800");
        return { success: true, message: "Long-pressed" };
      } catch (err) {
        return { success: false, message: "", error: `Long-press failed: ${err}` };
      }
    }
    return { success: false, message: "", error: "Element has no bounds for long-press" };
  }
}
