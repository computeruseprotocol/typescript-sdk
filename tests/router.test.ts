/**
 * Tests for platform router.
 *
 * Ported from python-sdk/tests/test_router.py
 */

import { describe, it, expect } from "vitest";
import { detectPlatform } from "../src/router.js";
import { platform } from "node:os";

describe("detectPlatform", () => {
  it("returns a valid platform string", () => {
    const result = detectPlatform();
    expect(["windows", "macos", "linux"]).toContain(result);
  });

  it("matches current OS", () => {
    const p = platform();
    const result = detectPlatform();
    if (p === "win32") expect(result).toBe("windows");
    else if (p === "darwin") expect(result).toBe("macos");
    else if (p === "linux") expect(result).toBe("linux");
  });
});
