# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-02-23

Initial release. TypeScript implementation of the [Computer Use Protocol](https://github.com/computeruseprotocol/computer-use-protocol).

### Added
- **Platform adapters** for tree capture:
  - Windows (UIA via PowerShell + C#)
  - macOS (AXUIElement via Swift + JXA)
  - Linux (AT-SPI2 via gdbus + xdotool)
  - Web (Chrome DevTools Protocol)
- **Action execution** on all four platforms (Windows, macOS, Linux, Web)
- **MCP server** (`cup-mcp`) for AI agent integration
- **Semantic search engine** with fuzzy matching and role synonyms
- **Viewport-aware pruning** that clips offscreen nodes
- **Session API** with `snapshot()`, `action()`, `press()`, `find()`, `batch()`, and `screenshot()`
- **CLI** (`cup`) for tree capture, JSON export, and compact output
- **Dual build** — ESM and CommonJS with TypeScript declarations

[0.1.0]: https://github.com/computeruseprotocol/typescript-sdk/releases/tag/v0.1.0
