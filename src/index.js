#!/usr/bin/env node
/**
 * simple-console-mcp - Minimal MCP server for browser console log monitoring
 * Lightweight alternative to chrome-devtools-mcp (6 tools vs 26+)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import puppeteer from 'puppeteer-core';
import { z } from 'zod';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// 從 package.json 讀取版本號，確保版本一致
const require = createRequire(import.meta.url);
const { version } = require('../package.json');

// === Constants ===
const CHROME_STARTUP_DELAY_MS = 2000;
const MAX_LOGS_PER_TARGET = 500;
const DEFAULT_MAX_LINES = 50;
const DEFAULT_CDP_PORT = 9222;
const ALLOWED_TARGET_TYPES = new Set(['page', 'service_worker', 'background_page']);
const PAGE_LOAD_WAIT_UNTIL = 'domcontentloaded';  // 頁面載入等待策略
const MAX_URL_LENGTH = 2048;  // URL 長度限制，防止 DoS
const MAX_NETWORK_LOGS_PER_TARGET = 200;
const DEFAULT_MAX_NETWORK_LINES = 50;
const SCREENSHOT_MAX_WIDTH = 1280;
const SCREENSHOT_MAX_HEIGHT = 800;
const SCREENSHOT_MAX_BYTES = 500 * 1024;  // 500KB base64 limit
const SCREENSHOT_TIMEOUT = 10000;  // 截圖超時（毫秒）

// === Global State ===
let browser = null;
let connectionPromise = null;  // 防止並行連線的 Promise lock
const logsCache = new Map();   // targetId (Puppeteer internal ID) -> logs[]
const pageCache = new Map();   // targetId (Puppeteer internal ID) -> page
const networkCache = new Map();      // targetId -> { requests: Map<id, entry>, order: string[] }
const requestEntryMap = new WeakMap(); // HTTPRequest -> entry（用於事件間關聯同一請求）

/**
 * 取得 target 的穩定 ID（不會隨 URL 改變）
 * @param {Target} target - Puppeteer Target 物件
 * @returns {string} 穩定的 target ID
 */
function getTargetId(target) {
  // 優先使用官方 API（Puppeteer 20+），fallback 到內部屬性
  // 這樣即使 Puppeteer 移除 _targetId，只要有官方 API 就能正常運作
  if (typeof target.targetId === 'function') {
    return target.targetId();
  }
  // Fallback: 使用內部屬性（較舊版本）
  if (target._targetId) {
    return target._targetId;
  }
  // 最後手段：使用 URL（但會隨導航改變，不推薦）
  return target.url();
}

// === Helper Functions ===

/**
 * 驗證 CDP port 參數，防止命令注入和路徑遍歷
 * @param {number} port - 使用者傳入的 port
 * @returns {number} 驗證後的 port（整數）
 * @throws {Error} 如果 port 不合法
 */
function validatePort(port) {
  const portNum = parseInt(port, 10);
  if (!Number.isInteger(portNum) || portNum < 1024 || portNum > 65535) {
    throw new Error(`Invalid port: ${port}. Must be integer between 1024-65535`);
  }
  return portNum;
}

/**
 * 驗證 URL 參數，防止 javascript: 和 file:// 協議注入
 * @param {string} url - 使用者傳入的 URL
 * @returns {{url: string, isHttp: boolean}} 驗證後的 URL 和是否為 HTTP
 * @throws {Error} 如果 URL 協議不合法或長度超限
 */
function validateUrl(url) {
  // 允許 "reload" 特殊指令
  if (url.toLowerCase() === 'reload') {
    return { url, isHttp: false };
  }

  // 檢查 URL 長度，防止 DoS
  if (url.length > MAX_URL_LENGTH) {
    throw new Error(`URL too long. Maximum ${MAX_URL_LENGTH} characters allowed.`);
  }

  // 只允許 http:// 和 https:// 協議
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Invalid URL protocol. Only http:// and https:// are allowed. Got: ${url.substring(0, 50)}`);
  }

  // 檢查是否為非 localhost 的 HTTP（用於警告）
  const isHttp = /^http:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|::1)(:|\/|$)/i.test(url);

  // 檢查是否為私有/內部 IP（SSRF 風險提示，不阻擋因為這是本機除錯工具）
  let isPrivateIp = false;
  try {
    const parsed = new URL(url);
    isPrivateIp = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(parsed.hostname);
  } catch {
    // URL 解析失敗時忽略
  }

  return { url, isHttp, isPrivateIp };
}

/**
 * 建立統一的錯誤回應格式
 * @param {string} message - 錯誤訊息
 * @returns {Object} MCP 錯誤回應物件
 */
function createErrorResponse(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }] };
}

/**
 * 清理外部來源的字串，移除換行符防止 log injection
 * @param {string} s - 外部來源的字串（page title, console text, error message 等）
 * @returns {string} 清理後的字串
 */
function sanitizeLogString(s) {
  if (typeof s !== 'string') return String(s);
  return s.replace(/[\r\n]/g, ' ').substring(0, 500);
}

function getChromePath() {
  switch (process.platform) {
    case 'darwin':
      return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    case 'win32':
      return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    default:
      return 'google-chrome';
  }
}

async function launchChrome(port) {
  // port 已在 ensureConnection 驗證過，這裡直接使用
  const chromePath = getChromePath();

  // 在 macOS 和 Windows 上檢查 Chrome 執行檔是否存在
  // Linux 上 'google-chrome' 是命令，由 PATH 解析，無法用 existsSync 檢查
  if (process.platform !== 'linux' && !existsSync(chromePath)) {
    throw new Error(`Chrome executable not found at: ${chromePath}\nPlease install Google Chrome or check the installation path.`);
  }

  const userDataDir = join(tmpdir(), `chrome-cdp-${port}`);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check'
  ];

  spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore'
  }).unref();

  // Wait for Chrome to start
  await new Promise(resolve => setTimeout(resolve, CHROME_STARTUP_DELAY_MS));
}

async function ensureConnection(port) {
  // 驗證 port 防止命令注入和路徑遍歷
  const validPort = validatePort(port);

  // 如果已連線，直接回傳
  if (browser && browser.isConnected()) return browser;

  // 如果有其他連線正在進行，等待它完成（防止 Race Condition）
  if (connectionPromise) {
    return connectionPromise;
  }

  // 建立連線 Promise lock
  connectionPromise = (async () => {
    try {
      // 再次檢查（可能在等待期間已連線）
      if (browser && browser.isConnected()) return browser;

      // First attempt: try to connect to existing Chrome
      try {
        browser = await puppeteer.connect({ browserURL: `http://localhost:${validPort}` });
        return browser;
      } catch (err) {
        // No Chrome with CDP found, try to launch one
      }

      // Second attempt: launch Chrome and retry
      await launchChrome(validPort);
      browser = await puppeteer.connect({ browserURL: `http://localhost:${validPort}` });
      return browser;
    } catch (err) {
      // 保留原始錯誤訊息以便調試
      const originalError = err.message || String(err);

      // 如果是我們自己拋出的明確錯誤，直接傳遞
      if (originalError.includes('Cannot launch Chrome') || originalError.includes('Chrome executable not found')) {
        throw err;
      }

      // 否則提供更友好的錯誤訊息
      throw new Error(
        `Cannot connect to Chrome CDP (port ${validPort}).\n\n` +
        `Most likely cause: A regular Chrome browser is already running.\n` +
        `When Chrome is already open, new instances merge into the existing one,\n` +
        `preventing debug mode from starting.\n\n` +
        `Solution: Close all Chrome windows (Cmd+Q on macOS, or close from Task Manager on Windows),\n` +
        `then try again. The MCP will automatically launch Chrome in debug mode.\n\n` +
        `Other possible causes:\n` +
        `- Another application is using port ${validPort}\n` +
        `- Firewall or antivirus blocking the connection\n\n` +
        `Original error: ${originalError}`
      );
    } finally {
      // 無論成功失敗，都釋放 lock
      connectionPromise = null;
    }
  })();

  return connectionPromise;
}

function setupLogListener(page, targetId) {
  if (logsCache.has(targetId)) return;
  logsCache.set(targetId, []);
  page.on('console', msg => {
    const logs = logsCache.get(targetId);
    logs.push({
      time: new Date().toISOString(),  // 使用 ISO 8601 格式，跨時區一致
      type: msg.type().toUpperCase(),
      text: msg.text()
    });
    // Keep only last N logs to prevent memory bloat
    if (logs.length > MAX_LOGS_PER_TARGET) logs.shift();
  });
}

function setupNetworkListener(page, targetId) {
  if (networkCache.has(targetId)) return;

  const store = { requests: new Map(), order: [] };
  networkCache.set(targetId, store);

  page.on('request', (request) => {
    const entry = {
      method: request.method(),
      url: request.url().substring(0, 500),
      resourceType: request.resourceType(),
      status: null,
      contentType: '',
      size: null,
      duration: null,
      error: null,
      startTime: Date.now(),
      endTime: null,
    };
    const id = `${entry.startTime}-${store.order.length}`;
    store.requests.set(id, entry);
    store.order.push(id);
    requestEntryMap.set(request, entry);

    // Evict oldest entries
    while (store.order.length > MAX_NETWORK_LOGS_PER_TARGET) {
      const oldest = store.order.shift();
      store.requests.delete(oldest);
    }
  });

  function finalizeEntry(entry) {
    entry.endTime = Date.now();
    entry.duration = entry.endTime - entry.startTime;
  }

  page.on('requestfinished', (request) => {
    const entry = requestEntryMap.get(request);
    const response = request.response();
    if (entry && response) {
      entry.status = response.status();
      entry.contentType = response.headers()['content-type'] || '';
      finalizeEntry(entry);
      const contentLength = parseInt(response.headers()['content-length'], 10);
      if (!Number.isNaN(contentLength)) entry.size = contentLength;
    }
  });

  page.on('requestfailed', (request) => {
    const entry = requestEntryMap.get(request);
    if (entry) {
      const failure = request.failure();
      entry.error = failure ? failure.errorText : 'Unknown error';
      finalizeEntry(entry);
    }
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

function formatNetworkLogs(store, maxLines, filter) {
  let entries = store.order.map(id => store.requests.get(id)).filter(Boolean);
  const totalCount = entries.length;

  if (filter !== 'all') {
    if (filter === 'failed') {
      entries = entries.filter(e => e.error || (e.status && e.status >= 400));
    } else {
      entries = entries.filter(e => e.resourceType === filter);
    }
  }
  const filteredCount = entries.length;
  const recent = entries.slice(-maxLines);

  const text = recent.map(e => {
    const status = e.error ? 'FAILED' : (e.status || 'PENDING');
    const duration = e.duration !== null ? `${e.duration}ms` : '...';
    const size = e.size ? formatBytes(e.size) : '';
    return `[${e.method}] ${status} ${e.url} (${duration}${size ? ', ' + size : ''})${e.error ? ' Error: ' + sanitizeLogString(e.error) : ''}`;
  }).join('\n');

  return { text, displayedCount: recent.length, filteredCount, totalCount };
}

function formatLogs(logs, maxLines, filter) {
  let filtered = logs;
  if (filter !== 'all') {
    filtered = logs.filter(log => log.type.toLowerCase() === filter);
  }
  const recent = filtered.slice(-maxLines);
  const text = recent.map(log => `[${log.time}] ${log.type}: ${sanitizeLogString(log.text)}`).join('\n');

  return {
    text,
    displayedCount: recent.length,
    filteredCount: filtered.length,
    totalCount: logs.length
  };
}

/**
 * 共用的 target page 取得邏輯
 * @param {number} targetIndex - target 索引
 * @param {number} port - CDP port
 * @param {Object} options
 * @param {boolean} options.pageOnly - 是否限定只能操作 page 類型
 * @returns {Promise<{page, targetId, displayUrl} | {error: string}>}
 */
async function getTargetPage(targetIndex, port, { pageOnly = false } = {}) {
  const b = await ensureConnection(port);
  const targets = b.targets().filter(t => ALLOWED_TARGET_TYPES.has(t.type()));

  if (targetIndex >= targets.length) {
    return { error: `Target index ${targetIndex} not found. Use list_targets to see available targets.` };
  }

  const target = targets[targetIndex];

  if (pageOnly && target.type() !== 'page') {
    return { error: `Target [${targetIndex}] is a ${target.type()}, not a page. This operation requires a page target.` };
  }

  const targetId = getTargetId(target);
  const displayUrl = target.url();

  let page = pageCache.get(targetId);
  if (!page) {
    page = await target.page();
    if (!page) {
      return { error: `Cannot get page for target ${targetIndex}. It might be a non-page target.` };
    }
    pageCache.set(targetId, page);
    setupLogListener(page, targetId);
    setupNetworkListener(page, targetId);
  }

  return { page, targetId, displayUrl };
}

// === MCP Server Setup ===
const server = new McpServer({
  name: 'simple-console-mcp',
  version  // 自動從 package.json 讀取，永不失同步
});

// === Tool 1: list_targets ===
server.registerTool(
  'list_targets',
  {
    title: 'List Browser Targets',
    description: 'List all available browser targets (pages, service workers, etc.)',
    inputSchema: {
      port: z.number().int().min(1024).max(65535).default(DEFAULT_CDP_PORT).describe('Chrome CDP port')
    }
  },
  async ({ port }) => {
    try {
      const b = await ensureConnection(port);
      const targets = b.targets();

      const formatted = targets
        .filter(t => ALLOWED_TARGET_TYPES.has(t.type()))
        .map((t, i) => `[${i}] ${t.type()}: ${t.url()}`)
        .join('\n');

      return {
        content: [{
          type: 'text',
          text: `Available targets:\n${formatted || 'No targets found. Open a page in Chrome first.'}`
        }]
      };
    } catch (err) {
      console.error('[list_targets] Error:', { port, error: err.message });
      return createErrorResponse(err.message);
    }
  }
);

// === Tool 2: get_console_logs ===
server.registerTool(
  'get_console_logs',
  {
    title: 'Get Console Logs',
    description: 'Get console logs from a browser target. Starts monitoring on first call.',
    inputSchema: {
      targetIndex: z.number().int().min(0).default(0).describe('Target index from list_targets'),
      maxLines: z.number().int().min(1).max(MAX_LOGS_PER_TARGET).default(DEFAULT_MAX_LINES).describe('Maximum lines to return'),
      filter: z.enum(['all', 'error', 'warn', 'log', 'info', 'debug']).default('all').describe('Filter by log type'),
      port: z.number().int().min(1024).max(65535).default(DEFAULT_CDP_PORT).describe('Chrome CDP port')
    }
  },
  async ({ targetIndex, maxLines, filter, port }) => {
    try {
      const result = await getTargetPage(targetIndex, port);
      if (result.error) return createErrorResponse(result.error);
      const { targetId, displayUrl } = result;

      const logs = logsCache.get(targetId) || [];
      const formatted = formatLogs(logs, maxLines, filter);
      const header = `=== Console Logs for ${displayUrl} ===\n`;
      const filterInfo = filter === 'all' ? '' : ` ${formatted.filteredCount} matched,`;
      const footer = `\n(showing ${formatted.displayedCount} of${filterInfo} ${formatted.totalCount} total, filter: ${filter})`;

      return {
        content: [{
          type: 'text',
          text: header + (formatted.text || 'No logs yet. Interact with the page to generate console output.') + footer
        }]
      };
    } catch (err) {
      console.error('[get_console_logs] Error:', { port, targetIndex, maxLines, filter, error: err.message });
      return createErrorResponse(err.message);
    }
  }
);

// === Tool 3: navigate ===
server.registerTool(
  'navigate',
  {
    title: 'Navigate Page',
    description: 'Navigate to a URL or reload the current page. Use "reload" as URL to refresh.',
    inputSchema: {
      url: z.string().min(1).describe('Target URL or "reload" to refresh current page'),
      targetIndex: z.number().int().min(0).default(0).describe('Target index from list_targets'),
      port: z.number().int().min(1024).max(65535).default(DEFAULT_CDP_PORT).describe('Chrome CDP port')
    }
  },
  async ({ url, targetIndex, port }) => {
    try {
      // 驗證 URL 協議，防止 javascript: 和 file:// 注入
      const { url: validUrl, isHttp, isPrivateIp } = validateUrl(url);
      const httpWarning = isHttp ? '\n⚠️  Warning: Using HTTP (not HTTPS). Data may be intercepted.' : '';
      const privateIpWarning = isPrivateIp ? '\n⚠️  Warning: Navigating to a private/internal IP address.' : '';

      const result = await getTargetPage(targetIndex, port, { pageOnly: true });
      if (result.error) return createErrorResponse(result.error);
      const { page, targetId } = result;

      // Clear logs and network cache for this target on navigation
      // 注意：networkCache 必須清空現有 store 而非替換，因為 listener 閉包持有原 store 引用
      logsCache.set(targetId, []);
      const netStore = networkCache.get(targetId);
      if (netStore) {
        netStore.requests.clear();
        netStore.order.length = 0;
      }

      if (validUrl.toLowerCase() === 'reload') {
        await page.reload({ waitUntil: PAGE_LOAD_WAIT_UNTIL });
        const newUrl = page.url();
        return { content: [{ type: 'text', text: `Reloaded: ${newUrl}\n(Console logs cleared)` }] };
      } else {
        await page.goto(validUrl, { waitUntil: PAGE_LOAD_WAIT_UNTIL });
        const title = sanitizeLogString(await page.title());
        return { content: [{ type: 'text', text: `Navigated to: ${validUrl}\nPage title: "${title}"\n(Console logs cleared)${httpWarning}${privateIpWarning}` }] };
      }
    } catch (err) {
      console.error('[navigate] Error:', { port, targetIndex, url, error: err.message });
      return createErrorResponse(err.message);
    }
  }
);

// === Tool 4: execute_js ===
const MAX_CODE_LENGTH = 10000;  // 代碼長度限制
const MAX_RESULT_LENGTH = 50000;  // 結果大小限制
const JS_EXECUTION_TIMEOUT = 5000;  // 執行超時（毫秒）

server.registerTool(
  'execute_js',
  {
    title: 'Execute JavaScript',
    description: 'Execute JavaScript code in the page context. Returns the result of the expression. Useful for clicking buttons, filling forms, or calling page functions.',
    inputSchema: {
      code: z.string().min(1).max(MAX_CODE_LENGTH).describe('JavaScript code to execute in page context'),
      targetIndex: z.number().int().min(0).default(0).describe('Target index from list_targets'),
      port: z.number().int().min(1024).max(65535).default(DEFAULT_CDP_PORT).describe('Chrome CDP port')
    }
  },
  async ({ code, targetIndex, port }) => {
    try {
      const pageResult = await getTargetPage(targetIndex, port, { pageOnly: true });
      if (pageResult.error) return createErrorResponse(pageResult.error);
      const { page } = pageResult;

      // 執行 JavaScript，帶超時保護
      const result = await Promise.race([
        page.evaluate((jsCode) => {
          // 在頁面 context 中執行代碼
          // 使用 Function 構造器來執行代碼，支援表達式和語句
          try {
            const fn = new Function(`return (${jsCode})`);
            return fn();
          } catch {
            // 如果不是表達式，嘗試作為語句執行
            const fn = new Function(jsCode);
            return fn();
          }
        }, code),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Execution timeout (5s)')), JS_EXECUTION_TIMEOUT)
        )
      ]);

      // 序列化結果
      let resultStr;
      try {
        resultStr = JSON.stringify(result, null, 2);
        if (resultStr === undefined) {
          resultStr = 'undefined';
        }
      } catch {
        resultStr = String(result);
      }

      // 結果大小限制
      if (resultStr.length > MAX_RESULT_LENGTH) {
        resultStr = resultStr.substring(0, MAX_RESULT_LENGTH) + '\n... [Result truncated]';
      }

      return {
        content: [{
          type: 'text',
          text: `=== JavaScript Executed ===\nCode: ${code.substring(0, 100)}${code.length > 100 ? '...' : ''}\n\nResult:\n${resultStr}`
        }]
      };
    } catch (err) {
      console.error('[execute_js] Error:', { port, targetIndex, code: code.substring(0, 50), error: err.message });
      return createErrorResponse(err.message);
    }
  }
);

// === Tool 5: get_network_logs ===
server.registerTool(
  'get_network_logs',
  {
    title: 'Get Network Logs',
    description: 'Get network request/response logs from a browser target. Starts monitoring on first call.',
    inputSchema: {
      targetIndex: z.number().int().min(0).default(0).describe('Target index from list_targets'),
      maxLines: z.number().int().min(1).max(MAX_NETWORK_LOGS_PER_TARGET).default(DEFAULT_MAX_NETWORK_LINES).describe('Maximum entries to return'),
      filter: z.enum(['all', 'failed', 'xhr', 'fetch', 'document', 'stylesheet', 'script', 'image']).default('all').describe('Filter by type: all, failed (errors+4xx/5xx), or resource type'),
      port: z.number().int().min(1024).max(65535).default(DEFAULT_CDP_PORT).describe('Chrome CDP port')
    }
  },
  async ({ targetIndex, maxLines, filter, port }) => {
    try {
      const result = await getTargetPage(targetIndex, port);
      if (result.error) return createErrorResponse(result.error);
      const { targetId, displayUrl } = result;

      const store = networkCache.get(targetId) || { requests: new Map(), order: [] };
      const formatted = formatNetworkLogs(store, maxLines, filter);
      const header = `=== Network Logs for ${displayUrl} ===\n`;
      const filterInfo = filter === 'all' ? '' : ` ${formatted.filteredCount} matched,`;
      const footer = `\n(showing ${formatted.displayedCount} of${filterInfo} ${formatted.totalCount} total, filter: ${filter})`;

      return {
        content: [{
          type: 'text',
          text: header + (formatted.text || 'No network requests yet. Navigate or interact with the page.') + footer
        }]
      };
    } catch (err) {
      console.error('[get_network_logs] Error:', { port, targetIndex, maxLines, filter, error: err.message });
      return createErrorResponse(err.message);
    }
  }
);

// === Tool 6: take_screenshot ===
server.registerTool(
  'take_screenshot',
  {
    title: 'Take Screenshot',
    description: 'Capture a screenshot of the current page. Returns a PNG image. Use for visual debugging of layout, CSS, or UI state.',
    inputSchema: {
      targetIndex: z.number().int().min(0).default(0).describe('Target index from list_targets'),
      fullPage: z.boolean().default(false).describe('Capture the full scrollable page (true) or just the viewport (false)'),
      port: z.number().int().min(1024).max(65535).default(DEFAULT_CDP_PORT).describe('Chrome CDP port')
    }
  },
  async ({ targetIndex, fullPage, port }) => {
    try {
      const result = await getTargetPage(targetIndex, port, { pageOnly: true });
      if (result.error) return createErrorResponse(result.error);
      const { page, displayUrl } = result;

      // 儲存原始 viewport 以便還原
      const originalViewport = page.viewport();
      let viewportChanged = false;

      try {
        // Clamp viewport to prevent oversized screenshots
        if (!originalViewport || originalViewport.width > SCREENSHOT_MAX_WIDTH || originalViewport.height > SCREENSHOT_MAX_HEIGHT) {
          await page.setViewport({
            width: Math.min(originalViewport?.width || SCREENSHOT_MAX_WIDTH, SCREENSHOT_MAX_WIDTH),
            height: Math.min(originalViewport?.height || SCREENSHOT_MAX_HEIGHT, SCREENSHOT_MAX_HEIGHT),
            deviceScaleFactor: 1,
          });
          viewportChanged = true;
        }

        // fullPage 時允許擷取超出 viewport 的內容
        const clipOpts = fullPage ? { captureBeyondViewport: true } : {};

        function takeScreenshotWithTimeout(opts) {
          return Promise.race([
            page.screenshot({ encoding: 'base64', fullPage, optimizeForSpeed: true, ...clipOpts, ...opts }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Screenshot timeout (10s)')), SCREENSHOT_TIMEOUT))
          ]);
        }

        // Try PNG first，帶超時保護
        let base64 = await takeScreenshotWithTimeout({ type: 'png' });
        let mimeType = 'image/png';

        // If PNG too large, fall back to JPEG
        if (base64.length > SCREENSHOT_MAX_BYTES) {
          base64 = await takeScreenshotWithTimeout({ type: 'jpeg', quality: 70 });
          mimeType = 'image/jpeg';

          if (base64.length > SCREENSHOT_MAX_BYTES) {
            return createErrorResponse(
              `Screenshot too large (${formatBytes(base64.length)}). ` +
              `Max: ${formatBytes(SCREENSHOT_MAX_BYTES)}. ` +
              `Try with fullPage: false, or screenshot a simpler page.`
            );
          }
        }

        return {
          content: [
            { type: 'image', data: base64, mimeType },
            { type: 'text', text: `Screenshot of ${displayUrl} (${mimeType.split('/')[1].toUpperCase()}, ${formatBytes(base64.length)})${fullPage ? ' [full page]' : ''}` }
          ]
        };
      } finally {
        // 還原原始 viewport，避免影響後續工具操作
        if (viewportChanged && originalViewport) {
          await page.setViewport(originalViewport).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[take_screenshot] Error:', { port, targetIndex, fullPage, error: err.message });
      return createErrorResponse(err.message);
    }
  }
);

// === Cleanup Handler ===
let isCleaningUp = false;  // 防止重複清理

async function cleanup() {
  // 防止並發調用（Race Condition 保護）
  if (isCleaningUp) return;
  isCleaningUp = true;

  console.error('[simple-console-mcp] Shutting down...');

  // 複製 keys 來迭代，避免在迭代時 Map 被修改（Race Condition 保護）
  const pageIds = [...pageCache.keys()];
  for (const id of pageIds) {
    try {
      const page = pageCache.get(id);
      if (page) {
        // 只移除 listener，不關閉 page（因為是連接到現有 Chrome）
        page.removeAllListeners('console');
        page.removeAllListeners('request');
        page.removeAllListeners('requestfinished');
        page.removeAllListeners('requestfailed');
      }
    } catch (err) {
      // ignore - page 可能已經關閉
    }
  }
  pageCache.clear();
  logsCache.clear();
  networkCache.clear();

  // 斷開 browser 連線（不關閉 Chrome，因為可能是使用者的 Chrome）
  if (browser) {
    try {
      // 檢查是否還在連線狀態再斷開
      if (browser.isConnected()) {
        browser.disconnect();
      }
    } catch (err) {
      // ignore - browser 可能已經斷開
    }
    browser = null;
  }
}

// 監聽程序終止信號
process.on('SIGINT', async () => {
  await cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(0);
});

// 處理未捕獲的異常，確保資源被清理
process.on('uncaughtException', async (err) => {
  console.error('[simple-console-mcp] Uncaught exception:', err);
  await cleanup();
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('[simple-console-mcp] Unhandled rejection:', reason);
  await cleanup();
  process.exit(1);
});

// === Start Server ===
const transport = new StdioServerTransport();
await server.connect(transport);
