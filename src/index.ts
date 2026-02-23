/**
 * CUP — Computer Use Protocol.
 *
 * Cross-platform accessibility tree capture in a unified format.
 *
 * Quick start:
 *
 *   import { Session, getCompact, getForegroundTree } from "cup";
 *
 *   // Session is the primary API — capture + actions
 *   const session = await Session.create();
 *   const tree = await session.capture({ scope: "overview" });
 *   const result = await session.execute("e14", "click");
 *
 *   // Convenience functions (use a default session internally)
 *   const envelope = await getForegroundTree();
 *   const text = await getCompact();
 */

import type { PlatformAdapter } from "./base.js";
import { ActionExecutor } from "./actions/executor.js";
import {
  buildEnvelope,
  pruneTree,
  serializeCompact,
  serializeOverview,
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
  async capture(options?: {
    scope?: Scope;
    app?: string;
    maxDepth?: number;
    compact?: boolean;
    detail?: Detail;
  }): Promise<string | CupEnvelope> {
    const scope = options?.scope ?? "foreground";
    const maxDepth = options?.maxDepth ?? 999;
    const compact = options?.compact ?? true;
    const detail = options?.detail ?? "standard";

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

    if (compact) {
      return serializeCompact(envelope, { windowList, detail });
    }
    return envelope;
  }

  /**
   * Execute an action on an element from the last capture.
   */
  async execute(
    elementId: string,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<ActionResult> {
    return this.executor.execute(elementId, action, params);
  }

  /**
   * Send a keyboard shortcut to the focused window.
   */
  async pressKeys(combo: string): Promise<ActionResult> {
    return this.executor.pressKeys(combo);
  }

  /**
   * Launch an application by name (fuzzy matched).
   */
  async launchApp(name: string): Promise<ActionResult> {
    return this.executor.launchApp(name);
  }

  /**
   * Search the last captured tree for matching elements.
   */
  async findElements(options: {
    query?: string;
    role?: string;
    name?: string;
    state?: string;
    limit?: number;
  }): Promise<CupNode[]> {
    if (this.lastRawTree === null) {
      await this.capture({ scope: "foreground", compact: true });
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
   * Execute a sequence of actions, stopping on first failure.
   */
  async batchExecute(actions: BatchAction[]): Promise<ActionResult[]> {
    const results: ActionResult[] = [];

    for (const spec of actions) {
      let result: ActionResult;

      if (spec.action === "wait") {
        const ms = Math.max(50, Math.min((spec as any).ms ?? 500, 5000));
        await new Promise((resolve) => setTimeout(resolve, ms));
        result = { success: true, message: `Waited ${ms}ms` };
      } else if (spec.action === "press_keys") {
        const keys = (spec as any).keys as string;
        if (!keys) {
          results.push({
            success: false,
            message: "",
            error: "press_keys action requires 'keys' parameter",
          });
          break;
        }
        result = await this.pressKeys(keys);
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
        result = await this.execute(elemSpec.element_id, elemSpec.action, params);
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

/** Capture the full accessibility tree (all windows) as a CUP envelope. */
export async function getTree(options?: { maxDepth?: number }): Promise<CupEnvelope> {
  const session = await getDefaultSession();
  return session.capture({
    scope: "full",
    maxDepth: options?.maxDepth ?? 999,
    compact: false,
  }) as Promise<CupEnvelope>;
}

/** Capture the foreground window's tree as a CUP envelope. */
export async function getForegroundTree(options?: { maxDepth?: number }): Promise<CupEnvelope> {
  const session = await getDefaultSession();
  return session.capture({
    scope: "foreground",
    maxDepth: options?.maxDepth ?? 999,
    compact: false,
  }) as Promise<CupEnvelope>;
}

/** Capture full tree and return CUP compact text (for LLM context). */
export async function getCompact(options?: { maxDepth?: number }): Promise<string> {
  const session = await getDefaultSession();
  return session.capture({
    scope: "full",
    maxDepth: options?.maxDepth ?? 999,
    compact: true,
  }) as Promise<string>;
}

/** Capture foreground window and return CUP compact text. */
export async function getForegroundCompact(options?: { maxDepth?: number }): Promise<string> {
  const session = await getDefaultSession();
  return session.capture({
    scope: "foreground",
    maxDepth: options?.maxDepth ?? 999,
    compact: true,
  }) as Promise<string>;
}

/** Get a compact window list (no tree walking). Near-instant. */
export async function getOverview(): Promise<string> {
  const session = await getDefaultSession();
  return session.capture({ scope: "overview", compact: true }) as Promise<string>;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { getAdapter, detectPlatform } from "./router.js";
export { buildEnvelope, serializeCompact, serializeOverview, pruneTree, formatLine } from "./format.js";
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
