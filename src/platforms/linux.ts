/**
 * Linux AT-SPI2 platform adapter for CUP.
 *
 * Captures the accessibility tree via AT-SPI2 over D-Bus (using gdbus CLI)
 * and maps it to the canonical CUP schema.
 *
 * Key design:
 *   1. Uses gdbus — the GNOME D-Bus CLI tool — to query AT-SPI2 objects
 *   2. Batch-reads core properties per node (role, name, states, bounds,
 *      actions, value) in a recursive walk
 *   3. xdotool / xrandr / xdpyinfo for screen info and window detection
 *   4. Parallel tree walking with Promise.all for multi-window captures
 *   5. No native Node addons required — everything goes through child_process
 *
 * Requirements:
 *   - gdbus (part of glib2, usually pre-installed on Linux)
 *   - AT-SPI2 enabled (default on GNOME/KDE/XFCE)
 *   - xdotool (for window detection)
 *   - xrandr or xdpyinfo (for screen info fallback)
 *
 * Ported from python-sdk/cup/platforms/linux.py
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PlatformAdapter } from "../base.js";
import type { CupNode, TreeStats, WindowInfo, WindowMetadata } from "../types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// AT-SPI2 role -> CUP ARIA role mapping
// ---------------------------------------------------------------------------
// Based on W3C Core AAM spec. Maps from AT-SPI2 dash-separated role names
// (e.g. "push-button") to canonical CUP roles.

const CUP_ROLES: Record<string, string> = {
  // Core interactive
  "push-button": "button",
  "toggle-button": "button",
  "check-box": "checkbox",
  "radio-button": "radio",
  "combo-box": "combobox",
  "text": "textbox",
  "password-text": "textbox",
  "entry": "textbox",
  "spin-button": "spinbutton",
  "slider": "slider",
  "scroll-bar": "scrollbar",
  "progress-bar": "progressbar",
  "link": "link",
  "menu": "menu",
  "menu-bar": "menubar",
  "menu-item": "menuitem",
  "check-menu-item": "menuitemcheckbox",
  "radio-menu-item": "menuitemradio",
  "separator": "separator",
  // Containers / structure
  "frame": "window",
  "dialog": "dialog",
  "alert": "alert",
  "file-chooser": "dialog",
  "color-chooser": "dialog",
  "font-chooser": "dialog",
  "window": "window",
  "panel": "group",
  "filler": "generic",
  "grouping": "group",
  "split-pane": "group",
  "viewport": "group",
  "scroll-pane": "group",
  "layered-pane": "group",
  "glass-pane": "group",
  "internal-frame": "group",
  "desktop-frame": "group",
  "root-pane": "group",
  "option-pane": "group",
  // Tables / grids
  "table": "table",
  "table-cell": "cell",
  "table-row": "row",
  "table-column-header": "columnheader",
  "table-row-header": "rowheader",
  "tree-table": "treegrid",
  // Lists / trees
  "list": "list",
  "list-item": "listitem",
  "tree": "tree",
  "tree-item": "treeitem",
  // Tabs
  "page-tab-list": "tablist",
  "page-tab": "tab",
  // Text / display
  "label": "text",
  "static": "text",
  "caption": "text",
  "heading": "heading",
  "paragraph": "text",
  "section": "generic",
  "block-quote": "generic",
  "image": "img",
  "icon": "img",
  "animation": "img",
  "canvas": "img",
  "chart": "img",
  // Document / content
  "document-frame": "document",
  "document-web": "document",
  "document-text": "document",
  "document-email": "document",
  "document-spreadsheet": "document",
  "document-presentation": "document",
  "article": "article",
  "form": "form",
  // Toolbar / status
  "tool-bar": "toolbar",
  "tool-tip": "tooltip",
  "status-bar": "status",
  "info-bar": "status",
  "notification": "alert",
  // ARIA landmarks
  "landmark": "region",
  "log": "log",
  "marquee": "marquee",
  "math": "math",
  "timer": "timer",
  "definition": "definition",
  "note": "note",
  "figure": "figure",
  "footer": "contentinfo",
  "content-deletion": "generic",
  "content-insertion": "generic",
  "description-list": "list",
  "description-term": "term",
  "description-value": "definition",
  "comment": "note",
  // Navigation
  "page": "region",
  "redundant-object": "generic",
  "application": "application",
  "autocomplete": "combobox",
  "embedded": "generic",
  "editbar": "toolbar",
  // Catch-all
  "unknown": "generic",
  "invalid": "generic",
  "extended": "generic",
};

// Roles that accept text input (for adding "type" action)
const TEXT_INPUT_ROLES = new Set(["textbox", "searchbox", "combobox", "document"]);

// AT-SPI action names -> CUP action mappings
const ACTION_MAP: Record<string, string> = {
  click: "click",
  press: "click",
  activate: "click",
  jump: "click",
  toggle: "toggle",
  "expand or contract": "expand",
  menu: "click",
};

// ARIA role refinements for web content
const ARIA_REFINEMENTS: Record<string, string> = {
  heading: "heading",
  dialog: "dialog",
  alert: "alert",
  alertdialog: "alertdialog",
  searchbox: "searchbox",
  navigation: "navigation",
  main: "main",
  search: "search",
  banner: "banner",
  contentinfo: "contentinfo",
  complementary: "complementary",
  region: "region",
  form: "form",
  switch: "switch",
  tabpanel: "tabpanel",
  log: "log",
  status: "status",
  timer: "timer",
  marquee: "marquee",
  feed: "feed",
  figure: "figure",
  math: "math",
  note: "note",
  article: "article",
  directory: "directory",
};

// ---------------------------------------------------------------------------
// AT-SPI2 D-Bus constants
// ---------------------------------------------------------------------------

const ATSPI_BUS = "org.a11y.atspi.Registry";
const ATSPI_PATH_PREFIX = "/org/a11y/atspi/accessible";
const ATSPI_IFACE_ACCESSIBLE = "org.a11y.atspi.Accessible";
const ATSPI_IFACE_COMPONENT = "org.a11y.atspi.Component";
const ATSPI_IFACE_ACTION = "org.a11y.atspi.Action";
const ATSPI_IFACE_VALUE = "org.a11y.atspi.Value";
const ATSPI_IFACE_TEXT = "org.a11y.atspi.Text";
const DBUS_PROPS = "org.freedesktop.DBus.Properties";

// ---------------------------------------------------------------------------
// D-Bus / gdbus helpers
// ---------------------------------------------------------------------------

interface AtspiRef {
  busName: string;
  objectPath: string;
}

async function gdbus(
  dest: string,
  objectPath: string,
  method: string,
  args: string[] = [],
  timeout = 5000,
): Promise<string> {
  const cmdArgs = [
    "call",
    "--session",
    "--dest", dest,
    "--object-path", objectPath,
    "--method", method,
    ...args,
  ];
  const { stdout } = await execFileAsync("gdbus", cmdArgs, { timeout });
  return stdout.trim();
}

async function gdbusGetProperty(
  dest: string,
  objectPath: string,
  iface: string,
  prop: string,
  timeout = 5000,
): Promise<string> {
  return gdbus(dest, objectPath, `${DBUS_PROPS}.Get`, [iface, prop], timeout);
}

// ---------------------------------------------------------------------------
// AT-SPI2 tree helpers
// ---------------------------------------------------------------------------

/**
 * Get the desktop accessible (root of the AT-SPI2 tree).
 * Returns the children (applications) as an array of refs.
 */
async function getDesktopChildren(): Promise<AtspiRef[]> {
  try {
    const output = await gdbus(
      ATSPI_BUS,
      "/org/a11y/atspi/accessible/root",
      `${ATSPI_IFACE_ACCESSIBLE}.GetChildren`,
    );
    return parseRefArray(output);
  } catch {
    return [];
  }
}

/**
 * Parse a GVariant array of (so) tuples from gdbus output.
 * Format: [(':1.42', '/org/a11y/atspi/accessible/0'), ...]
 */
function parseRefArray(output: string): AtspiRef[] {
  const refs: AtspiRef[] = [];
  const regex = /\('([^']+)',\s*'([^']+)'\)/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    refs.push({ busName: match[1], objectPath: match[2] });
  }
  return refs;
}

/**
 * Get the role name of an accessible.
 */
async function atspiGetRoleName(ref: AtspiRef): Promise<string> {
  try {
    const output = await gdbus(
      ref.busName,
      ref.objectPath,
      `${ATSPI_IFACE_ACCESSIBLE}.GetRoleName`,
    );
    // Output: ('push button',)
    const match = output.match(/\('([^']*)'\)/);
    return match ? match[1].toLowerCase().replace(/\s+/g, "-") : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Get the name of an accessible.
 */
async function atspiGetName(ref: AtspiRef): Promise<string> {
  try {
    const output = await gdbusGetProperty(
      ref.busName,
      ref.objectPath,
      ATSPI_IFACE_ACCESSIBLE,
      "Name",
    );
    // Output: (<'Window Title'>,)
    const match = output.match(/<'((?:[^'\\]|\\.)*)'>/);
    return match ? match[1].replace(/\\'/g, "'") : "";
  } catch {
    return "";
  }
}

/**
 * Get the description of an accessible.
 */
async function atspiGetDescription(ref: AtspiRef): Promise<string> {
  try {
    const output = await gdbusGetProperty(
      ref.busName,
      ref.objectPath,
      ATSPI_IFACE_ACCESSIBLE,
      "Description",
    );
    const match = output.match(/<'((?:[^'\\]|\\.)*)'>/);
    return match ? match[1].replace(/\\'/g, "'") : "";
  } catch {
    return "";
  }
}

/**
 * Get children refs of an accessible.
 */
async function atspiGetChildren(ref: AtspiRef): Promise<AtspiRef[]> {
  try {
    const output = await gdbus(
      ref.busName,
      ref.objectPath,
      `${ATSPI_IFACE_ACCESSIBLE}.GetChildren`,
    );
    return parseRefArray(output);
  } catch {
    return [];
  }
}

/**
 * Get the state set of an accessible.
 * Returns state names as lowercase dash-separated strings.
 */
async function atspiGetStates(ref: AtspiRef): Promise<Set<string>> {
  const states = new Set<string>();
  try {
    const output = await gdbus(
      ref.busName,
      ref.objectPath,
      `${ATSPI_IFACE_ACCESSIBLE}.GetState`,
    );
    // Output: ([uint32 N, M],) — a pair of uint32 bitmasks
    const match = output.match(/\(\[(?:uint32\s+)?(\d+),\s*(\d+)\]/);
    if (!match) return states;

    const low = parseInt(match[1], 10) >>> 0;
    const high = parseInt(match[2], 10) >>> 0;

    // AT-SPI2 state enum values (from Atspi.StateType)
    const STATE_NAMES: Record<number, string> = {
      1: "active",
      2: "armed",
      3: "busy",
      4: "checked",
      7: "enabled",
      8: "expandable",
      9: "expanded",
      10: "focusable",
      11: "focused",
      12: "horizontal",
      14: "modal",
      16: "multi-selectable",
      18: "editable",
      19: "pressed",
      21: "selectable",
      22: "selected",
      23: "sensitive",
      24: "showing",
      26: "vertical",
      27: "visible",
      33: "indeterminate",
      35: "required",
      36: "read-only",
    };

    for (const [bit, name] of Object.entries(STATE_NAMES)) {
      const bitNum = parseInt(bit, 10);
      if (bitNum < 32) {
        if (low & (1 << bitNum)) states.add(name);
      } else {
        if (high & (1 << (bitNum - 32))) states.add(name);
      }
    }
  } catch {
    // Ignore — states will be empty
  }
  return states;
}

/**
 * Get the bounding rectangle of an accessible.
 */
async function atspiGetBounds(
  ref: AtspiRef,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  try {
    const output = await gdbus(
      ref.busName,
      ref.objectPath,
      `${ATSPI_IFACE_COMPONENT}.GetExtents`,
      ["uint32 0"], // ATSPI_COORD_TYPE_SCREEN
    );
    // Output: ((x, y, w, h),)
    const match = output.match(/\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)/);
    if (!match) return null;
    const x = parseInt(match[1], 10);
    const y = parseInt(match[2], 10);
    const w = parseInt(match[3], 10);
    const h = parseInt(match[4], 10);
    if (w <= 0 && h <= 0) return null;
    return { x, y, w, h };
  } catch {
    return null;
  }
}

/**
 * Get action names from the Action interface.
 */
async function atspiGetActions(ref: AtspiRef): Promise<string[]> {
  try {
    const output = await gdbus(
      ref.busName,
      ref.objectPath,
      `${ATSPI_IFACE_ACTION}.GetActions`,
    );
    // Output: ([('click', 'Clicks the button', ''), ...],)
    const actions: string[] = [];
    const regex = /\('([^']*)',\s*'[^']*',\s*'[^']*'\)/g;
    let match;
    while ((match = regex.exec(output)) !== null) {
      if (match[1]) actions.push(match[1].toLowerCase());
    }
    return actions;
  } catch {
    return [];
  }
}

/**
 * Get object attributes dict.
 */
async function atspiGetAttributes(ref: AtspiRef): Promise<Record<string, string>> {
  try {
    const output = await gdbus(
      ref.busName,
      ref.objectPath,
      `${ATSPI_IFACE_ACCESSIBLE}.GetAttributes`,
    );
    // Output: ({'key': 'value', ...},)
    const attrs: Record<string, string> = {};
    const regex = /'([^']+)':\s*'([^']*)'/g;
    let match;
    while ((match = regex.exec(output)) !== null) {
      attrs[match[1]] = match[2];
    }
    return attrs;
  } catch {
    return {};
  }
}

/**
 * Read Value interface: current, min, max.
 */
async function atspiGetValue(
  ref: AtspiRef,
): Promise<{ current: number; min: number; max: number } | null> {
  try {
    const [curOut, minOut, maxOut] = await Promise.all([
      gdbusGetProperty(ref.busName, ref.objectPath, ATSPI_IFACE_VALUE, "CurrentValue"),
      gdbusGetProperty(ref.busName, ref.objectPath, ATSPI_IFACE_VALUE, "MinimumValue"),
      gdbusGetProperty(ref.busName, ref.objectPath, ATSPI_IFACE_VALUE, "MaximumValue"),
    ]);
    const parseVal = (s: string): number => {
      const m = s.match(/<(?:double\s+)?(-?[\d.]+(?:e[+-]?\d+)?)/i);
      return m ? parseFloat(m[1]) : NaN;
    };
    const current = parseVal(curOut);
    const min = parseVal(minOut);
    const max = parseVal(maxOut);
    if (isNaN(current)) return null;
    return { current, min: isNaN(min) ? 0 : min, max: isNaN(max) ? 100 : max };
  } catch {
    return null;
  }
}

/**
 * Read the Text interface to get text content.
 */
async function atspiGetText(ref: AtspiRef): Promise<string> {
  try {
    // Get character count first
    const countOutput = await gdbusGetProperty(
      ref.busName,
      ref.objectPath,
      ATSPI_IFACE_TEXT,
      "CharacterCount",
    );
    const countMatch = countOutput.match(/<(?:int32\s+)?(\d+)>/);
    const charCount = countMatch ? parseInt(countMatch[1], 10) : 0;
    if (charCount <= 0 || charCount > 10000) return "";

    const output = await gdbus(
      ref.busName,
      ref.objectPath,
      `${ATSPI_IFACE_TEXT}.GetText`,
      ["int32 0", `int32 ${charCount}`],
    );
    // Output: ('text content',)
    const match = output.match(/\('((?:[^'\\]|\\.)*)'\)/);
    return match ? match[1].replace(/\\'/g, "'") : "";
  } catch {
    return "";
  }
}

/**
 * Get the process ID of an application accessible.
 */
async function atspiGetPid(ref: AtspiRef): Promise<number | null> {
  try {
    const output = await gdbus(
      ref.busName,
      ref.objectPath,
      `${ATSPI_IFACE_ACCESSIBLE}.GetApplication`,
    );
    // Application returns a ref — we need to get the pid from it
    const appRefs = parseRefArray(output);
    if (appRefs.length === 0) return null;

    const pidOutput = await gdbusGetProperty(
      appRefs[0].busName,
      appRefs[0].objectPath,
      "org.a11y.atspi.Application",
      "Id",
    );
    const pidMatch = pidOutput.match(/<(?:int32\s+)?(\d+)>/);
    return pidMatch ? parseInt(pidMatch[1], 10) : null;
  } catch {
    // Try getting ProcessId from the accessible itself
    try {
      const output = await gdbusGetProperty(
        ref.busName,
        ref.objectPath,
        ATSPI_IFACE_ACCESSIBLE,
        "ProcessId",
      );
      // Fallback to checking via /proc if needed
      return null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// CUP node builder
// ---------------------------------------------------------------------------

let globalIdCounter = 0;

function resetIdCounter(): void {
  globalIdCounter = 0;
}

function nextId(): string {
  return `e${globalIdCounter++}`;
}

async function buildCupNode(
  ref: AtspiRef,
  stats: TreeStats,
  depth: number,
  maxDepth: number,
  screenW: number,
  screenH: number,
  refs: Map<string, unknown>,
): Promise<CupNode | null> {
  if (depth > maxDepth) return null;

  stats.nodes++;
  stats.max_depth = Math.max(stats.max_depth, depth);

  // Gather properties in parallel where possible
  const [roleName, name, description, rawStates, bounds, rawActions, objAttrs] =
    await Promise.all([
      atspiGetRoleName(ref),
      atspiGetName(ref),
      atspiGetDescription(ref),
      atspiGetStates(ref),
      atspiGetBounds(ref),
      atspiGetActions(ref),
      atspiGetAttributes(ref),
    ]);

  // Track raw AT-SPI role names in stats
  stats.roles[roleName] = (stats.roles[roleName] ?? 0) + 1;

  // Role
  let role = CUP_ROLES[roleName] ?? "generic";

  // ARIA refinement from xml-roles attribute
  const xmlRole = (objAttrs["xml-roles"] ?? "").toLowerCase();
  if (xmlRole && ARIA_REFINEMENTS[xmlRole]) {
    role = ARIA_REFINEMENTS[xmlRole];
  }

  // Panel with a name -> region
  if (role === "group" && name) {
    role = "region";
  }

  // States
  const states: string[] = [];
  const isSensitive = rawStates.has("sensitive");
  if (!isSensitive) states.push("disabled");
  if (rawStates.has("focused")) states.push("focused");
  if (rawStates.has("checked")) states.push("checked");
  if (rawStates.has("pressed")) states.push("pressed");
  if (rawStates.has("indeterminate")) states.push("mixed");
  if (rawStates.has("expanded")) states.push("expanded");
  else if (rawStates.has("expandable")) states.push("collapsed");
  if (rawStates.has("selected")) states.push("selected");
  if (rawStates.has("required")) states.push("required");
  if (rawStates.has("modal")) states.push("modal");
  if (rawStates.has("read-only")) states.push("readonly");
  if (rawStates.has("editable") && !rawStates.has("read-only")) states.push("editable");
  if (rawStates.has("busy")) states.push("busy");
  if (rawStates.has("multi-selectable")) states.push("multiselectable");

  // Offscreen detection
  let isOffscreen = false;
  if (!rawStates.has("showing") && rawStates.has("visible")) {
    isOffscreen = true;
  } else if (bounds && screenW > 0 && screenH > 0) {
    if (
      bounds.x + bounds.w <= 0 ||
      bounds.y + bounds.h <= 0 ||
      bounds.x >= screenW ||
      bounds.y >= screenH
    ) {
      isOffscreen = true;
    }
  }
  if (isOffscreen) states.push("offscreen");

  // Actions
  const actions: string[] = [];
  const seenActions = new Set<string>();
  for (const rawAct of rawActions) {
    const mapped = ACTION_MAP[rawAct] ?? rawAct;
    if (mapped && !seenActions.has(mapped)) {
      actions.push(mapped);
      seenActions.add(mapped);
    }
  }

  // Expand/collapse from state
  if (rawStates.has("expandable") && !seenActions.has("expand")) {
    actions.push("expand");
    actions.push("collapse");
  }

  // Text input action
  if (TEXT_INPUT_ROLES.has(role) && rawStates.has("editable")) {
    if (!seenActions.has("type")) actions.push("type");
    if (!seenActions.has("setvalue")) actions.push("setvalue");
  }

  // Selection action
  if (rawStates.has("selectable") && !seenActions.has("select")) {
    actions.push("select");
  }

  // Default focus action
  if (actions.length === 0 && rawStates.has("focusable")) {
    actions.push("focus");
  }

  // Role refinement from actions
  if (role === "generic" && name && seenActions.has("click")) {
    role = "button";
  }

  // Value
  let valueStr = "";
  const valueRoles = new Set(["slider", "progressbar", "spinbutton", "scrollbar"]);
  const textRoles = new Set(["textbox", "searchbox", "combobox", "spinbutton", "document"]);

  // Get text content for text inputs
  let textContent = "";
  if (textRoles.has(role)) {
    textContent = await atspiGetText(ref);
  }

  // Get value for range widgets
  let valueInfo: { current: number; min: number; max: number } | null = null;
  if (valueRoles.has(role)) {
    valueInfo = await atspiGetValue(ref);
  }

  if (textContent) {
    valueStr = textContent.slice(0, 200);
  } else if (valueInfo !== null && valueRoles.has(role)) {
    valueStr = String(valueInfo.current);
  }

  // Attributes
  const attrs: Record<string, unknown> = {};
  if (role === "heading") {
    const levelStr = objAttrs.level ?? "";
    if (levelStr) {
      const lvl = parseInt(levelStr, 10);
      if (!isNaN(lvl)) attrs.level = lvl;
    }
  }

  if (valueInfo !== null && valueRoles.has(role)) {
    attrs.valueMin = valueInfo.min;
    attrs.valueMax = valueInfo.max;
    attrs.valueNow = valueInfo.current;
  }

  const placeholder = objAttrs["placeholder-text"] ?? "";
  if (placeholder && ["textbox", "searchbox", "combobox"].includes(role)) {
    attrs.placeholder = placeholder.slice(0, 200);
  }

  const orientableRoles = new Set(["scrollbar", "slider", "separator", "toolbar", "tablist"]);
  if (rawStates.has("horizontal") && orientableRoles.has(role)) {
    attrs.orientation = "horizontal";
  } else if (rawStates.has("vertical") && orientableRoles.has(role)) {
    attrs.orientation = "vertical";
  }

  if (role === "link") {
    const linkUrl = objAttrs.href ?? "";
    if (linkUrl) attrs.url = linkUrl.slice(0, 500);
  }

  // Assemble CUP node
  const node: CupNode = {
    id: nextId(),
    role,
    name: name.slice(0, 200),
  };

  if (description) node.description = description.slice(0, 200);
  if (valueStr) node.value = valueStr;
  if (bounds) node.bounds = bounds;
  if (states.length) node.states = states;
  if (actions.length) node.actions = actions;
  if (Object.keys(attrs).length) node.attributes = attrs as CupNode["attributes"];

  // Platform extension
  const plat: Record<string, unknown> = { atspiRole: roleName };
  if (objAttrs.id) plat.id = objAttrs.id;
  if (objAttrs.class) plat.class = objAttrs.class;
  if (objAttrs.toolkit) plat.toolkit = objAttrs.toolkit;
  if (rawActions.length) plat.actions = rawActions;
  node.platform = { linux: plat };

  // Store native ref for action execution
  refs.set(node.id, ref);

  // Children
  if (depth < maxDepth) {
    const childRefs = await atspiGetChildren(ref);
    if (childRefs.length > 0) {
      const childNodes: CupNode[] = [];
      for (const childRef of childRefs) {
        try {
          const childNode = await buildCupNode(
            childRef,
            stats,
            depth + 1,
            maxDepth,
            screenW,
            screenH,
            refs,
          );
          if (childNode !== null) {
            childNodes.push(childNode);
          }
        } catch {
          continue;
        }
      }
      if (childNodes.length) node.children = childNodes;
    }
  }

  return node;
}

// ---------------------------------------------------------------------------
// Screen info helpers
// ---------------------------------------------------------------------------

async function getScaleFactor(): Promise<number> {
  // GDK_SCALE env var (set by GTK/GNOME)
  const gdkScale = process.env.GDK_SCALE;
  if (gdkScale) {
    const val = parseFloat(gdkScale);
    if (!isNaN(val) && val > 0) return val;
  }

  // Qt scale factor
  const qtScale = process.env.QT_SCALE_FACTOR;
  if (qtScale) {
    const val = parseFloat(qtScale);
    if (!isNaN(val) && val > 0) return val;
  }

  // gsettings (GNOME)
  try {
    const { stdout } = await execFileAsync(
      "gsettings",
      ["get", "org.gnome.desktop.interface", "text-scaling-factor"],
      { timeout: 2000 },
    );
    const val = parseFloat(stdout.trim());
    if (!isNaN(val) && val > 0) return val;
  } catch {
    // Not GNOME or gsettings not available
  }

  return 1.0;
}

async function getScreenSize(): Promise<[number, number]> {
  // Try xrandr
  try {
    const { stdout } = await execFileAsync("xrandr", ["--query"], { timeout: 3000 });

    // Look for connected primary resolution
    let match = stdout.match(/(\d+)x(\d+)\+0\+0/);
    if (match) return [parseInt(match[1], 10), parseInt(match[2], 10)];

    // Fallback: "current WxH"
    match = stdout.match(/current\s+(\d+)\s*x\s*(\d+)/);
    if (match) return [parseInt(match[1], 10), parseInt(match[2], 10)];
  } catch {
    // xrandr not available
  }

  // Try xdpyinfo
  try {
    const { stdout } = await execFileAsync("xdpyinfo", [], { timeout: 3000 });
    const match = stdout.match(/dimensions:\s+(\d+)x(\d+)/);
    if (match) return [parseInt(match[1], 10), parseInt(match[2], 10)];
  } catch {
    // xdpyinfo not available
  }

  // Last resort default
  return [1920, 1080];
}

// ---------------------------------------------------------------------------
// Desktop app detection (for getDesktopWindow)
// ---------------------------------------------------------------------------

const DESKTOP_APPS = new Set([
  "nautilus", "nemo", "caja", "pcmanfm", "pcmanfm-qt", "thunar",
]);

// ---------------------------------------------------------------------------
// LinuxAdapter — PlatformAdapter implementation
// ---------------------------------------------------------------------------

export class LinuxAdapter implements PlatformAdapter {
  private _screenW = 0;
  private _screenH = 0;
  private _scale = 1.0;
  private _initialized = false;

  get platformName(): string {
    return "linux";
  }

  async initialize(): Promise<void> {
    if (this._initialized) return;

    // Verify gdbus is available
    try {
      await execFileAsync("gdbus", ["--version"], { timeout: 3000 });
    } catch {
      throw new Error(
        "gdbus not found. Install glib2-tools or libglib2.0-bin for AT-SPI2 support.",
      );
    }

    // Verify AT-SPI2 bus is accessible
    try {
      await gdbus(
        ATSPI_BUS,
        "/org/a11y/atspi/accessible/root",
        `${ATSPI_IFACE_ACCESSIBLE}.GetRoleName`,
      );
    } catch {
      throw new Error(
        "AT-SPI2 accessibility bus not available. Ensure AT-SPI2 is enabled " +
        "(set ACCESSIBILITY_ENABLED=1 or enable it in your desktop settings).",
      );
    }

    [this._screenW, this._screenH] = await getScreenSize();
    this._scale = await getScaleFactor();
    this._initialized = true;
  }

  async getScreenInfo(): Promise<[number, number, number]> {
    await this.initialize();
    return [this._screenW, this._screenH, this._scale];
  }

  async getForegroundWindow(): Promise<WindowMetadata> {
    await this.initialize();
    const apps = await getDesktopChildren();

    let best: WindowMetadata | null = null;

    for (const appRef of apps) {
      try {
        const appName = await atspiGetName(appRef);
        const children = await atspiGetChildren(appRef);

        for (const winRef of children) {
          try {
            const winStates = await atspiGetStates(winRef);
            const title = (await atspiGetName(winRef)) || appName;

            if (winStates.has("active") || winStates.has("focused")) {
              return {
                handle: winRef,
                title,
                pid: await atspiGetPid(appRef),
                bundle_id: null,
              };
            }
            // Track first visible window as fallback
            if (!best && winStates.has("visible")) {
              best = {
                handle: winRef,
                title,
                pid: await atspiGetPid(appRef),
                bundle_id: null,
              };
            }
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    if (best) return best;
    return {
      handle: { busName: ATSPI_BUS, objectPath: "/org/a11y/atspi/accessible/root" },
      title: "Desktop",
      pid: null,
      bundle_id: null,
    };
  }

  async getAllWindows(): Promise<WindowMetadata[]> {
    await this.initialize();
    const apps = await getDesktopChildren();
    const windows: WindowMetadata[] = [];

    for (const appRef of apps) {
      try {
        const appName = await atspiGetName(appRef);
        const children = await atspiGetChildren(appRef);

        for (const winRef of children) {
          try {
            const winStates = await atspiGetStates(winRef);
            if (!winStates.has("visible")) continue;

            const title = (await atspiGetName(winRef)) || appName;
            windows.push({
              handle: winRef,
              title,
              pid: await atspiGetPid(appRef),
              bundle_id: null,
            });
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    return windows;
  }

  async getWindowList(): Promise<WindowInfo[]> {
    await this.initialize();
    const apps = await getDesktopChildren();
    const results: WindowInfo[] = [];

    // Determine foreground window for marking
    let fgTitle: string | null = null;
    let fgPid: number | null = null;

    for (const appRef of apps) {
      try {
        const appName = await atspiGetName(appRef);
        const pid = await atspiGetPid(appRef);
        const children = await atspiGetChildren(appRef);

        for (const winRef of children) {
          try {
            const winStates = await atspiGetStates(winRef);
            if (!winStates.has("visible")) continue;

            const title = (await atspiGetName(winRef)) || appName;
            const isActive = winStates.has("active");

            if (isActive) {
              fgTitle = title;
              fgPid = pid;
            }

            const bounds = await atspiGetBounds(winRef);
            results.push({
              title,
              pid,
              bundle_id: null,
              foreground: isActive,
              bounds,
            });
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    // If no active window was found, try to match by stored fg info
    if (fgTitle === null && results.length > 0) {
      results[0].foreground = true;
    }

    return results;
  }

  async getDesktopWindow(): Promise<WindowMetadata | null> {
    await this.initialize();
    const apps = await getDesktopChildren();

    for (const appRef of apps) {
      try {
        const appName = (await atspiGetName(appRef)).toLowerCase();
        if (!DESKTOP_APPS.has(appName)) continue;

        const children = await atspiGetChildren(appRef);
        for (const winRef of children) {
          try {
            const roleName = await atspiGetRoleName(winRef);
            if (roleName === "desktop-frame") {
              return {
                handle: winRef,
                title: "Desktop",
                pid: await atspiGetPid(appRef),
                bundle_id: null,
              };
            }
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  async captureTree(
    windows: WindowMetadata[],
    options?: { maxDepth?: number },
  ): Promise<[CupNode[], TreeStats, Map<string, unknown>]> {
    await this.initialize();
    const maxDepth = options?.maxDepth ?? 999;
    const refs = new Map<string, unknown>();

    resetIdCounter();

    if (windows.length <= 1) {
      // Single window — sequential walk
      const stats: TreeStats = { nodes: 0, max_depth: 0, roles: {} };
      const tree: CupNode[] = [];

      for (const win of windows) {
        const winRef = win.handle as AtspiRef;
        try {
          const node = await buildCupNode(
            winRef,
            stats,
            0,
            maxDepth,
            this._screenW,
            this._screenH,
            refs,
          );
          if (node !== null) tree.push(node);
        } catch {
          continue;
        }
      }

      return [tree, stats, refs];
    } else {
      // Multiple windows — parallel walk with merged stats
      return this._parallelCapture(windows, maxDepth, refs);
    }
  }

  private async _parallelCapture(
    windows: WindowMetadata[],
    maxDepth: number,
    refs: Map<string, unknown>,
  ): Promise<[CupNode[], TreeStats, Map<string, unknown>]> {
    const perWindowResults = await Promise.all(
      windows.map(async (win) => {
        const localStats: TreeStats = { nodes: 0, max_depth: 0, roles: {} };
        try {
          const winRef = win.handle as AtspiRef;
          const node = await buildCupNode(
            winRef,
            localStats,
            0,
            maxDepth,
            this._screenW,
            this._screenH,
            refs,
          );
          return { node, stats: localStats };
        } catch {
          return { node: null, stats: localStats };
        }
      }),
    );

    // Merge results
    const tree: CupNode[] = [];
    const mergedStats: TreeStats = { nodes: 0, max_depth: 0, roles: {} };

    for (const { node, stats } of perWindowResults) {
      if (node !== null) tree.push(node);
      mergedStats.nodes += stats.nodes;
      mergedStats.max_depth = Math.max(mergedStats.max_depth, stats.max_depth);
      for (const [role, count] of Object.entries(stats.roles)) {
        mergedStats.roles[role] = (mergedStats.roles[role] ?? 0) + count;
      }
    }

    return [tree, mergedStats, refs];
  }
}
