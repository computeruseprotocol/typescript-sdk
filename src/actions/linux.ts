/**
 * Linux action handler — AT-SPI2 (via D-Bus/gdbus) + xdotool action execution.
 *
 * Uses a combination of:
 *   - gdbus (GNOME D-Bus tool) to invoke AT-SPI2 actions on accessible elements
 *   - xdotool for keyboard/mouse input simulation
 *   - xte (from xautomation) as fallback for input events
 *
 * Requirements:
 *   - xdotool (for keyboard/mouse input)
 *   - gdbus (part of glib2, usually pre-installed on Linux)
 *   - AT-SPI2 enabled (default on GNOME/KDE/XFCE)
 *
 * See Python reference: cup/actions/_linux.py
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
// X11 keysym names for xdotool
// ---------------------------------------------------------------------------

const XDO_KEY_MAP: Record<string, string> = {
  enter: "Return",
  return: "Return",
  tab: "Tab",
  escape: "Escape",
  space: "space",
  backspace: "BackSpace",
  delete: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  insert: "Insert",
  f1: "F1",
  f2: "F2",
  f3: "F3",
  f4: "F4",
  f5: "F5",
  f6: "F6",
  f7: "F7",
  f8: "F8",
  f9: "F9",
  f10: "F10",
  f11: "F11",
  f12: "F12",
};

const XDO_MOD_MAP: Record<string, string> = {
  ctrl: "ctrl",
  alt: "alt",
  shift: "shift",
  meta: "super",
};

// ---------------------------------------------------------------------------
// Linux native ref interface
// ---------------------------------------------------------------------------

/**
 * Native reference for Linux AT-SPI2 elements.
 *
 * When tree capture is available, elements carry their D-Bus path
 * (bus_name + object_path) for direct AT-SPI2 action invocation.
 * As a fallback, bounds can be used for mouse-based actions.
 */
interface LinuxNativeRef {
  /** AT-SPI2 D-Bus bus name (e.g. ":1.42") */
  busName?: string;
  /** AT-SPI2 D-Bus object path (e.g. "/org/a11y/atspi/accessible/123") */
  objectPath?: string;
  /** Element bounds in screen coordinates */
  bounds?: { x: number; y: number; w: number; h: number };
  /** AT-SPI2 action names available on this element */
  actions?: string[];
  /** The Atspi accessible object (when running in-process with GObject bindings) */
  accessible?: unknown;
}

function getElementCenter(
  ref: LinuxNativeRef | null,
): { x: number; y: number } | null {
  if (!ref?.bounds) return null;
  return {
    x: Math.round(ref.bounds.x + ref.bounds.w / 2),
    y: Math.round(ref.bounds.y + ref.bounds.h / 2),
  };
}

// ---------------------------------------------------------------------------
// xdotool helpers
// ---------------------------------------------------------------------------

async function xdotool(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("xdotool", args, { timeout: 10000 });
  return stdout.trim();
}

async function sendKeyCombo(combo: string): Promise<void> {
  const [modNames, keyNames] = parseCombo(combo);

  // Build xdotool key string: "ctrl+shift+a" → "ctrl+shift+a" (xdotool uses same format)
  const parts: string[] = [];

  for (const m of modNames) {
    const mapped = XDO_MOD_MAP[m];
    if (mapped) parts.push(mapped);
  }

  for (const k of keyNames) {
    const mapped = XDO_KEY_MAP[k];
    if (mapped) {
      parts.push(mapped);
    } else if (k.length === 1) {
      parts.push(k);
    }
  }

  // If only modifiers were specified, treat them as key presses
  if (parts.length === 0 && modNames.length > 0) {
    for (const m of modNames) {
      const mapped = XDO_MOD_MAP[m];
      if (mapped) parts.push(mapped);
    }
  }

  if (parts.length === 0) {
    throw new Error(`Could not resolve any key names from combo: '${combo}'`);
  }

  await xdotool("key", "--clearmodifiers", parts.join("+"));
}

async function typeString(text: string): Promise<void> {
  await xdotool("type", "--clearmodifiers", "--", text);
}

async function mouseClick(
  x: number,
  y: number,
  button: "left" | "right" = "left",
  count = 1,
): Promise<void> {
  const btnNum = button === "right" ? "3" : "1";
  await xdotool(
    "mousemove",
    "--sync",
    String(x),
    String(y),
    "click",
    "--repeat",
    String(count),
    btnNum,
  );
}

async function mouseLongPress(
  x: number,
  y: number,
  durationMs = 800,
): Promise<void> {
  await xdotool("mousemove", "--sync", String(x), String(y));
  await xdotool("mousedown", "1");
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  await xdotool("mouseup", "1");
}

async function mouseScroll(
  x: number,
  y: number,
  direction: string,
  amount = 5,
): Promise<void> {
  await xdotool("mousemove", "--sync", String(x), String(y));

  // xdotool click button 4=up, 5=down, 6=left, 7=right
  const buttonMap: Record<string, string> = {
    up: "4",
    down: "5",
    left: "6",
    right: "7",
  };
  const btn = buttonMap[direction] ?? "5";
  await xdotool("click", "--repeat", String(amount), btn);
}

// ---------------------------------------------------------------------------
// AT-SPI2 D-Bus action helpers (via gdbus)
// ---------------------------------------------------------------------------

async function atspiDoAction(
  ref: LinuxNativeRef,
  actionName: string,
): Promise<boolean> {
  // If we have the accessible object directly (in-process), use it
  // This path is for when tree capture passes actual Atspi objects
  if (ref.accessible && typeof ref.accessible === "object") {
    try {
      const acc = ref.accessible as any;
      const actionIface = acc.get_action_iface?.();
      if (actionIface) {
        const n = actionIface.get_n_actions();
        for (let i = 0; i < n; i++) {
          const name = (actionIface.get_action_name(i) || "").toLowerCase();
          if (name === actionName) {
            return actionIface.do_action(i);
          }
        }
      }
    } catch {
      // Fall through to D-Bus path
    }
  }

  // D-Bus path: use gdbus to invoke the action
  if (!ref.busName || !ref.objectPath) return false;

  try {
    // First, find the action index by name
    const { stdout: actionCountStr } = await execFileAsync(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        ref.busName,
        "--object-path",
        ref.objectPath,
        "--method",
        "org.a11y.atspi.Action.GetActions",
      ],
      { timeout: 5000 },
    );

    // Parse the action descriptions to find our target action index
    const lowerName = actionName.toLowerCase();
    // GetActions returns an array of (name, description, keybinding) tuples
    // Find the index of the matching action
    const actionRegex = /\('([^']*)',\s*'[^']*',\s*'[^']*'\)/g;
    let match;
    let actionIndex = -1;
    let idx = 0;
    while ((match = actionRegex.exec(actionCountStr)) !== null) {
      if (match[1].toLowerCase() === lowerName) {
        actionIndex = idx;
        break;
      }
      idx++;
    }

    if (actionIndex < 0) return false;

    // Invoke the action by index
    await execFileAsync(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        ref.busName,
        "--object-path",
        ref.objectPath,
        "--method",
        "org.a11y.atspi.Action.DoAction",
        String(actionIndex),
      ],
      { timeout: 5000 },
    );

    return true;
  } catch {
    return false;
  }
}

async function atspiGrabFocus(ref: LinuxNativeRef): Promise<boolean> {
  if (ref.accessible && typeof ref.accessible === "object") {
    try {
      const acc = ref.accessible as any;
      const comp = acc.get_component_iface?.();
      if (comp) return comp.grab_focus();
    } catch {
      // Fall through
    }
  }

  if (!ref.busName || !ref.objectPath) return false;

  try {
    await execFileAsync(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        ref.busName,
        "--object-path",
        ref.objectPath,
        "--method",
        "org.a11y.atspi.Component.GrabFocus",
      ],
      { timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function atspiSetValue(
  ref: LinuxNativeRef,
  value: number,
): Promise<boolean> {
  if (ref.accessible && typeof ref.accessible === "object") {
    try {
      const acc = ref.accessible as any;
      const valueIface = acc.get_value_iface?.();
      if (valueIface) {
        valueIface.set_current_value(value);
        return true;
      }
    } catch {
      // Fall through
    }
  }

  if (!ref.busName || !ref.objectPath) return false;

  try {
    await execFileAsync(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        ref.busName,
        "--object-path",
        ref.objectPath,
        "--method",
        "org.freedesktop.DBus.Properties.Set",
        "org.a11y.atspi.Value",
        "CurrentValue",
        `<double ${value}>`,
      ],
      { timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function atspiGetCurrentValue(
  ref: LinuxNativeRef,
): Promise<number | null> {
  if (ref.accessible && typeof ref.accessible === "object") {
    try {
      const acc = ref.accessible as any;
      const valueIface = acc.get_value_iface?.();
      if (valueIface) return valueIface.get_current_value();
    } catch {
      // Fall through
    }
  }

  if (!ref.busName || !ref.objectPath) return null;

  try {
    const { stdout } = await execFileAsync(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        ref.busName,
        "--object-path",
        ref.objectPath,
        "--method",
        "org.freedesktop.DBus.Properties.Get",
        "org.a11y.atspi.Value",
        "CurrentValue",
      ],
      { timeout: 5000 },
    );
    const match = stdout.match(/(\d+(?:\.\d+)?)/);
    return match ? parseFloat(match[1]) : null;
  } catch {
    return null;
  }
}

async function atspiGetMinMaxIncrement(
  ref: LinuxNativeRef,
): Promise<{ min: number; max: number; increment: number } | null> {
  if (ref.accessible && typeof ref.accessible === "object") {
    try {
      const acc = ref.accessible as any;
      const valueIface = acc.get_value_iface?.();
      if (valueIface) {
        return {
          min: valueIface.get_minimum_value(),
          max: valueIface.get_maximum_value(),
          increment: valueIface.get_minimum_increment(),
        };
      }
    } catch {
      // Fall through
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// App launching helpers
// ---------------------------------------------------------------------------

function discoverDesktopApps(): Map<string, string> {
  const apps = new Map<string, string>();

  const xdgDataDirs = (
    process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share"
  ).split(":");
  const xdgDataHome =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share");
  const searchDirs = [xdgDataHome, ...xdgDataDirs];

  for (const dataDir of searchDirs) {
    const appDir = path.join(dataDir, "applications");
    try {
      if (!fs.existsSync(appDir)) continue;
      walkDesktopFiles(appDir, apps);
    } catch {
      continue;
    }
  }

  return apps;
}

function walkDesktopFiles(dir: string, apps: Map<string, string>): void {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDesktopFiles(fullPath, apps);
      } else if (entry.name.endsWith(".desktop")) {
        const [name, execCmd] = parseDesktopFile(fullPath);
        if (name && execCmd) {
          const key = name.toLowerCase();
          if (!apps.has(key)) {
            apps.set(key, execCmd);
          }
        }
      }
    }
  } catch {
    // Permission denied or similar
  }
}

function parseDesktopFile(filePath: string): [string, string] {
  let name = "";
  let execCmd = "";
  let noDisplay = false;
  let inDesktopEntry = false;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "[Desktop Entry]") {
        inDesktopEntry = true;
        continue;
      }
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        if (inDesktopEntry) break;
        continue;
      }
      if (!inDesktopEntry) continue;

      if (trimmed.startsWith("Name=") && !name) {
        name = trimmed.slice(5).trim();
      } else if (trimmed.startsWith("Exec=")) {
        execCmd = trimmed
          .slice(5)
          .trim()
          .replace(/\s+%[fFuUdDnNickvm]/g, "")
          .trim();
      } else if (trimmed === "NoDisplay=true") {
        noDisplay = true;
      }
    }
  } catch {
    return ["", ""];
  }

  if (noDisplay) return ["", ""];
  return [name, execCmd];
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
    const escapedQuery = queryLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `(?:^|[\\s\\-_])${escapedQuery}(?:$|[\\s\\-_])`,
    );
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
// LinuxActionHandler
// ---------------------------------------------------------------------------

export class LinuxActionHandler implements ActionHandler {
  async execute(
    nativeRef: unknown,
    action: string,
    params: Record<string, unknown>,
  ): Promise<ActionResult> {
    const ref = (nativeRef as LinuxNativeRef | null) ?? {};

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
          error: `Action '${action}' not implemented for Linux`,
        };
    }
  }

  async pressKeys(combo: string): Promise<ActionResult> {
    try {
      await sendKeyCombo(combo);
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
      const apps = discoverDesktopApps();
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

      const execCmd = apps.get(match)!;
      const displayName = match
        .split(/[\s\-_]+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");

      // Launch via child_process (detached)
      const { spawn } = await import("node:child_process");
      const child = spawn(execCmd, [], {
        shell: true,
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      // Wait for window to appear (poll with xdotool)
      const deadline = Date.now() + 8000;
      const pattern = new RegExp(
        match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );
      while (Date.now() < deadline) {
        try {
          const { stdout } = await execFileAsync(
            "xdotool",
            ["search", "--name", match],
            { timeout: 3000 },
          );
          if (stdout.trim()) {
            return { success: true, message: `${displayName} launched` };
          }
        } catch {
          // No window found yet
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

  private async _click(ref: LinuxNativeRef): Promise<ActionResult> {
    // Try AT-SPI Action interface first
    for (const actName of ["click", "press", "activate"]) {
      if (await atspiDoAction(ref, actName)) {
        return { success: true, message: "Clicked" };
      }
    }

    // Fallback: focus + Enter
    if (await atspiGrabFocus(ref)) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        await sendKeyCombo("enter");
        return { success: true, message: "Clicked (focus+enter fallback)" };
      } catch {
        // Continue to mouse fallback
      }
    }

    // Fallback: mouse click at element center
    const center = getElementCenter(ref);
    if (center) {
      try {
        await mouseClick(center.x, center.y);
        return { success: true, message: "Clicked (mouse fallback)" };
      } catch (err) {
        return {
          success: false,
          message: "",
          error: `Mouse click failed: ${err}`,
        };
      }
    }

    return {
      success: false,
      message: "",
      error: "Element does not support click and has no bounds",
    };
  }

  private async _toggle(ref: LinuxNativeRef): Promise<ActionResult> {
    if (await atspiDoAction(ref, "toggle")) {
      return { success: true, message: "Toggled" };
    }
    // Many checkboxes use "click" to toggle
    if (await atspiDoAction(ref, "click")) {
      return { success: true, message: "Toggled" };
    }
    return {
      success: false,
      message: "",
      error: "Element does not support toggle",
    };
  }

  private async _type(
    ref: LinuxNativeRef,
    text: string,
  ): Promise<ActionResult> {
    try {
      // Focus the element first
      await atspiGrabFocus(ref);
      await new Promise((r) => setTimeout(r, 50));

      // Click to ensure focus
      const center = getElementCenter(ref);
      if (center) {
        await mouseClick(center.x, center.y);
        await new Promise((r) => setTimeout(r, 50));
      }

      // Select all then type
      await sendKeyCombo("ctrl+a");
      await new Promise((r) => setTimeout(r, 50));
      await typeString(text);

      return { success: true, message: `Typed: ${text}` };
    } catch (err) {
      return {
        success: false,
        message: "",
        error: `Failed to type: ${err}`,
      };
    }
  }

  private async _setvalue(
    ref: LinuxNativeRef,
    text: string,
  ): Promise<ActionResult> {
    // Try Value interface (for sliders, spinbuttons)
    const numValue = parseFloat(text);
    if (!isNaN(numValue)) {
      if (await atspiSetValue(ref, numValue)) {
        return { success: true, message: `Set value to: ${text}` };
      }
    }

    // Fallback: type
    return this._type(ref, text);
  }

  private async _expand(ref: LinuxNativeRef): Promise<ActionResult> {
    if (await atspiDoAction(ref, "expand or contract")) {
      return { success: true, message: "Expanded" };
    }
    if (
      (await atspiDoAction(ref, "click")) ||
      (await atspiDoAction(ref, "activate"))
    ) {
      return { success: true, message: "Expanded" };
    }
    return {
      success: false,
      message: "",
      error: "Element does not support expand",
    };
  }

  private async _collapse(ref: LinuxNativeRef): Promise<ActionResult> {
    if (await atspiDoAction(ref, "expand or contract")) {
      return { success: true, message: "Collapsed" };
    }
    if (
      (await atspiDoAction(ref, "click")) ||
      (await atspiDoAction(ref, "activate"))
    ) {
      return { success: true, message: "Collapsed" };
    }
    return {
      success: false,
      message: "",
      error: "Element does not support collapse",
    };
  }

  private async _select(ref: LinuxNativeRef): Promise<ActionResult> {
    if (
      (await atspiDoAction(ref, "click")) ||
      (await atspiDoAction(ref, "activate"))
    ) {
      return { success: true, message: "Selected" };
    }
    // Fallback: mouse click
    return this._click(ref);
  }

  private async _scroll(
    ref: LinuxNativeRef,
    direction: string,
  ): Promise<ActionResult> {
    const center = getElementCenter(ref);
    if (center) {
      try {
        await mouseScroll(center.x, center.y, direction);
        return { success: true, message: `Scrolled ${direction}` };
      } catch (err) {
        return {
          success: false,
          message: "",
          error: `Scroll failed: ${err}`,
        };
      }
    }
    return {
      success: false,
      message: "",
      error: "Element has no bounds for scroll target",
    };
  }

  private async _increment(ref: LinuxNativeRef): Promise<ActionResult> {
    if (await atspiDoAction(ref, "increment")) {
      return { success: true, message: "Incremented" };
    }

    // Try Value interface
    const current = await atspiGetCurrentValue(ref);
    const info = await atspiGetMinMaxIncrement(ref);
    if (current !== null && info) {
      const step = info.increment > 0 ? info.increment : 1;
      const newVal = Math.min(current + step, info.max);
      if (await atspiSetValue(ref, newVal)) {
        return { success: true, message: `Incremented to ${newVal}` };
      }
    }

    return {
      success: false,
      message: "",
      error: "Element does not support increment",
    };
  }

  private async _decrement(ref: LinuxNativeRef): Promise<ActionResult> {
    if (await atspiDoAction(ref, "decrement")) {
      return { success: true, message: "Decremented" };
    }

    const current = await atspiGetCurrentValue(ref);
    const info = await atspiGetMinMaxIncrement(ref);
    if (current !== null && info) {
      const step = info.increment > 0 ? info.increment : 1;
      const newVal = Math.max(current - step, info.min);
      if (await atspiSetValue(ref, newVal)) {
        return { success: true, message: `Decremented to ${newVal}` };
      }
    }

    return {
      success: false,
      message: "",
      error: "Element does not support decrement",
    };
  }

  private async _rightclick(ref: LinuxNativeRef): Promise<ActionResult> {
    const center = getElementCenter(ref);
    if (center) {
      try {
        await mouseClick(center.x, center.y, "right");
        return { success: true, message: "Right-clicked" };
      } catch (err) {
        return {
          success: false,
          message: "",
          error: `Right-click failed: ${err}`,
        };
      }
    }
    return {
      success: false,
      message: "",
      error: "Element has no bounds for right-click",
    };
  }

  private async _doubleclick(ref: LinuxNativeRef): Promise<ActionResult> {
    const center = getElementCenter(ref);
    if (center) {
      try {
        await mouseClick(center.x, center.y, "left", 2);
        return { success: true, message: "Double-clicked" };
      } catch (err) {
        return {
          success: false,
          message: "",
          error: `Double-click failed: ${err}`,
        };
      }
    }
    return {
      success: false,
      message: "",
      error: "Element has no bounds for double-click",
    };
  }

  private async _focus(ref: LinuxNativeRef): Promise<ActionResult> {
    if (await atspiGrabFocus(ref)) {
      return { success: true, message: "Focused" };
    }
    return {
      success: false,
      message: "",
      error: "Failed to focus element",
    };
  }

  private async _dismiss(ref: LinuxNativeRef): Promise<ActionResult> {
    for (const actName of ["close", "dismiss"]) {
      if (await atspiDoAction(ref, actName)) {
        return { success: true, message: "Dismissed" };
      }
    }

    // Fallback: focus + Escape
    try {
      await atspiGrabFocus(ref);
      await new Promise((r) => setTimeout(r, 50));
      await sendKeyCombo("escape");
      return { success: true, message: "Dismissed (Escape)" };
    } catch (err) {
      return {
        success: false,
        message: "",
        error: `Failed to dismiss: ${err}`,
      };
    }
  }

  private async _longpress(ref: LinuxNativeRef): Promise<ActionResult> {
    const center = getElementCenter(ref);
    if (center) {
      try {
        await mouseLongPress(center.x, center.y);
        return { success: true, message: "Long-pressed" };
      } catch (err) {
        return {
          success: false,
          message: "",
          error: `Long-press failed: ${err}`,
        };
      }
    }
    return {
      success: false,
      message: "",
      error: "Element has no bounds for long-press",
    };
  }
}
