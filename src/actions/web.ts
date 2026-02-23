/**
 * Web action handler — CDP-based action execution.
 *
 * Ported from python-sdk/cup/actions/_web.py
 */

import type { ActionResult } from "../types.js";
import type { ActionHandler } from "./handler.js";
import { parseCombo } from "./keys.js";

// ---------------------------------------------------------------------------
// CDP key mapping for Input.dispatchKeyEvent
// ---------------------------------------------------------------------------

const CDP_KEY_MAP: Record<string, { key: string; code: string }> = {
  enter: { key: "Enter", code: "Enter" },
  tab: { key: "Tab", code: "Tab" },
  escape: { key: "Escape", code: "Escape" },
  backspace: { key: "Backspace", code: "Backspace" },
  delete: { key: "Delete", code: "Delete" },
  space: { key: " ", code: "Space" },
  up: { key: "ArrowUp", code: "ArrowUp" },
  down: { key: "ArrowDown", code: "ArrowDown" },
  left: { key: "ArrowLeft", code: "ArrowLeft" },
  right: { key: "ArrowRight", code: "ArrowRight" },
  home: { key: "Home", code: "Home" },
  end: { key: "End", code: "End" },
  pageup: { key: "PageUp", code: "PageUp" },
  pagedown: { key: "PageDown", code: "PageDown" },
  f1: { key: "F1", code: "F1" },
  f2: { key: "F2", code: "F2" },
  f3: { key: "F3", code: "F3" },
  f4: { key: "F4", code: "F4" },
  f5: { key: "F5", code: "F5" },
  f6: { key: "F6", code: "F6" },
  f7: { key: "F7", code: "F7" },
  f8: { key: "F8", code: "F8" },
  f9: { key: "F9", code: "F9" },
  f10: { key: "F10", code: "F10" },
  f11: { key: "F11", code: "F11" },
  f12: { key: "F12", code: "F12" },
};

const CDP_MODIFIER_MAP: Record<string, { key: string; code: string; bit: number }> = {
  ctrl: { key: "Control", code: "ControlLeft", bit: 2 },
  alt: { key: "Alt", code: "AltLeft", bit: 1 },
  shift: { key: "Shift", code: "ShiftLeft", bit: 8 },
  meta: { key: "Meta", code: "MetaLeft", bit: 4 },
};

function getClickPoint(boxModel: Record<string, unknown>): [number, number] {
  const model = boxModel.model as Record<string, number[]> | undefined;
  const content = model?.content ?? [];
  if (content.length >= 8) {
    const xs = [content[0], content[2], content[4], content[6]];
    const ys = [content[1], content[3], content[5], content[7]];
    return [xs.reduce((a, b) => a + b, 0) / 4, ys.reduce((a, b) => a + b, 0) / 4];
  }
  const border = model?.border ?? [];
  if (border.length >= 8) {
    const xs = [border[0], border[2], border[4], border[6]];
    const ys = [border[1], border[3], border[5], border[7]];
    return [xs.reduce((a, b) => a + b, 0) / 4, ys.reduce((a, b) => a + b, 0) / 4];
  }
  throw new Error("Cannot determine element position from box model");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// WebActionHandler
// ---------------------------------------------------------------------------

export class WebActionHandler implements ActionHandler {
  private host: string;

  constructor(options?: { cdpHost?: string }) {
    this.host = options?.cdpHost ?? process.env.CUP_CDP_HOST ?? "127.0.0.1";
  }

  async execute(
    nativeRef: unknown,
    action: string,
    params: Record<string, unknown>,
  ): Promise<ActionResult> {
    const { cdpConnect, cdpClose } = await import("../platforms/web.js");
    const [wsUrl, backendNodeId] = nativeRef as [string, number];
    const ws = await cdpConnect(wsUrl, this.host);
    try {
      return await this.dispatch(ws, backendNodeId, action, params);
    } catch (err) {
      return { success: false, message: "", error: `Web action '${action}' failed: ${err}` };
    } finally {
      cdpClose(ws);
    }
  }

  async pressKeys(combo: string): Promise<ActionResult> {
    const { cdpConnect, cdpClose, cdpGetTargets } = await import("../platforms/web.js");
    const port = parseInt(process.env.CUP_CDP_PORT ?? "9222", 10);

    let targets: Array<Record<string, unknown>>;
    try {
      targets = await cdpGetTargets(this.host, port);
    } catch (err) {
      return { success: false, message: "", error: `Cannot connect to CDP for press_keys: ${err}` };
    }

    const pageTargets = targets.filter((t) => t.type === "page");
    if (pageTargets.length === 0) {
      return { success: false, message: "", error: "No browser tabs found for press_keys" };
    }

    const wsUrl = pageTargets[0].webSocketDebuggerUrl as string;
    const ws = await cdpConnect(wsUrl, this.host);
    try {
      await this.sendKeyCombo(ws, combo);
      return { success: true, message: `Pressed ${combo}` };
    } catch (err) {
      return { success: false, message: "", error: `Failed to press keys: ${err}` };
    } finally {
      cdpClose(ws);
    }
  }

  async launchApp(_name: string): Promise<ActionResult> {
    return {
      success: false,
      message: "",
      error: "launch_app is not applicable for web platform",
    };
  }

  // -- dispatch -----------------------------------------------------------

  private async dispatch(
    ws: unknown,
    backendNodeId: number,
    action: string,
    params: Record<string, unknown>,
  ): Promise<ActionResult> {
    switch (action) {
      case "click":
        return this.doClick(ws, backendNodeId);
      case "rightclick":
        return this.doMouseClick(ws, backendNodeId, "right", 1);
      case "doubleclick":
        return this.doMouseClick(ws, backendNodeId, "left", 2);
      case "type":
        return this.doType(ws, backendNodeId, params.value as string);
      case "setvalue":
        return this.doSetvalue(ws, backendNodeId, params.value as string);
      case "toggle":
        return this.doToggle(ws, backendNodeId);
      case "expand":
      case "collapse":
        return this.doClick(ws, backendNodeId);
      case "select":
        return this.doSelect(ws, backendNodeId);
      case "scroll":
        return this.doScroll(ws, backendNodeId, params.direction as string);
      case "focus":
        return this.doFocus(ws, backendNodeId);
      case "dismiss":
        return this.doDismiss(ws);
      case "increment":
        return this.doArrowKey(ws, backendNodeId, "ArrowUp");
      case "decrement":
        return this.doArrowKey(ws, backendNodeId, "ArrowDown");
      default:
        return { success: false, message: "", error: `Action '${action}' not implemented for web` };
    }
  }

  // -- individual actions -------------------------------------------------

  private async doClick(ws: unknown, backendNodeId: number): Promise<ActionResult> {
    return this.doMouseClick(ws, backendNodeId, "left", 1);
  }

  private async doMouseClick(
    ws: unknown,
    backendNodeId: number,
    button: string,
    clickCount: number,
  ): Promise<ActionResult> {
    const { cdpSend } = await import("../platforms/web.js");
    const resp = await cdpSend(ws, "DOM.getBoxModel", { backendNodeId });
    const [x, y] = getClickPoint((resp as Record<string, unknown>).result as Record<string, unknown>);

    for (let i = 0; i < clickCount; i++) {
      await cdpSend(ws, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button,
        clickCount: i + 1,
      });
      await cdpSend(ws, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button,
        clickCount: i + 1,
      });
    }

    const actionName =
      button === "left" && clickCount === 1
        ? "Clicked"
        : button === "left" && clickCount === 2
          ? "Double-clicked"
          : button === "right" && clickCount === 1
            ? "Right-clicked"
            : `Mouse ${button} x${clickCount}`;
    return { success: true, message: actionName };
  }

  private async doType(ws: unknown, backendNodeId: number, text: string): Promise<ActionResult> {
    const { cdpSend } = await import("../platforms/web.js");
    await cdpSend(ws, "DOM.focus", { backendNodeId });
    await sleep(50);
    await this.sendKeyCombo(ws, "ctrl+a");
    await sleep(50);
    await cdpSend(ws, "Input.insertText", { text });
    return { success: true, message: `Typed: ${text}` };
  }

  private async doSetvalue(
    ws: unknown,
    backendNodeId: number,
    text: string,
  ): Promise<ActionResult> {
    const { cdpSend } = await import("../platforms/web.js");
    const resp = await cdpSend(ws, "DOM.resolveNode", { backendNodeId });
    const objectId = (resp as any)?.result?.object?.objectId;
    if (!objectId) {
      return { success: false, message: "", error: "Cannot resolve DOM node for setvalue" };
    }
    await cdpSend(ws, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(v) {
        this.value = v;
        this.dispatchEvent(new Event('input', {bubbles: true}));
        this.dispatchEvent(new Event('change', {bubbles: true}));
      }`,
      arguments: [{ value: text }],
    });
    return { success: true, message: `Set value to: ${text}` };
  }

  private async doScroll(
    ws: unknown,
    backendNodeId: number,
    direction: string,
  ): Promise<ActionResult> {
    const { cdpSend } = await import("../platforms/web.js");
    const resp = await cdpSend(ws, "DOM.getBoxModel", { backendNodeId });
    const [x, y] = getClickPoint((resp as Record<string, unknown>).result as Record<string, unknown>);

    let deltaX = 0;
    let deltaY = 0;
    if (direction === "up") deltaY = -200;
    else if (direction === "down") deltaY = 200;
    else if (direction === "left") deltaX = -200;
    else if (direction === "right") deltaX = 200;

    await cdpSend(ws, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY,
    });
    return { success: true, message: `Scrolled ${direction}` };
  }

  private async doFocus(ws: unknown, backendNodeId: number): Promise<ActionResult> {
    const { cdpSend } = await import("../platforms/web.js");
    await cdpSend(ws, "DOM.focus", { backendNodeId });
    return { success: true, message: "Focused" };
  }

  private async doToggle(ws: unknown, backendNodeId: number): Promise<ActionResult> {
    const { cdpSend } = await import("../platforms/web.js");
    const resp = await cdpSend(ws, "DOM.resolveNode", { backendNodeId });
    const objectId = (resp as any)?.result?.object?.objectId;
    if (!objectId) {
      return this.doClick(ws, backendNodeId);
    }
    await cdpSend(ws, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function() { this.click(); }",
    });
    return { success: true, message: "Toggled" };
  }

  private async doSelect(ws: unknown, backendNodeId: number): Promise<ActionResult> {
    const { cdpSend } = await import("../platforms/web.js");
    const resp = await cdpSend(ws, "DOM.resolveNode", { backendNodeId });
    const objectId = (resp as any)?.result?.object?.objectId;
    if (!objectId) {
      return this.doClick(ws, backendNodeId);
    }
    await cdpSend(ws, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        if (this.tagName === 'OPTION') {
          this.selected = true;
          if (this.parentElement) {
            this.parentElement.dispatchEvent(new Event('change', {bubbles: true}));
          }
        } else {
          this.click();
        }
      }`,
    });
    return { success: true, message: "Selected" };
  }

  private async doDismiss(ws: unknown): Promise<ActionResult> {
    const { cdpSend } = await import("../platforms/web.js");
    await cdpSend(ws, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
    });
    await cdpSend(ws, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
    });
    return { success: true, message: "Dismissed (Escape)" };
  }

  private async doArrowKey(
    ws: unknown,
    backendNodeId: number,
    key: string,
  ): Promise<ActionResult> {
    const { cdpSend } = await import("../platforms/web.js");
    await cdpSend(ws, "DOM.focus", { backendNodeId });
    await sleep(50);
    await cdpSend(ws, "Input.dispatchKeyEvent", { type: "keyDown", key, code: key });
    await cdpSend(ws, "Input.dispatchKeyEvent", { type: "keyUp", key, code: key });
    return { success: true, message: key === "ArrowUp" ? "Incremented" : "Decremented" };
  }

  // -- keyboard helpers ---------------------------------------------------

  private async sendKeyCombo(ws: unknown, combo: string): Promise<void> {
    const { cdpSend } = await import("../platforms/web.js");
    const [modifiers, keys] = parseCombo(combo);

    let modBits = 0;
    for (const mod of modifiers) {
      const info = CDP_MODIFIER_MAP[mod];
      if (info) modBits |= info.bit;
    }

    // Press modifiers down
    for (const mod of modifiers) {
      const info = CDP_MODIFIER_MAP[mod];
      if (info) {
        await cdpSend(ws, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: info.key,
          code: info.code,
          modifiers: modBits,
        });
      }
    }

    // Press and release main keys
    for (const key of keys) {
      const mapped = CDP_KEY_MAP[key];
      let cdpKey: string;
      let cdpCode: string;
      let text = "";

      if (mapped) {
        cdpKey = mapped.key;
        cdpCode = mapped.code;
      } else if (key.length === 1) {
        cdpKey = key;
        cdpCode = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : "";
        text = key;
      } else {
        continue;
      }

      const keyParams: Record<string, unknown> = {
        type: "keyDown",
        key: cdpKey,
        code: cdpCode,
        modifiers: modBits,
      };
      if (text && !modBits) keyParams.text = text;
      await cdpSend(ws, "Input.dispatchKeyEvent", keyParams);

      await cdpSend(ws, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: cdpKey,
        code: cdpCode,
        modifiers: modBits,
      });
    }

    // Release modifiers
    for (const mod of [...modifiers].reverse()) {
      const info = CDP_MODIFIER_MAP[mod];
      if (info) {
        await cdpSend(ws, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: info.key,
          code: info.code,
          modifiers: 0,
        });
      }
    }
  }
}
