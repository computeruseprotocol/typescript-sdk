/**
 * Shared key combo parsing and normalization.
 *
 * Ported from python-sdk/cup/actions/_keys.py
 */

export const MODIFIERS = new Set(["ctrl", "alt", "shift", "win", "cmd", "meta", "super"]);

const ALIASES: Record<string, string> = {
  return: "enter",
  esc: "escape",
  del: "delete",
  bs: "backspace",
  cmd: "meta",
  super: "meta",
  win: "meta",
  pgup: "pageup",
  pgdn: "pagedown",
  pgdown: "pagedown",
};

/**
 * Parse a key combo string into [modifiers, keys].
 *
 * Examples:
 *   parseCombo("ctrl+s")        → [["ctrl"], ["s"]]
 *   parseCombo("ctrl+shift+p")  → [["ctrl", "shift"], ["p"]]
 *   parseCombo("enter")         → [[], ["enter"]]
 */
export function parseCombo(combo: string): [string[], string[]] {
  const parts = combo
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);

  const modifiers: string[] = [];
  const keys: string[] = [];

  for (const part of parts) {
    const normalized = ALIASES[part] ?? part;
    if (["ctrl", "alt", "shift", "meta"].includes(normalized)) {
      modifiers.push(normalized);
    } else {
      keys.push(normalized);
    }
  }

  return [modifiers, keys];
}
