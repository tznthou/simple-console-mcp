# Changelog

All notable changes to this project will be documented in this file.

## v1.5.0 (2026-04-15)

**New Features:**
- `get_network_logs` tool: Monitor HTTP requests/responses
  - Pull-based monitoring (same pattern as console logs)
  - Shows method, URL, status, duration, size
  - Filter by: all / failed / xhr / fetch / document / stylesheet / script / image
  - 200 entries cache per target
- `take_screenshot` tool: Capture page screenshots
  - Returns PNG image via MCP image content type
  - Auto-fallback to JPEG if PNG exceeds 500KB
  - Viewport clamped to 1280x800, deviceScaleFactor: 1
  - Optional `fullPage` mode

**Improvements:**
- Extracted `getTargetPage()` shared helper (reduces code duplication across tools)
- Navigation now clears both console and network caches
- Cleanup handler now removes network event listeners
- Repositioned from "97% lighter" to "6 tools vs 26+ with best signal-to-noise ratio"

**Security (GoGo pipeline):**
- Log injection: added `sanitizeLogString()` to strip newlines from external data (OWASP A09)
- Page title sanitization in navigate tool (OWASP A05)
- Private IP detection and warning in `validateUrl()` (OWASP A01)

**Code Quality (GoGo pipeline):**
- Codex Review: fixed network stale store bug, screenshot OOM timeout, viewport restore
- Simplify: extracted `finalizeEntry()`, `takeScreenshotWithTimeout()`, fixed `parseInt` NaN guard

## v1.4.0 (2025-12-17)

**New Features:**
- `execute_js` tool: Execute JavaScript in page context
  - Click buttons, fill forms, read DOM, call page functions
  - Safety measures: 5s timeout, 10K code limit, 50K result limit
- Simplified Chrome launch logic:
  - Directly launches debug Chrome with isolated profile (`/tmp/chrome-cdp-9222`)
  - Clear error message when regular Chrome conflicts with debug Chrome

**Improvements:**
- Removed automatic Chrome kill logic (user must close regular Chrome manually)
- Better error messages explaining Chrome conflict resolution

## v1.3.6 (2025-12-17)

**Security Hardening** (comprehensive code review):

| Issue | Severity | Fix |
|-------|----------|-----|
| URL Protocol Injection | Critical | Added `validateUrl()` allowing only `http://` and `https://` |
| Shell Command Injection | Critical | `start-chrome.sh` validates port must be integer 1024-65535 |
| Cleanup Race Condition | Critical | Added `isCleaningUp` flag, `uncaughtException` handler |
| Private API Dependency | High | `getTargetId()` prefers official API, falls back to `_targetId` |
| Incomplete Resource Cleanup | High | Added `browser.isConnected()` check before disconnect |
| Missing HTTP Warning | Medium | Non-localhost HTTP URLs now show security warning |
| Unlimited URL Length | Medium | Added `MAX_URL_LENGTH = 2048` limit |

## v1.3.1 (2025-12-13)

- Fixed `navigate` tool's `targetIndex` inconsistency with `list_targets`

## v1.3.0 (2025-12-13)

**Security Fixes:**

| Issue | Severity | Fix |
|-------|----------|-----|
| Command Injection | Critical | Added `validatePort()` |
| Race Condition | Critical | Used Promise lock |
| Resource Leak | Critical | Added `SIGINT/SIGTERM` handlers |

## v1.2.0 (2025-12-12)

- Auto-launched Chrome now uses isolated `user-data-dir`

## v1.1.0 (2025-12-12)

- Added auto-launch Chrome CDP feature

## v1.0.0 (2025-12-12)

- Initial release: `list_targets`, `get_console_logs`, `navigate`
