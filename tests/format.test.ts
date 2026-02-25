/**
 * Tests for CUP format utilities.
 *
 * Ported from python-sdk/tests/test_format.py
 */

import { describe, it, expect } from "vitest";
import {
  buildEnvelope,
  pruneTree,
  serializeCompact,
  serializeOverview,
  formatLine,
} from "../src/format.js";
import type { CupNode, CupEnvelope, WindowInfo } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<CupNode> = {}): CupNode {
  return {
    id: "e0",
    role: "button",
    name: "Test",
    ...overrides,
  };
}

function makeEnvelope(overrides: Partial<CupEnvelope> = {}): CupEnvelope {
  return {
    version: "0.1.0",
    platform: "windows",
    screen: { w: 1920, h: 1080 },
    tree: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildEnvelope
// ---------------------------------------------------------------------------

describe("buildEnvelope", () => {
  it("includes required fields", () => {
    const env = buildEnvelope([], {
      platform: "windows",
      screenW: 1920,
      screenH: 1080,
    });
    expect(env.version).toBe("0.1.0");
    expect(env.platform).toBe("windows");
    expect(env.screen).toEqual({ w: 1920, h: 1080 });
    expect(env.tree).toEqual([]);
    expect(env.timestamp).toBeTypeOf("number");
  });

  it("includes screen scale when not 1.0", () => {
    const env = buildEnvelope([], {
      platform: "macos",
      screenW: 2560,
      screenH: 1440,
      screenScale: 2.0,
    });
    expect(env.screen.scale).toBe(2.0);
  });

  it("omits screen scale when 1.0", () => {
    const env = buildEnvelope([], {
      platform: "windows",
      screenW: 1920,
      screenH: 1080,
      screenScale: 1.0,
    });
    expect(env.screen.scale).toBeUndefined();
  });

  it("includes app info", () => {
    const env = buildEnvelope([], {
      platform: "windows",
      screenW: 1920,
      screenH: 1080,
      appName: "Discord",
      appPid: 1234,
    });
    expect(env.app?.name).toBe("Discord");
    expect(env.app?.pid).toBe(1234);
  });

  it("includes scope", () => {
    const env = buildEnvelope([], {
      platform: "windows",
      screenW: 1920,
      screenH: 1080,
      scope: "foreground",
    });
    expect(env.scope).toBe("foreground");
  });

  it("includes tools", () => {
    const env = buildEnvelope([], {
      platform: "web",
      screenW: 1920,
      screenH: 1080,
      tools: [{ name: "search", description: "Search the page" }],
    });
    expect(env.tools).toHaveLength(1);
    expect(env.tools![0].name).toBe("search");
  });
});

// ---------------------------------------------------------------------------
// pruneTree
// ---------------------------------------------------------------------------

describe("pruneTree", () => {
  it("returns deep copy for detail=full", () => {
    const tree = [makeNode({ children: [makeNode({ id: "e1", name: "Child" })] })];
    const pruned = pruneTree(tree, { detail: "full" });
    expect(pruned).toEqual(tree);
    expect(pruned).not.toBe(tree);
  });

  it("hoists unnamed generic children", () => {
    const tree = [
      makeNode({
        id: "e0",
        role: "window",
        name: "Win",
        children: [
          makeNode({
            id: "e1",
            role: "generic",
            name: "",
            children: [makeNode({ id: "e2", role: "button", name: "Click" })],
          }),
        ],
      }),
    ];
    const pruned = pruneTree(tree, { detail: "compact" });
    // The unnamed generic should be hoisted, so button is direct child of window
    expect(pruned[0].children?.[0]?.role).toBe("button");
    expect(pruned[0].children?.[0]?.id).toBe("e2");
  });

  it("skips scrollbar roles", () => {
    const tree = [
      makeNode({
        id: "e0",
        role: "window",
        name: "Win",
        children: [
          makeNode({ id: "e1", role: "scrollbar", name: "" }),
          makeNode({ id: "e2", role: "button", name: "OK" }),
        ],
      }),
    ];
    const pruned = pruneTree(tree, { detail: "compact" });
    expect(pruned[0].children).toHaveLength(1);
    expect(pruned[0].children?.[0]?.role).toBe("button");
  });

  it("skips unnamed images", () => {
    const tree = [
      makeNode({
        id: "e0",
        role: "window",
        name: "Win",
        children: [makeNode({ id: "e1", role: "img", name: "" })],
      }),
    ];
    const pruned = pruneTree(tree, { detail: "compact" });
    expect(pruned[0].children ?? []).toHaveLength(0);
  });

  it("skips empty text nodes", () => {
    const tree = [
      makeNode({
        id: "e0",
        role: "window",
        name: "Win",
        children: [makeNode({ id: "e1", role: "text", name: "" })],
      }),
    ];
    const pruned = pruneTree(tree, { detail: "compact" });
    expect(pruned[0].children ?? []).toHaveLength(0);
  });

  it("skips zero-size elements", () => {
    const tree = [
      makeNode({
        id: "e0",
        role: "window",
        name: "Win",
        children: [
          makeNode({ id: "e1", role: "button", name: "Zero", bounds: { x: 0, y: 0, w: 0, h: 30 } }),
        ],
      }),
    ];
    const pruned = pruneTree(tree, { detail: "compact" });
    expect(pruned[0].children ?? []).toHaveLength(0);
  });

  it("keeps interactive offscreen nodes", () => {
    const tree = [
      makeNode({
        id: "e0",
        role: "window",
        name: "Win",
        children: [
          makeNode({
            id: "e1",
            role: "button",
            name: "Offscreen",
            states: ["offscreen"],
            actions: ["click"],
          }),
        ],
      }),
    ];
    const pruned = pruneTree(tree, { detail: "compact" });
    expect(pruned[0].children).toHaveLength(1);
  });

});

// ---------------------------------------------------------------------------
// serializeOverview
// ---------------------------------------------------------------------------

describe("serializeOverview", () => {
  it("formats window list", () => {
    const windows: WindowInfo[] = [
      { title: "Discord", pid: 1234, foreground: true, bounds: { x: 0, y: 0, w: 1920, h: 1080 } },
      { title: "Chrome", pid: 5678, foreground: false, bounds: null },
    ];
    const result = serializeOverview(windows, { platform: "windows", screenW: 1920, screenH: 1080 });
    expect(result).toContain("# CUP 0.1.0 | windows | 1920x1080");
    expect(result).toContain("# overview | 2 windows");
    expect(result).toContain("* [fg] Discord");
    expect(result).toContain("(pid:1234)");
    expect(result).toContain("Chrome");
  });

  it("handles empty window list", () => {
    const result = serializeOverview([], { platform: "macos", screenW: 2560, screenH: 1440 });
    expect(result).toContain("# overview | 0 windows");
  });
});

// ---------------------------------------------------------------------------
// formatLine
// ---------------------------------------------------------------------------

describe("formatLine", () => {
  it("formats basic node", () => {
    const result = formatLine(makeNode({ id: "e14", role: "button", name: "Submit" }));
    expect(result).toBe('[e14] btn "Submit"');
  });

  it("includes bounds for interactable nodes", () => {
    const result = formatLine(
      makeNode({ id: "e0", bounds: { x: 100, y: 50, w: 80, h: 30 }, actions: ["click"] }),
    );
    expect(result).toContain("100,50 80x30");
  });

  it("omits bounds for non-interactable nodes", () => {
    const result = formatLine(
      makeNode({ id: "e0", bounds: { x: 100, y: 50, w: 80, h: 30 } }),
    );
    expect(result).not.toContain("100,50");
  });

  it("includes states with short codes", () => {
    const result = formatLine(makeNode({ id: "e0", states: ["disabled", "focused"] }));
    expect(result).toContain("{dis,foc}");
  });

  it("includes actions with short codes (without focus)", () => {
    const result = formatLine(makeNode({ id: "e0", actions: ["click", "focus", "toggle"] }));
    expect(result).toContain("[clk,tog]");
    expect(result).not.toContain("foc");
  });

  it("includes value for textbox", () => {
    const result = formatLine(
      makeNode({ id: "e0", role: "textbox", name: "Input", value: "hello" }),
    );
    expect(result).toContain('val="hello"');
  });
});

// ---------------------------------------------------------------------------
// serializeCompact
// ---------------------------------------------------------------------------

describe("serializeCompact", () => {
  it("produces header and tree", () => {
    const env = makeEnvelope({
      tree: [makeNode({ id: "e0", role: "window", name: "App" })],
      app: { name: "App" },
    });
    const result = serializeCompact(env);
    expect(result).toContain("# CUP 0.1.0 | windows | 1920x1080");
    expect(result).toContain("# app: App");
    expect(result).toContain('[e0] win "App"');
  });

  it("includes window list when provided", () => {
    const env = makeEnvelope({
      tree: [makeNode({ id: "e0", role: "window", name: "App" })],
    });
    const windows: WindowInfo[] = [{ title: "Discord", foreground: true }];
    const result = serializeCompact(env, { windowList: windows });
    expect(result).toContain("# --- 1 open windows ---");
    expect(result).toContain("#   Discord [fg]");
  });

  it("truncates at maxChars", () => {
    const children = Array.from({ length: 200 }, (_, i) =>
      makeNode({ id: `e${i + 1}`, role: "button", name: `Button ${i}` }),
    );
    const env = makeEnvelope({
      tree: [makeNode({ id: "e0", role: "window", name: "App", children })],
    });
    const result = serializeCompact(env, { maxChars: 500, detail: "full" });
    expect(result).toContain("# OUTPUT TRUNCATED");
    expect(result.length).toBeLessThan(800); // some overhead for truncation message
  });

  it("shows WebMCP tools count", () => {
    const env = makeEnvelope({
      tree: [makeNode()],
      tools: [{ name: "search" }, { name: "navigate" }],
    });
    const result = serializeCompact(env);
    expect(result).toContain("# 2 WebMCP tools available");
  });
});

// ---------------------------------------------------------------------------
// Viewport clipping
// ---------------------------------------------------------------------------

describe("viewport clipping", () => {
  it("clips offscreen children of scrollable containers", () => {
    const tree: CupNode[] = [
      makeNode({
        id: "e0",
        role: "list",
        name: "List",
        actions: ["scroll"],
        bounds: { x: 0, y: 0, w: 200, h: 100 },
        children: [
          makeNode({ id: "e1", role: "listitem", name: "Visible", bounds: { x: 0, y: 0, w: 200, h: 30 } }),
          makeNode({ id: "e2", role: "listitem", name: "Below", bounds: { x: 0, y: 200, w: 200, h: 30 } }),
        ],
      }),
    ];
    const pruned = pruneTree(tree, { detail: "compact" });
    expect(pruned[0].children).toHaveLength(1);
    expect(pruned[0].children?.[0]?.name).toBe("Visible");
    expect(pruned[0]._clipped?.below).toBeGreaterThan(0);
  });
});
