#!/usr/bin/env node
/**
 * CLI for CUP tree capture.
 *
 * Ported from python-sdk/cup/__main__.py
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { detectPlatform, getAdapter } from "./router.js";
import { buildEnvelope, pruneTree, serializeCompact, serializeOverview } from "./format.js";

async function main() {
  const { values } = parseArgs({
    options: {
      depth: { type: "string", default: "0" },
      scope: { type: "string" },
      app: { type: "string" },
      "json-out": { type: "string" },
      "full-json-out": { type: "string" },
      "compact-out": { type: "string" },
      verbose: { type: "boolean", default: false },
      platform: { type: "string" },
      "cdp-port": { type: "string" },
      "cdp-host": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: false,
  });

  if (values.help) {
    console.log(`CUP: Capture accessibility tree in Computer Use Protocol format

Options:
  --scope <scope>        Capture scope: overview, foreground, desktop, full (default: foreground)
  --depth <n>            Max tree depth (0 = unlimited)
  --app <title>          Filter to window/app title containing this string
  --verbose              Print diagnostics (timing, role distribution, sizes)
  --json-out <file>      Write pruned CUP JSON to file
  --full-json-out <file> Write full (unpruned) CUP JSON to file
  --compact-out <file>   Write compact text to file
  --platform <platform>  Force platform: windows, macos, linux, web
  --cdp-port <port>      CDP port for web platform (default: 9222)
  --cdp-host <host>      CDP host for web platform (default: 127.0.0.1)
  -h, --help             Show this help message`);
    return;
  }

  const scope = (values.scope as string) ?? "foreground";
  const maxDepth = parseInt(values.depth as string, 10) || 999;
  const platformName = (values.platform as string) ?? detectPlatform();
  const verbose = values.verbose as boolean;

  // Pass CDP args via env vars
  if (platformName === "web") {
    if (values["cdp-port"]) process.env.CUP_CDP_PORT = values["cdp-port"] as string;
    if (values["cdp-host"]) process.env.CUP_CDP_HOST = values["cdp-host"] as string;
  }

  if (verbose) {
    console.log(`=== CUP Tree Capture (${platformName}) ===`);
  }

  const adapter = await getAdapter(platformName);
  const [sw, sh, scale] = await adapter.getScreenInfo();

  if (verbose) {
    const scaleStr = scale !== 1.0 ? ` @${scale}x` : "";
    console.log(`Screen: ${sw}x${sh}${scaleStr}`);
  }

  // -- Overview scope --
  if (scope === "overview") {
    const t0 = performance.now();
    const windowList = await adapter.getWindowList();
    const tEnum = performance.now() - t0;

    if (verbose) {
      console.log(`Scope: overview (${windowList.length} windows, ${tEnum.toFixed(1)} ms)`);
    }

    const overviewStr = serializeOverview(windowList, {
      platform: platformName,
      screenW: sw,
      screenH: sh,
    });
    console.log(overviewStr);

    if (values["compact-out"]) {
      writeFileSync(values["compact-out"] as string, overviewStr, "utf-8");
      if (verbose) {
        console.log(`Overview written to ${values["compact-out"]}`);
      }
    }
    return;
  }

  // -- Window enumeration --
  const t0 = performance.now();
  let windowList: import("./types.js").WindowInfo[] | null = null;
  let windows: import("./types.js").WindowMetadata[];

  if (scope === "foreground") {
    windows = [await adapter.getForegroundWindow()];
    windowList = await adapter.getWindowList();
    if (verbose) {
      console.log(`Scope: foreground ("${windows[0].title}")`);
    }
  } else if (scope === "desktop") {
    const desktopWin = await adapter.getDesktopWindow();
    if (!desktopWin) {
      if (verbose) {
        console.log("No desktop window found on this platform. Falling back to overview.");
      }
      const wl = await adapter.getWindowList();
      const overviewStr = serializeOverview(wl, {
        platform: platformName,
        screenW: sw,
        screenH: sh,
      });
      console.log(overviewStr);
      return;
    }
    windows = [desktopWin];
    if (verbose) {
      console.log("Scope: desktop");
    }
  } else {
    // "full"
    windows = await adapter.getAllWindows();
    if (values.app) {
      const appLower = (values.app as string).toLowerCase();
      windows = windows.filter((w) => (w.title || "").toLowerCase().includes(appLower));
      if (windows.length === 0) {
        console.log(`No window found matching '${values.app}'`);
        return;
      }
    }
    if (verbose) {
      console.log(`Scope: full (${windows.length} window(s))`);
    }
  }
  const tEnum = performance.now() - t0;

  // -- Tree capture --
  const t1 = performance.now();
  const [tree, stats, _refs] = await adapter.captureTree(windows, { maxDepth });
  const tWalk = performance.now() - t1;

  if (verbose) {
    console.log(`Captured ${stats.nodes} nodes in ${tWalk.toFixed(1)} ms (enum: ${tEnum.toFixed(1)} ms)`);
    console.log(`Max depth: ${stats.max_depth}`);
  }

  // -- Envelope --
  const appName = windows.length === 1 ? windows[0].title : undefined;
  const appPid = windows.length === 1 ? windows[0].pid : undefined;
  const appBundleId = windows.length === 1 ? windows[0].bundle_id : undefined;

  let tools: any[] | null = null;
  if ("getLastTools" in adapter && typeof (adapter as any).getLastTools === "function") {
    tools = (adapter as any).getLastTools() || null;
  }

  const envelope = buildEnvelope(tree, {
    platform: platformName,
    scope,
    screenW: sw,
    screenH: sh,
    screenScale: scale,
    appName,
    appPid,
    appBundleId,
    tools,
  });

  // -- Compact text to stdout (default) --
  const compactStr = serializeCompact(envelope, { windowList });
  console.log(compactStr);

  // -- Verbose diagnostics --
  if (verbose) {
    const jsonStr = JSON.stringify(envelope);
    const jsonKb = jsonStr.length / 1024;
    const compactKb = compactStr.length / 1024;
    console.log(`JSON size: ${jsonKb.toFixed(1)} KB | Compact size: ${compactKb.toFixed(1)} KB`);

    console.log("\nRole distribution (top 15):");
    const sortedRoles = Object.entries(stats.roles)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);
    for (const [role, count] of sortedRoles) {
      console.log(`  ${role.padEnd(45)} ${String(count).padStart(6)}`);
    }

    if (tools && tools.length > 0) {
      console.log(`\nWebMCP tools (${tools.length}):`);
      for (const tool of tools) {
        const desc = tool.description ? ` - ${tool.description}` : "";
        console.log(`  ${tool.name}${desc}`);
      }
    }
  }

  // -- File output options --
  if (values["json-out"]) {
    const prunedTree = pruneTree(envelope.tree);
    const prunedEnvelope = { ...envelope, tree: prunedTree };
    writeFileSync(values["json-out"] as string, JSON.stringify(prunedEnvelope, null, 2), "utf-8");
    if (verbose) {
      const prunedKb = JSON.stringify(prunedEnvelope).length / 1024;
      console.log(`\nPruned JSON written to ${values["json-out"]} (${prunedKb.toFixed(1)} KB)`);
    }
  }

  if (values["full-json-out"]) {
    writeFileSync(values["full-json-out"] as string, JSON.stringify(envelope, null, 2), "utf-8");
    if (verbose) {
      const jsonKb = JSON.stringify(envelope).length / 1024;
      console.log(`Full JSON written to ${values["full-json-out"]} (${jsonKb.toFixed(1)} KB)`);
    }
  }

  if (values["compact-out"]) {
    writeFileSync(values["compact-out"] as string, compactStr, "utf-8");
    if (verbose) {
      const jsonKb = JSON.stringify(envelope).length / 1024;
      const compactKb = compactStr.length / 1024;
      const ratio = jsonKb > 0 ? ((1 - compactKb / jsonKb) * 100).toFixed(0) : "0";
      console.log(
        `Compact written to ${values["compact-out"]} (${compactKb.toFixed(1)} KB, ${ratio}% smaller)`,
      );
    }
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message ?? err}`);
  process.exit(1);
});
