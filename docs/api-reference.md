# API Reference

## Session

The primary interface for CUP. Captures accessibility trees and executes actions.

```typescript
import { Session } from "computeruseprotocol";

const session = await Session.create(platform?);
```

**Parameters:**
- `platform` (string | undefined) — Force a specific platform adapter (`"windows"`, `"macos"`, `"linux"`, `"web"`). Auto-detected if omitted.

---

### session.snapshot()

Capture the accessibility tree.

```typescript
const result = await session.snapshot({
    scope: "foreground",   // "overview" | "foreground" | "desktop" | "full"
    app: undefined,        // filter by window title (scope="full" only)
    maxDepth: 999,         // maximum tree depth
    compact: true,         // true → compact text, false → CUP envelope object
    detail: "compact",     // "compact" | "full"
});
```

**Scopes:**

| Scope | What it captures | Tree walking |
|-------|-----------------|-------------|
| `overview` | Window list only | No (near-instant) |
| `foreground` | Active window tree + window list header | Yes |
| `desktop` | Desktop surface (icons, widgets) | Yes |
| `full` | All windows | Yes |

**Returns:** `string` (compact text) or `CupEnvelope` (structured object), depending on `compact`.

**Detail levels:**

| Level | Behavior |
|-------|----------|
| `compact` | Prunes unnamed generics, empty text, decorative images (~75% smaller) |
| `full` | No pruning — every node included |

---

### session.action()

Execute an action on an element from the last snapshot.

```typescript
const result = await session.action("e14", "click");
const result = await session.action("e5", "type", { value: "hello world" });
const result = await session.action("e9", "scroll", { direction: "down" });
```

**Parameters:**
- `elementId` (string) — Element ID from the tree (e.g., `"e14"`). Only valid for the most recent snapshot.
- `actionName` (string) — One of the canonical actions below.
- `params` (object) — Action-specific parameters.

**Canonical actions:**

| Action | Parameters | Description |
|--------|-----------|-------------|
| `click` | — | Click/invoke the element |
| `collapse` | — | Collapse an expanded element |
| `decrement` | — | Decrement a slider/spinbutton |
| `dismiss` | — | Dismiss a dialog/popup |
| `doubleclick` | — | Double-click |
| `expand` | — | Expand a collapsed element |
| `focus` | — | Move keyboard focus to the element |
| `increment` | — | Increment a slider/spinbutton |
| `longpress` | — | Long-press (touch/mobile interaction) |
| `rightclick` | — | Right-click (context menu) |
| `scroll` | `direction: string` | Scroll container (`up`/`down`/`left`/`right`) |
| `select` | — | Select an item in a list/tree/tab |
| `setvalue` | `value: string` | Set element value programmatically |
| `toggle` | — | Toggle checkbox or switch |
| `type` | `value: string` | Type text into a field |

**Returns:** `ActionResult`

```typescript
interface ActionResult {
    success: boolean;
    message: string;
    error?: string;
}
```

---

### session.press()

Send a keyboard shortcut.

```typescript
const result = await session.press("ctrl+s");
const result = await session.press("alt+f4");
const result = await session.press("enter");
```

**Parameters:**
- `combo` (string) — Key combination. Modifiers: `ctrl`, `alt`, `shift`, `win`/`cmd`/`meta`. Joined with `+`.

---

### session.openApp()

Open an application by name with fuzzy matching.

```typescript
const result = await session.openApp("chrome");     // → Google Chrome
const result = await session.openApp("code");       // → Visual Studio Code
const result = await session.openApp("notepad");    // → Notepad
```

**Parameters:**
- `name` (string) — Application name (fuzzy matched against installed apps).

**Returns:** `ActionResult`. Waits for the app window to appear.

---

### session.find()

Search the last captured tree without re-capturing.

```typescript
const results = await session.find({ query: "play button" });
const results = await session.find({ role: "textbox", state: "focused" });
const results = await session.find({ name: "Submit" });
```

**Parameters:**
- `query` (string | undefined) — Freeform semantic query. Automatically parsed into role + name signals.
- `role` (string | undefined) — Role filter. Accepts CUP roles or synonyms (e.g., `"search bar"` matches `searchbox`/`textbox`).
- `name` (string | undefined) — Name filter with fuzzy token matching.
- `state` (string | undefined) — Exact state match (e.g., `"focused"`, `"disabled"`).
- `limit` (number) — Max results (default 10).

**Returns:** Array of CUP node objects (without children), ranked by relevance.

---

### session.batch()

Execute a sequence of actions, stopping on first failure.

```typescript
const results = await session.batch([
    { element_id: "e3", action: "click" },
    { action: "wait", ms: 500 },
    { element_id: "e7", action: "type", value: "hello" },
    { action: "press", keys: "enter" },
]);
```

**Action spec format:**

| Key | Required | Description |
|-----|----------|-------------|
| `action` | Yes | Action name |
| `element_id` | For element actions | Target element |
| `value` | For `type`/`setvalue` | Text value |
| `direction` | For `scroll` | Scroll direction |
| `keys` | For `press` | Key combination |
| `ms` | For `wait` | Delay in ms (50-5000) |

**Returns:** Array of `ActionResult` — stops at first failure.

---

### session.screenshot()

Capture a screenshot as a PNG buffer.

```typescript
const png = await session.screenshot();
const png = await session.screenshot({ x: 100, y: 200, w: 800, h: 600 });
```

**Parameters:**
- `region` (object | undefined) — Capture region `{ x, y, w, h }` in pixels. `undefined` for full primary monitor.

**Returns:** `Buffer` (PNG image data).

---

## Convenience Functions

Thin wrappers around a default `Session` instance. Useful for quick scripting.

```typescript
import { snapshot, snapshotRaw, overview } from "computeruseprotocol";

// Foreground window as compact text
const text = await snapshot();

// Foreground window as CUP envelope object
const envelope = await snapshotRaw();

// Window list only (no tree walking)
const text = await overview();
```

---

## CUP Envelope Format

The JSON envelope returned by `session.snapshot({ compact: false })`:

```json
{
    "version": "0.1.0",
    "platform": "windows",
    "timestamp": 1740067200000,
    "screen": { "w": 2560, "h": 1440, "scale": 1.0 },
    "scope": "foreground",
    "app": { "name": "Discord", "pid": 1234 },
    "tree": [ ... ]
}
```

### Node format

Each node in the tree:

```json
{
    "id": "e14",
    "role": "button",
    "name": "Submit",
    "bounds": { "x": 120, "y": 340, "w": 88, "h": 36 },
    "states": ["focused"],
    "actions": ["click"],
    "value": null,
    "children": [],
    "platform": { ... }
}
```

**Roles:** 54 ARIA-derived roles. See [schema/mappings.json](../schema/mappings.json) for the full list and per-platform mappings.

**States:** `busy`, `checked`, `collapsed`, `disabled`, `editable`, `expanded`, `focused`, `hidden`, `mixed`, `modal`, `multiselectable`, `offscreen`, `pressed`, `readonly`, `required`, `selected`

**Element actions:** `click`, `collapse`, `decrement`, `dismiss`, `doubleclick`, `expand`, `focus`, `increment`, `longpress`, `rightclick`, `scroll`, `select`, `setvalue`, `toggle`, `type`

**Session-level actions:** `press`

---

## Compact Format

The text format returned by `session.snapshot({ compact: true })`. Optimized for LLM context windows (~75% smaller than JSON).

```
# CUP 0.1.0 | windows | 2560x1440
# app: Discord
# 87 nodes (353 before pruning)

[e0] win "Discord" 509,62 1992x1274
  [e1] doc "General" 509,62 1992x1274 {ro}
    [e2] btn "Back" 518,66 26x24 [clk]
    [e7] tre "Servers" 509,94 72x1242
      [e8] ti "Lechownia" 513,190 64x48 {sel} [clk,sel]
```

Line format: `[id] role "name" x,y wxh {states} [actions] val="value" (attrs)`

Full spec: [compact.md](https://github.com/computeruseprotocol/computeruseprotocol/blob/main/schema/compact.md)

---

## MCP Server

CUP ships an MCP server for integration with AI agents (Claude, Copilot, etc.).

```bash
# Run directly
npx cup-mcp

# Or with bun
bun run src/mcp/cli.ts
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `snapshot` | Capture active window tree (compact) |
| `snapshot_app(app)` | Capture specific app by title |
| `overview` | Window list only (near-instant) |
| `snapshot_desktop` | Desktop surface (icons, widgets) |
| `find(query, role, name, state)` | Search last tree |
| `action(action, element_id, ...)` | Execute action on element or press keys |
| `open_app(name)` | Open app by name |
| `screenshot(region)` | Capture screenshot |

### Configuration

Add to your MCP client config (e.g., `.mcp.json` for Claude Code):

```json
{
    "mcpServers": {
        "cup": {
            "command": "npx",
            "args": ["cup-mcp"]
        }
    }
}
```

---

## PlatformAdapter

Interface for adding new platform support.

```typescript
import type { PlatformAdapter } from "computeruseprotocol";

class AndroidAdapter implements PlatformAdapter {
    platformName = "android";

    async initialize(): Promise<void> { ... }
    async getScreenInfo(): Promise<[number, number, number]> { ... }
    async getForegroundWindow(): Promise<WindowMetadata> { ... }
    async getAllWindows(): Promise<WindowMetadata[]> { ... }
    async getWindowList(): Promise<WindowInfo[]> { ... }
    async getDesktopWindow(): Promise<WindowMetadata | null> { ... }
    async captureTree(windows, options?): Promise<[CupNode[], object, Map<string, unknown>]> { ... }
}
```

See [src/base.ts](../src/base.ts) for the full interface with JSDoc comments.
