/**
 * Abstract base for platform-specific action handlers.
 *
 * Ported from python-sdk/cup/actions/_handler.py
 */

import type { ActionResult } from "../types.js";

/**
 * Interface for platform-specific action execution.
 *
 * Each platform implements this to translate CUP canonical actions
 * (click, type, toggle, etc.) into native API calls.
 */
export interface ActionHandler {
  execute(
    nativeRef: unknown,
    action: string,
    params: Record<string, unknown>,
  ): Promise<ActionResult>;

  pressKeys(combo: string): Promise<ActionResult>;

  launchApp(name: string): Promise<ActionResult>;
}
