/**
 * Tests for action execution.
 *
 * Ported from python-sdk/tests/test_actions.py
 */

import { describe, it, expect } from "vitest";
import { parseCombo } from "../src/actions/keys.js";
import { VALID_ACTIONS } from "../src/actions/executor.js";

// ---------------------------------------------------------------------------
// parseCombo
// ---------------------------------------------------------------------------

describe("parseCombo", () => {
  it("parses single key", () => {
    const [mods, keys] = parseCombo("enter");
    expect(mods).toEqual([]);
    expect(keys).toEqual(["enter"]);
  });

  it("parses single character", () => {
    const [mods, keys] = parseCombo("a");
    expect(mods).toEqual([]);
    expect(keys).toEqual(["a"]);
  });

  it("parses ctrl+key", () => {
    const [mods, keys] = parseCombo("ctrl+s");
    expect(mods).toEqual(["ctrl"]);
    expect(keys).toEqual(["s"]);
  });

  it("parses multiple modifiers", () => {
    const [mods, keys] = parseCombo("ctrl+shift+p");
    expect(mods).toEqual(["ctrl", "shift"]);
    expect(keys).toEqual(["p"]);
  });

  it("normalizes return to enter", () => {
    const [, keys] = parseCombo("return");
    expect(keys).toEqual(["enter"]);
  });

  it("normalizes esc to escape", () => {
    const [, keys] = parseCombo("esc");
    expect(keys).toEqual(["escape"]);
  });

  it("normalizes cmd to meta", () => {
    const [mods] = parseCombo("cmd+s");
    expect(mods).toEqual(["meta"]);
  });

  it("normalizes win to meta", () => {
    const [mods] = parseCombo("win+e");
    expect(mods).toEqual(["meta"]);
  });

  it("handles spaces around +", () => {
    const [mods, keys] = parseCombo("ctrl + a");
    expect(mods).toEqual(["ctrl"]);
    expect(keys).toEqual(["a"]);
  });

  it("lowercases input", () => {
    const [mods, keys] = parseCombo("CTRL+S");
    expect(mods).toEqual(["ctrl"]);
    expect(keys).toEqual(["s"]);
  });
});

// ---------------------------------------------------------------------------
// VALID_ACTIONS
// ---------------------------------------------------------------------------

describe("VALID_ACTIONS", () => {
  it("contains all canonical actions", () => {
    const expected = [
      "click", "collapse", "decrement", "dismiss", "doubleclick",
      "expand", "focus", "increment", "longpress", "press",
      "rightclick", "scroll", "select", "setvalue", "toggle", "type",
    ];
    for (const action of expected) {
      expect(VALID_ACTIONS.has(action)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// MacosActionHandler
// ---------------------------------------------------------------------------

describe("MacosActionHandler", () => {
  it("returns error for unknown action", async () => {
    const { MacosActionHandler } = await import("../src/actions/macos.js");
    const handler = new MacosActionHandler();
    const result = await handler.action(null, "fly", {});
    expect(result.success).toBe(false);
    expect(result.error?.toLowerCase()).toContain("not implemented");
  });

  it("press works on macOS", async () => {
    if (process.platform !== "darwin") return; // skip on non-macOS

    const { MacosActionHandler } = await import("../src/actions/macos.js");
    const handler = new MacosActionHandler();
    const result = await handler.press("escape");
    expect(result.success).toBe(true);
    expect(result.message).toContain("Pressed");
  }, 60000); // First run compiles the Swift helper (~30s)

  it("openApp rejects empty name", async () => {
    const { MacosActionHandler } = await import("../src/actions/macos.js");
    const handler = new MacosActionHandler();
    const result = await handler.openApp("");
    expect(result.success).toBe(false);
    expect(result.error?.toLowerCase()).toContain("empty");
  });

  it("openApp rejects nonexistent app", async () => {
    if (process.platform !== "darwin") return; // skip on non-macOS

    const { MacosActionHandler } = await import("../src/actions/macos.js");
    const handler = new MacosActionHandler();
    const result = await handler.openApp("zzzznonexistentapp99999");
    expect(result.success).toBe(false);
    expect(result.error?.toLowerCase()).toContain("no installed app");
  });
});
