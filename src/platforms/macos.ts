/**
 * macOS platform adapter.
 *
 * Uses JXA (JavaScript for Automation via osascript) and CGWindowList
 * for window enumeration, screen info, and foreground detection.
 *
 * Tree capture (accessibility tree walking) requires native AXUIElement
 * bindings and is not yet implemented — contributions welcome.
 *
 * See Python reference: cup/platforms/macos.py
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PlatformAdapter } from "../base.js";
import type { CupNode, TreeStats, WindowInfo, WindowMetadata } from "../types.js";

const execFileAsync = promisify(execFile);

// Process names that are macOS system daemons with on-screen layer-0 windows
// but should NOT appear in user-facing app lists.
const SYSTEM_OWNER_NAMES = new Set([
  "WindowServer",
  "Dock",
  "SystemUIServer",
  "Control Center",
  "Notification Center",
  "loginwindow",
  "Window Manager",
  "Spotlight",
]);

// ---------------------------------------------------------------------------
// JXA helpers
// ---------------------------------------------------------------------------

async function runJxa(script: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "osascript",
    ["-l", "JavaScript", "-e", script],
    { timeout: 10000 },
  );
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Screen info
// ---------------------------------------------------------------------------

async function macosScreenInfo(): Promise<[number, number, number]> {
  const result = await runJxa(`
    ObjC.import('AppKit');
    const screen = $.NSScreen.mainScreen;
    const frame = screen.frame;
    const scale = screen.backingScaleFactor;
    JSON.stringify({
      w: frame.size.width,
      h: frame.size.height,
      scale: scale,
    });
  `);
  const info = JSON.parse(result);
  return [Math.round(info.w), Math.round(info.h), info.scale];
}

// ---------------------------------------------------------------------------
// Window enumeration via CGWindowList (always fresh from window server)
// ---------------------------------------------------------------------------

interface CgWindowApp {
  pid: number;
  owner: string;
}

/**
 * Return apps with on-screen, normal-layer (layer 0) windows via
 * CGWindowListCopyWindowInfo. This is always fresh from the window server,
 * unlike NSWorkspace.runningApplications() which can be stale in
 * long-running processes without an NSRunLoop.
 */
async function cgWindowApps(): Promise<CgWindowApp[]> {
  try {
    const result = await runJxa(`
      ObjC.import('CoreGraphics');
      const wins = $.CGWindowListCopyWindowInfo(
        $.kCGWindowListOptionOnScreenOnly, 0
      );
      const apps = [];
      const seenPids = {};
      for (let i = 0; i < wins.count; i++) {
        const w = wins.objectAtIndex(i);
        const layer = ObjC.unwrap(w.objectForKey('kCGWindowLayer'));
        if (layer !== 0) continue;
        const pid = ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID'));
        const owner = ObjC.unwrap(w.objectForKey('kCGWindowOwnerName'));
        if (!pid || !owner) continue;
        if (seenPids[pid]) continue;
        seenPids[pid] = true;
        apps.push({ pid: pid, owner: owner });
      }
      JSON.stringify(apps);
    `);
    return JSON.parse(result);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Foreground app
// ---------------------------------------------------------------------------

async function macosForegroundApp(): Promise<{
  pid: number;
  name: string;
  bundleId: string | null;
}> {
  const result = await runJxa(`
    ObjC.import('AppKit');
    const ws = $.NSWorkspace.sharedWorkspace;
    const app = ws.frontmostApplication;
    JSON.stringify({
      pid: app.processIdentifier,
      name: ObjC.unwrap(app.localizedName) || '',
      bundleId: ObjC.unwrap(app.bundleIdentifier) || null,
    });
  `);
  return JSON.parse(result);
}

// ---------------------------------------------------------------------------
// Visible apps (NSWorkspace + CGWindowList cross-check)
// ---------------------------------------------------------------------------

async function macosVisibleApps(): Promise<
  Array<{ pid: number; name: string; bundleId: string | null }>
> {
  // Strategy 1: NSWorkspace.runningApplications() — has bundle IDs
  const nsResult = await runJxa(`
    ObjC.import('AppKit');
    const ws = $.NSWorkspace.sharedWorkspace;
    const running = ws.runningApplications;
    const apps = [];
    for (let i = 0; i < running.count; i++) {
      const a = running.objectAtIndex(i);
      if (a.activationPolicy === $.NSApplicationActivationPolicyRegular) {
        apps.push({
          pid: a.processIdentifier,
          name: ObjC.unwrap(a.localizedName) || '',
          bundleId: ObjC.unwrap(a.bundleIdentifier) || null,
        });
      }
    }
    JSON.stringify(apps);
  `);
  const apps: Array<{ pid: number; name: string; bundleId: string | null }> =
    JSON.parse(nsResult);

  // Strategy 2: Cross-check with CGWindowList for fresh data
  const seenPids = new Set(apps.map((a) => a.pid));
  const cgApps = await cgWindowApps();
  for (const cg of cgApps) {
    if (!seenPids.has(cg.pid) && !SYSTEM_OWNER_NAMES.has(cg.owner)) {
      apps.push({ pid: cg.pid, name: cg.owner, bundleId: null });
      seenPids.add(cg.pid);
    }
  }

  return apps;
}

// ---------------------------------------------------------------------------
// MacosAdapter
// ---------------------------------------------------------------------------

export class MacosAdapter implements PlatformAdapter {
  get platformName(): string {
    return "macos";
  }

  async initialize(): Promise<void> {
    // No explicit init needed for JXA/osascript
  }

  async getScreenInfo(): Promise<[number, number, number]> {
    return macosScreenInfo();
  }

  async getForegroundWindow(): Promise<WindowMetadata> {
    const fg = await macosForegroundApp();
    return {
      handle: { pid: fg.pid },
      title: fg.name,
      pid: fg.pid,
      bundle_id: fg.bundleId,
    };
  }

  async getAllWindows(): Promise<WindowMetadata[]> {
    const apps = await macosVisibleApps();
    return apps.map((a) => ({
      handle: { pid: a.pid },
      title: a.name,
      pid: a.pid,
      bundle_id: a.bundleId,
    }));
  }

  async getWindowList(): Promise<WindowInfo[]> {
    const fg = await macosForegroundApp();
    const apps = await macosVisibleApps();
    const seen = new Set<number>();
    const results: WindowInfo[] = [];

    for (const a of apps) {
      if (seen.has(a.pid)) continue;
      seen.add(a.pid);
      results.push({
        title: a.name,
        pid: a.pid,
        bundle_id: a.bundleId,
        foreground: a.pid === fg.pid,
        bounds: null,
      });
    }

    return results;
  }

  async getDesktopWindow(): Promise<WindowMetadata | null> {
    const apps = await macosVisibleApps();
    const finder = apps.find((a) => a.bundleId === "com.apple.finder");
    if (finder) {
      return {
        handle: { pid: finder.pid },
        title: "Desktop",
        pid: finder.pid,
        bundle_id: finder.bundleId,
      };
    }
    return null;
  }

  async captureTree(
    _windows: WindowMetadata[],
    _options?: { maxDepth?: number },
  ): Promise<[CupNode[], TreeStats, Map<string, unknown>]> {
    // Tree capture requires native AXUIElement bindings (e.g. via
    // node-ffi-napi or a compiled Swift helper). Not yet implemented.
    // Contributions welcome: https://github.com/computeruseprotocol/typescript-sdk
    throw new Error(
      "macOS tree capture is not yet implemented in the TypeScript SDK. " +
        "Window enumeration, actions, screenshots, and app launching are available. " +
        "Contributions welcome!",
    );
  }
}
