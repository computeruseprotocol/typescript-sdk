/**
 * CUP format utilities: envelope builder, compact text serializer, and overview.
 *
 * Ported from python-sdk/cup/format.py
 */

import type { CupEnvelope, CupNode, Detail, Rect, WindowInfo } from "./types.js";

// ---------------------------------------------------------------------------
// CUP envelope
// ---------------------------------------------------------------------------

export function buildEnvelope(
  treeData: CupNode[],
  options: {
    platform: string;
    scope?: string;
    screenW: number;
    screenH: number;
    screenScale?: number;
    appName?: string | null;
    appPid?: number | null;
    appBundleId?: string | null;
    tools?: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }> | null;
  },
): CupEnvelope {
  const screen: { w: number; h: number; scale?: number } = {
    w: options.screenW,
    h: options.screenH,
  };
  if (options.screenScale != null && options.screenScale !== 1.0) {
    screen.scale = options.screenScale;
  }

  const envelope: CupEnvelope = {
    version: "0.1.0",
    platform: options.platform,
    timestamp: Date.now(),
    screen,
    tree: treeData,
  };

  if (options.scope) {
    envelope.scope = options.scope as CupEnvelope["scope"];
  }

  if (options.appName || options.appPid != null || options.appBundleId) {
    const app: Record<string, unknown> = {};
    if (options.appName) app.name = options.appName;
    if (options.appPid != null) app.pid = options.appPid;
    if (options.appBundleId) app.bundleId = options.appBundleId;
    envelope.app = app as CupEnvelope["app"];
  }

  if (options.tools && options.tools.length > 0) {
    envelope.tools = options.tools;
  }

  return envelope;
}

// ---------------------------------------------------------------------------
// Overview serializer (window list only, no tree)
// ---------------------------------------------------------------------------

export function serializeOverview(
  windowList: WindowInfo[],
  options: { platform: string; screenW: number; screenH: number },
): string {
  const lines = [
    `# CUP 0.1.0 | ${options.platform} | ${options.screenW}x${options.screenH}`,
    `# overview | ${windowList.length} windows`,
    "",
  ];

  for (const win of windowList) {
    const title = win.title || "(untitled)";
    const pid = win.pid;
    const isFg = win.foreground ?? false;
    const bounds = win.bounds;

    const prefix = isFg ? "* " : "  ";
    const marker = isFg ? "[fg] " : "";

    const parts = [`${prefix}${marker}${title}`];
    if (pid != null) {
      parts.push(`(pid:${pid})`);
    }
    if (bounds) {
      parts.push(`@${bounds.x},${bounds.y} ${bounds.w}x${bounds.h}`);
    }

    const url = win.url;
    if (url) {
      const truncated = url.length > 80 ? url.slice(0, 80) + "..." : url;
      parts.push(`url:${truncated}`);
    }

    lines.push(parts.join(" "));
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Node counting
// ---------------------------------------------------------------------------

function countNodes(nodes: CupNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += 1;
    total += countNodes(node.children ?? []);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Pruning helpers
// ---------------------------------------------------------------------------

const CHROME_ROLES = new Set(["scrollbar", "separator", "titlebar", "tooltip", "status"]);

const COLLAPSIBLE_ROLES = new Set([
  "region",
  "document",
  "main",
  "complementary",
  "navigation",
  "search",
  "banner",
  "contentinfo",
  "form",
]);

function hasMeaningfulActions(node: CupNode): boolean {
  const actions = node.actions ?? [];
  return actions.some((a) => a !== "focus");
}

function shouldSkip(node: CupNode, parent: CupNode | null, siblings: number): boolean {
  const role = node.role;
  const name = node.name || "";
  const states = node.states ?? [];

  // Skip window chrome / decorative roles
  if (CHROME_ROLES.has(role)) return true;

  // Skip zero-size elements
  const bounds = node.bounds;
  if (bounds && (bounds.w === 0 || bounds.h === 0)) return true;

  // Skip offscreen nodes with no meaningful actions
  if (states.includes("offscreen")) {
    const actions = node.actions ?? [];
    const meaningful = actions.filter((a) => a !== "focus");
    if (meaningful.length === 0) return true;
  }

  // Skip unnamed decorative images
  if (role === "img" && !name) return true;

  // Skip empty-name text nodes
  if (role === "text" && !name) return true;

  // Skip text that is sole child of a named parent (redundant label)
  if (role === "text" && parent && parent.name && siblings === 1) return true;

  return false;
}

function shouldHoist(node: CupNode): boolean {
  const role = node.role;
  const name = node.name || "";

  if (role === "generic" && !name) return true;
  if (role === "region" && !name) return true;

  if (role === "group" && !name) {
    if (!hasMeaningfulActions(node)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Viewport clipping helpers
// ---------------------------------------------------------------------------

function isOutsideViewport(childBounds: Rect, viewport: Rect): boolean {
  return (
    childBounds.x + childBounds.w <= viewport.x ||
    childBounds.x >= viewport.x + viewport.w ||
    childBounds.y + childBounds.h <= viewport.y ||
    childBounds.y >= viewport.y + viewport.h
  );
}

function clipDirection(childBounds: Rect, viewport: Rect): string {
  if (childBounds.y + childBounds.h <= viewport.y) return "above";
  if (childBounds.y >= viewport.y + viewport.h) return "below";
  if (childBounds.x + childBounds.w <= viewport.x) return "left";
  return "right";
}

function isScrollable(node: CupNode): boolean {
  return (node.actions ?? []).includes("scroll");
}

function intersectViewports(bounds: Rect, viewport: Rect | null): Rect {
  if (!viewport) return bounds;
  const x1 = Math.max(bounds.x, viewport.x);
  const y1 = Math.max(bounds.y, viewport.y);
  const x2 = Math.min(bounds.x + bounds.w, viewport.x + viewport.w);
  const y2 = Math.min(bounds.y + bounds.h, viewport.y + viewport.h);
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

// ---------------------------------------------------------------------------
// JSON tree pruning
// ---------------------------------------------------------------------------

function pruneNode(
  node: CupNode,
  parent: CupNode | null,
  siblings: number,
  viewport: Rect | null,
): CupNode[] {
  const children = node.children ?? [];

  if (shouldHoist(node)) {
    const result: CupNode[] = [];
    for (const child of children) {
      result.push(...pruneNode(child, parent, children.length, viewport));
    }
    return result;
  }

  if (shouldSkip(node, parent, siblings)) {
    return [];
  }

  // Determine viewport for children
  let childViewport = viewport;
  if (isScrollable(node) && node.bounds) {
    childViewport = intersectViewports(node.bounds, viewport);
  }

  // Keep this node — prune children recursively
  const prunedChildren: CupNode[] = [];
  const clipped = { above: 0, below: 0, left: 0, right: 0 };
  let hasClipped = false;

  for (const child of children) {
    const childBounds = child.bounds;
    if (childViewport && childBounds && isOutsideViewport(childBounds, childViewport)) {
      const dir = clipDirection(childBounds, childViewport);
      clipped[dir as keyof typeof clipped] += countNodes([child]);
      hasClipped = true;
      continue;
    }
    prunedChildren.push(...pruneNode(child, node, children.length, childViewport));
  }

  // Single-child structural collapse
  if (
    prunedChildren.length === 1 &&
    COLLAPSIBLE_ROLES.has(node.role) &&
    !node.name &&
    !hasMeaningfulActions(node)
  ) {
    return prunedChildren;
  }

  const pruned: CupNode = { ...node };
  delete pruned.children;
  if (prunedChildren.length > 0) {
    pruned.children = prunedChildren;
  }
  if (hasClipped) {
    pruned._clipped = clipped;
  }
  return [pruned];
}

function pruneMinimalNode(node: CupNode): CupNode | null {
  const children = node.children ?? [];
  const keptChildren: CupNode[] = [];

  for (const child of children) {
    const pruned = pruneMinimalNode(child);
    if (pruned) keptChildren.push(pruned);
  }

  if (hasMeaningfulActions(node) || keptChildren.length > 0) {
    const pruned: CupNode = { ...node };
    delete pruned.children;
    if (keptChildren.length > 0) {
      pruned.children = keptChildren;
    }
    return pruned;
  }

  return null;
}

export function pruneTree(
  tree: CupNode[],
  options?: { detail?: Detail; screen?: { w: number; h: number } | null },
): CupNode[] {
  const detail = options?.detail ?? "standard";
  const screen = options?.screen;

  if (detail === "full") {
    return structuredClone(tree);
  }

  if (detail === "minimal") {
    const result: CupNode[] = [];
    for (const root of tree) {
      const pruned = pruneMinimalNode(root);
      if (pruned) result.push(pruned);
    }
    return result;
  }

  // "standard"
  let screenViewport: Rect | null = null;
  if (screen) {
    screenViewport = { x: 0, y: 0, w: screen.w, h: screen.h };
  }
  const result: CupNode[] = [];
  for (const root of tree) {
    result.push(...pruneNode(root, null, tree.length, screenViewport));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Compact text serializer
// ---------------------------------------------------------------------------

const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);

export function formatLine(node: CupNode): string {
  const parts = [`[${node.id}]`, node.role];

  const name = node.name || "";
  if (name) {
    let truncated = name.length > 80 ? name.slice(0, 80) + "..." : name;
    truncated = truncated.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
    parts.push(`"${truncated}"`);
  }

  const bounds = node.bounds;
  if (bounds) {
    parts.push(`@${bounds.x},${bounds.y} ${bounds.w}x${bounds.h}`);
  }

  const states = node.states ?? [];
  if (states.length > 0) {
    parts.push("{" + states.join(",") + "}");
  }

  // Actions (drop "focus" — it's noise)
  const actions = (node.actions ?? []).filter((a) => a !== "focus");
  if (actions.length > 0) {
    parts.push("[" + actions.join(",") + "]");
  }

  // Value for input-type elements
  const value = node.value || "";
  if (value && VALUE_ROLES.has(node.role)) {
    let truncatedVal = value.length > 120 ? value.slice(0, 120) + "..." : value;
    truncatedVal = truncatedVal.replace(/"/g, '\\"').replace(/\n/g, " ");
    parts.push(`val="${truncatedVal}"`);
  }

  // Compact attributes
  const attrs = node.attributes;
  if (attrs) {
    const attrParts: string[] = [];
    if (attrs.level != null) attrParts.push(`L${attrs.level}`);
    if (attrs.placeholder) {
      let ph = attrs.placeholder.slice(0, 30);
      ph = ph.replace(/"/g, '\\"').replace(/\n/g, " ");
      attrParts.push(`ph="${ph}"`);
    }
    if (attrs.orientation) attrParts.push(attrs.orientation.charAt(0));
    if (attrs.valueMin != null || attrs.valueMax != null) {
      const vmin = attrs.valueMin ?? "";
      const vmax = attrs.valueMax ?? "";
      attrParts.push(`range=${vmin}..${vmax}`);
    }
    if (attrParts.length > 0) {
      parts.push("(" + attrParts.join(" ") + ")");
    }
  }

  return parts.join(" ");
}

function emitCompact(node: CupNode, depth: number, lines: string[], counter: number[]): void {
  counter[0] += 1;
  const indent = "  ".repeat(depth);
  lines.push(`${indent}${formatLine(node)}`);

  for (const child of node.children ?? []) {
    emitCompact(child, depth + 1, lines, counter);
  }

  // Emit hint for viewport-clipped children
  const clipped = node._clipped;
  if (clipped) {
    const { above = 0, below = 0, left = 0, right: right_ = 0 } = clipped;
    const total = above + below + left + right_;
    if (total > 0) {
      const directions: string[] = [];
      if (above > 0) directions.push("up");
      if (below > 0) directions.push("down");
      if (left > 0) directions.push("left");
      if (right_ > 0) directions.push("right");
      const hintIndent = "  ".repeat(depth + 1);
      lines.push(`${hintIndent}# ${total} more items — scroll ${directions.join("/")} to see`);
    }
  }
}

export const MAX_OUTPUT_CHARS = 40_000;

export function serializeCompact(
  envelope: CupEnvelope,
  options?: {
    windowList?: WindowInfo[] | null;
    detail?: Detail;
    maxChars?: number;
  },
): string {
  const detail = options?.detail ?? "standard";
  const maxChars = options?.maxChars ?? MAX_OUTPUT_CHARS;
  const windowList = options?.windowList ?? null;

  const totalBefore = countNodes(envelope.tree);
  const pruned = pruneTree(envelope.tree, { detail, screen: envelope.screen });

  const lines: string[] = [];
  const counter = [0];

  for (const root of pruned) {
    emitCompact(root, 0, lines, counter);
  }

  // Build header
  const headerLines = [
    `# CUP ${envelope.version} | ${envelope.platform} | ${envelope.screen.w}x${envelope.screen.h}`,
  ];
  if (envelope.app) {
    headerLines.push(`# app: ${envelope.app.name ?? ""}`);
  }
  headerLines.push(`# ${counter[0]} nodes (${totalBefore} before pruning)`);
  if (envelope.tools && envelope.tools.length > 0) {
    const n = envelope.tools.length;
    headerLines.push(`# ${n} WebMCP tool${n !== 1 ? "s" : ""} available`);
  }

  // Window list in header
  if (windowList && windowList.length > 0) {
    headerLines.push(`# --- ${windowList.length} open windows ---`);
    for (const win of windowList) {
      const title = (win.title || "(untitled)").slice(0, 50);
      const isFg = win.foreground ?? false;
      const marker = isFg ? " [fg]" : "";
      headerLines.push(`#   ${title}${marker}`);
    }
  }

  headerLines.push("");

  let output = [...headerLines, ...lines].join("\n") + "\n";

  // Hard truncation safety net
  if (maxChars > 0 && output.length > maxChars) {
    let truncated = output.slice(0, maxChars);
    const lastNl = truncated.lastIndexOf("\n");
    if (lastNl > 0) {
      truncated = truncated.slice(0, lastNl);
    }
    truncated +=
      "\n\n# OUTPUT TRUNCATED — exceeded character limit.\n" +
      "# Use find(name=...) to locate specific elements instead.\n" +
      "# Or use snapshot_app(app='<title>') to target a specific window.\n";
    return truncated;
  }

  return output;
}
