# simple-console-mcp

> 極簡 Console MCP - 瀏覽器除錯的最小單位
>
> Minimal MCP server for browser console log monitoring - **97% lighter** than chrome-devtools-mcp

## Why?

| Feature | chrome-devtools-mcp | simple-console-mcp |
|---------|---------------------|-------------------|
| Tools | 50+ | **3** |
| Context | ~5000 tokens | **~160 tokens** |
| Focus | Everything | Console logs only |

If you just want to see console errors, you don't need 50 tools eating your context.

## Installation

### Option 1: npm (Recommended)

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

## Quick Start

### 1. Start Chrome with CDP

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

### 2. Add MCP to your Claude settings

Choose one of the installation options above and add it to your MCP settings.

### 3. Use It

```
You: My webpage is broken
Claude: [calls list_targets]
Claude: [calls get_console_logs]
Claude: "I found an error at app.js:42..."
```

## Tools

### `list_targets`

List all browser tabs and service workers.

```javascript
// Input
{ port: 9222 }

// Output
Available targets:
[0] page: http://localhost:3000 (title: "My App")
[1] service_worker: chrome-extension://xxx/background.js
```

### `get_console_logs`

Get console output from a specific target.

```javascript
// Input
{
  targetIndex: 0,      // From list_targets
  maxLines: 50,        // Limit output
  filter: "error",     // all|error|warn|log|info|debug
  port: 9222
}

// Output
=== Console Logs for http://localhost:3000 ===
[12:34:56] ERROR: Uncaught TypeError: Cannot read property 'x' of undefined
(showing 1 of 50 total logs, filter: error)
```

### `navigate`

Navigate to URL or reload.

```javascript
// Input
{
  url: "http://localhost:3000/login",  // Or "reload"
  targetIndex: 0,
  port: 9222
}

// Output
Navigated to: http://localhost:3000/login
Page title: "Login"
(Console logs cleared)
```

## Extension Development

This MCP supports Chrome extension debugging:

```
[0] page: http://localhost:3000
[1] service_worker: chrome-extension://abc/background.js
[2] page: chrome-extension://abc/popup.html
```

Monitor multiple targets by calling `get_console_logs` with different `targetIndex`.

## Requirements

- Node.js 18+
- Chrome browser with `--remote-debugging-port` enabled

## License

Apache-2.0

## Author

- GitHub: [@tznthou](https://github.com/tznthou)
- Part of [muripo 30-day challenge](https://github.com/tznthou) - Day 14
