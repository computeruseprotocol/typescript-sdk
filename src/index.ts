/**
 * CUP — Computer Use Protocol.
 *
 * Cross-platform accessibility tree capture in a unified format.
 *
 * Quick start:
 *
 *   import { Session, snapshot, overview } from "computeruseprotocol";
 *
 *   // Session is the primary API — capture + actions
 *   const session = await Session.create();
 *   const tree = await session.snapshot({ scope: "overview" });
 *   const result = await session.action("e14", "click");
 *
 *   // Convenience functions (use a default session internally)
 *   const text = await snapshot();
 *   const raw = await snapshotRaw();
 *   const windows = await overview();
 */

import type { PlatformAdapter } from "./base.js";
import { ActionExecutor } from "./actions/executor.js";
import {
  buildEnvelope,
  pruneTree,
  serializeCompact,
  serializeOverview,
  serializePage,
  findNodeById,
  formatLine,
} from "./format.js";
import { searchTree } from "./search.js";
import { getAdapter, detectPlatform } from "./router.js";
import type {
  ActionResult,
  BatchAction,
  CupEnvelope,
  CupNode,
  Detail,
  Rect,
  Scope,
  WindowInfo,
} from "./types.js";

// ---------------------------------------------------------------------------
// Session — stateful tree capture with action execution
// ---------------------------------------------------------------------------

export class Session {
  private adapter: PlatformAdapter;
  private executor: ActionExecutor;
  private lastTree: CupNode[] | null = null;
  private lastRawTree: CupNode[] | null = null;
  private _pageCursors: Map<string, number> = new Map();

  private constructor(adapter: PlatformAdapter) {
    this.adapter = adapter;
    this.executor = new ActionExecutor(adapter);
  }

  /**
   * Create a new CUP session. Async because adapter initialization
   * may involve network or native API setup.
   */
  static async create(options?: { platform?: string }): Promise<Session> {
    const adapter = await getAdapter(options?.platform);
    return new Session(adapter);
  }

  /**
   * Capture the accessibility tree.
   */
  async snapshot(options?: {
    scope?: Scope;
    app?: string;
    maxDepth?: number;
    compact?: boolean;
    detail?: Detail;
  }): Promise<string | CupEnvelope> {
    const scope = options?.scope ?? "foreground";
    const maxDepth = options?.maxDepth ?? 999;
    const compact = options?.compact ?? true;
    const detail = options?.detail ?? "compact";

    const [sw, sh, scale] = await this.adapter.getScreenInfo();

    // --- overview scope: no tree walking ---
    if (scope === "overview") {
      const windowList = await this.adapter.getWindowList();
      if (compact) {
        return serializeOverview(windowList, {
          platform: this.adapter.platformName,
          screenW: sw,
          screenH: sh,
        });
      }
      return {
        version: "0.1.0",
        platform: this.adapter.platformName,
        screen: { w: sw, h: sh },
        scope: "overview",
        tree: [],
        windows: windowList,
      };
    }

    // --- scopes that require tree walking ---
    let windowList: WindowInfo[] | null = null;
    let windows: Array<import("./types.js").WindowMetadata>;
    let appName: string | null | undefined;
    let appPid: number | null | undefined;
    let appBundleId: string | null | undefined;

    if (scope === "foreground") {
      const win = await this.adapter.getForegroundWindow();
      windows = [win];
      appName = win.title;
      appPid = win.pid;
      appBundleId = win.bundle_id;
      windowList = await this.adapter.getWindowList();
    } else if (scope === "desktop") {
      const desktopWin = await this.adapter.getDesktopWindow();
      if (desktopWin === null) {
        windowList = await this.adapter.getWindowList();
        if (compact) {
          return serializeOverview(windowList, {
            platform: this.adapter.platformName,
            screenW: sw,
            screenH: sh,
          });
        }
        return {
          version: "0.1.0",
          platform: this.adapter.platformName,
          screen: { w: sw, h: sh },
          scope: "overview",
          tree: [],
          windows: windowList,
        };
      }
      windows = [desktopWin];
      appName = "Desktop";
      appPid = desktopWin.pid;
      appBundleId = desktopWin.bundle_id;
    } else {
      // "full"
      windows = await this.adapter.getAllWindows();
      if (options?.app) {
        const appLower = options.app.toLowerCase();
        windows = windows.filter((w) => (w.title || "").toLowerCase().includes(appLower));
      }
      appName = undefined;
      appPid = undefined;
      appBundleId = undefined;
    }

    const [tree, _stats, refs] = await this.adapter.captureTree(windows, { maxDepth });
    this.executor.setRefs(refs);

    let tools: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }> | null = null;
    if ("getLastTools" in this.adapter && typeof (this.adapter as any).getLastTools === "function") {
      tools = (this.adapter as any).getLastTools() || null;
    }

    const envelope = buildEnvelope(tree, {
      platform: this.adapter.platformName,
      scope,
      screenW: sw,
      screenH: sh,
      screenScale: scale,
      appName,
      appPid,
      appBundleId,
      tools,
    });

    // Store raw tree for search + pruned tree for compact
    this.lastRawTree = envelope.tree;
    this.lastTree = pruneTree(envelope.tree, { detail });
    this._pageCursors.clear();

    if (compact) {
      return serializeCompact(envelope, { windowList, detail });
    }
    return envelope;
  }

  /**
   * Execute an action on an element from the last snapshot.
   */
  async action(
    elementId: string,
    actionName: string,
    params?: Record<string, unknown>,
  ): Promise<ActionResult> {
    this._pageCursors.clear();
    return this.executor.action(elementId, actionName, params);
  }

  /**
   * Send a keyboard shortcut to the focused window.
   */
  async press(combo: string): Promise<ActionResult> {
    this._pageCursors.clear();
    return this.executor.press(combo);
  }

  /**
   * Open an application by name (fuzzy matched).
   */
  async openApp(name: string): Promise<ActionResult> {
    this._pageCursors.clear();
    return this.executor.openApp(name);
  }

  /**
   * Search the last captured tree for matching elements.
   */
  async find(options: {
    query?: string;
    role?: string;
    name?: string;
    state?: string;
    limit?: number;
  }): Promise<CupNode[]> {
    if (this.lastRawTree === null) {
      await this.snapshot({ scope: "foreground", compact: true });
    }

    const results = searchTree(this.lastRawTree!, {
      query: options.query,
      role: options.role,
      name: options.name,
      state: options.state,
      limit: options.limit,
    });

    return results.map((r) => r.node);
  }

  /**
   * Page through clipped content in a scrollable container.
   *
   * Serves slices of the cached raw tree — no UI scrolling needed.
   * Provides deterministic, contiguous pagination of offscreen items.
   */
  page(
    elementId: string,
    options?: {
      direction?: "up" | "down" | "left" | "right";
      offset?: number;
      limit?: number;
    },
  ): string {
    if (this.lastRawTree === null || this.lastTree === null) {
      throw new Error("No tree captured. Call snapshot() first.");
    }

    const rawContainer = findNodeById(this.lastRawTree, elementId);
    if (!rawContainer) {
      throw new Error(`Element '${elementId}' not found in current tree.`);
    }

    const rawChildren = rawContainer.children ?? [];
    if (rawChildren.length === 0) {
      throw new Error(`Container '${elementId}' has no children to paginate.`);
    }

    // Get pruned container for visible count and _clipped metadata
    const prunedContainer = findNodeById(this.lastTree, elementId);
    const visibleCount = prunedContainer?.children?.length ?? 0;
    const clipped = prunedContainer?._clipped;
    const clippedAbove = clipped?.above ?? 0;
    const clippedBelow = clipped?.below ?? 0;
    const clippedLeft = clipped?.left ?? 0;
    const clippedRight = clipped?.right ?? 0;
    const clippedCount = clippedAbove + clippedBelow + clippedLeft + clippedRight;

    // Virtual scroll detection: if raw tree has far fewer children than
    // visible + clipped, the content is likely lazy-loaded
    if (clippedCount > 0) {
      const expectedTotal = visibleCount + clippedCount;
      if (rawChildren.length < expectedTotal * 0.8) {
        throw new Error(
          `Container '${elementId}' appears to use virtual scrolling ` +
          `(raw: ${rawChildren.length}, expected: ~${expectedTotal}). ` +
          `Use action(action='scroll', element_id='${elementId}', direction='...') ` +
          `followed by snapshot() instead.`,
        );
      }
    }

    const direction = options?.direction;
    const total = rawChildren.length;
    const defaultPageSize = visibleCount > 0 ? visibleCount : 20;
    const pageSize = options?.limit ?? defaultPageSize;

    // Compute directional start offsets from clipping metadata.
    // Clipped-above items are at the start of the children array (low indices),
    // clipped-below items are at the end (high indices), because children are
    // in document/spatial order.
    const startDown = total - clippedBelow;   // first below-clipped child
    const startUp = clippedAbove - 1;          // last above-clipped child (page backwards from here)
    const startRight = total - clippedRight;
    const startLeft = clippedLeft - 1;

    // Determine offset
    let currentOffset: number;
    if (options?.offset != null) {
      currentOffset = options.offset;
    } else if (direction) {
      const cursor = this._pageCursors.get(elementId);
      if (cursor == null) {
        // First page call — start at the boundary of clipped content
        if (direction === "down") currentOffset = startDown;
        else if (direction === "right") currentOffset = startRight;
        else if (direction === "up") currentOffset = Math.max(0, startUp - pageSize + 1);
        else /* left */ currentOffset = Math.max(0, startLeft - pageSize + 1);
      } else {
        currentOffset =
          direction === "down" || direction === "right"
            ? cursor + pageSize
            : Math.max(0, cursor - pageSize);
      }
    } else {
      // No direction or offset — show first page of hidden content
      currentOffset = startDown;
    }

    // Clamp
    currentOffset = Math.max(0, Math.min(currentOffset, total - 1));

    // Slice
    const pageItems = rawChildren.slice(currentOffset, currentOffset + pageSize);

    // Track cursor
    this._pageCursors.set(elementId, currentOffset);

    return serializePage(rawContainer, pageItems, currentOffset, total);
  }

  /**
   * Execute a sequence of actions, stopping on first failure.
   */
  async batch(actions: BatchAction[]): Promise<ActionResult[]> {
    const results: ActionResult[] = [];

    for (const spec of actions) {
      let result: ActionResult;

      if (spec.action === "wait") {
        const ms = Math.max(50, Math.min((spec as any).ms ?? 500, 5000));
        await new Promise((resolve) => setTimeout(resolve, ms));
        result = { success: true, message: `Waited ${ms}ms` };
      } else if (spec.action === "press") {
        const keys = (spec as any).keys as string;
        if (!keys) {
          results.push({
            success: false,
            message: "",
            error: "press action requires 'keys' parameter",
          });
          break;
        }
        result = await this.press(keys);
      } else {
        const elemSpec = spec as { element_id: string; action: string; [k: string]: unknown };
        if (!elemSpec.element_id) {
          results.push({
            success: false,
            message: "",
            error: `Element action '${elemSpec.action}' requires 'element_id' parameter`,
          });
          break;
        }
        const params: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(elemSpec)) {
          if (k !== "element_id" && k !== "action") params[k] = v;
        }
        result = await this.action(elemSpec.element_id, elemSpec.action, params);
      }

      results.push(result);
      if (!result.success) break;
    }

    return results;
  }

  /**
   * Capture a screenshot and return PNG bytes.
   *
   * On macOS, uses the `screencapture` system utility and checks
   * Screen Recording permission upfront — raises an error with
   * a clear message if the permission is missing.
   *
   * On other platforms, requires the `screenshot-desktop` package:
   * `npm install screenshot-desktop`
   *
   * @throws {Error} On macOS if Screen Recording permission is not granted.
   * @throws {Error} On other platforms if `screenshot-desktop` is not installed.
   */
  async screenshot(region?: Rect): Promise<Buffer> {
    if (process.platform === "darwin") {
      return this._screenshotMacos(region);
    }
    return this._screenshotDesktop(region);
  }

  private async _screenshotMacos(region?: Rect): Promise<Buffer> {
    const { execFile: execFileCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const execFileAsync = promisify(execFileCb);

    // Check Screen Recording permission via CGWindowListCopyWindowInfo.
    // Without it, all screenshot APIs return only the desktop wallpaper.
    try {
      const { stdout } = await execFileAsync(
        "osascript",
        [
          "-l", "JavaScript", "-e",
          `ObjC.import('CoreGraphics');` +
          `const wins = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0);` +
          `let hasName = false;` +
          `for (let i = 0; i < wins.count; i++) {` +
          `  const name = wins.objectAtIndex(i).objectForKey('kCGWindowName');` +
          `  if (name && ObjC.unwrap(name).length > 0) { hasName = true; break; }` +
          `}` +
          `hasName ? 'ok' : 'no_permission';`,
        ],
        { timeout: 5000 },
      );
      if (stdout.trim() === "no_permission") {
        throw new Error(
          "Screen Recording permission is required for screenshots. " +
            "Grant it to this app in: System Settings > Privacy & Security " +
            "> Screen Recording. You may need to restart the app after granting.",
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("Screen Recording")) {
        throw err;
      }
      // If the check itself fails, proceed and let screencapture handle it
    }

    const tmpPath = path.join(os.tmpdir(), `cup-screenshot-${Date.now()}.png`);

    try {
      const args = ["-x"]; // -x = no sound
      if (region) {
        args.push("-R", `${region.x},${region.y},${region.w},${region.h}`);
      }
      args.push(tmpPath);

      await execFileAsync("screencapture", args, { timeout: 10000 });

      const data = fs.readFileSync(tmpPath);
      if (data.length === 0) {
        throw new Error("screencapture produced an empty file");
      }
      return data;
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  private async _screenshotDesktop(region?: Rect): Promise<Buffer> {
    let screenshotDesktop: (options?: any) => Promise<Buffer>;
    try {
      const mod = await import("screenshot-desktop");
      screenshotDesktop = mod.default ?? mod;
    } catch {
      throw new Error(
        "Screenshot support requires the 'screenshot-desktop' package. " +
          "Install it with: npm install screenshot-desktop",
      );
    }

    const png = await screenshotDesktop({ format: "png" });

    // If a region is specified, we'd need an image manipulation library
    if (region) {
      // TODO: Crop to region using sharp or similar
      return png;
    }
    return png;
  }
}

// ---------------------------------------------------------------------------
// Default session — used by convenience functions
// ---------------------------------------------------------------------------

let _defaultSession: Session | null = null;

async function getDefaultSession(): Promise<Session> {
  if (!_defaultSession) {
    _defaultSession = await Session.create();
  }
  return _defaultSession;
}

// ---------------------------------------------------------------------------
// Convenience functions
// ---------------------------------------------------------------------------

/** Capture the screen as LLM-optimized compact text. */
export async function snapshot(
  scope: Scope = "foreground",
  options?: { maxDepth?: number },
): Promise<string> {
  const session = await getDefaultSession();
  return session.snapshot({
    scope,
    maxDepth: options?.maxDepth ?? 999,
    compact: true,
  }) as Promise<string>;
}

/** Capture the screen as a structured CUP envelope dict. */
export async function snapshotRaw(
  scope: Scope = "foreground",
  options?: { maxDepth?: number },
): Promise<CupEnvelope> {
  const session = await getDefaultSession();
  return session.snapshot({
    scope,
    maxDepth: options?.maxDepth ?? 999,
    compact: false,
  }) as Promise<CupEnvelope>;
}

/** List all open windows (no tree walking). Near-instant. */
export async function overview(): Promise<string> {
  const session = await getDefaultSession();
  return session.snapshot({ scope: "overview", compact: true }) as Promise<string>;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { getAdapter, detectPlatform } from "./router.js";
export { buildEnvelope, serializeCompact, serializeOverview, pruneTree, formatLine, ROLE_CODES, STATE_CODES, ACTION_CODES } from "./format.js";
export { searchTree, resolveRoles, tokenize } from "./search.js";
export { ActionExecutor, VALID_ACTIONS } from "./actions/executor.js";
export { parseCombo } from "./actions/keys.js";

// Type re-exports
export type {
  ActionResult,
  BatchAction,
  CupEnvelope,
  CupNode,
  Detail,
  Scope,
  Rect,
  Screen,
  AppInfo,
  Attributes,
  WindowInfo,
  WindowMetadata,
  TreeStats,
  SearchResult,
  PlatformId,
  Role,
  State,
  Action,
  PlatformWindows,
  PlatformMacOS,
  PlatformLinux,
  PlatformWeb,
  PlatformAndroid,
  PlatformIOS,
} from "./types.js";

export type { PlatformAdapter } from "./base.js";
export type { ActionHandler } from "./actions/handler.js";
