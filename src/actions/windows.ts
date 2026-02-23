/**
 * Windows action handler — stub.
 *
 * TODO: Implement using node-ffi-napi or edge-js for UIA COM interop.
 * See Python reference: cup/actions/_windows.py
 */

import type { ActionResult } from "../types.js";
import type { ActionHandler } from "./handler.js";

export class WindowsActionHandler implements ActionHandler {
  async execute(
    _nativeRef: unknown,
    action: string,
    _params: Record<string, unknown>,
  ): Promise<ActionResult> {
    return {
      success: false,
      message: "",
      error: `Windows action '${action}' is not yet implemented in the TypeScript SDK. Contributions welcome!`,
    };
  }

  async pressKeys(_combo: string): Promise<ActionResult> {
    return {
      success: false,
      message: "",
      error: "Windows press_keys is not yet implemented in the TypeScript SDK. Contributions welcome!",
    };
  }

  async launchApp(_name: string): Promise<ActionResult> {
    return {
      success: false,
      message: "",
      error: "Windows launch_app is not yet implemented in the TypeScript SDK. Contributions welcome!",
    };
  }
}
