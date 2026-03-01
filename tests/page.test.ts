/**
 * Tests for the CUP pagination system.
 *
 * Tests findNodeById, serializePage, and the clipping hint format.
 */

import { describe, it, expect } from "vitest";
import {
  findNodeById,
  serializePage,
  pruneTree,
  serializeCompact,
  buildEnvelope,
} from "../src/format.js";
import type { CupNode, CupEnvelope } from "../src/types.js";

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

function makeScrollableList(itemCount: number, viewportItems: number): {
  rawTree: CupNode[];
  envelope: CupEnvelope;
} {
  // Create a scrollable list with itemCount children
  // The list's bounds define a viewport that fits viewportItems
  const itemHeight = 30;
  const viewportHeight = viewportItems * itemHeight;

  const children: CupNode[] = [];
  for (let i = 0; i < itemCount; i++) {
    children.push({
      id: `e${i + 1}`,
      role: "listitem",
      name: `Item ${i + 1}`,
      bounds: { x: 0, y: i * itemHeight, w: 200, h: itemHeight },
    });
  }

  const list: CupNode = {
    id: "e0",
    role: "list",
    name: "Items",
    bounds: { x: 0, y: 0, w: 200, h: viewportHeight },
    actions: ["scroll"],
    children,
  };

  const tree = [list];
  const envelope: CupEnvelope = {
    version: "0.1.0",
    platform: "windows",
    screen: { w: 1920, h: 1080 },
    tree,
  };

  return { rawTree: tree, envelope };
}

// ---------------------------------------------------------------------------
// findNodeById
// ---------------------------------------------------------------------------

describe("findNodeById", () => {
  it("finds root node", () => {
    const tree = [makeNode({ id: "e0" })];
    const result = findNodeById(tree, "e0");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("e0");
  });

  it("finds nested node", () => {
    const tree = [
      makeNode({
        id: "e0",
        children: [
          makeNode({ id: "e1", children: [makeNode({ id: "e2", name: "Deep" })] }),
        ],
      }),
    ];
    const result = findNodeById(tree, "e2");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Deep");
  });

  it("returns null for missing ID", () => {
    const tree = [makeNode({ id: "e0" })];
    expect(findNodeById(tree, "e99")).toBeNull();
  });

  it("returns null for empty tree", () => {
    expect(findNodeById([], "e0")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// serializePage
// ---------------------------------------------------------------------------

describe("serializePage", () => {
  it("produces correct header with pagination context", () => {
    const container = makeNode({ id: "e0", role: "list", name: "Items" });
    const items = [
      makeNode({ id: "e3", role: "listitem", name: "Item 3" }),
      makeNode({ id: "e4", role: "listitem", name: "Item 4" }),
    ];

    const result = serializePage(container, items, 2, 10);
    expect(result).toContain('# page e0 | items 3-4 of 10 | lst "Items"');
  });

  it("includes footer with remaining items hint", () => {
    const container = makeNode({ id: "e0", role: "list", name: "Items" });
    const items = [makeNode({ id: "e3", role: "listitem", name: "Item 3" })];

    const result = serializePage(container, items, 2, 10);
    expect(result).toContain("# 7 more — page(element_id='e0', direction='down')");
  });

  it("includes footer with preceding items hint", () => {
    const container = makeNode({ id: "e0", role: "list", name: "Items" });
    const items = [makeNode({ id: "e5", role: "listitem", name: "Item 5" })];

    const result = serializePage(container, items, 5, 10);
    expect(result).toContain("# 5 before — page(element_id='e0', direction='up')");
  });

  it("omits remaining hint when at end", () => {
    const container = makeNode({ id: "e0", role: "list", name: "Items" });
    const items = [makeNode({ id: "e9", role: "listitem", name: "Item 10" })];

    const result = serializePage(container, items, 9, 10);
    expect(result).not.toContain("direction='down'");
  });

  it("omits preceding hint when at start", () => {
    const container = makeNode({ id: "e0", role: "list", name: "Items" });
    const items = [makeNode({ id: "e0", role: "listitem", name: "Item 1" })];

    const result = serializePage(container, items, 0, 10);
    expect(result).not.toContain("direction='up'");
  });

  it("renders items using compact format", () => {
    const container = makeNode({ id: "e0", role: "list", name: "Items" });
    const items = [
      makeNode({ id: "e3", role: "listitem", name: "Item 3" }),
    ];

    const result = serializePage(container, items, 2, 10);
    expect(result).toContain('[e3] li "Item 3"');
  });
});

// ---------------------------------------------------------------------------
// Updated clipping hints
// ---------------------------------------------------------------------------

describe("clipping hints reference page()", () => {
  it("emits page() hint instead of scroll hint", () => {
    const { envelope } = makeScrollableList(20, 5);
    const output = serializeCompact(envelope, { detail: "compact" });

    // Should reference page(), not scroll
    expect(output).toContain("page(element_id='e0'");
    expect(output).toContain("direction='down'");
    expect(output).not.toContain("scroll down to see");
  });
});

// ---------------------------------------------------------------------------
// pruneTree clipping + page integration
// ---------------------------------------------------------------------------

describe("pruneTree clipping with page integration", () => {
  it("attaches _clipped metadata to scrollable container", () => {
    const { envelope } = makeScrollableList(20, 5);
    const pruned = pruneTree(envelope.tree, {
      detail: "compact",
      screen: envelope.screen,
    });

    // The list node should have _clipped with below > 0
    const list = pruned[0];
    expect(list._clipped).toBeDefined();
    expect(list._clipped!.below).toBeGreaterThan(0);
  });
});
