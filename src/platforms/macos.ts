/**
 * macOS platform adapter — stub.
 *
 * TODO: Implement using node-ffi-napi for AXUIElement API.
 * See Python reference: cup/platforms/macos.py
 */

import type { PlatformAdapter } from "../base.js";
import type { CupNode, TreeStats, WindowInfo, WindowMetadata } from "../types.js";

const NOT_IMPL = "macOS adapter is not yet implemented in the TypeScript SDK. Contributions welcome!";

export class MacosAdapter implements PlatformAdapter {
  get platformName(): string {
    return "macos";
  }

  async initialize(): Promise<void> {
    throw new Error(NOT_IMPL);
  }

  async getScreenInfo(): Promise<[number, number, number]> {
    throw new Error(NOT_IMPL);
  }

  async getForegroundWindow(): Promise<WindowMetadata> {
    throw new Error(NOT_IMPL);
  }

  async getAllWindows(): Promise<WindowMetadata[]> {
    throw new Error(NOT_IMPL);
  }

  async getWindowList(): Promise<WindowInfo[]> {
    throw new Error(NOT_IMPL);
  }

  async getDesktopWindow(): Promise<WindowMetadata | null> {
    throw new Error(NOT_IMPL);
  }

  async captureTree(
    _windows: WindowMetadata[],
    _options?: { maxDepth?: number },
  ): Promise<[CupNode[], TreeStats, Map<string, unknown>]> {
    throw new Error(NOT_IMPL);
  }
}
