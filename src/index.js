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

// === Constants ===
const CHROME_STARTUP_DELAY_MS = 2000;
const MAX_LOGS_PER_TARGET = 500;
const DEFAULT_MAX_LINES = 50;
const DEFAULT_CDP_PORT = 9222;
const ALLOWED_TARGET_TYPES = new Set(['page', 'service_worker', 'background_page']);

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
  // 使用 Puppeteer 內部 ID，不會隨導航改變
  return target._targetId || target.url();
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
  return recent.map(log => `[${log.time}] ${log.type}: ${log.text}`).join('\n');
}

// === MCP Server Setup ===
const server = new McpServer({
  name: 'simple-console-mcp',
  version: '1.3.1'  // 修復 navigate index 不一致問題
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
        .map((t, i) => `[${i}] ${t.type()}: ${t.url()} (title: "${t.page ? 'loading...' : ''}")`)
        .join('\n');

      return {
        content: [{
          type: 'text',
          text: `Available targets:\n${formatted || 'No targets found. Open a page in Chrome first.'}`
        }]
      };
    } catch (err) {
      console.error('[list_targets] Error:', err);
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
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
        return { content: [{ type: 'text', text: `Error: Target index ${targetIndex} not found. Use list_targets to see available targets.` }] };
      }

      const target = targets[targetIndex];
      const targetId = getTargetId(target);  // 使用穩定 ID，不會隨導航改變
      const displayUrl = target.url();       // URL 只用於顯示

      // Get or create page for this target（使用 targetId 而非 index）
      let page = pageCache.get(targetId);
      if (!page) {
        page = await target.page();
        if (!page) {
          return { content: [{ type: 'text', text: `Error: Cannot get page for target ${targetIndex}. It might be a non-page target.` }] };
        }
        pageCache.set(targetId, page);
        setupLogListener(page, targetId);
      }

      const logs = logsCache.get(targetId) || [];
      const formatted = formatLogs(logs, maxLines, filter);
      const header = `=== Console Logs for ${displayUrl} ===\n`;
      const footer = `\n(showing ${Math.min(logs.length, maxLines)} of ${logs.length} total logs, filter: ${filter})`;

      return {
        content: [{
          type: 'text',
          text: header + (formatted || 'No logs yet. Interact with the page to generate console output.') + footer
        }]
      };
    } catch (err) {
      console.error('[get_console_logs] Error:', err);
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
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
      const b = await ensureConnection(port);
      // 使用與 list_targets 相同的過濾邏輯，確保 index 一致
      const targets = b.targets().filter(t => ALLOWED_TARGET_TYPES.has(t.type()));

      if (targetIndex >= targets.length) {
        return { content: [{ type: 'text', text: `Error: Target index ${targetIndex} not found. Use list_targets to see available targets.` }] };
      }

      const target = targets[targetIndex];

      // navigate 只能對 page 類型操作，service_worker/background_page 無法導航
      if (target.type() !== 'page') {
        return { content: [{ type: 'text', text: `Error: Target [${targetIndex}] is a ${target.type()}, not a page. Only page targets can be navigated.` }] };
      }
      const targetId = getTargetId(target);  // 使用穩定 ID

      // Get or create page for this target（使用 targetId 而非 index）
      let page = pageCache.get(targetId);
      if (!page) {
        page = await target.page();
        if (!page) {
          return { content: [{ type: 'text', text: `Error: Cannot get page for target ${targetIndex}.` }] };
        }
        pageCache.set(targetId, page);
        setupLogListener(page, targetId);
      }

      // Clear logs for this target on navigation（使用穩定 ID，確保清到正確的 logs）
      logsCache.set(targetId, []);

      if (url.toLowerCase() === 'reload') {
        await page.reload({ waitUntil: 'domcontentloaded' });
        const newUrl = page.url();
        return { content: [{ type: 'text', text: `Reloaded: ${newUrl}\n(Console logs cleared)` }] };
      } else {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const title = await page.title();
        return { content: [{ type: 'text', text: `Navigated to: ${url}\nPage title: "${title}"\n(Console logs cleared)` }] };
      }
    } catch (err) {
      console.error('[navigate] Error:', err);
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

// === Cleanup Handler ===
async function cleanup() {
  console.error('[simple-console-mcp] Shutting down...');

  // 清理 page cache
  for (const page of pageCache.values()) {
    try {
      // 只移除 listener，不關閉 page（因為是連接到現有 Chrome）
      page.removeAllListeners('console');
    } catch (err) {
      // ignore
    }
  }
  pageCache.clear();
  logsCache.clear();

  // 斷開 browser 連線（不關閉 Chrome，因為可能是使用者的 Chrome）
  if (browser) {
    try {
      browser.disconnect();
    } catch (err) {
      // ignore
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

// === Start Server ===
const transport = new StdioServerTransport();
await server.connect(transport);
