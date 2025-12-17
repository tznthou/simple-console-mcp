#!/usr/bin/env node
/**
 * simple-console-mcp - Minimal MCP server for browser console log monitoring
 * 97% lighter than chrome-devtools-mcp (3 tools vs 50+)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import puppeteer from 'puppeteer-core';
import { z } from 'zod';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { existsSync } from 'fs';

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

// === Global State ===
let browser = null;
let connectionPromise = null;  // 防止並行連線的 Promise lock
const logsCache = new Map();   // targetId (Puppeteer internal ID) -> logs[]
const pageCache = new Map();   // targetId (Puppeteer internal ID) -> page

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

  return { url, isHttp };
}

/**
 * 建立統一的錯誤回應格式
 * @param {string} message - 錯誤訊息
 * @returns {Object} MCP 錯誤回應物件
 */
function createErrorResponse(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }] };
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

  const userDataDir = `/tmp/chrome-cdp-${port}`;
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
      throw new Error(`Cannot connect to Chrome CDP (port ${validPort}).\nAuto-launch failed. Please start Chrome manually with:\n${getChromePath()} --remote-debugging-port=${validPort}`);
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

function formatLogs(logs, maxLines, filter) {
  let filtered = logs;
  if (filter !== 'all') {
    filtered = logs.filter(log => log.type.toLowerCase() === filter);
  }
  const recent = filtered.slice(-maxLines);
  const text = recent.map(log => `[${log.time}] ${log.type}: ${log.text}`).join('\n');

  return {
    text,
    displayedCount: recent.length,
    filteredCount: filtered.length,
    totalCount: logs.length
  };
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
      const b = await ensureConnection(port);
      const targets = b.targets().filter(t => ALLOWED_TARGET_TYPES.has(t.type()));

      if (targetIndex >= targets.length) {
        return createErrorResponse(`Target index ${targetIndex} not found. Use list_targets to see available targets.`);
      }

      const target = targets[targetIndex];
      const targetId = getTargetId(target);  // 使用穩定 ID，不會隨導航改變
      const displayUrl = target.url();       // URL 只用於顯示

      // Get or create page for this target（使用 targetId 而非 index）
      let page = pageCache.get(targetId);
      if (!page) {
        page = await target.page();
        if (!page) {
          return createErrorResponse(`Cannot get page for target ${targetIndex}. It might be a non-page target.`);
        }
        pageCache.set(targetId, page);
        setupLogListener(page, targetId);
      }

      const logs = logsCache.get(targetId) || [];
      const result = formatLogs(logs, maxLines, filter);
      const header = `=== Console Logs for ${displayUrl} ===\n`;
      const filterInfo = filter === 'all' ? '' : ` ${result.filteredCount} matched,`;
      const footer = `\n(showing ${result.displayedCount} of${filterInfo} ${result.totalCount} total, filter: ${filter})`;

      return {
        content: [{
          type: 'text',
          text: header + (result.text || 'No logs yet. Interact with the page to generate console output.') + footer
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
      const { url: validUrl, isHttp } = validateUrl(url);
      const httpWarning = isHttp ? '\n⚠️  Warning: Using HTTP (not HTTPS). Data may be intercepted.' : '';

      const b = await ensureConnection(port);
      // 使用與 list_targets 相同的過濾邏輯，確保 index 一致
      const targets = b.targets().filter(t => ALLOWED_TARGET_TYPES.has(t.type()));

      if (targetIndex >= targets.length) {
        return createErrorResponse(`Target index ${targetIndex} not found. Use list_targets to see available targets.`);
      }

      const target = targets[targetIndex];

      // navigate 只能對 page 類型操作，service_worker/background_page 無法導航
      if (target.type() !== 'page') {
        return createErrorResponse(`Target [${targetIndex}] is a ${target.type()}, not a page. Only page targets can be navigated.`);
      }
      const targetId = getTargetId(target);  // 使用穩定 ID

      // Get or create page for this target（使用 targetId 而非 index）
      let page = pageCache.get(targetId);
      if (!page) {
        page = await target.page();
        if (!page) {
          return createErrorResponse(`Cannot get page for target ${targetIndex}.`);
        }
        pageCache.set(targetId, page);
        setupLogListener(page, targetId);
      }

      // Clear logs for this target on navigation（使用穩定 ID，確保清到正確的 logs）
      logsCache.set(targetId, []);

      if (validUrl.toLowerCase() === 'reload') {
        await page.reload({ waitUntil: PAGE_LOAD_WAIT_UNTIL });
        const newUrl = page.url();
        return { content: [{ type: 'text', text: `Reloaded: ${newUrl}\n(Console logs cleared)` }] };
      } else {
        await page.goto(validUrl, { waitUntil: PAGE_LOAD_WAIT_UNTIL });
        const title = await page.title();
        return { content: [{ type: 'text', text: `Navigated to: ${validUrl}\nPage title: "${title}"\n(Console logs cleared)${httpWarning}` }] };
      }
    } catch (err) {
      console.error('[navigate] Error:', { port, targetIndex, url, error: err.message });
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
      }
    } catch (err) {
      // ignore - page 可能已經關閉
    }
  }
  pageCache.clear();
  logsCache.clear();

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
