/**
 * Action executor — dispatches CUP actions to platform-specific handlers.
 *
 * Ported from python-sdk/cup/actions/executor.py
 */

import type { PlatformAdapter } from "../base.js";
import type { ActionResult } from "../types.js";
import type { ActionHandler } from "./handler.js";

export const VALID_ACTIONS = new Set([
  "click",
  "collapse",
  "decrement",
  "dismiss",
  "doubleclick",
  "expand",
  "focus",
  "increment",
  "longpress",
  "press_keys",
  "rightclick",
  "scroll",
  "select",
  "setvalue",
  "toggle",
  "type",
]);

async function getActionHandler(platformName: string): Promise<ActionHandler> {
  switch (platformName) {
    case "windows": {
      const { WindowsActionHandler } = await import("./windows.js");
      return new WindowsActionHandler();
    }
    case "macos": {
      const { MacosActionHandler } = await import("./macos.js");
      return new MacosActionHandler();
    }
    case "linux": {
      const { LinuxActionHandler } = await import("./linux.js");
      return new LinuxActionHandler();
    }
    case "web": {
      const { WebActionHandler } = await import("./web.js");
      return new WebActionHandler();
    }
    default:
      throw new Error(
        `No action handler for platform '${platformName}'. Supported: windows, macos, linux, web`,
      );
  }
}

export class ActionExecutor {
  private adapter: PlatformAdapter;
  private refs: Map<string, unknown> = new Map();
  private handler: ActionHandler | null = null;

  constructor(adapter: PlatformAdapter) {
    this.adapter = adapter;
  }

  private async getHandler(): Promise<ActionHandler> {
    if (!this.handler) {
      this.handler = await getActionHandler(this.adapter.platformName);
    }
    return this.handler;
  }

  setRefs(refs: Map<string, unknown>): void {
    this.refs = refs;
  }

  async execute(
    elementId: string,
    action: string,
    params?: Record<string, unknown> | null,
  ): Promise<ActionResult> {
    if (!VALID_ACTIONS.has(action)) {
      return {
        success: false,
        message: "",
        error: `Unknown action '${action}'. Valid: ${[...VALID_ACTIONS].sort().join(", ")}`,
      };
    }

    // press_keys does not require an element reference
    if (action === "press_keys") {
      const keys = (params ?? {}).keys as string | undefined;
      if (!keys) {
        return {
          success: false,
          message: "",
          error: "Action 'press_keys' requires a 'keys' parameter",
        };
      }
      return this.pressKeys(keys);
    }

    if (!this.refs.has(elementId)) {
      return {
        success: false,
        message: "",
        error: `Element '${elementId}' not found in current tree snapshot`,
      };
    }

    // Validate required parameters
    if ((action === "type" || action === "setvalue") && !((params ?? {}).value != null)) {
      return {
        success: false,
        message: "",
        error: `Action '${action}' requires a 'value' parameter`,
      };
    }
    if (action === "scroll") {
      const direction = (params ?? {}).direction;
      if (!["up", "down", "left", "right"].includes(direction as string)) {
        return {
          success: false,
          message: "",
          error: `Action 'scroll' requires 'direction' (up/down/left/right), got: ${JSON.stringify(direction)}`,
        };
      }
    }

    const nativeRef = this.refs.get(elementId);
    try {
      const handler = await this.getHandler();
      return await handler.execute(nativeRef, action, params ?? {});
    } catch (err) {
      return { success: false, message: "", error: String(err) };
    }
  }

  async pressKeys(combo: string): Promise<ActionResult> {
    try {
      const handler = await this.getHandler();
      return await handler.pressKeys(combo);
    } catch (err) {
      return { success: false, message: "", error: String(err) };
    }
  }

  async launchApp(name: string): Promise<ActionResult> {
    try {
      const handler = await this.getHandler();
      return await handler.launchApp(name);
    } catch (err) {
      return { success: false, message: "", error: String(err) };
    }
  }
}
