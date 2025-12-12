# simple-console-mcp

> Minimal MCP server for browser console log monitoring - **97% lighter** than chrome-devtools-mcp

## Why?

| Feature | chrome-devtools-mcp | simple-console-mcp |
|---------|---------------------|-------------------|
| Tools | 50+ | **3** |
| Context | ~5000 tokens | **~160 tokens** |
| Focus | Everything | Console logs only |

If you just want to see console errors, you don't need 50 tools eating your context.

## Quick Start

### 1. Start Chrome with CDP

```bash
# macOS
./bin/start-chrome.sh

# Or manually:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

### 2. Configure Claude Code / Claude Desktop

Add to your MCP settings:

```json
{
  "mcpServers": {
    "simple-console": {
      "command": "node",
      "args": ["/path/to/day-14-simple-console-mcp/src/index.js"]
    }
  }
}
```

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

## License

MIT
