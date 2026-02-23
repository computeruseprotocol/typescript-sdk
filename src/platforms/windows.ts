/**
 * Windows platform adapter — stub.
 *
 * TODO: Implement using one of:
 * - node-ffi-napi for calling UIA COM interfaces
 * - edge-js for .NET interop
 * - Child process spawning a C++/C# native helper
 *
 * See Python reference: cup/platforms/windows.py
 */

import type { PlatformAdapter } from "../base.js";
import type { CupNode, TreeStats, WindowInfo, WindowMetadata } from "../types.js";

const NOT_IMPL = "Windows adapter is not yet implemented in the TypeScript SDK. Contributions welcome!";

export class WindowsAdapter implements PlatformAdapter {
  get platformName(): string {
    return "windows";
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
