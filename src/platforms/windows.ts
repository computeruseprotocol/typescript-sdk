/**
 * Windows UIA platform adapter for CUP.
 *
 * Captures the accessibility tree via UIA COM (invoked through a PowerShell/C#
 * helper) and maps it to the canonical CUP schema. Window enumeration and
 * screen info use lightweight PowerShell commands.
 *
 * Key design:
 *   1. UIA tree capture runs an inline C# snippet via PowerShell — the same
 *      29-property CacheRequest strategy as the Python SDK.
 *   2. Win32 window enumeration is done via PowerShell calling
 *      user32.dll P/Invoke (EnumWindows, GetForegroundWindow, etc.)
 *   3. No native Node addons required — everything goes through child_process.
 *
 * Ported from python-sdk/cup/platforms/windows.py
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PlatformAdapter } from "../base.js";
import type { CupNode, TreeStats, WindowInfo, WindowMetadata } from "../types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// PowerShell helper
// ---------------------------------------------------------------------------

async function runPowerShell(script: string, timeout = 30000): Promise<string> {
  // Use base64 encoding to avoid escaping issues
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-OutputFormat", "Text", "-EncodedCommand", encoded],
    { timeout, maxBuffer: 50 * 1024 * 1024 },
  );
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// CUP role mapping: UIA ControlType ID -> canonical CUP role
// ---------------------------------------------------------------------------

const CUP_ROLES: Record<number, string> = {
  50000: "button",        // Button
  50001: "grid",          // Calendar
  50002: "checkbox",      // CheckBox
  50003: "combobox",      // ComboBox
  50004: "textbox",       // Edit
  50005: "link",          // Hyperlink
  50006: "img",           // Image
  50007: "listitem",      // ListItem
  50008: "list",          // List
  50009: "menu",          // Menu
  50010: "menubar",       // MenuBar
  50011: "menuitem",      // MenuItem
  50012: "progressbar",   // ProgressBar
  50013: "radio",         // RadioButton
  50014: "scrollbar",     // ScrollBar
  50015: "slider",        // Slider
  50016: "spinbutton",    // Spinner
  50017: "status",        // StatusBar
  50018: "tablist",       // Tab (the container)
  50019: "tab",           // TabItem
  50020: "text",          // Text
  50021: "toolbar",       // ToolBar
  50022: "tooltip",       // ToolTip
  50023: "tree",          // Tree
  50024: "treeitem",      // TreeItem
  50025: "generic",       // Custom
  50026: "group",         // Group
  50027: "generic",       // Thumb
  50028: "grid",          // DataGrid
  50029: "row",           // DataItem
  50030: "document",      // Document
  50031: "button",        // SplitButton
  50032: "window",        // Window
  50033: "generic",       // Pane — context-dependent, refined below
  50034: "group",         // Header
  50035: "columnheader",  // HeaderItem
  50036: "table",         // Table
  50037: "titlebar",      // TitleBar
  50038: "separator",     // Separator
  50039: "generic",       // SemanticZoom
  50040: "toolbar",       // AppBar
};

const CONTROL_TYPES: Record<number, string> = {
  50000: "Button", 50001: "Calendar", 50002: "CheckBox", 50003: "ComboBox",
  50004: "Edit", 50005: "Hyperlink", 50006: "Image", 50007: "ListItem",
  50008: "List", 50009: "Menu", 50010: "MenuBar", 50011: "MenuItem",
  50012: "ProgressBar", 50013: "RadioButton", 50014: "ScrollBar", 50015: "Slider",
  50016: "Spinner", 50017: "StatusBar", 50018: "Tab", 50019: "TabItem",
  50020: "Text", 50021: "ToolBar", 50022: "ToolTip", 50023: "Tree",
  50024: "TreeItem", 50025: "Custom", 50026: "Group", 50027: "Thumb",
  50028: "DataGrid", 50029: "DataItem", 50030: "Document", 50031: "SplitButton",
  50032: "Window", 50033: "Pane", 50034: "Header", 50035: "HeaderItem",
  50036: "Table", 50037: "TitleBar", 50038: "Separator", 50039: "SemanticZoom",
  50040: "AppBar",
};

// ARIA role refinement for web content hosted in UIA
const ARIA_ROLE_MAP: Record<string, string> = {
  heading: "heading", dialog: "dialog", alert: "alert",
  alertdialog: "alertdialog", searchbox: "searchbox", navigation: "navigation",
  main: "main", search: "search", banner: "banner", contentinfo: "contentinfo",
  complementary: "complementary", region: "region", form: "form",
  cell: "cell", gridcell: "cell", switch: "switch", tab: "tab",
  tabpanel: "tabpanel", log: "log", status: "status", timer: "timer",
  marquee: "marquee",
};

// Roles that accept text input (for adding "type" action)
const TEXT_INPUT_ROLES = new Set(["textbox", "searchbox", "combobox", "document"]);

// ---------------------------------------------------------------------------
// C# inline script for UIA tree capture
//
// This captures the full UIA subtree with 29 cached properties in a single
// COM call (ElementFromHandleBuildCache with TreeScope_Subtree), then walks
// the cached tree emitting JSON. This mirrors the Python SDK's approach C
// (walk_cached_tree) for maximum performance.
// ---------------------------------------------------------------------------

const UIA_CAPTURE_CS = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using UIAutomationClient;

class Program {
    // UIA property IDs
    const int UIA_NamePropertyId = 30005;
    const int UIA_ControlTypePropertyId = 30003;
    const int UIA_BoundingRectanglePropertyId = 30001;
    const int UIA_IsEnabledPropertyId = 30010;
    const int UIA_HasKeyboardFocusPropertyId = 30008;
    const int UIA_IsOffscreenPropertyId = 30022;
    const int UIA_AutomationIdPropertyId = 30011;
    const int UIA_ClassNamePropertyId = 30012;
    const int UIA_HelpTextPropertyId = 30013;
    const int UIA_OrientationPropertyId = 30023;
    const int UIA_IsRequiredForFormPropertyId = 30025;
    const int UIA_IsInvokePatternAvailablePropertyId = 30031;
    const int UIA_IsTogglePatternAvailablePropertyId = 30041;
    const int UIA_IsExpandCollapsePatternAvailablePropertyId = 30042;
    const int UIA_IsValuePatternAvailablePropertyId = 30043;
    const int UIA_IsSelectionItemPatternAvailablePropertyId = 30036;
    const int UIA_IsScrollPatternAvailablePropertyId = 30037;
    const int UIA_IsRangeValuePatternAvailablePropertyId = 30033;
    const int UIA_ToggleToggleStatePropertyId = 30086;
    const int UIA_ExpandCollapseExpandCollapseStatePropertyId = 30070;
    const int UIA_SelectionItemIsSelectedPropertyId = 30079;
    const int UIA_ValueIsReadOnlyPropertyId = 30046;
    const int UIA_ValueValuePropertyId = 30045;
    const int UIA_RangeValueValuePropertyId = 30047;
    const int UIA_RangeValueMinimumPropertyId = 30049;
    const int UIA_RangeValueMaximumPropertyId = 30050;
    const int UIA_WindowIsModalPropertyId = 30077;
    const int UIA_AriaRolePropertyId = 30101;
    const int UIA_AriaPropertiesPropertyId = 30102;

    static readonly int[] PROP_IDS = {
        UIA_NamePropertyId, UIA_ControlTypePropertyId, UIA_BoundingRectanglePropertyId,
        UIA_IsEnabledPropertyId, UIA_HasKeyboardFocusPropertyId, UIA_IsOffscreenPropertyId,
        UIA_AutomationIdPropertyId, UIA_ClassNamePropertyId, UIA_HelpTextPropertyId,
        UIA_OrientationPropertyId, UIA_IsRequiredForFormPropertyId,
        UIA_IsInvokePatternAvailablePropertyId, UIA_IsTogglePatternAvailablePropertyId,
        UIA_IsExpandCollapsePatternAvailablePropertyId, UIA_IsValuePatternAvailablePropertyId,
        UIA_IsSelectionItemPatternAvailablePropertyId, UIA_IsScrollPatternAvailablePropertyId,
        UIA_IsRangeValuePatternAvailablePropertyId,
        UIA_ToggleToggleStatePropertyId, UIA_ExpandCollapseExpandCollapseStatePropertyId,
        UIA_SelectionItemIsSelectedPropertyId, UIA_ValueIsReadOnlyPropertyId,
        UIA_ValueValuePropertyId, UIA_RangeValueValuePropertyId,
        UIA_RangeValueMinimumPropertyId, UIA_RangeValueMaximumPropertyId,
        UIA_WindowIsModalPropertyId,
        UIA_AriaRolePropertyId, UIA_AriaPropertiesPropertyId,
    };

    static IUIAutomation uia;
    static int nodeCounter = 0;
    static StringBuilder sb = new StringBuilder();
    static bool firstNode = true;

    static bool GetBool(IUIAutomationElement el, int pid, bool def_val) {
        try { var v = el.GetCachedPropertyValue(pid); return v != null ? Convert.ToBoolean(v) : def_val; }
        catch { return def_val; }
    }
    static int GetInt(IUIAutomationElement el, int pid, int def_val) {
        try { var v = el.GetCachedPropertyValue(pid); return v != null ? Convert.ToInt32(v) : def_val; }
        catch { return def_val; }
    }
    static double GetDouble(IUIAutomationElement el, int pid, double def_val) {
        try { var v = el.GetCachedPropertyValue(pid); return v != null ? Convert.ToDouble(v) : def_val; }
        catch { return def_val; }
    }
    static string GetStr(IUIAutomationElement el, int pid) {
        try { var v = el.GetCachedPropertyValue(pid); return v != null ? v.ToString() : ""; }
        catch { return ""; }
    }

    static string JsonEscape(string s) {
        if (string.IsNullOrEmpty(s)) return "";
        var r = new StringBuilder(s.Length);
        foreach (char c in s) {
            switch (c) {
                case '"': r.Append("\\\\\\\""); break;
                case '\\\\': r.Append("\\\\\\\\"); break;
                case '\\n': r.Append("\\\\n"); break;
                case '\\r': r.Append("\\\\r"); break;
                case '\\t': r.Append("\\\\t"); break;
                default:
                    if (c < 0x20) r.AppendFormat("\\\\u{0:x4}", (int)c);
                    else r.Append(c);
                    break;
            }
        }
        return r.ToString();
    }

    static void WalkCachedTree(IUIAutomationElement el, int depth, int maxDepth) {
        if (depth > maxDepth) return;

        string id = "e" + (nodeCounter++);

        // Core
        string name = ""; try { name = el.CachedName ?? ""; } catch {}
        int ct = 0; try { ct = el.CachedControlType; } catch {}

        double[] rect = null;
        try {
            var r = el.GetCachedPropertyValue(UIA_BoundingRectanglePropertyId);
            if (r is double[] da && da.Length == 4) rect = da;
        } catch {}

        // State
        bool isEnabled = GetBool(el, UIA_IsEnabledPropertyId, true);
        bool hasFocus = GetBool(el, UIA_HasKeyboardFocusPropertyId, false);
        bool isOffscreen = GetBool(el, UIA_IsOffscreenPropertyId, false);
        bool isRequired = GetBool(el, UIA_IsRequiredForFormPropertyId, false);
        bool isModal = GetBool(el, UIA_WindowIsModalPropertyId, false);

        // Patterns
        bool hasInvoke = GetBool(el, UIA_IsInvokePatternAvailablePropertyId, false);
        bool hasToggle = GetBool(el, UIA_IsTogglePatternAvailablePropertyId, false);
        bool hasExpand = GetBool(el, UIA_IsExpandCollapsePatternAvailablePropertyId, false);
        bool hasValue = GetBool(el, UIA_IsValuePatternAvailablePropertyId, false);
        bool hasSelItem = GetBool(el, UIA_IsSelectionItemPatternAvailablePropertyId, false);
        bool hasScroll = GetBool(el, UIA_IsScrollPatternAvailablePropertyId, false);
        bool hasRange = GetBool(el, UIA_IsRangeValuePatternAvailablePropertyId, false);

        // Pattern states
        int toggleState = GetInt(el, UIA_ToggleToggleStatePropertyId, -1);
        int expandState = GetInt(el, UIA_ExpandCollapseExpandCollapseStatePropertyId, -1);
        bool isSelected = GetBool(el, UIA_SelectionItemIsSelectedPropertyId, false);
        bool valReadonly = hasValue ? GetBool(el, UIA_ValueIsReadOnlyPropertyId, false) : false;
        string valStr = hasValue ? GetStr(el, UIA_ValueValuePropertyId) : "";

        // Identification
        string automationId = GetStr(el, UIA_AutomationIdPropertyId);
        string className = GetStr(el, UIA_ClassNamePropertyId);
        string helpText = GetStr(el, UIA_HelpTextPropertyId);

        // ARIA
        string ariaRole = GetStr(el, UIA_AriaRolePropertyId);
        string ariaPropsStr = GetStr(el, UIA_AriaPropertiesPropertyId);

        // Range
        double rangeMin = hasRange ? GetDouble(el, UIA_RangeValueMinimumPropertyId, double.NaN) : double.NaN;
        double rangeMax = hasRange ? GetDouble(el, UIA_RangeValueMaximumPropertyId, double.NaN) : double.NaN;
        double rangeVal = hasRange ? GetDouble(el, UIA_RangeValueValuePropertyId, double.NaN) : double.NaN;

        int orientation = GetInt(el, UIA_OrientationPropertyId, -1);

        // Emit JSON node
        if (!firstNode) sb.Append(",");
        firstNode = false;

        sb.Append("{");
        sb.AppendFormat("\\"id\\":\\"{0}\\",\\"ct\\":{1},\\"d\\":{2}", id, ct, depth);
        if (!string.IsNullOrEmpty(name)) sb.AppendFormat(",\\"nm\\":\\"{0}\\"", JsonEscape(name.Length > 200 ? name.Substring(0, 200) : name));
        if (rect != null) sb.AppendFormat(",\\"bx\\":[{0},{1},{2},{3}]", (int)rect[0], (int)rect[1], (int)rect[2], (int)rect[3]);
        if (!isEnabled) sb.Append(",\\"en\\":0");
        if (hasFocus) sb.Append(",\\"fo\\":1");
        if (isOffscreen) sb.Append(",\\"os\\":1");
        if (isRequired) sb.Append(",\\"rq\\":1");
        if (isModal) sb.Append(",\\"mo\\":1");
        if (hasInvoke) sb.Append(",\\"pi\\":1");
        if (hasToggle) sb.AppendFormat(",\\"pt\\":{0}", toggleState);
        if (hasExpand) sb.AppendFormat(",\\"pe\\":{0}", expandState);
        if (hasValue) sb.AppendFormat(",\\"pv\\":1,\\"pvr\\":{0}", valReadonly ? 1 : 0);
        if (hasSelItem) sb.AppendFormat(",\\"ps\\":{0}", isSelected ? 1 : 0);
        if (hasScroll) sb.Append(",\\"psc\\":1");
        if (hasRange) sb.Append(",\\"pr\\":1");
        if (!string.IsNullOrEmpty(valStr)) sb.AppendFormat(",\\"val\\":\\"{0}\\"", JsonEscape(valStr.Length > 200 ? valStr.Substring(0, 200) : valStr));
        if (!string.IsNullOrEmpty(automationId)) sb.AppendFormat(",\\"aid\\":\\"{0}\\"", JsonEscape(automationId));
        if (!string.IsNullOrEmpty(className)) sb.AppendFormat(",\\"cn\\":\\"{0}\\"", JsonEscape(className));
        if (!string.IsNullOrEmpty(helpText)) sb.AppendFormat(",\\"ht\\":\\"{0}\\"", JsonEscape(helpText.Length > 200 ? helpText.Substring(0, 200) : helpText));
        if (!string.IsNullOrEmpty(ariaRole)) sb.AppendFormat(",\\"ar\\":\\"{0}\\"", JsonEscape(ariaRole));
        if (!string.IsNullOrEmpty(ariaPropsStr)) sb.AppendFormat(",\\"ap\\":\\"{0}\\"", JsonEscape(ariaPropsStr));
        if (!double.IsNaN(rangeMin)) sb.AppendFormat(",\\"rmn\\":{0}", rangeMin);
        if (!double.IsNaN(rangeMax)) sb.AppendFormat(",\\"rmx\\":{0}", rangeMax);
        if (!double.IsNaN(rangeVal)) sb.AppendFormat(",\\"rv\\":{0}", rangeVal);
        if (orientation == 1 || orientation == 2) sb.AppendFormat(",\\"ori\\":{0}", orientation);
        sb.Append("}");

        // Walk children
        if (depth < maxDepth) {
            try {
                var children = el.GetCachedChildren();
                if (children != null) {
                    for (int i = 0; i < children.Length; i++) {
                        WalkCachedTree(children.GetElement(i), depth + 1, maxDepth);
                    }
                }
            } catch {}
        }
    }

    static void Main(string[] args) {
        if (args.Length < 1) { Console.Error.WriteLine("Usage: <hwnd> [maxDepth]"); return; }
        IntPtr hwnd = new IntPtr(long.Parse(args[0]));
        int maxDepth = args.Length > 1 ? int.Parse(args[1]) : 999;

        uia = new CUIAutomation();
        var cr = uia.CreateCacheRequest();
        foreach (int pid in PROP_IDS) cr.AddProperty(pid);
        cr.TreeScope = TreeScope.TreeScope_Subtree;

        try {
            var root = uia.ElementFromHandleBuildCache(hwnd, cr);
            sb.Append("[");
            WalkCachedTree(root, 0, maxDepth);
            sb.Append("]");
            Console.Write(sb.ToString());
        } catch (Exception ex) {
            Console.Error.WriteLine("UIA Error: " + ex.Message);
            Console.Write("[]");
        }
    }
}
`;

// Compile UIA helper once, cache the path
let uiaHelperPath: string | null = null;

async function getUiaHelper(): Promise<string> {
  if (uiaHelperPath) return uiaHelperPath;

  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");

  const dir = path.join(os.tmpdir(), "cup-uia-helper");
  const exePath = path.join(dir, "CupUiaHelper.exe");
  const csPath = path.join(dir, "CupUiaHelper.cs");

  // Return cached if exe exists and is recent (within 24 hours)
  try {
    const stat = fs.statSync(exePath);
    if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) {
      uiaHelperPath = exePath;
      return exePath;
    }
  } catch { /* needs compilation */ }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(csPath, UIA_CAPTURE_CS);

  // Compile with csc.exe (ships with .NET Framework on all Windows)
  const cscPaths = [
    "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
    "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
  ];
  let csc: string | null = null;
  for (const p of cscPaths) {
    try { fs.accessSync(p); csc = p; break; } catch { /* try next */ }
  }
  if (!csc) {
    throw new Error("Could not find csc.exe — .NET Framework 4.x is required for UIA tree capture");
  }

  // UIAutomationClient is a COM interop assembly; reference it
  await execFileAsync(csc, [
    "/nologo", "/optimize+", "/out:" + exePath,
    "/reference:UIAutomationClient.dll",
    csPath,
  ], { timeout: 30000 });

  uiaHelperPath = exePath;
  return exePath;
}

// ---------------------------------------------------------------------------
// Raw node from UIA helper JSON → CUP node builder
// ---------------------------------------------------------------------------

interface RawUiaNode {
  id: string;
  ct: number;  // controlType
  d: number;   // depth
  nm?: string;
  bx?: [number, number, number, number];
  en?: 0;      // 0 = disabled
  fo?: 1;      // 1 = focused
  os?: 1;      // 1 = offscreen
  rq?: 1;      // 1 = required
  mo?: 1;      // 1 = modal
  pi?: 1;      // has invoke
  pt?: number; // toggle state (-1 if no pattern)
  pe?: number; // expand state (-1 if no pattern)
  pv?: 1;      // has value
  pvr?: number; // value read-only
  ps?: number; // selection item (0/1)
  psc?: 1;     // has scroll
  pr?: 1;      // has range
  val?: string;
  aid?: string;
  cn?: string;
  ht?: string;
  ar?: string;
  ap?: string;
  rmn?: number;
  rmx?: number;
  rv?: number;
  ori?: number;
}

function buildCupNode(raw: RawUiaNode): CupNode {
  const ct = raw.ct;

  // ARIA properties
  const ariaRole = raw.ar ?? "";
  const ariaProps: Record<string, string> = {};
  if (raw.ap) {
    for (const pair of raw.ap.split(";")) {
      const eq = pair.indexOf("=");
      if (eq > 0) {
        ariaProps[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
    }
  }

  // Role
  let role = CUP_ROLES[ct] ?? "generic";
  if (ct === 50033 && raw.nm) role = "region"; // Pane with name → region

  // Refine role from ARIA for web content in UIA
  if (ariaRole && ["generic", "group", "text", "region"].includes(role)) {
    const mapped = ARIA_ROLE_MAP[ariaRole];
    if (mapped) role = mapped;
  }

  // MenuItem subrole
  if (ct === 50011) {
    if (raw.pt !== undefined) role = "menuitemcheckbox";
    else if (raw.ps !== undefined) role = "menuitemradio";
  }

  // Pattern booleans
  const hasInvoke = raw.pi === 1;
  const hasToggle = raw.pt !== undefined;
  const hasExpand = raw.pe !== undefined;
  const hasValue = raw.pv === 1;
  const hasSelItem = raw.ps !== undefined;
  const hasScroll = raw.psc === 1;
  const hasRange = raw.pr === 1;
  const toggleState = raw.pt ?? -1;
  const expandState = raw.pe ?? -1;
  const isSelected = raw.ps === 1;
  const valReadonly = (raw.pvr ?? 0) === 1;
  const valStr = raw.val ?? "";
  const isEnabled = raw.en !== 0;

  // States
  const states: string[] = [];
  if (!isEnabled) states.push("disabled");
  if (raw.fo === 1) states.push("focused");
  if (raw.os === 1) states.push("offscreen");
  if (hasToggle) {
    if (toggleState === 1) {
      states.push(ct === 50000 ? "pressed" : "checked");
    } else if (toggleState === 2) {
      states.push("mixed");
    }
  }
  if (hasExpand) {
    if (expandState === 0) states.push("collapsed");
    else if (expandState === 1 || expandState === 2) states.push("expanded");
  }
  if (isSelected) states.push("selected");
  if (raw.rq === 1) states.push("required");
  if (raw.mo === 1) states.push("modal");
  if (hasValue && valReadonly) states.push("readonly");
  if (hasValue && !valReadonly && TEXT_INPUT_ROLES.has(role)) states.push("editable");

  // Actions
  const actions: string[] = [];
  if (hasInvoke) actions.push("click");
  if (hasToggle) actions.push("toggle");
  if (hasExpand && expandState !== 3) { actions.push("expand"); actions.push("collapse"); }
  if (hasValue && !valReadonly) {
    actions.push("setvalue");
    if (TEXT_INPUT_ROLES.has(role)) actions.push("type");
  }
  if (hasSelItem) actions.push("select");
  if (hasScroll) actions.push("scroll");
  if (hasRange) { actions.push("increment"); actions.push("decrement"); }
  if (actions.length === 0 && isEnabled) actions.push("focus");

  // Attributes
  const attrs: Record<string, unknown> = {};
  if (role === "heading" && ariaProps.level) {
    const lvl = parseInt(ariaProps.level, 10);
    if (!isNaN(lvl)) attrs.level = lvl;
  }
  if (hasRange) {
    if (raw.rmn !== undefined) attrs.valueMin = raw.rmn;
    if (raw.rmx !== undefined) attrs.valueMax = raw.rmx;
    if (raw.rv !== undefined) attrs.valueNow = raw.rv;
  }
  const ori = raw.ori ?? -1;
  const orientableRoles = new Set(["scrollbar", "slider", "separator", "toolbar", "tablist"]);
  if (ori === 1 && orientableRoles.has(role)) attrs.orientation = "horizontal";
  else if (ori === 2 && orientableRoles.has(role)) attrs.orientation = "vertical";
  if (["textbox", "searchbox", "combobox"].includes(role) && ariaProps.placeholder) {
    attrs.placeholder = ariaProps.placeholder.slice(0, 200);
  }
  if (role === "link" && valStr) attrs.url = valStr.slice(0, 500);

  // Build CUP node
  const node: CupNode = {
    id: raw.id,
    role,
    name: (raw.nm ?? "").slice(0, 200),
  };

  if (raw.ht) node.description = raw.ht.slice(0, 200);
  if (valStr && ["textbox", "searchbox", "combobox", "spinbutton", "slider", "progressbar", "document"].includes(role)) {
    node.value = valStr.slice(0, 200);
  }
  if (raw.bx) node.bounds = { x: raw.bx[0], y: raw.bx[1], w: raw.bx[2], h: raw.bx[3] };
  if (states.length) node.states = states;
  if (actions.length) node.actions = actions;
  if (Object.keys(attrs).length) node.attributes = attrs as CupNode["attributes"];

  // Platform extension
  const patterns: string[] = [];
  if (hasInvoke) patterns.push("Invoke");
  if (hasToggle) patterns.push("Toggle");
  if (hasExpand) patterns.push("ExpandCollapse");
  if (hasValue) patterns.push("Value");
  if (hasSelItem) patterns.push("SelectionItem");
  if (hasScroll) patterns.push("Scroll");
  if (hasRange) patterns.push("RangeValue");

  const pw: Record<string, unknown> = { controlType: ct };
  if (raw.aid) pw.automationId = raw.aid;
  if (raw.cn) pw.className = raw.cn;
  if (patterns.length) pw.patterns = patterns;
  node.platform = { windows: pw };

  return node;
}

// ---------------------------------------------------------------------------
// Build hierarchical tree from flat depth-ordered array
// ---------------------------------------------------------------------------

function buildTreeFromFlat(flatNodes: RawUiaNode[]): CupNode[] {
  if (flatNodes.length === 0) return [];

  const cupNodes = flatNodes.map(buildCupNode);

  // Stack-based tree reconstruction: each entry is [node, depth]
  const roots: CupNode[] = [];
  const stack: Array<{ node: CupNode; depth: number }> = [];

  for (let i = 0; i < cupNodes.length; i++) {
    const node = cupNodes[i];
    const depth = flatNodes[i].d;

    // Pop stack until parent depth
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
// Win32 helpers via PowerShell
// ---------------------------------------------------------------------------

async function win32EnumWindows(): Promise<Array<{ hwnd: number; title: string }>> {
  const script = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum {
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder sb, int max);
    public static string GetAll() {
        var sb = new StringBuilder();
        sb.Append("[");
        bool first = true;
        EnumWindows((hwnd, _) => {
            if (!IsWindowVisible(hwnd)) return true;
            var buf = new StringBuilder(512);
            GetWindowTextW(hwnd, buf, 512);
            if (!first) sb.Append(",");
            first = false;
            sb.AppendFormat("[{0},\\"{1}\\"]", hwnd.ToInt64(), buf.ToString().Replace("\\\\","\\\\\\\\").Replace("\\"","\\\\\\""));
            return true;
        }, IntPtr.Zero);
        sb.Append("]");
        return sb.ToString();
    }
}
"@
[WinEnum]::GetAll()
`;
  const output = await runPowerShell(script);
  try {
    const pairs = JSON.parse(output) as [number, string][];
    return pairs.map(([hwnd, title]) => ({ hwnd, title }));
  } catch {
    return [];
  }
}

async function win32ForegroundWindow(): Promise<{ hwnd: number; title: string }> {
  const script = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FgWin {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder sb, int max);
}
"@
$h = [FgWin]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][FgWin]::GetWindowTextW($h, $sb, 512)
"$($h.ToInt64())|$($sb.ToString())"
`;
  const output = await runPowerShell(script);
  const sep = output.indexOf("|");
  if (sep < 0) return { hwnd: 0, title: "" };
  return { hwnd: parseInt(output.slice(0, sep), 10), title: output.slice(sep + 1) };
}

async function win32GetPid(hwnd: number): Promise<number> {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PidHelper {
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
"@
$pid = 0
[void][PidHelper]::GetWindowThreadProcessId([IntPtr]${hwnd}, [ref]$pid)
$pid
`;
  const output = await runPowerShell(script);
  return parseInt(output, 10) || 0;
}

async function win32ScreenInfo(): Promise<[number, number, number]> {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ScreenInfo {
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
    [DllImport("shcore.dll")] public static extern int GetDpiForSystem();
}
"@
$w = [ScreenInfo]::GetSystemMetrics(0)
$h = [ScreenInfo]::GetSystemMetrics(1)
try { $dpi = [ScreenInfo]::GetDpiForSystem() } catch { $dpi = 96 }
"$w|$h|$dpi"
`;
  const output = await runPowerShell(script);
  const parts = output.split("|");
  const w = parseInt(parts[0], 10) || 1920;
  const h = parseInt(parts[1], 10) || 1080;
  const dpi = parseInt(parts[2], 10) || 96;
  return [w, h, dpi / 96.0];
}

async function win32GetWindowRect(hwnd: number): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public class RectHelper {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
}
"@
$r = New-Object RECT
if ([RectHelper]::GetWindowRect([IntPtr]${hwnd}, [ref]$r)) {
    "$($r.Left)|$($r.Top)|$($r.Right - $r.Left)|$($r.Bottom - $r.Top)"
} else { "" }
`;
  const output = await runPowerShell(script);
  if (!output) return null;
  const parts = output.split("|").map(Number);
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

async function win32FindDesktopHwnd(): Promise<number | null> {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DesktopFinder {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string win);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string win);
}
"@
$progman = [DesktopFinder]::FindWindowW("Progman", $null)
if ($progman -ne [IntPtr]::Zero) {
    $shell = [DesktopFinder]::FindWindowExW($progman, [IntPtr]::Zero, "SHELLDLL_DefView", $null)
    if ($shell -ne [IntPtr]::Zero) { $progman.ToInt64(); return }
}
""
`;
  const output = await runPowerShell(script);
  if (!output) return null;
  const val = parseInt(output, 10);
  return isNaN(val) ? null : val;
}

async function win32PokeWindow(hwnd: number): Promise<void> {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Poker { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd); }
"@
[Poker]::SetForegroundWindow([IntPtr]${hwnd})
Start-Sleep -Milliseconds 300
`;
  await runPowerShell(script);
}

// ---------------------------------------------------------------------------
// WindowsAdapter — PlatformAdapter implementation
// ---------------------------------------------------------------------------

const SPARSE_TREE_THRESHOLD = 30;

export class WindowsAdapter implements PlatformAdapter {
  private _initialized = false;

  get platformName(): string {
    return "windows";
  }

  async initialize(): Promise<void> {
    if (this._initialized) return;
    // Pre-compile UIA helper on first init
    await getUiaHelper();
    this._initialized = true;
  }

  async getScreenInfo(): Promise<[number, number, number]> {
    return win32ScreenInfo();
  }

  async getForegroundWindow(): Promise<WindowMetadata> {
    const { hwnd, title } = await win32ForegroundWindow();
    const pid = await win32GetPid(hwnd);
    return { handle: hwnd, title, pid: pid || null, bundle_id: null };
  }

  async getAllWindows(): Promise<WindowMetadata[]> {
    const wins = await win32EnumWindows();
    const results: WindowMetadata[] = [];
    for (const { hwnd, title } of wins) {
      const pid = await win32GetPid(hwnd);
      results.push({ handle: hwnd, title, pid: pid || null, bundle_id: null });
    }
    return results;
  }

  async getWindowList(): Promise<WindowInfo[]> {
    const [wins, fg] = await Promise.all([
      win32EnumWindows(),
      win32ForegroundWindow(),
    ]);

    const results: WindowInfo[] = [];
    for (const { hwnd, title } of wins) {
      if (!title) continue;
      const pid = await win32GetPid(hwnd);
      const bounds = await win32GetWindowRect(hwnd);
      results.push({
        title,
        pid: pid || null,
        bundle_id: null,
        foreground: hwnd === fg.hwnd,
        bounds,
      });
    }
    return results;
  }

  async getDesktopWindow(): Promise<WindowMetadata | null> {
    const hwnd = await win32FindDesktopHwnd();
    if (hwnd === null) return null;
    const pid = await win32GetPid(hwnd);
    return { handle: hwnd, title: "Desktop", pid: pid || null, bundle_id: null };
  }

  async captureTree(
    windows: WindowMetadata[],
    options?: { maxDepth?: number },
  ): Promise<[CupNode[], TreeStats, Map<string, unknown>]> {
    await this.initialize();
    let [tree, stats, refs] = await this._walkWindows(windows, options?.maxDepth ?? 999);

    // Chromium/Electron lazy a11y init detection
    if (windows.length === 1 && this._treeNeedsPoke(stats)) {
      const hwnd = windows[0].handle as number;
      await win32PokeWindow(hwnd);
      [tree, stats, refs] = await this._walkWindows(windows, options?.maxDepth ?? 999);
    }

    return [tree, stats, refs];
  }

  private _treeNeedsPoke(stats: TreeStats): boolean {
    if (stats.nodes < SPARSE_TREE_THRESHOLD) return true;
    const roles = stats.roles;
    const hasChrome = Boolean(roles.ToolBar || roles.TabItem);
    const hasDocument = Boolean(roles.Document);
    if (hasChrome && !hasDocument) return true;
    return false;
  }

  private async _walkWindows(
    windows: WindowMetadata[],
    maxDepth: number,
  ): Promise<[CupNode[], TreeStats, Map<string, unknown>]> {
    const stats: TreeStats = { nodes: 0, max_depth: 0, roles: {} };
    const refs = new Map<string, unknown>();
    const tree: CupNode[] = [];

    const helperExe = await getUiaHelper();

    for (const win of windows) {
      const hwnd = win.handle as number;
      try {
        const { stdout } = await execFileAsync(helperExe, [
          String(hwnd),
          String(maxDepth),
        ], { timeout: 30000, maxBuffer: 50 * 1024 * 1024 });

        const rawNodes: RawUiaNode[] = JSON.parse(stdout.trim() || "[]");

        // Stats
        for (const raw of rawNodes) {
          stats.nodes++;
          stats.max_depth = Math.max(stats.max_depth, raw.d);
          const ctName = CONTROL_TYPES[raw.ct] ?? `Unknown(${raw.ct})`;
          stats.roles[ctName] = (stats.roles[ctName] ?? 0) + 1;
        }

        // Build hierarchical tree
        const roots = buildTreeFromFlat(rawNodes);
        for (const root of roots) tree.push(root);

        // Store refs (element IDs map to { hwnd, nodeIndex } for action execution)
        for (let j = 0; j < rawNodes.length; j++) {
          refs.set(rawNodes[j].id, { hwnd, nodeIndex: j });
        }
      } catch {
        // Window may have disappeared, skip
        continue;
      }
    }

    return [tree, stats, refs];
  }
}
