/**
 * Platform auto-detection and adapter dispatch.
 *
 * Ported from python-sdk/cup/_router.py
 */

import { platform } from "node:os";
import type { PlatformAdapter } from "./base.js";

export function detectPlatform(): string {
  const p = platform();
  if (p === "win32") return "windows";
  if (p === "darwin") return "macos";
  if (p === "linux") return "linux";
  throw new Error(`Unsupported platform: ${p}`);
}

export async function getAdapter(platformName?: string | null): Promise<PlatformAdapter> {
  const name = platformName ?? detectPlatform();

  let adapter: PlatformAdapter;
  switch (name) {
    case "windows": {
      const { WindowsAdapter } = await import("./platforms/windows.js");
      adapter = new WindowsAdapter();
      break;
    }
    case "macos": {
      const { MacosAdapter } = await import("./platforms/macos.js");
      adapter = new MacosAdapter();
      break;
    }
    case "linux": {
      const { LinuxAdapter } = await import("./platforms/linux.js");
      adapter = new LinuxAdapter();
      break;
    }
    case "web": {
      const { WebAdapter } = await import("./platforms/web.js");
      adapter = new WebAdapter();
      break;
    }
    default:
      throw new Error(
        `No adapter available for platform '${name}'. ` +
          `Currently supported: windows, macos, linux, web.`,
      );
  }

  await adapter.initialize();
  return adapter;
}
