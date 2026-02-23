<p align="center">
  <a href="https://computeruseprotocol.com">
    <img src="assets/banner.png" alt="Computer Use Protocol">
  </a>
</p>

<p align="center">
  <b>TypeScript SDK for the Computer Use Protocol</b>
</p>

<br>

<p align="center">
  <a href="https://www.npmjs.com/package/computer-use-protocol"><img src="https://img.shields.io/npm/v/computer-use-protocol?style=for-the-badge&color=FF6F61&labelColor=000000" alt="npm"></a>
  <a href="https://github.com/computeruseprotocol/typescript-sdk/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-0cc0df?style=for-the-badge&labelColor=000000" alt="MIT License"></a>
  <a href="https://github.com/computeruseprotocol/computer-use-protocol"><img src="https://img.shields.io/badge/Spec-computer--use--protocol-7ed957?style=for-the-badge&labelColor=000000" alt="Spec"></a>
</p>

The official TypeScript SDK for the [Computer Use Protocol (CUP)](https://github.com/computeruseprotocol/computer-use-protocol) — a universal protocol for AI agents to perceive and interact with any desktop UI. This package provides tree capture, action execution, semantic search, and an MCP server for AI agent integration.

## Installation

```bash
# npm
npm install computer-use-protocol

# bun
bun add computer-use-protocol
```

## Quick start

```typescript
import { getTree, getForegroundTree, getCompact } from "computer-use-protocol";

// Full accessibility tree as a CUP envelope
const envelope = await getTree();

// Just the foreground window
const foreground = await getForegroundTree();

// Compact text format — optimized for LLM context windows
const text = await getCompact();
console.log(text);
```

Output (compact format):

```
# CUP 0.1.0 | windows | 2560x1440
# app: Discord
# 87 nodes (353 before pruning)

[e0] window "Discord" @509,62 1992x1274
    [e1] document "General | Lechownia" @509,62 1992x1274 {readonly}
        [e2] button "Back" @518,66 26x24 [click]
        [e3] button "Forward" @546,66 26x24 {disabled} [click]
        [e7] tree "Servers" @509,94 72x1242
            [e8] treeitem "Lechownia" @513,190 64x48 {selected} [click,select]
```

### Session API

```typescript
import { Session } from "computer-use-protocol";

const session = await Session.create();

// Capture the foreground window
const result = await session.capture({ scope: "foreground" });
console.log(result.compact);

// Execute actions
await session.execute("e8", "click");
await session.pressKeys("ctrl+s");
await session.launchApp("notepad");

// Semantic search
const elements = await session.findElements({ query: "submit button" });

// Batch actions
await session.batchExecute([
  { element_id: "e2", action: "click" },
  { action: "wait", ms: 500 },
  { action: "press_keys", keys: "ctrl+a" },
  { element_id: "e5", action: "type", value: "hello" },
]);
```

## CLI

```bash
# Print compact tree of the foreground window
npx cup --scope foreground --compact

# Save full JSON envelope
npx cup --json-out tree.json

# Filter by app name
npx cup --app Discord --compact

# Capture from Chrome via CDP
npx cup --platform web --cdp-port 9222 --compact
```

## Platform support

| Platform | Adapter | Tree Capture | Actions |
|----------|---------|-------------|---------|
| Windows | UIA via PowerShell + C# | Stable | Stable |
| macOS | AXUIElement via Swift + JXA | Stable | Stable |
| Linux | AT-SPI2 via gdbus + xdotool | Stable | Stable |
| Web | Chrome DevTools Protocol | Stable | Stable |
| Android | | Planned | Planned |
| iOS | | Planned | Planned |

CUP auto-detects your platform. The Web adapter uses Chrome DevTools Protocol (CDP) and works on any OS. Native adapters use platform accessibility APIs via compiled helpers (C# on Windows, Swift on macOS, gdbus on Linux).

## Architecture

```
src/
├── index.ts                    # Public API: Session, getTree, getCompact, ...
├── types.ts                    # CUP type definitions
├── cli.ts                      # CLI entry point
├── base.ts                     # Abstract PlatformAdapter interface
├── router.ts                   # Platform detection & adapter dispatch
├── format.ts                   # Envelope builder, compact serializer, tree pruning
├── search.ts                   # Semantic element search with fuzzy matching
├── actions/                    # Action execution layer
│   ├── executor.ts             # ActionExecutor orchestrator
│   ├── keys.ts                 # Key combo parsing
│   ├── web.ts                  # Chrome CDP actions
│   ├── windows.ts              # Windows UIA + SendInput actions
│   ├── macos.ts                # macOS AX + CGEvent actions
│   └── linux.ts                # Linux AT-SPI2 + xdotool actions
├── platforms/                  # Platform-specific tree capture
│   ├── web.ts                  # Chrome CDP adapter
│   ├── windows.ts              # Windows UIA adapter
│   ├── macos.ts                # macOS AXUIElement adapter
│   └── linux.ts                # Linux AT-SPI2 adapter
└── mcp/                        # MCP server integration
    ├── server.ts               # MCP protocol server
    └── cli.ts                  # Stdio transport entry point
```

Adding a new platform means implementing `PlatformAdapter` — see [src/base.ts](src/base.ts) for the interface.

## MCP Server

CUP ships an MCP server for integration with AI agents (Claude, Copilot, etc.).

```bash
# Run directly
npx cup-mcp

# Or with bun
bun run src/mcp/cli.ts
```

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

**Tools:** `get_foreground`, `get_tree`, `get_overview`, `get_desktop`, `find_element`, `execute_action`, `launch_app`, `screenshot`

## Contributing

CUP is in early development (v0.1.0). Contributions welcome — especially:

- Android adapter (`src/platforms/android.ts`)
- iOS adapter (`src/platforms/ios.ts`)
- Tests — especially cross-platform integration tests
- Documentation and examples

For protocol or schema changes, please contribute to [computer-use-protocol](https://github.com/computeruseprotocol/computer-use-protocol).

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and guidelines.

## Documentation

- **[API Reference](docs/api-reference.md)** — Session API, actions, envelope format, MCP server
- **[Protocol Specification](https://github.com/computeruseprotocol/computer-use-protocol)** — Schema, roles, states, actions, compact format

## License

[MIT](LICENSE)
