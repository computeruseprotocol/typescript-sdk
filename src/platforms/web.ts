/**
 * Web platform adapter for CUP via Chrome DevTools Protocol (CDP).
 *
 * Connects to a Chromium browser running with --remote-debugging-port,
 * captures the accessibility tree via Accessibility.getFullAXTree(),
 * and optionally discovers WebMCP tools from the page context.
 *
 * Ported from python-sdk/cup/platforms/web.py
 */

import http from "node:http";
import type { PlatformAdapter } from "../base.js";
import type { CupNode, TreeStats, WindowInfo, WindowMetadata } from "../types.js";

// ---------------------------------------------------------------------------
// CDP Transport
// ---------------------------------------------------------------------------

let msgIdCounter = 0;

export async function cdpGetTargets(
  host: string,
  port: number,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${host}:${port}/json`, { timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Failed to parse CDP targets: ${err}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`CDP connection timed out at ${host}:${port}`));
    });
  });
}

export async function cdpConnect(wsUrl: string, host?: string): Promise<unknown> {
  const { default: WebSocket } = await import("ws");

  if (host) {
    const url = new URL(wsUrl);
    url.hostname = host;
    wsUrl = url.toString();
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 30000 });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

export async function cdpSend(
  ws: unknown,
  method: string,
  params?: Record<string, unknown> | null,
  timeout: number = 30000,
): Promise<Record<string, unknown>> {
  const socket = ws as import("ws").WebSocket;
  const msgId = ++msgIdCounter;

  const message: Record<string, unknown> = { id: msgId, method };
  if (params) message.params = params;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeListener("message", onMessage);
      reject(new Error(`CDP command '${method}' timed out after ${timeout}ms`));
    }, timeout);

    function onMessage(raw: Buffer | string) {
      const resp = JSON.parse(raw.toString());
      if (resp.id === msgId) {
        clearTimeout(timer);
        socket.removeListener("message", onMessage);
        if (resp.error) {
          reject(new Error(`CDP error ${resp.error.code}: ${resp.error.message}`));
        } else {
          resolve(resp);
        }
      }
      // else: event notification — discard
    }

    socket.on("message", onMessage);
    socket.send(JSON.stringify(message));
  });
}

export function cdpClose(ws: unknown): void {
  try {
    (ws as import("ws").WebSocket).close();
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// CDP AX Role → CUP Role mapping
// ---------------------------------------------------------------------------

const SKIP_ROLES = new Set([
  "InlineTextBox",
  "LineBreak",
  "IframePresentational",
  "none",
  "Ignored",
  "IgnoredRole",
]);

const CDP_ROLE_MAP: Record<string, string> = {
  RootWebArea: "document",
  WebArea: "document",
  GenericContainer: "generic",
  Iframe: "generic",
  Div: "generic",
  Span: "generic",
  Paragraph: "generic",
  Pre: "generic",
  Mark: "generic",
  Abbr: "generic",
  Ruby: "generic",
  Time: "generic",
  Subscript: "generic",
  Superscript: "generic",
  LabelText: "generic",
  Legend: "generic",
  StaticText: "text",
  Blockquote: "group",
  Figcaption: "group",
  DescriptionListDetail: "group",
  Details: "group",
  DescriptionList: "list",
  DescriptionListTerm: "listitem",
  progressIndicator: "progressbar",
  spinButton: "spinbutton",
  tabList: "tablist",
  tabPanel: "tabpanel",
  menuItem: "menuitem",
  menuItemCheckBox: "menuitemcheckbox",
  menuItemRadio: "menuitemradio",
  menuBar: "menubar",
  listItem: "listitem",
  treeItem: "treeitem",
  columnHeader: "columnheader",
  rowHeader: "rowheader",
  comboBoxGrouping: "combobox",
  comboBoxMenuButton: "combobox",
  comboBoxSelect: "combobox",
  alertDialog: "alertdialog",
  contentInfo: "contentinfo",
  radioButton: "radio",
  scrollBar: "scrollbar",
  Summary: "button",
  Meter: "progressbar",  // meter → progressbar (both show value in range)
  Output: "status",
  Figure: "group",
  Canvas: "img",
  Video: "generic",
  Audio: "generic",
  Section: "generic",
};

// Canonical CUP roles (59) — matches the schema enum exactly.
// Non-schema ARIA roles are mapped to CUP equivalents below.
const CUP_ROLES = new Set([
  "alert", "alertdialog", "application", "banner", "button",
  "cell", "checkbox", "columnheader", "combobox", "complementary",
  "contentinfo", "dialog", "document", "form", "generic", "grid",
  "group", "heading", "img", "link", "list", "listitem", "log",
  "main", "marquee", "menu", "menubar", "menuitem", "menuitemcheckbox",
  "menuitemradio", "navigation", "none", "option", "progressbar", "radio",
  "region", "row", "rowheader", "scrollbar", "search", "searchbox",
  "separator", "slider", "spinbutton", "status", "switch", "tab", "table",
  "tablist", "tabpanel", "text", "textbox", "timer", "titlebar", "toolbar",
  "tooltip", "tree", "treeitem", "window",
]);

// Non-schema ARIA roles → closest CUP equivalent.
// CDP sometimes returns these as role names directly (lowercase).
const NON_SCHEMA_ROLE_MAP: Record<string, string> = {
  article: "region",
  definition: "text",
  directory: "list",
  feed: "list",
  figure: "group",
  gridcell: "cell",
  listbox: "list",
  math: "generic",
  meter: "progressbar",
  note: "region",
  pane: "generic",
  presentation: "none",
  radiogroup: "group",
  rowgroup: "group",
  term: "text",
  treegrid: "grid",
};

const TEXT_INPUT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const CLICKABLE_ROLES = new Set([
  "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "tab",
]);
const SELECTABLE_ROLES = new Set([
  "option", "tab", "treeitem", "listitem", "row", "cell",
]);
const TOGGLE_ROLES = new Set(["checkbox", "switch", "menuitemcheckbox"]);
const RANGE_ROLES = new Set(["slider", "spinbutton", "progressbar", "scrollbar"]);

function mapCdpRole(cdpRole: string, name: string): string | null {
  if (SKIP_ROLES.has(cdpRole)) return null;

  const cupRole = CDP_ROLE_MAP[cdpRole];
  if (cupRole != null) {
    if (cdpRole === "Section" && name) return "region";
    return cupRole;
  }

  const lower = cdpRole.toLowerCase();
  if (CUP_ROLES.has(lower)) return lower;

  // Map non-schema ARIA roles to CUP equivalents
  const mapped = NON_SCHEMA_ROLE_MAP[lower];
  if (mapped) return mapped;

  return "generic";
}

// ---------------------------------------------------------------------------
// State extraction
// ---------------------------------------------------------------------------

function extractStates(
  props: Record<string, unknown>,
  role: string,
  bounds: { x: number; y: number; w: number; h: number } | null,
  viewportW: number,
  viewportH: number,
): string[] {
  const states: string[] = [];

  if (props.disabled) states.push("disabled");
  if (props.focused) states.push("focused");

  const expanded = props.expanded;
  if (expanded === true) states.push("expanded");
  else if (expanded === false) states.push("collapsed");

  if (props.selected) states.push("selected");

  const checked = props.checked;
  if (checked === true || checked === "true") states.push("checked");
  else if (checked === "mixed") states.push("mixed");

  const pressed = props.pressed;
  if (pressed === true || pressed === "true") states.push("pressed");
  else if (pressed === "mixed") states.push("mixed");

  if (props.busy) states.push("busy");
  if (props.modal) states.push("modal");
  if (props.required) states.push("required");

  const readonly = props.readonly;
  if (readonly) states.push("readonly");

  if (TEXT_INPUT_ROLES.has(role) && !readonly) states.push("editable");

  if (bounds) {
    const { x, y, w, h } = bounds;
    if (w <= 0 || h <= 0 || x + w <= 0 || y + h <= 0 || x >= viewportW || y >= viewportH) {
      states.push("offscreen");
    }
  }

  return states;
}

// ---------------------------------------------------------------------------
// Action derivation
// ---------------------------------------------------------------------------

function deriveActions(role: string, props: Record<string, unknown>, states: string[]): string[] {
  const actions: string[] = [];

  if (states.includes("disabled")) return actions;

  if (CLICKABLE_ROLES.has(role)) {
    actions.push("click", "rightclick", "doubleclick");
  }

  if (TOGGLE_ROLES.has(role)) actions.push("toggle");

  if (SELECTABLE_ROLES.has(role) && !actions.includes("select")) {
    actions.push("select");
  }

  if (states.includes("expanded") || states.includes("collapsed")) {
    if (!actions.includes("expand")) {
      actions.push("expand", "collapse");
    }
  }

  if (TEXT_INPUT_ROLES.has(role) && !states.includes("readonly")) {
    actions.push("type", "setvalue");
  }

  if (role === "slider" || role === "spinbutton") {
    actions.push("increment", "decrement");
  }

  if (role === "scrollbar") actions.push("scroll");

  if (actions.length === 0 && props.focusable) actions.push("focus");

  return actions;
}

// ---------------------------------------------------------------------------
// Attribute extraction
// ---------------------------------------------------------------------------

function extractAttributes(
  props: Record<string, unknown>,
  role: string,
  _axNode: Record<string, unknown>,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};

  if (props.level != null) attrs.level = Number(props.level);
  if (props.placeholder) attrs.placeholder = String(props.placeholder).slice(0, 200);
  if (props.orientation) attrs.orientation = String(props.orientation);

  if (RANGE_ROLES.has(role)) {
    if (props.valuemin != null) attrs.valueMin = Number(props.valuemin);
    if (props.valuemax != null) attrs.valueMax = Number(props.valuemax);
    const vnow = props.valuetext ?? props.valuenow;
    if (vnow != null) {
      const n = Number(vnow);
      if (!isNaN(n)) attrs.valueNow = n;
    }
  }

  if (role === "link" && props.url) {
    attrs.url = String(props.url).slice(0, 500);
  }

  if (props.autocomplete && props.autocomplete !== "none") {
    attrs.autocomplete = String(props.autocomplete);
  }

  return attrs;
}

// ---------------------------------------------------------------------------
// CUP node builder
// ---------------------------------------------------------------------------

function axValue(field: unknown): unknown {
  if (typeof field === "object" && field !== null && "value" in field) {
    return (field as Record<string, unknown>).value;
  }
  return field;
}

const VALUE_NODE_ROLES = new Set([
  "textbox", "searchbox", "combobox", "spinbutton", "slider",
  "progressbar", "document",
]);

function buildCupNode(
  axNode: Record<string, unknown>,
  idGen: { next: () => number },
  stats: TreeStats,
  viewportW: number,
  viewportH: number,
): CupNode | null {
  const cdpRole = (axValue(axNode.role) as string) || "generic";
  const rawName = (axValue(axNode.name) as string) || "";
  const role = mapCdpRole(cdpRole, rawName);
  if (role === null) return null;

  stats.nodes += 1;
  stats.roles[cdpRole] = (stats.roles[cdpRole] ?? 0) + 1;

  const name = rawName ? String(rawName).slice(0, 200) : "";
  const description = String((axValue(axNode.description) as string) || "").slice(0, 200);

  const rawValue = axValue(axNode.value);
  const valueStr = rawValue != null ? String(rawValue).slice(0, 200) : "";

  // Properties to flat dict
  const props: Record<string, unknown> = {};
  for (const prop of (axNode.properties as Array<Record<string, unknown>>) ?? []) {
    const propName = prop.name as string;
    if (propName) props[propName] = axValue(prop.value);
  }

  // Bounds
  let bounds: { x: number; y: number; w: number; h: number } | null = null;
  const bb = axNode.boundingBox as Record<string, number> | undefined;
  if (bb) {
    bounds = {
      x: Math.round(bb.x ?? 0),
      y: Math.round(bb.y ?? 0),
      w: Math.round(bb.width ?? 0),
      h: Math.round(bb.height ?? 0),
    };
  }

  const states = extractStates(props, role, bounds, viewportW, viewportH);
  const actions = deriveActions(role, props, states);
  const attrs = extractAttributes(props, role, axNode);

  const node: CupNode = {
    id: `e${idGen.next()}`,
    role,
    name,
  };

  if (description) node.description = description;
  if (valueStr && VALUE_NODE_ROLES.has(role)) node.value = valueStr;
  if (bounds) node.bounds = bounds;
  if (states.length > 0) node.states = states;
  if (actions.length > 0) node.actions = actions;
  if (Object.keys(attrs).length > 0) node.attributes = attrs as CupNode["attributes"];

  // Platform extension
  const platformExt: Record<string, unknown> = { cdpRole };
  const backendId = axNode.backendDOMNodeId;
  if (backendId != null) platformExt.backendDOMNodeId = backendId;
  const nodeId = axNode.nodeId;
  if (nodeId) platformExt.cdpNodeId = nodeId;
  node.platform = { web: platformExt as CupNode["platform"] extends undefined ? never : NonNullable<CupNode["platform"]>["web"] };

  return node;
}

// ---------------------------------------------------------------------------
// Tree reconstruction from flat CDP AX node list
// ---------------------------------------------------------------------------

interface PromotedResult {
  _promoted: CupNode[];
}

function buildTreeFromFlat(
  axNodes: Array<Record<string, unknown>>,
  idGen: { next: () => number },
  stats: TreeStats,
  maxDepth: number,
  viewportW: number,
  viewportH: number,
  refs: Map<string, unknown>,
  wsUrl?: string | null,
): CupNode[] {
  if (axNodes.length === 0) return [];

  const nodeMap = new Map<string, Record<string, unknown>>();
  for (const axNode of axNodes) {
    const nid = axNode.nodeId as string;
    if (nid) nodeMap.set(nid, axNode);
  }

  const cupCache = new Map<string, CupNode | PromotedResult | null>();

  function convert(nodeId: string, depth: number): CupNode | PromotedResult | null {
    if (depth > maxDepth) return null;
    if (cupCache.has(nodeId)) return cupCache.get(nodeId)!;

    const axNode = nodeMap.get(nodeId);
    if (!axNode) return null;

    const cdpRole = (axValue(axNode.role) as string) || "generic";
    if (SKIP_ROLES.has(cdpRole)) {
      cupCache.set(nodeId, null);
      const childIds = (axNode.childIds as string[]) ?? [];
      const promoted: CupNode[] = [];
      if (childIds.length > 0 && depth < maxDepth) {
        for (const cid of childIds) {
          const child = convert(String(cid), depth);
          if (child === null) continue;
          if ("_promoted" in child) {
            promoted.push(...child._promoted);
          } else {
            promoted.push(child as CupNode);
          }
        }
      }
      if (promoted.length > 0) {
        const result: PromotedResult = { _promoted: promoted };
        cupCache.set(nodeId, result);
        return result;
      }
      return null;
    }

    const cupNode = buildCupNode(axNode, idGen, stats, viewportW, viewportH);
    if (!cupNode) {
      cupCache.set(nodeId, null);
      return null;
    }

    if (wsUrl != null) {
      const backendId = axNode.backendDOMNodeId;
      if (backendId != null) {
        refs.set(cupNode.id, [wsUrl, backendId]);
      }
    }

    stats.max_depth = Math.max(stats.max_depth, depth);

    const childIds = (axNode.childIds as string[]) ?? [];
    if (childIds.length > 0 && depth < maxDepth) {
      const children: CupNode[] = [];
      for (const cid of childIds) {
        const childResult = convert(String(cid), depth + 1);
        if (childResult === null) continue;
        if ("_promoted" in childResult) {
          children.push(...childResult._promoted);
        } else {
          children.push(childResult as CupNode);
        }
      }
      if (children.length > 0) cupNode.children = children;
    }

    cupCache.set(nodeId, cupNode);
    return cupNode;
  }

  const rootId = axNodes[0].nodeId as string;
  const root = convert(rootId, 0);
  if (root === null) return [];
  if ("_promoted" in root) return root._promoted;
  return [root as CupNode];
}

// ---------------------------------------------------------------------------
// WebMCP tool discovery
// ---------------------------------------------------------------------------

const WEBMCP_JS = `(() => {
    try {
        const mc = navigator.modelContext;
        if (!mc) return JSON.stringify([]);
        let tools = [];
        if (typeof mc.getTools === 'function') {
            tools = mc.getTools();
        } else if (mc.tools) {
            tools = Array.from(mc.tools);
        } else if (mc._tools) {
            tools = Array.from(mc._tools);
        }
        return JSON.stringify(
            tools.map(t => ({
                name: t.name || '',
                description: t.description || '',
                inputSchema: t.inputSchema || null,
                annotations: t.annotations || null,
            })).filter(t => t.name)
        );
    } catch (e) {
        return JSON.stringify([]);
    }
})()`;

async function extractWebmcpTools(ws: unknown): Promise<Array<Record<string, unknown>>> {
  try {
    const resp = await cdpSend(
      ws,
      "Runtime.evaluate",
      { expression: WEBMCP_JS, returnByValue: true, awaitPromise: false },
      5000,
    );
    const remoteObj = (resp.result as Record<string, unknown>)?.result as Record<string, unknown>;
    const raw = remoteObj?.value ?? "[]";
    const tools = typeof raw === "string" ? JSON.parse(raw) : [];
    return tools.filter((t: Record<string, unknown>) => typeof t === "object" && t.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Viewport info
// ---------------------------------------------------------------------------

async function getViewportInfo(ws: unknown): Promise<[number, number, number]> {
  try {
    const resp = await cdpSend(
      ws,
      "Runtime.evaluate",
      {
        expression:
          "JSON.stringify({w:window.innerWidth,h:window.innerHeight,s:window.devicePixelRatio})",
        returnByValue: true,
      },
      5000,
    );
    const raw =
      ((resp.result as Record<string, unknown>)?.result as Record<string, unknown>)?.value ?? "{}";
    const info = JSON.parse(raw as string);
    return [
      Number(info.w ?? 1920),
      Number(info.h ?? 1080),
      Number(info.s ?? 1.0),
    ];
  } catch {
    return [1920, 1080, 1.0];
  }
}

// ---------------------------------------------------------------------------
// WebAdapter
// ---------------------------------------------------------------------------

export class WebAdapter implements PlatformAdapter {
  private host: string;
  private port: number;
  private initialized = false;
  private lastTools: Array<Record<string, unknown>> = [];

  constructor(options?: { cdpHost?: string; cdpPort?: number }) {
    this.host = options?.cdpHost ?? process.env.CUP_CDP_HOST ?? "127.0.0.1";
    this.port = options?.cdpPort ?? parseInt(process.env.CUP_CDP_PORT ?? "9222", 10);
  }

  get platformName(): string {
    return "web";
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    let targets: Array<Record<string, unknown>>;
    try {
      targets = await cdpGetTargets(this.host, this.port);
    } catch (err) {
      throw new Error(
        `Cannot connect to CDP at ${this.host}:${this.port}. ` +
          `Launch Chrome with: chrome --remote-debugging-port=${this.port}\n` +
          `  Error: ${err}`,
      );
    }
    const pageTargets = targets.filter((t) => t.type === "page");
    if (pageTargets.length === 0) {
      throw new Error(
        `CDP endpoint at ${this.host}:${this.port} has no page targets. ` +
          `Open at least one tab in the browser.`,
      );
    }
    this.initialized = true;
  }

  async getScreenInfo(): Promise<[number, number, number]> {
    const targets = await cdpGetTargets(this.host, this.port);
    const pageTargets = targets.filter((t) => t.type === "page");
    if (pageTargets.length === 0) return [1920, 1080, 1.0];

    const ws = await cdpConnect(pageTargets[0].webSocketDebuggerUrl as string, this.host);
    try {
      return await getViewportInfo(ws);
    } finally {
      cdpClose(ws);
    }
  }

  private async pageTargets(): Promise<Array<Record<string, unknown>>> {
    const targets = await cdpGetTargets(this.host, this.port);
    return targets.filter((t) => t.type === "page");
  }

  async getForegroundWindow(): Promise<WindowMetadata> {
    const pages = await this.pageTargets();
    if (pages.length === 0) throw new Error("No browser tabs found");
    const t = pages[0];
    return {
      handle: t.webSocketDebuggerUrl,
      title: (t.title as string) ?? "",
      pid: null,
      bundle_id: null,
      url: (t.url as string) ?? "",
    };
  }

  async getAllWindows(): Promise<WindowMetadata[]> {
    const pages = await this.pageTargets();
    return pages.map((t) => ({
      handle: t.webSocketDebuggerUrl,
      title: (t.title as string) ?? "",
      pid: null,
      bundle_id: null,
      url: (t.url as string) ?? "",
    }));
  }

  async getWindowList(): Promise<WindowInfo[]> {
    const pages = await this.pageTargets();
    return pages.map((t, i) => ({
      title: (t.title as string) ?? "",
      pid: null,
      bundle_id: null,
      foreground: i === 0,
      bounds: null,
      url: (t.url as string) ?? "",
    }));
  }

  async getDesktopWindow(): Promise<WindowMetadata | null> {
    return null;
  }

  async captureTree(
    windows: WindowMetadata[],
    options?: { maxDepth?: number },
  ): Promise<[CupNode[], TreeStats, Map<string, unknown>]> {
    await this.initialize();
    const maxDepth = options?.maxDepth ?? 999;

    let idCounter = 0;
    const idGen = { next: () => idCounter++ };
    const stats: TreeStats = { nodes: 0, max_depth: 0, roles: {} };
    const refs = new Map<string, unknown>();
    const tree: CupNode[] = [];
    const allTools: Array<Record<string, unknown>> = [];

    for (const win of windows) {
      const wsUrl = win.handle as string;
      const ws = await cdpConnect(wsUrl, this.host);
      try {
        await cdpSend(ws, "Accessibility.enable");
        await cdpSend(ws, "Runtime.enable");

        const [vw, vh] = await getViewportInfo(ws);

        const result = await cdpSend(ws, "Accessibility.getFullAXTree");
        const axNodes = ((result.result as Record<string, unknown>)?.nodes ??
          []) as Array<Record<string, unknown>>;

        const roots = buildTreeFromFlat(axNodes, idGen, stats, maxDepth, vw, vh, refs, wsUrl);
        tree.push(...roots);

        const tools = await extractWebmcpTools(ws);
        allTools.push(...tools);
      } catch {
        continue;
      } finally {
        cdpClose(ws);
      }
    }

    this.lastTools = allTools;
    return [tree, stats, refs];
  }

  getLastTools(): Array<Record<string, unknown>> {
    return this.lastTools;
  }
}
