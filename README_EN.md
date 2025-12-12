# simple-console-mcp

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![npm](https://img.shields.io/npm/v/simple-console-mcp.svg)](https://www.npmjs.com/package/simple-console-mcp)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Protocol-8B5CF6.svg)](https://modelcontextprotocol.io/)

[← Back to Muripo HQ](https://tznthou.github.io/muripo-hq/)

> Minimal Console MCP — The smallest unit for browser debugging

[中文版](README.md)

---

## TL;DR

An extremely minimal MCP Server focused solely on browser Console Log monitoring. **97% lighter** than chrome-devtools-mcp (3 tools vs 50+), so your AI assistant won't consume a ton of context tokens while debugging.

| Comparison | chrome-devtools-mcp | simple-console-mcp |
|------------|---------------------|-------------------|
| Tools | 50+ | **3** |
| Context Cost | ~5000 tokens | **~160 tokens** |
| Focus | Full-featured | Console only |

---

## Why I Built This

This project started with a simple question: **"I just want to see Console Logs. Why do I need 50 tools?"**

chrome-devtools-mcp is powerful, but every time the AI calls a tool, it needs to understand all 50+ tools first. The tool descriptions alone consume a huge amount of context. For scenarios where you just want to quickly debug JavaScript errors, that's wasteful.

So I built this "**Minimum Viable MCP**":

- `list_targets` — List browser tabs
- `get_console_logs` — Read Console output
- `navigate` — Navigate or reload

Just three tools. Good enough.

The core goal of this MCP is to fully embrace the **subtraction principle** — achieve maximum effect with minimum functionality. It's also an application of the **80/20 rule**: if 80% of debugging scenarios only need Console Logs, why load 100% of the tools?

I believe this is probably the world's smallest MCP for Console Log monitoring. I'm quite proud of that. This was also my first time building an MCP tool, and through the process I learned how to publish packages to npm for anyone in the world to download. I'm not sure if others will adopt this tool, but at least it's very useful for me.

That said, this MCP might seem a bit pointless to non-Vibe Coders — real engineers already know how to read Console Logs themselves, no AI needed. So this is more of a practice project to gain experience. But hey, taking an idea from zero to publishing on npm is valuable in itself.

---

## Architecture

```mermaid
graph TB
    subgraph Client["AI Client"]
        CLAUDE["Claude Desktop<br/>or Claude Code"]
    end

    subgraph MCP["simple-console-mcp"]
        SERVER["MCP Server<br/>StdioTransport"]
        TOOLS["3 Tools<br/>list_targets | get_console_logs | navigate"]
        CACHE["Log Cache<br/>Map + WeakMap"]
    end

    subgraph Browser["Chrome Browser"]
        CDP["CDP Port 9222<br/>--remote-debugging-port"]
        PAGES["Browser Targets<br/>Pages | Service Workers"]
        CONSOLE["Console Events<br/>log | error | warn"]
    end

    CLAUDE --> |"MCP Protocol"| SERVER
    SERVER --> TOOLS
    TOOLS --> |"puppeteer-core"| CDP
    CDP --> PAGES
    PAGES --> |"console event"| CACHE
    CACHE --> |"formatted logs"| TOOLS
```

---

## Usage Flow

```mermaid
sequenceDiagram
    participant User as User
    participant AI as Claude
    participant MCP as simple-console-mcp
    participant Chrome as Chrome CDP

    User->>Chrome: Start Chrome --remote-debugging-port=9222
    User->>AI: "My webpage is broken"

    AI->>MCP: list_targets()
    MCP->>Chrome: Get all tabs
    Chrome-->>MCP: [0] localhost:3000, [1] google.com
    MCP-->>AI: Display tab list

    AI->>MCP: get_console_logs(targetIndex: 0)
    MCP->>Chrome: Listen to Console events
    Chrome-->>MCP: [ERROR] TypeError at app.js:42
    MCP-->>AI: Formatted log output

    AI-->>User: "The issue is in app.js line 42..."

    opt Need to reload
        AI->>MCP: navigate(url: "reload")
        MCP->>Chrome: page.reload()
        Chrome-->>MCP: Page reloaded
    end
```

---

## Installation

### Option 1: npm (Recommended)

Add to your Claude Desktop or Claude Code MCP settings:

```json
{
  "mcpServers": {
    "simple-console": {
      "command": "npx",
      "args": ["-y", "simple-console-mcp"]
    }
  }
}
```

### Option 2: GitHub URL

```json
{
  "mcpServers": {
    "simple-console": {
      "command": "npx",
      "args": ["-y", "github:tznthou/simple-console-mcp"]
    }
  }
}
```

### Option 3: Local Installation

```bash
git clone https://github.com/tznthou/simple-console-mcp.git
cd simple-console-mcp && npm install
```

```json
{
  "mcpServers": {
    "simple-console": {
      "command": "node",
      "args": ["/path/to/simple-console-mcp/src/index.js"]
    }
  }
}
```

---

## Starting Chrome CDP

### Auto-launch (v1.1.0+)

**No manual setup required!** The MCP automatically detects whether Chrome has CDP enabled:
- If CDP is already enabled → connects directly
- If not → **auto-launches** a new Chrome with CDP

Just install the MCP, and tell Claude "help me debug" — it handles everything automatically.

### Manual Start (Fallback)

If auto-launch fails, you can start Chrome manually:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

Or use the included convenience script:

```bash
./bin/start-chrome.sh
```

> **Note**: If you already have a "normal" Chrome open (without CDP), the MCP will launch a **new** Chrome window. You'll need to open the webpage you want to debug in that new window.

---

## Tools

### `list_targets`

List all available browser targets (pages, Service Workers, etc.).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `port` | number | 9222 | Chrome CDP port |

```
Available targets:
[0] page: http://localhost:3000 (title: "My App")
[1] service_worker: chrome-extension://xxx/background.js
[2] page: chrome-extension://xxx/popup.html
```

### `get_console_logs`

Get Console output from a specific target. Starts monitoring on first call.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `targetIndex` | number | 0 | Target index from list_targets |
| `maxLines` | number | 50 | Maximum lines to return |
| `filter` | string | "all" | Filter type: all / error / warn / log / info / debug |
| `port` | number | 9222 | Chrome CDP port |

```
=== Console Logs for http://localhost:3000 ===
[12:34:56] ERROR: Uncaught TypeError: Cannot read property 'x' of undefined
[12:34:57] WARN: Deprecation warning...
(showing 2 of 50 total logs, filter: all)
```

### `navigate`

Navigate to a URL or reload the page.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | - | Target URL or "reload" |
| `targetIndex` | number | 0 | Target index |
| `port` | number | 9222 | Chrome CDP port |

```
Navigated to: http://localhost:3000/login
Page title: "Login"
(Console logs cleared)
```

---

## Chrome Extension Development

This MCP supports monitoring Console output from Chrome Extensions:

```
[0] page: http://localhost:3000           ← Regular webpage
[1] service_worker: chrome-extension://abc/background.js  ← Extension background script
[2] page: chrome-extension://abc/popup.html               ← Extension popup
```

Use different `targetIndex` values to monitor each target separately.

---

## How It Works: Pull-based

```
Claude calls get_console_logs → MCP returns accumulated logs → Claude processes
         ↑                                                        |
         └──────────────── Claude must call again ────────────────┘
```

**Behavior**:
1. On first `get_console_logs` call, MCP starts monitoring that target
2. Console events are continuously collected in memory (max 500 entries)
3. **Claude does NOT receive automatic notifications** — must call `get_console_logs` again to see new logs

> **Why Pull-based?**
> MCP protocol is request-response based and doesn't support push notifications. The server cannot proactively tell Claude "there's a new error" — Claude must actively ask.

### Real Usage Example

```
You: "Help me debug this page"
Claude: [calls list_targets]
Claude: [calls get_console_logs]
Claude: "No errors found, the page looks fine."

You: "I clicked that button and the page broke"
Claude: [calls get_console_logs again]  ← needs your prompt to check again
Claude: "Found new error: TypeError at app.js:42..."
```

---

## Tech Stack

| Technology | Purpose |
|------------|---------|
| Node.js 18+ | Runtime |
| ES Modules | Module system |
| @modelcontextprotocol/sdk | MCP protocol implementation |
| puppeteer-core | Chrome CDP connection (no bundled Chromium) |
| zod | Parameter validation |

---

## Project Structure

```
simple-console-mcp/
├── src/
│   └── index.js        # MCP Server main code (~200 lines)
├── bin/
│   └── start-chrome.sh # Chrome startup script
├── package.json
├── README.md           # Chinese docs
├── README_EN.md        # English docs
└── LICENSE             # Apache-2.0
```

---

## Requirements

| Item | Requirement |
|------|-------------|
| Node.js | 18+ |
| Chrome | Any version with `--remote-debugging-port` enabled |
| OS | macOS / Linux / Windows |

---

## Notes

1. **Chrome must have CDP enabled**: Chrome without `--remote-debugging-port` cannot be connected
2. **One Chrome at a time**: If multiple Chrome instances exist, MCP connects to the first one
3. **Log cache limit**: Each target keeps at most 500 logs, older ones are automatically removed
4. **Navigation clears logs**: Calling navigate clears the target's log cache

---

## License

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

This project is licensed under the [Apache License 2.0](LICENSE).

---

## Author

- GitHub: [@tznthou](https://github.com/tznthou)
