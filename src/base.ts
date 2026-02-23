/**
 * Abstract base for platform adapters.
 *
 * Ported from python-sdk/cup/_base.py
 */

import type { CupNode, TreeStats, WindowInfo, WindowMetadata } from "./types.js";

/**
 * Interface that each platform tree-capture backend must implement.
 *
 * Subclasses handle all platform-specific initialization, window
 * enumeration, tree walking, and CUP node construction.
 */
export interface PlatformAdapter {
  /** Platform identifier used in CUP envelopes. */
  readonly platformName: string;

  /** Perform any one-time setup (COM init, etc.). Idempotent. */
  initialize(): Promise<void>;

  /** Return [width, height, scaleFactor] of the primary display. */
  getScreenInfo(): Promise<[number, number, number]>;

  /** Return metadata about the foreground/focused window. */
  getForegroundWindow(): Promise<WindowMetadata>;

  /** Return metadata for all visible top-level windows. */
  getAllWindows(): Promise<WindowMetadata[]>;

  /** Return lightweight metadata for all visible windows. Near-instant. */
  getWindowList(): Promise<WindowInfo[]>;

  /** Return metadata for the desktop surface, or null. */
  getDesktopWindow(): Promise<WindowMetadata | null>;

  /**
   * Walk the accessibility tree for the given windows.
   *
   * Returns [treeRoots, stats, refs] where refs maps element IDs
   * to native platform references for action execution.
   */
  captureTree(
    windows: WindowMetadata[],
    options?: { maxDepth?: number },
  ): Promise<[CupNode[], TreeStats, Map<string, unknown>]>;
}
