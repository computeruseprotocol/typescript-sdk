/**
 * Linux action handler — stub.
 *
 * TODO: Implement using node-ffi-napi or D-Bus bindings for AT-SPI2.
 * See Python reference: cup/actions/_linux.py
 */

import type { ActionResult } from "../types.js";
import type { ActionHandler } from "./handler.js";

export class LinuxActionHandler implements ActionHandler {
  async execute(
    _nativeRef: unknown,
    action: string,
    _params: Record<string, unknown>,
  ): Promise<ActionResult> {
    return {
      success: false,
      message: "",
      error: `Linux action '${action}' is not yet implemented in the TypeScript SDK. Contributions welcome!`,
    };
  }

  async pressKeys(_combo: string): Promise<ActionResult> {
    return {
      success: false,
      message: "",
      error: "Linux press_keys is not yet implemented in the TypeScript SDK. Contributions welcome!",
    };
  }

  async launchApp(_name: string): Promise<ActionResult> {
    return {
      success: false,
      message: "",
      error: "Linux launch_app is not yet implemented in the TypeScript SDK. Contributions welcome!",
    };
  }
}
