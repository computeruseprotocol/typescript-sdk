/**
 * Tests for CUP search engine.
 *
 * Ported from python-sdk/tests/test_find.py
 */

import { describe, it, expect } from "vitest";
import { tokenize, resolveRoles, searchTree, ROLE_SYNONYMS, ALL_ROLES } from "../src/search.js";
import type { CupNode } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<CupNode> = {}): CupNode {
  return { id: "e0", role: "button", name: "", ...overrides };
}

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  it("splits on non-alphanumeric", () => {
    expect(tokenize("hello world")).toEqual(["hello", "world"]);
  });

  it("lowercases", () => {
    expect(tokenize("Hello World")).toEqual(["hello", "world"]);
  });

  it("strips accents", () => {
    expect(tokenize("café")).toEqual(["cafe"]);
  });

  it("handles empty input", () => {
    expect(tokenize("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveRoles
// ---------------------------------------------------------------------------

describe("resolveRoles", () => {
  it("resolves exact role", () => {
    const roles = resolveRoles("button");
    expect(roles).toContain("button");
  });

  it("resolves synonym", () => {
    const roles = resolveRoles("search bar");
    expect(roles).toBeDefined();
    expect(roles!.has("searchbox")).toBe(true);
    expect(roles!.has("textbox")).toBe(true);
  });

  it("resolves substring", () => {
    const roles = resolveRoles("combo");
    expect(roles).toBeDefined();
    expect(roles!.has("combobox")).toBe(true);
  });

  it("returns null for unknown", () => {
    const roles = resolveRoles("xyznonexistent");
    expect(roles).toBeNull();
  });

  it("identity mapping for all roles", () => {
    for (const role of ALL_ROLES) {
      expect(ROLE_SYNONYMS.has(role)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// searchTree
// ---------------------------------------------------------------------------

describe("searchTree", () => {
  const tree: CupNode[] = [
    makeNode({
      id: "e0",
      role: "window",
      name: "App",
      children: [
        makeNode({ id: "e1", role: "button", name: "Submit", actions: ["click"] }),
        makeNode({ id: "e2", role: "textbox", name: "Username", actions: ["type"], states: ["editable"] }),
        makeNode({ id: "e3", role: "button", name: "Cancel", actions: ["click"], states: ["disabled"] }),
        makeNode({ id: "e4", role: "link", name: "Help", actions: ["click"] }),
        makeNode({ id: "e5", role: "checkbox", name: "Remember me", actions: ["toggle"] }),
      ],
    }),
  ];

  it("finds by role", () => {
    const results = searchTree(tree, { role: "button" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.node.role === "button")).toBe(true);
  });

  it("finds by name", () => {
    const results = searchTree(tree, { name: "Submit" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].node.name).toBe("Submit");
  });

  it("finds by state", () => {
    const results = searchTree(tree, { role: "button", state: "disabled" });
    expect(results).toHaveLength(1);
    expect(results[0].node.name).toBe("Cancel");
  });

  it("freeform query parses role + name", () => {
    const results = searchTree(tree, { query: "the submit button" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].node.name).toBe("Submit");
    expect(results[0].node.role).toBe("button");
  });

  it("respects limit", () => {
    const results = searchTree(tree, { role: "button", limit: 1 });
    expect(results).toHaveLength(1);
  });

  it("search bar synonym", () => {
    const results = searchTree(tree, { query: "search bar" });
    // Should match textbox/searchbox/combobox roles
    // Username textbox should match
    const roles = results.map((r) => r.node.role);
    expect(roles.some((r) => ["textbox", "searchbox", "combobox"].includes(r))).toBe(true);
  });

  it("returns empty for no match", () => {
    const results = searchTree(tree, { name: "nonexistent12345" });
    expect(results).toHaveLength(0);
  });

  it("ranks exact name higher than partial", () => {
    const tree2: CupNode[] = [
      makeNode({
        id: "e0",
        role: "window",
        name: "App",
        children: [
          makeNode({ id: "e1", role: "button", name: "Submit Form", actions: ["click"] }),
          makeNode({ id: "e2", role: "button", name: "Submit", actions: ["click"] }),
        ],
      }),
    ];
    const results = searchTree(tree2, { query: "submit button" });
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Exact match "Submit" should score higher
    expect(results[0].node.name).toBe("Submit");
  });
});
