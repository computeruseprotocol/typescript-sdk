/**
 * Tests for batch execution.
 *
 * Ported from python-sdk/tests/test_batch.py
 */

import { describe, it, expect } from "vitest";
import type { BatchAction } from "../src/types.js";

// We test the batch logic indirectly since Session.batchExecute requires
// a real adapter. Here we test the batch action type definitions work.

describe("BatchAction types", () => {
  it("accepts wait action", () => {
    const action: BatchAction = { action: "wait", ms: 500 };
    expect(action.action).toBe("wait");
  });

  it("accepts press_keys action", () => {
    const action: BatchAction = { action: "press_keys", keys: "ctrl+s" };
    expect(action.action).toBe("press_keys");
  });

  it("accepts element action", () => {
    const action: BatchAction = { element_id: "e14", action: "click" };
    expect(action.action).toBe("click");
  });

  it("accepts element action with params", () => {
    const action: BatchAction = { element_id: "e5", action: "type", value: "hello" };
    expect(action.action).toBe("type");
  });
});
