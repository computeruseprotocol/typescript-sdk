/**
 * macOS action handler — stub.
 *
 * TODO: Implement using node-ffi-napi for AXUIElement API calls.
 * See Python reference: cup/actions/_macos.py
 */

import type { ActionResult } from "../types.js";
import type { ActionHandler } from "./handler.js";

export class MacosActionHandler implements ActionHandler {
  async execute(
    _nativeRef: unknown,
    action: string,
    _params: Record<string, unknown>,
  ): Promise<ActionResult> {
    return {
      success: false,
      message: "",
      error: `macOS action '${action}' is not yet implemented in the TypeScript SDK. Contributions welcome!`,
    };
  }

  async pressKeys(_combo: string): Promise<ActionResult> {
    return {
      success: false,
      message: "",
      error: "macOS press_keys is not yet implemented in the TypeScript SDK. Contributions welcome!",
    };
  }

  async launchApp(_name: string): Promise<ActionResult> {
    return {
      success: false,
      message: "",
      error: "macOS launch_app is not yet implemented in the TypeScript SDK. Contributions welcome!",
    };
  }
}
