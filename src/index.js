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

// === Global State ===
let browser = null;
const logsCache = new Map(); // targetId -> logs[]
const pageCache = new Map(); // targetIndex -> page

// === Helper Functions ===
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
  await new Promise(resolve => setTimeout(resolve, 2000));
}

async function ensureConnection(port) {
  if (browser && browser.isConnected()) return browser;

  // First attempt: try to connect to existing Chrome
  try {
    browser = await puppeteer.connect({ browserURL: `http://localhost:${port}` });
    return browser;
  } catch (err) {
    // No Chrome with CDP found, try to launch one
  }

  // Second attempt: launch Chrome and retry
  try {
    await launchChrome(port);
    browser = await puppeteer.connect({ browserURL: `http://localhost:${port}` });
    return browser;
  } catch (err) {
    throw new Error(`Cannot connect to Chrome CDP (port ${port}).\nAuto-launch failed. Please start Chrome manually with:\n${getChromePath()} --remote-debugging-port=${port}`);
  }
}

function setupLogListener(page, targetId) {
  if (logsCache.has(targetId)) return;
  logsCache.set(targetId, []);
  page.on('console', msg => {
    const logs = logsCache.get(targetId);
    logs.push({
      time: new Date().toLocaleTimeString('en-US', { hour12: false }),
      type: msg.type().toUpperCase(),
      text: msg.text()
    });
    // Keep only last 500 logs to prevent memory bloat
    if (logs.length > 500) logs.shift();
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
  version: '1.2.0'
});

// === Tool 1: list_targets ===
server.registerTool(
  'list_targets',
  {
    title: 'List Browser Targets',
    description: 'List all available browser targets (pages, service workers, etc.)',
    inputSchema: {
      port: z.number().default(9222).describe('Chrome CDP port')
    }
  },
  async ({ port }) => {
    try {
      const b = await ensureConnection(port);
      const targets = b.targets();

      const formatted = targets
        .filter(t => ['page', 'service_worker', 'background_page'].includes(t.type()))
        .map((t, i) => `[${i}] ${t.type()}: ${t.url()} (title: "${t.page ? 'loading...' : ''}")`)
        .join('\n');

      return {
        content: [{
          type: 'text',
          text: `Available targets:\n${formatted || 'No targets found. Open a page in Chrome first.'}`
        }]
      };
    } catch (err) {
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
      targetIndex: z.number().default(0).describe('Target index from list_targets'),
      maxLines: z.number().default(50).describe('Maximum lines to return'),
      filter: z.enum(['all', 'error', 'warn', 'log', 'info', 'debug']).default('all').describe('Filter by log type'),
      port: z.number().default(9222).describe('Chrome CDP port')
    }
  },
  async ({ targetIndex, maxLines, filter, port }) => {
    try {
      const b = await ensureConnection(port);
      const targets = b.targets().filter(t => ['page', 'service_worker', 'background_page'].includes(t.type()));

      if (targetIndex >= targets.length) {
        return { content: [{ type: 'text', text: `Error: Target index ${targetIndex} not found. Use list_targets to see available targets.` }] };
      }

      const target = targets[targetIndex];
      const targetId = target.url();

      // Get or create page for this target
      let page = pageCache.get(targetIndex);
      if (!page) {
        page = await target.page();
        if (!page) {
          return { content: [{ type: 'text', text: `Error: Cannot get page for target ${targetIndex}. It might be a non-page target.` }] };
        }
        pageCache.set(targetIndex, page);
        setupLogListener(page, targetId);
      }

      const logs = logsCache.get(targetId) || [];
      const formatted = formatLogs(logs, maxLines, filter);
      const header = `=== Console Logs for ${targetId} ===\n`;
      const footer = `\n(showing ${Math.min(logs.length, maxLines)} of ${logs.length} total logs, filter: ${filter})`;

      return {
        content: [{
          type: 'text',
          text: header + (formatted || 'No logs yet. Interact with the page to generate console output.') + footer
        }]
      };
    } catch (err) {
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
      url: z.string().describe('Target URL or "reload" to refresh current page'),
      targetIndex: z.number().default(0).describe('Target index from list_targets'),
      port: z.number().default(9222).describe('Chrome CDP port')
    }
  },
  async ({ url, targetIndex, port }) => {
    try {
      const b = await ensureConnection(port);
      const targets = b.targets().filter(t => t.type() === 'page');

      if (targetIndex >= targets.length) {
        return { content: [{ type: 'text', text: `Error: Target index ${targetIndex} not found. Use list_targets to see available targets.` }] };
      }

      const target = targets[targetIndex];
      let page = pageCache.get(targetIndex);
      if (!page) {
        page = await target.page();
        if (!page) {
          return { content: [{ type: 'text', text: `Error: Cannot get page for target ${targetIndex}.` }] };
        }
        pageCache.set(targetIndex, page);
        setupLogListener(page, target.url());
      }

      // Clear logs for this target on navigation
      const targetId = target.url();
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
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

// === Start Server ===
const transport = new StdioServerTransport();
await server.connect(transport);
