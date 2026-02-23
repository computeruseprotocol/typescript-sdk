/**
 * Core CUP type definitions.
 *
 * Hand-written from the CUP JSON Schema (cup.schema.json) for
 * maximum IDE ergonomics (autocomplete, hover docs, type narrowing).
 */

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export type PlatformId =
  | "windows"
  | "macos"
  | "linux"
  | "web"
  | "android"
  | "ios";

// ---------------------------------------------------------------------------
// Screen & geometry
// ---------------------------------------------------------------------------

export interface Screen {
  w: number;
  h: number;
  scale?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// App info
// ---------------------------------------------------------------------------

export interface AppInfo {
  name?: string;
  pid?: number;
  bundleId?: string;
}

// ---------------------------------------------------------------------------
// Roles (54 canonical ARIA-derived roles)
// ---------------------------------------------------------------------------

export type Role =
  | "alert"
  | "alertdialog"
  | "application"
  | "banner"
  | "button"
  | "cell"
  | "checkbox"
  | "columnheader"
  | "combobox"
  | "complementary"
  | "contentinfo"
  | "dialog"
  | "document"
  | "form"
  | "generic"
  | "grid"
  | "group"
  | "heading"
  | "img"
  | "link"
  | "list"
  | "listbox"
  | "listitem"
  | "log"
  | "main"
  | "marquee"
  | "menu"
  | "menubar"
  | "menuitem"
  | "menuitemcheckbox"
  | "menuitemradio"
  | "navigation"
  | "none"
  | "option"
  | "progressbar"
  | "radio"
  | "region"
  | "row"
  | "rowheader"
  | "scrollbar"
  | "search"
  | "searchbox"
  | "separator"
  | "slider"
  | "spinbutton"
  | "status"
  | "switch"
  | "tab"
  | "table"
  | "tablist"
  | "tabpanel"
  | "text"
  | "textbox"
  | "timer"
  | "titlebar"
  | "toolbar"
  | "tooltip"
  | "tree"
  | "treeitem"
  | "window";

// ---------------------------------------------------------------------------
// States (16 active-only flags)
// ---------------------------------------------------------------------------

export type State =
  | "busy"
  | "checked"
  | "collapsed"
  | "disabled"
  | "editable"
  | "expanded"
  | "focused"
  | "hidden"
  | "mixed"
  | "modal"
  | "multiselectable"
  | "offscreen"
  | "pressed"
  | "readonly"
  | "required"
  | "selected";

// ---------------------------------------------------------------------------
// Actions (15 element-level canonical actions)
// ---------------------------------------------------------------------------

export type Action =
  | "click"
  | "collapse"
  | "decrement"
  | "dismiss"
  | "doubleclick"
  | "expand"
  | "focus"
  | "increment"
  | "longpress"
  | "rightclick"
  | "scroll"
  | "select"
  | "setvalue"
  | "toggle"
  | "type";

// ---------------------------------------------------------------------------
// Node attributes
// ---------------------------------------------------------------------------

export interface Attributes {
  level?: number;
  valueMin?: number;
  valueMax?: number;
  valueNow?: number;
  orientation?: "horizontal" | "vertical";
  rowIndex?: number;
  colIndex?: number;
  rowCount?: number;
  colCount?: number;
  posInSet?: number;
  setSize?: number;
  placeholder?: string;
  url?: string;
  live?: "polite" | "assertive" | "off";
  autocomplete?: "inline" | "list" | "both" | "none";
  keyShortcut?: string;
  roledescription?: string;
}

// ---------------------------------------------------------------------------
// Platform extension types
// ---------------------------------------------------------------------------

export interface PlatformWindows {
  controlType?: number;
  automationId?: string;
  className?: string;
  patterns?: string[];
  hwnd?: number;
  [key: string]: unknown;
}

export interface PlatformMacOS {
  axRole?: string;
  axSubrole?: string;
  axIdentifier?: string;
  axActions?: string[];
  [key: string]: unknown;
}

export interface PlatformLinux {
  atspiRole?: string;
  interfaces?: string[];
  [key: string]: unknown;
}

export interface PlatformWeb {
  tagName?: string;
  ariaRole?: string;
  selector?: string;
  xpath?: string;
  inputType?: string;
  cdpRole?: string;
  backendDOMNodeId?: number;
  cdpNodeId?: string;
  [key: string]: unknown;
}

export interface PlatformAndroid {
  className?: string;
  resourceId?: string;
  packageName?: string;
  isClickable?: boolean;
  isScrollable?: boolean;
  [key: string]: unknown;
}

export interface PlatformIOS {
  elementType?: string;
  identifier?: string;
  traits?: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// CUP Node
// ---------------------------------------------------------------------------

export interface CupNode {
  id: string;
  role: string;
  name: string;
  description?: string;
  value?: string;
  bounds?: Rect;
  states?: string[];
  actions?: string[];
  attributes?: Attributes;
  children?: CupNode[];
  platform?: {
    windows?: PlatformWindows;
    macos?: PlatformMacOS;
    linux?: PlatformLinux;
    web?: PlatformWeb;
    android?: PlatformAndroid;
    ios?: PlatformIOS;
  };
  /** Internal pruning marker — not part of the CUP schema. */
  _clipped?: { above: number; below: number; left: number; right: number };
}

// ---------------------------------------------------------------------------
// Window info (for overview / window lists)
// ---------------------------------------------------------------------------

export interface WindowInfo {
  title: string;
  pid?: number | null;
  bundle_id?: string | null;
  foreground?: boolean;
  bounds?: Rect | null;
  url?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// CUP Envelope (top-level document)
// ---------------------------------------------------------------------------

export interface CupEnvelope {
  version: string;
  platform: string;
  timestamp?: number;
  screen: Screen;
  app?: AppInfo;
  scope?: Scope;
  tree: CupNode[];
  windows?: WindowInfo[];
  tools?: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// Scope & Detail
// ---------------------------------------------------------------------------

export type Scope = "overview" | "foreground" | "desktop" | "full";

export type Detail = "standard" | "minimal" | "full";

// ---------------------------------------------------------------------------
// Window metadata (internal, from adapters)
// ---------------------------------------------------------------------------

export interface WindowMetadata {
  handle: unknown;
  title: string;
  pid: number | null;
  bundle_id?: string | null;
  url?: string;
}

// ---------------------------------------------------------------------------
// Tree capture stats
// ---------------------------------------------------------------------------

export interface TreeStats {
  nodes: number;
  max_depth: number;
  roles: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Action result
// ---------------------------------------------------------------------------

export interface ActionResult {
  success: boolean;
  message: string;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Batch action spec
// ---------------------------------------------------------------------------

export type BatchAction =
  | { action: "wait"; ms?: number }
  | { action: "press"; keys: string }
  | { element_id: string; action: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// Search result
// ---------------------------------------------------------------------------

export interface SearchResult {
  node: CupNode;
  score: number;
}
