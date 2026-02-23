/**
 * Tests for CUP JSON Schema validation.
 *
 * Ported from python-sdk/tests/test_schema.py
 */

import { describe, it, expect } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const schemaPath = resolve(import.meta.dirname, "../schema/cup.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));

const ajv = new Ajv2020({ strict: false });
const validate = ajv.compile(schema);

function validEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "0.1.0",
    platform: "windows",
    screen: { w: 1920, h: 1080 },
    tree: [],
    ...overrides,
  };
}

function validNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "e0", role: "button", name: "OK", ...overrides };
}

// ---------------------------------------------------------------------------
// Schema structure
// ---------------------------------------------------------------------------

describe("schema structure", () => {
  it("has required fields", () => {
    expect(schema.required).toContain("version");
    expect(schema.required).toContain("platform");
    expect(schema.required).toContain("screen");
    expect(schema.required).toContain("tree");
  });

  it("defines all 6 platforms", () => {
    const platforms = schema.$defs.platformId.enum;
    expect(platforms).toEqual(["windows", "macos", "linux", "web", "android", "ios"]);
  });

  it("defines node with required fields", () => {
    const nodeRequired = schema.$defs.node.required;
    expect(nodeRequired).toContain("id");
    expect(nodeRequired).toContain("role");
    expect(nodeRequired).toContain("name");
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("schema validation", () => {
  it("validates minimal envelope", () => {
    expect(validate(validEnvelope())).toBe(true);
  });

  it("validates envelope with tree", () => {
    expect(
      validate(validEnvelope({ tree: [validNode()] })),
    ).toBe(true);
  });

  it("validates envelope with scope", () => {
    expect(
      validate(validEnvelope({ scope: "foreground" })),
    ).toBe(true);
  });

  it("validates envelope with app info", () => {
    expect(
      validate(validEnvelope({ app: { name: "Test", pid: 1234 } })),
    ).toBe(true);
  });

  it("validates node with all optional fields", () => {
    const node = validNode({
      description: "A button",
      value: "hello",
      bounds: { x: 0, y: 0, w: 100, h: 30 },
      states: ["focused"],
      actions: ["click"],
      attributes: { level: 2 },
    });
    expect(validate(validEnvelope({ tree: [node] }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rejection
// ---------------------------------------------------------------------------

describe("schema rejection", () => {
  it("rejects missing version", () => {
    const env = validEnvelope();
    delete env.version;
    expect(validate(env)).toBe(false);
  });

  it("rejects missing platform", () => {
    const env = validEnvelope();
    delete env.platform;
    expect(validate(env)).toBe(false);
  });

  it("rejects invalid platform", () => {
    expect(validate(validEnvelope({ platform: "bsd" }))).toBe(false);
  });

  it("rejects invalid scope", () => {
    expect(validate(validEnvelope({ scope: "invalid" }))).toBe(false);
  });

  it("rejects node with missing id", () => {
    const node = validNode();
    delete node.id;
    expect(validate(validEnvelope({ tree: [node] }))).toBe(false);
  });

  it("rejects node with invalid id format", () => {
    expect(
      validate(validEnvelope({ tree: [validNode({ id: "invalid" })] })),
    ).toBe(false);
  });

  it("rejects node with invalid role", () => {
    expect(
      validate(validEnvelope({ tree: [validNode({ role: "nonexistent" })] })),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------

describe("mappings", () => {
  const mappingsPath = resolve(import.meta.dirname, "../schema/mappings.json");
  const mappings = JSON.parse(readFileSync(mappingsPath, "utf-8"));

  it("has roles section", () => {
    expect(mappings.roles).toBeDefined();
    expect(Object.keys(mappings.roles).length).toBeGreaterThan(0);
  });

  it("has states section", () => {
    expect(mappings.states).toBeDefined();
    expect(Object.keys(mappings.states).length).toBeGreaterThan(0);
  });

  it("has actions section", () => {
    expect(mappings.actions).toBeDefined();
    expect(Object.keys(mappings.actions).length).toBeGreaterThan(0);
  });

  it("role mappings include button", () => {
    expect(mappings.roles.button).toBeDefined();
    expect(mappings.roles.button.windows).toBeTruthy();
  });
});
