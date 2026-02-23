/**
 * Windows action handler — UIA pattern-based action execution + SendInput keyboard/mouse.
 *
 * Uses PowerShell with inline C# for:
 *   - UIA pattern invocation (Invoke, Toggle, Value, ExpandCollapse, etc.)
 *   - Win32 SendInput for keyboard and mouse events
 *   - App discovery and launching via Get-StartApps / .lnk scan
 *
 * Ported from python-sdk/cup/actions/_windows.py
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ActionResult } from "../types.js";
import type { ActionHandler } from "./handler.js";
import { parseCombo } from "./keys.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// PowerShell helper
// ---------------------------------------------------------------------------

async function runPowerShell(script: string, timeout = 15000): Promise<{ stdout: string; ok: boolean }> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    const result = await execFileAsync(
      "powershell",
      ["-NoProfile", "-OutputFormat", "Text", "-EncodedCommand", encoded],
      { timeout, maxBuffer: 10 * 1024 * 1024 },
    );
    return { stdout: result.stdout?.trim() ?? "", ok: true };
  } catch {
    return { stdout: "", ok: false };
  }
}

function psQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

// ---------------------------------------------------------------------------
// VK code map (Windows virtual key codes)
// ---------------------------------------------------------------------------

const VK_MAP: Record<string, number> = {
  enter: 0x0d, return: 0x0d, tab: 0x09, escape: 0x1b, esc: 0x1b,
  backspace: 0x08, delete: 0x2e, space: 0x20,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  ctrl: 0xa2, alt: 0xa4, shift: 0xa0, win: 0x5b, meta: 0x5b,
  insert: 0x2d,
};

const EXTENDED_VKS = new Set([
  0x26, 0x28, 0x25, 0x27, // arrow keys
  0x24, 0x23, 0x21, 0x22, // home, end, pageup, pagedown
  0x2e,                    // delete
  0x5b, 0x5c,             // VK_LWIN, VK_RWIN
  0x2d,                    // insert
]);

const MOD_TO_VK: Record<string, number> = {
  ctrl: 0xa2, alt: 0xa4, shift: 0xa0, meta: 0x5b,
};

// ---------------------------------------------------------------------------
// SendInput via PowerShell (keyboard)
// ---------------------------------------------------------------------------

/**
 * Build a PowerShell script that sends key inputs via SendInput.
 * This generates the exact same INPUT structs as the Python version.
 */
function buildSendKeyScript(modNames: string[], keyNames: string[]): string {
  const modVks = modNames.map((m) => MOD_TO_VK[m]).filter((v) => v !== undefined);
  const mainVks: number[] = [];

  for (const k of keyNames) {
    if (VK_MAP[k] !== undefined) {
      mainVks.push(VK_MAP[k]);
    } else if (k.length === 1) {
      mainVks.push(k.toUpperCase().charCodeAt(0));
    }
  }

  // If only modifier keys, treat them as main keys
  if (modVks.length > 0 && mainVks.length === 0) {
    mainVks.push(...modVks);
    modVks.length = 0;
  }

  if (modVks.length === 0 && mainVks.length === 0) {
    return "# no keys resolved";
  }

  // Build the C# SendInput calls
  const allVks: Array<{ vk: number; down: boolean }> = [];
  for (const vk of modVks) allVks.push({ vk, down: true });
  for (const vk of mainVks) allVks.push({ vk, down: true });
  for (const vk of [...mainVks].reverse()) allVks.push({ vk, down: false });
  for (const vk of [...modVks].reverse()) allVks.push({ vk, down: false });

  const inputLines = allVks.map(({ vk, down }) => {
    const ext = EXTENDED_VKS.has(vk) ? " -bor 1" : "";
    const flags = down ? `0${ext}` : `2${ext}`;
    return `[KeySend]::MakeKey(${vk}, ${flags})`;
  });

  const nMods = modVks.length;
  const hasModsAndKeys = nMods > 0 && mainVks.length > 0;

  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Explicit)]
public struct INPUT_UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
[StructLayout(LayoutKind.Sequential)]
public struct INPUT { public uint type; public INPUT_UNION u; }
public class KeySend {
    [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    public static INPUT MakeKey(ushort vk, uint flags) {
        var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.dwFlags = flags; return i;
    }
}
"@
${hasModsAndKeys ? `
$mods = @(${inputLines.slice(0, nMods).join(", ")})
[KeySend]::SendInput($mods.Length, $mods, [System.Runtime.InteropServices.Marshal]::SizeOf([type][INPUT]))
Start-Sleep -Milliseconds 20
$rest = @(${inputLines.slice(nMods).join(", ")})
[KeySend]::SendInput($rest.Length, $rest, [System.Runtime.InteropServices.Marshal]::SizeOf([type][INPUT]))
` : `
$inputs = @(${inputLines.join(", ")})
[KeySend]::SendInput($inputs.Length, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([type][INPUT]))
`}
`;
}

// ---------------------------------------------------------------------------
// SendInput via PowerShell (unicode string)
// ---------------------------------------------------------------------------

function buildSendUnicodeScript(text: string): string {
  // Encode each char as a pair of unicode key down/up events
  const charCodes = Array.from(text).map((c) => c.charCodeAt(0));

  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Explicit)]
public struct INPUT_UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
[StructLayout(LayoutKind.Sequential)]
public struct INPUT { public uint type; public INPUT_UNION u; }
public class UniSend {
    [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    public static void SendUnicode(ushort[] codes) {
        var inputs = new INPUT[codes.Length * 2];
        for (int i = 0; i < codes.Length; i++) {
            inputs[i*2] = new INPUT();
            inputs[i*2].type = 1;
            inputs[i*2].u.ki.wScan = codes[i];
            inputs[i*2].u.ki.dwFlags = 4; // KEYEVENTF_UNICODE
            inputs[i*2+1] = new INPUT();
            inputs[i*2+1].type = 1;
            inputs[i*2+1].u.ki.wScan = codes[i];
            inputs[i*2+1].u.ki.dwFlags = 6; // KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
        }
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
}
"@
[UniSend]::SendUnicode(@(${charCodes.join(", ")}))
`;
}

// ---------------------------------------------------------------------------
// SendInput via PowerShell (mouse)
// ---------------------------------------------------------------------------

function buildMouseClickScript(
  x: number, y: number,
  opts: { button?: "left" | "right"; count?: number } = {},
): string {
  const button = opts.button ?? "left";
  const count = opts.count ?? 1;
  const downFlag = button === "right" ? 0x0008 : 0x0002;
  const upFlag = button === "right" ? 0x0010 : 0x0004;

  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Explicit)]
public struct INPUT_UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
[StructLayout(LayoutKind.Sequential)]
public struct INPUT { public uint type; public INPUT_UNION u; }
public class MouseSend {
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int idx);
    [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    public static INPUT MakeMouse(int dx, int dy, uint flags) {
        var i = new INPUT(); i.type = 0; i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.dwFlags = flags; return i;
    }
}
"@
$sw = [MouseSend]::GetSystemMetrics(0)
$sh = [MouseSend]::GetSystemMetrics(1)
$ax = [int](${x} * 65535 / $sw)
$ay = [int](${y} * 65535 / $sh)
$inputs = @([MouseSend]::MakeMouse($ax, $ay, 0x8001))  # MOVE | ABSOLUTE
${Array.from({ length: count }, () =>
    `$inputs += [MouseSend]::MakeMouse($ax, $ay, ${downFlag} -bor 0x8000)
$inputs += [MouseSend]::MakeMouse($ax, $ay, ${upFlag} -bor 0x8000)`
  ).join("\n")}
[MouseSend]::SendInput($inputs.Length, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([type][INPUT]))
`;
}

function buildMouseLongPressScript(x: number, y: number): string {
  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Explicit)]
public struct INPUT_UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
[StructLayout(LayoutKind.Sequential)]
public struct INPUT { public uint type; public INPUT_UNION u; }
public class MouseLP {
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int idx);
    [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    public static INPUT MakeMouse(int dx, int dy, uint flags) {
        var i = new INPUT(); i.type = 0; i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.dwFlags = flags; return i;
    }
}
"@
$sw = [MouseLP]::GetSystemMetrics(0)
$sh = [MouseLP]::GetSystemMetrics(1)
$ax = [int](${x} * 65535 / $sw)
$ay = [int](${y} * 65535 / $sh)
$sz = [System.Runtime.InteropServices.Marshal]::SizeOf([type][INPUT])
$move = @([MouseLP]::MakeMouse($ax, $ay, 0x8001))
[MouseLP]::SendInput(1, $move, $sz)
$down = @([MouseLP]::MakeMouse($ax, $ay, 0x8002))
[MouseLP]::SendInput(1, $down, $sz)
Start-Sleep -Milliseconds 800
$up = @([MouseLP]::MakeMouse($ax, $ay, 0x8004))
[MouseLP]::SendInput(1, $up, $sz)
`;
}

// ---------------------------------------------------------------------------
// UIA action execution via PowerShell
// ---------------------------------------------------------------------------

function buildUiaActionScript(hwnd: number, nodeIndex: number, action: string, params: Record<string, unknown>): string {
  const valueParam = typeof params.value === "string" ? params.value.replace(/'/g, "''").replace(/"/g, '\\"') : "";
  const directionParam = typeof params.direction === "string" ? params.direction : "down";

  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using UIAutomationClient;
public class UiaAction {
    static int counter = 0;
    static IUIAutomationElement targetEl = null;

    static void FindElement(IUIAutomationElement el, int targetIdx, int depth, int maxDepth) {
        if (counter == targetIdx) { targetEl = el; return; }
        counter++;
        if (targetEl != null || depth >= maxDepth) return;
        try {
            var children = el.GetCachedChildren();
            if (children != null) {
                for (int i = 0; i < children.Length; i++) {
                    if (targetEl != null) return;
                    FindElement(children.GetElement(i), targetIdx, depth + 1, maxDepth);
                }
            }
        } catch {}
    }

    public static string Run(IntPtr hwnd, int targetIdx, string action, string param) {
        var uia = new CUIAutomation();
        var cr = uia.CreateCacheRequest();
        int[] props = {30005,30003,30001,30010,30008,30022,30011,30012,30013,30023,30025,30031,30041,30042,30043,30036,30037,30033,30086,30070,30079,30046,30045,30047,30049,30050,30077,30101,30102};
        foreach (var p in props) cr.AddProperty(p);
        cr.TreeScope = TreeScope.TreeScope_Subtree;

        IUIAutomationElement root;
        try { root = uia.ElementFromHandleBuildCache(hwnd, cr); }
        catch (Exception ex) { return "ERROR:Could not find window: " + ex.Message; }

        counter = 0;
        targetEl = null;
        FindElement(root, targetIdx, 0, 999);

        if (targetEl == null) return "ERROR:Element not found in tree";

        try {
            switch (action) {
                case "click": {
                    try {
                        var pat = targetEl.GetCurrentPattern(10000);
                        if (pat != null) { ((IUIAutomationInvokePattern)pat).Invoke(); return "OK:Clicked"; }
                    } catch {}
                    targetEl.SetFocus();
                    System.Threading.Thread.Sleep(50);
                    return "FALLBACK:focus+enter";
                }
                case "toggle": {
                    var pat = targetEl.GetCurrentPattern(10015);
                    if (pat != null) { ((IUIAutomationTogglePattern)pat).Toggle(); return "OK:Toggled"; }
                    return "ERROR:Element does not support toggle";
                }
                case "setvalue": {
                    var pat = targetEl.GetCurrentPattern(10002);
                    if (pat != null) { ((IUIAutomationValuePattern)pat).SetValue(param); return "OK:Set value to: " + param; }
                    return "ERROR:Element does not support ValuePattern";
                }
                case "expand": {
                    var pat = targetEl.GetCurrentPattern(10005);
                    if (pat != null) { ((IUIAutomationExpandCollapsePattern)pat).Expand(); return "OK:Expanded"; }
                    return "ERROR:Element does not support expand";
                }
                case "collapse": {
                    var pat = targetEl.GetCurrentPattern(10005);
                    if (pat != null) { ((IUIAutomationExpandCollapsePattern)pat).Collapse(); return "OK:Collapsed"; }
                    return "ERROR:Element does not support collapse";
                }
                case "select": {
                    var pat = targetEl.GetCurrentPattern(10010);
                    if (pat != null) { ((IUIAutomationSelectionItemPattern)pat).Select(); return "OK:Selected"; }
                    // Fallback to click
                    try {
                        var invPat = targetEl.GetCurrentPattern(10000);
                        if (invPat != null) { ((IUIAutomationInvokePattern)invPat).Invoke(); return "OK:Selected (click fallback)"; }
                    } catch {}
                    return "ERROR:Element does not support select";
                }
                case "scroll": {
                    var pat = targetEl.GetCurrentPattern(10004);
                    if (pat != null) {
                        int h = 2, v = 2; // NoAmount
                        if (param == "up") v = 1; else if (param == "down") v = 3;
                        else if (param == "left") h = 1; else if (param == "right") h = 3;
                        ((IUIAutomationScrollPattern)pat).Scroll((ScrollAmount)h, (ScrollAmount)v);
                        return "OK:Scrolled " + param;
                    }
                    return "ERROR:Element does not support scroll";
                }
                case "increment": {
                    var pat = targetEl.GetCurrentPattern(10013);
                    if (pat != null) {
                        var rv = (IUIAutomationRangeValuePattern)pat;
                        double cur = rv.CurrentValue;
                        double step = rv.CurrentSmallChange > 0 ? rv.CurrentSmallChange : 1.0;
                        double nv = Math.Min(rv.CurrentMaximum, cur + step);
                        rv.SetValue(nv);
                        return "OK:Incremented to " + nv;
                    }
                    return "ERROR:Element does not support range value";
                }
                case "decrement": {
                    var pat = targetEl.GetCurrentPattern(10013);
                    if (pat != null) {
                        var rv = (IUIAutomationRangeValuePattern)pat;
                        double cur = rv.CurrentValue;
                        double step = rv.CurrentSmallChange > 0 ? rv.CurrentSmallChange : 1.0;
                        double nv = Math.Max(rv.CurrentMinimum, cur - step);
                        rv.SetValue(nv);
                        return "OK:Decremented to " + nv;
                    }
                    return "ERROR:Element does not support range value";
                }
                case "focus": {
                    targetEl.SetFocus();
                    return "OK:Focused";
                }
                case "getbounds": {
                    // Helper: return bounds for mouse actions
                    var rect = targetEl.CurrentBoundingRectangle;
                    int cx = (rect.left + rect.right) / 2;
                    int cy = (rect.top + rect.bottom) / 2;
                    return "BOUNDS:" + cx + "," + cy;
                }
                default:
                    return "ERROR:Unknown UIA action " + action;
            }
        } catch (Exception ex) {
            return "ERROR:" + ex.Message;
        }
    }
}
"@
[UiaAction]::Run([IntPtr]${hwnd}, ${nodeIndex}, "${action}", "${action === "scroll" ? directionParam : valueParam}")
`;
}

// ---------------------------------------------------------------------------
// Fuzzy matching for app launch
// ---------------------------------------------------------------------------

function fuzzyMatch(query: string, candidates: string[], cutoff = 0.6): string | null {
  const q = query.toLowerCase().trim();

  // Exact match
  if (candidates.includes(q)) return q;

  // Substring match
  for (const c of candidates) {
    if (c.includes(q)) return c;
  }

  // Dice coefficient similarity
  function bigrams(s: string): Set<string> {
    const result = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) result.add(s.slice(i, i + 2));
    return result;
  }

  function dice(a: string, b: string): number {
    const aGrams = bigrams(a);
    const bGrams = bigrams(b);
    let overlap = 0;
    for (const g of aGrams) if (bGrams.has(g)) overlap++;
    const total = aGrams.size + bGrams.size;
    return total === 0 ? 0 : (2 * overlap) / total;
  }

  let bestMatch: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = dice(q, c);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = c;
    }
  }

  return bestMatch && bestScore >= cutoff ? bestMatch : null;
}

// ---------------------------------------------------------------------------
// WindowsActionHandler
// ---------------------------------------------------------------------------

export class WindowsActionHandler implements ActionHandler {
  async action(
    nativeRef: unknown,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<ActionResult> {
    // nativeRef is { hwnd: number, nodeIndex: number } from WindowsAdapter
    const ref = nativeRef as { hwnd: number; nodeIndex: number };
    const hwnd = ref.hwnd;
    const nodeIndex = ref.nodeIndex;

    switch (actionName) {
      case "click":
        return this._uiaAction(hwnd, nodeIndex, "click", params);
      case "toggle":
        return this._uiaAction(hwnd, nodeIndex, "toggle", params);
      case "type":
        return this._type(hwnd, nodeIndex, String(params.value ?? ""));
      case "setvalue":
        return this._uiaAction(hwnd, nodeIndex, "setvalue", params);
      case "expand":
        return this._uiaAction(hwnd, nodeIndex, "expand", params);
      case "collapse":
        return this._uiaAction(hwnd, nodeIndex, "collapse", params);
      case "select":
        return this._uiaAction(hwnd, nodeIndex, "select", params);
      case "scroll":
        return this._uiaAction(hwnd, nodeIndex, "scroll", params);
      case "increment":
        return this._uiaAction(hwnd, nodeIndex, "increment", params);
      case "decrement":
        return this._uiaAction(hwnd, nodeIndex, "decrement", params);
      case "rightclick":
        return this._mouseAction(hwnd, nodeIndex, "right");
      case "doubleclick":
        return this._mouseAction(hwnd, nodeIndex, "double");
      case "focus":
        return this._uiaAction(hwnd, nodeIndex, "focus", params);
      case "dismiss":
        return this._dismiss(hwnd, nodeIndex);
      case "longpress":
        return this._longpress(hwnd, nodeIndex);
      default:
        return { success: false, message: "", error: `Action '${actionName}' not implemented for Windows` };
    }
  }

  async press(combo: string): Promise<ActionResult> {
    const [modNames, keyNames] = parseCombo(combo);
    const script = buildSendKeyScript(modNames, keyNames);
    const { ok } = await runPowerShell(script);
    if (!ok) return { success: false, message: "", error: `Failed to send key combo: ${combo}` };
    return { success: true, message: `Pressed ${combo}` };
  }

  async openApp(name: string): Promise<ActionResult> {
    if (!name?.trim()) {
      return { success: false, message: "", error: "App name must not be empty" };
    }

    try {
      const apps = await this._getStartApps();
      if (Object.keys(apps).length === 0) {
        return { success: false, message: "", error: "Could not discover installed applications" };
      }

      const match = fuzzyMatch(name, Object.keys(apps));
      if (!match) {
        return { success: false, message: "", error: `No installed app matching '${name}' found` };
      }

      const appId = apps[match];
      const displayName = match.replace(/\b\w/g, (c) => c.toUpperCase());

      await this._launchByAppId(appId);

      // Wait for window (poll for 8 seconds)
      const appeared = await this._waitForWindow(name, 8000);
      if (appeared) {
        return { success: true, message: `${displayName} launched` };
      }
      return { success: true, message: `${displayName} launch sent, but window not yet detected` };
    } catch (err) {
      return { success: false, message: "", error: `Failed to launch '${name}': ${err}` };
    }
  }

  // -- private helpers -------------------------------------------------------

  private async _uiaAction(
    hwnd: number,
    nodeIndex: number,
    action: string,
    params: Record<string, unknown>,
  ): Promise<ActionResult> {
    const script = buildUiaActionScript(hwnd, nodeIndex, action, params);
    const { stdout, ok } = await runPowerShell(script, 30000);

    if (!ok) return { success: false, message: "", error: `UIA action '${action}' failed (PowerShell error)` };

    if (stdout.startsWith("OK:")) {
      return { success: true, message: stdout.slice(3) };
    }
    if (stdout.startsWith("FALLBACK:focus+enter")) {
      // Click fallback: focus + enter key
      const [modNames, keyNames] = parseCombo("enter");
      const keyScript = buildSendKeyScript(modNames, keyNames);
      await runPowerShell(keyScript);
      return { success: true, message: "Clicked (focus+enter fallback)" };
    }
    if (stdout.startsWith("ERROR:")) {
      return { success: false, message: "", error: stdout.slice(6) };
    }

    return { success: false, message: "", error: `Unexpected UIA response: ${stdout}` };
  }

  private async _type(hwnd: number, nodeIndex: number, text: string): Promise<ActionResult> {
    // Focus the element first
    const focusResult = await this._uiaAction(hwnd, nodeIndex, "focus", {});
    if (!focusResult.success) {
      return { success: false, message: "", error: `Failed to focus element for typing: ${focusResult.error}` };
    }

    // Select all existing text
    await this.press("ctrl+a");
    await new Promise((r) => setTimeout(r, 50));

    // Type via unicode SendInput
    const script = buildSendUnicodeScript(text);
    const { ok } = await runPowerShell(script);
    if (!ok) return { success: false, message: "", error: "Failed to type text via SendInput" };
    return { success: true, message: `Typed: ${text}` };
  }

  private async _mouseAction(
    hwnd: number,
    nodeIndex: number,
    type: "right" | "double",
  ): Promise<ActionResult> {
    // Get element bounds via UIA
    const boundsScript = buildUiaActionScript(hwnd, nodeIndex, "getbounds", {});
    const { stdout, ok } = await runPowerShell(boundsScript, 30000);

    if (!ok || !stdout.startsWith("BOUNDS:")) {
      return { success: false, message: "", error: `Failed to get element bounds for ${type} click` };
    }

    const [cx, cy] = stdout.slice(7).split(",").map(Number);

    if (type === "right") {
      const script = buildMouseClickScript(cx, cy, { button: "right" });
      await runPowerShell(script);
      return { success: true, message: "Right-clicked" };
    } else {
      const script = buildMouseClickScript(cx, cy, { count: 2 });
      await runPowerShell(script);
      return { success: true, message: "Double-clicked" };
    }
  }

  private async _dismiss(hwnd: number, nodeIndex: number): Promise<ActionResult> {
    // Focus then press Escape
    await this._uiaAction(hwnd, nodeIndex, "focus", {});
    await new Promise((r) => setTimeout(r, 50));
    await this.press("escape");
    return { success: true, message: "Dismissed (Escape)" };
  }

  private async _longpress(hwnd: number, nodeIndex: number): Promise<ActionResult> {
    const boundsScript = buildUiaActionScript(hwnd, nodeIndex, "getbounds", {});
    const { stdout, ok } = await runPowerShell(boundsScript, 30000);

    if (!ok || !stdout.startsWith("BOUNDS:")) {
      return { success: false, message: "", error: "Failed to get element bounds for long press" };
    }

    const [cx, cy] = stdout.slice(7).split(",").map(Number);
    const script = buildMouseLongPressScript(cx, cy);
    const result = await runPowerShell(script, 15000);
    if (!result.ok) {
      return { success: false, message: "", error: "Failed to long-press" };
    }
    return { success: true, message: "Long-pressed" };
  }

  // -- app launch helpers ---------------------------------------------------

  private async _getStartApps(): Promise<Record<string, string>> {
    // Try Get-StartApps first (PowerShell cmdlet for UWP/desktop apps)
    const { stdout, ok } = await runPowerShell(
      "Get-StartApps | ConvertTo-Csv -NoTypeInformation",
      10000,
    );

    if (ok && stdout.trim()) {
      const apps: Record<string, string> = {};
      const lines = stdout.trim().split("\n");
      // Skip header
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        // Parse CSV: "Name","AppID"
        const match = line.match(/^"([^"]*)","([^"]*)"$/);
        if (match) {
          const [, appName, appId] = match;
          if (appName && appId) apps[appName.toLowerCase()] = appId;
        }
      }
      if (Object.keys(apps).length > 0) return apps;
    }

    // Fallback: scan Start Menu .lnk shortcuts
    return this._getAppsFromShortcuts();
  }

  private async _getAppsFromShortcuts(): Promise<Record<string, string>> {
    const script = [
      "$dirs = @(",
      '    "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",',
      '    "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs"',
      ")",
      "$results = @()",
      "foreach ($d in $dirs) {",
      "    if (Test-Path $d) {",
      '        Get-ChildItem -Path $d -Filter "*.lnk" -Recurse | ForEach-Object {',
      '            $results += "$($_.BaseName)|$($_.FullName)"',
      "        }",
      "    }",
      "}",
      '$results -join "`n"',
    ].join("\n");
    const { stdout, ok } = await runPowerShell(script, 10000);
    if (!ok) return {};

    const apps: Record<string, string> = {};
    for (const line of stdout.split("\n")) {
      const sep = line.indexOf("|");
      if (sep > 0) {
        const name = line.slice(0, sep).trim().toLowerCase();
        const lnkPath = line.slice(sep + 1).trim();
        if (name && lnkPath && !apps[name]) apps[name] = lnkPath;
      }
    }
    return apps;
  }

  private async _launchByAppId(appId: string): Promise<void> {
    // Check if it's a file path (.lnk / .exe) or a UWP AppID
    if (appId.includes("\\") || appId.includes("/") || appId.endsWith(".lnk") || appId.endsWith(".exe")) {
      await runPowerShell(`Start-Process ${psQuote(appId)}`, 10000);
    } else {
      await runPowerShell(`Start-Process ${psQuote("shell:AppsFolder\\" + appId)}`, 10000);
    }
  }

  private async _waitForWindow(appName: string, timeoutMs: number): Promise<boolean> {
    const safeName = appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const csBlock = [
        'Add-Type @"',
        "using System;",
        "using System.Collections.Generic;",
        "using System.Runtime.InteropServices;",
        "using System.Text;",
        "using System.Text.RegularExpressions;",
        "public class WinFind {",
        "    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);",
        '    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);',
        '    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);',
        '    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder sb, int max);',
        "    public static bool Find(string pattern) {",
        "        bool found = false;",
        "        var rx = new Regex(pattern, RegexOptions.IgnoreCase);",
        "        EnumWindows((hwnd, _) => {",
        "            if (!IsWindowVisible(hwnd)) return true;",
        "            var buf = new StringBuilder(512);",
        "            GetWindowTextW(hwnd, buf, 512);",
        "            if (rx.IsMatch(buf.ToString())) { found = true; return false; }",
        "            return true;",
        "        }, IntPtr.Zero);",
        "        return found;",
        "    }",
        "}",
        '"@',
      ].join("\n");
      const script = csBlock + "\n[WinFind]::Find(" + psQuote(safeName) + ")";
      const { stdout, ok } = await runPowerShell(script);
      if (ok && stdout.trim().toLowerCase() === "true") return true;

      await new Promise((r) => setTimeout(r, 500));
    }

    return false;
  }
}
