/**
 * CUP MCP Server — Computer Use Protocol tools for AI agents.
 *
 * Exposes tools for UI tree capture, element search, action execution,
 * and screenshots.
 *
 * Ported from python-sdk/cup/mcp/server.py
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Session } from "../index.js";
import { formatLine } from "../format.js";

export const server = new McpServer({
  name: "cup",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

let _session: Session | null = null;

async function getSession(): Promise<Session> {
  if (!_session) {
    _session = await Session.create();
  }
  return _session;
}

// ---------------------------------------------------------------------------
// Tree capture tools
// ---------------------------------------------------------------------------

server.tool(
  "snapshot",
  `Capture the foreground (active) window's accessibility tree.

Returns a structured text representation where each UI element has an ID
(e.g., 'e14') that can be used with the action tool. The format shows:

    [id] role "name" @x,y wxh {states} [actions] val="value"

Indentation shows the element hierarchy.

Also includes a window list in the header showing all open apps.
This is the primary tool for interacting with the current app's UI.

Element IDs are ephemeral — they are only valid for THIS snapshot.
After executing any action, you MUST call this again for fresh IDs.`,
  {},
  async () => {
    const session = await getSession();
    const result = await session.snapshot({
      scope: "foreground",
      maxDepth: 999,
      compact: true,
      detail: "standard",
    });
    return { content: [{ type: "text", text: result as string }] };
  },
);

server.tool(
  "snapshot_app",
  `Capture a specific app's window accessibility tree by title.

Use this when you need to interact with a window that is NOT in the
foreground, or when you know the exact app you want by name.

The 'app' parameter is a case-insensitive substring match against
window titles (e.g., "Spotify", "Firefox", "VS Code").

Element IDs are ephemeral — only valid for THIS snapshot.`,
  { app: z.string().describe("Target app by window title (case-insensitive substring match)") },
  async ({ app }) => {
    const session = await getSession();
    const result = await session.snapshot({
      scope: "full",
      app,
      maxDepth: 999,
      compact: true,
      detail: "standard",
    });
    return { content: [{ type: "text", text: result as string }] };
  },
);

server.tool(
  "snapshot_desktop",
  `Capture the desktop surface (icons, widgets, shortcuts).

Use this to see and interact with desktop items. Falls back to a
window overview if the platform has no desktop concept.

Element IDs are ephemeral — only valid for THIS snapshot.`,
  {},
  async () => {
    const session = await getSession();
    const result = await session.snapshot({
      scope: "desktop",
      maxDepth: 999,
      compact: true,
      detail: "standard",
    });
    return { content: [{ type: "text", text: result as string }] };
  },
);

server.tool(
  "overview",
  `List all open windows. Near-instant, no tree walking.

Returns a lightweight window list showing app names, PIDs, and bounds.
No element IDs are returned (no tree walking is performed).

Use this to quickly discover what apps are open before targeting
a specific one with snapshot_app(app='...').`,
  {},
  async () => {
    const session = await getSession();
    const result = await session.snapshot({ scope: "overview", compact: true });
    return { content: [{ type: "text", text: result as string }] };
  },
);

// ---------------------------------------------------------------------------
// Action tools
// ---------------------------------------------------------------------------

server.tool(
  "action",
  `Execute an action on a UI element or send a keyboard shortcut.

IMPORTANT: Element IDs are only valid from the most recent snapshot.
After executing any action, re-capture for fresh IDs.

Element actions (require element_id):
    click, rightclick, doubleclick, toggle, type, setvalue,
    select, expand, collapse, scroll, increment, decrement, focus

Keyboard shortcut (no element_id needed):
    press — pass combo in 'keys' (e.g., "ctrl+s", "enter")`,
  {
    action: z.string().describe("The action to perform"),
    element_id: z.string().optional().describe("Element ID from the tree (e.g., 'e14')"),
    value: z.string().optional().describe("Text for 'type' or 'setvalue' actions"),
    direction: z.string().optional().describe("Direction for 'scroll' (up/down/left/right)"),
    keys: z.string().optional().describe("Key combination for 'press' (e.g., 'ctrl+s')"),
  },
  async ({ action, element_id, value, direction, keys }) => {
    const session = await getSession();

    if (action === "press") {
      if (!keys) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                message: "",
                error: "press action requires the 'keys' parameter (e.g., keys='ctrl+s').",
              }),
            },
          ],
        };
      }
      const result = await session.press(keys);
      return {
        content: [
          { type: "text", text: JSON.stringify({ success: result.success, message: result.message, error: result.error }) },
        ],
      };
    }

    if (!element_id) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              message: "",
              error: `Action '${action}' requires the 'element_id' parameter.`,
            }),
          },
        ],
      };
    }

    const params: Record<string, unknown> = {};
    if (value !== undefined) params.value = value;
    if (direction !== undefined) params.direction = direction;

    const result = await session.action(element_id, action, params);
    return {
      content: [
        { type: "text", text: JSON.stringify({ success: result.success, message: result.message, error: result.error }) },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Open app tool
// ---------------------------------------------------------------------------

server.tool(
  "open_app",
  `Open an application by name.

Fuzzy-matches the name against installed apps on the system.
Examples: "chrome" → Google Chrome, "code" → Visual Studio Code.

After opening, use snapshot() to capture the new app's UI tree.`,
  {
    name: z.string().describe("Application name to open (fuzzy matched)"),
  },
  async ({ name }) => {
    const session = await getSession();
    const result = await session.openApp(name);
    return {
      content: [
        { type: "text", text: JSON.stringify({ success: result.success, message: result.message, error: result.error }) },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Search tool
// ---------------------------------------------------------------------------

server.tool(
  "find",
  `Search the last captured tree for elements matching criteria.

Searches the FULL tree with semantic matching and relevance ranking.
If no tree has been captured yet, auto-captures the foreground window.

QUERY MODE (recommended):
    Pass a freeform query describing what you're looking for.
    Examples: "the play button", "search input", "volume slider"

STRUCTURED MODE:
    Pass explicit role, name, and/or state filters.

Both modes can be combined: query + state="focused" narrows to focused elements.`,
  {
    query: z.string().optional().describe("Freeform semantic query"),
    role: z.string().optional().describe("Filter by role"),
    name: z.string().optional().describe("Filter by name (fuzzy)"),
    state: z.string().optional().describe("Filter by state (exact)"),
  },
  async ({ query, role, name, state }) => {
    if (!query && !role && !name && !state) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              message: "",
              error: "At least one search parameter (query, role, name, or state) must be provided.",
            }),
          },
        ],
      };
    }

    const session = await getSession();
    const matches = await session.find({ query, role, name, state });

    if (matches.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, message: "No matching elements found.", matches: 0 }),
          },
        ],
      };
    }

    const lines = matches.map((node) => formatLine(node));
    const text = [
      `# ${matches.length} match${matches.length !== 1 ? "es" : ""} found`,
      "",
      ...lines,
    ].join("\n") + "\n";
    return { content: [{ type: "text", text }] };
  },
);

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

server.tool(
  "screenshot",
  `Capture a screenshot of the screen and return it as a PNG image.

By default captures the full primary monitor. Optionally specify a
region to capture only part of the screen.

Use this alongside tree capture tools when you need visual context.`,
  {
    region_x: z.number().optional().describe("Left edge of capture region in pixels"),
    region_y: z.number().optional().describe("Top edge of capture region in pixels"),
    region_w: z.number().optional().describe("Width of capture region in pixels"),
    region_h: z.number().optional().describe("Height of capture region in pixels"),
  },
  async ({ region_x, region_y, region_w, region_h }) => {
    const regionParams = [region_x, region_y, region_w, region_h];
    const hasAny = regionParams.some((v) => v !== undefined);
    const hasAll = regionParams.every((v) => v !== undefined);

    if (hasAny && !hasAll) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              message: "",
              error: "All region parameters must be provided together, or none at all.",
            }),
          },
        ],
      };
    }

    const region =
      hasAll
        ? { x: region_x!, y: region_y!, w: region_w!, h: region_h! }
        : undefined;

    const session = await getSession();
    try {
      const pngBytes = await session.screenshot(region);
      return {
        content: [
          { type: "image", data: pngBytes.toString("base64"), mimeType: "image/png" },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, message: "", error: err.message ?? String(err) }),
          },
        ],
      };
    }
  },
);
