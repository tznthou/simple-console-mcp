# simple-console-mcp

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![npm](https://img.shields.io/npm/v/simple-console-mcp.svg)](https://www.npmjs.com/package/simple-console-mcp)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Protocol-8B5CF6.svg)](https://modelcontextprotocol.io/)

[← 回到 Muripo HQ](https://tznthou.github.io/muripo-hq/)

> 極簡 Console MCP — 瀏覽器除錯的最小單位

[English Version](README_EN.md)

---

## TL;DR

一個極度精簡的 MCP Server，只專注於瀏覽器 Console Log 監聽。比 chrome-devtools-mcp 輕 **97%**（3 個工具 vs 50+ 個），讓 AI 助手幫你 debug 時不會吃掉一堆 context token。

| 對比 | chrome-devtools-mcp | simple-console-mcp |
|------|---------------------|-------------------|
| 工具數 | 50+ | **3** |
| Context 消耗 | ~5000 tokens | **~160 tokens** |
| 功能 | 全功能 | Console 專精 |

---

## 開發心得

這個專案源自一個簡單的問題：**「我只想看 Console Log，為什麼要載入 50 個工具？」**

chrome-devtools-mcp 很強大，但每次 AI 呼叫工具前都要先理解這 50+ 個工具的用途，光是工具描述就吃掉大量 context。對於只想快速 debug JavaScript 錯誤的場景來說，這太浪費了。

所以我做了這個「**最小可行 MCP**」：

- `list_targets` — 列出瀏覽器分頁
- `get_console_logs` — 讀取 Console 輸出
- `navigate` — 導航或重新整理

就這三個。夠用就好。

這個 MCP 的核心目標，是徹底執行**減法原則**——用最小的功能達成最大的效果。實際上，這也是 **80/20 法則**的運用：80% 的 debug 場景只需要看 Console Log，那為什麼要載入 100% 的工具？

---

## 系統架構

```mermaid
graph TB
    subgraph Client["AI 客戶端"]
        CLAUDE["Claude Desktop<br/>or Claude Code"]
    end

    subgraph MCP["simple-console-mcp"]
        SERVER["MCP Server<br/>StdioTransport"]
        TOOLS["3 Tools<br/>list_targets | get_console_logs | navigate"]
        CACHE["Log Cache<br/>Map + WeakMap"]
    end

    subgraph Browser["Chrome 瀏覽器"]
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

## 使用流程

```mermaid
sequenceDiagram
    participant User as 使用者
    participant AI as Claude
    participant MCP as simple-console-mcp
    participant Chrome as Chrome CDP

    User->>Chrome: 啟動 Chrome --remote-debugging-port=9222
    User->>AI: 「我的網頁壞了」

    AI->>MCP: list_targets()
    MCP->>Chrome: 取得所有分頁
    Chrome-->>MCP: [0] localhost:3000, [1] google.com
    MCP-->>AI: 顯示分頁列表

    AI->>MCP: get_console_logs(targetIndex: 0)
    MCP->>Chrome: 監聽 Console 事件
    Chrome-->>MCP: [ERROR] TypeError at app.js:42
    MCP-->>AI: 格式化 Log 輸出

    AI-->>User: 「問題在 app.js 第 42 行...」

    opt 需要重新整理
        AI->>MCP: navigate(url: "reload")
        MCP->>Chrome: page.reload()
        Chrome-->>MCP: 頁面已重載
    end
```

---

## 安裝方式

### 方法一：npm（推薦）

直接在 Claude Desktop 或 Claude Code 的 MCP 設定加入：

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

### 方法二：GitHub URL

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

### 方法三：本地安裝

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

## 啟動 Chrome CDP

MCP Server 需要連接到 Chrome 的 DevTools Protocol。啟動 Chrome 時加上 `--remote-debugging-port` 參數：

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

或使用專案內附的便利腳本：

```bash
./bin/start-chrome.sh
```

---

## 工具說明

### `list_targets`

列出所有可監聽的瀏覽器目標（頁面、Service Worker 等）。

| 參數 | 類型 | 預設值 | 說明 |
|------|------|--------|------|
| `port` | number | 9222 | Chrome CDP 連接埠 |

```
Available targets:
[0] page: http://localhost:3000 (title: "My App")
[1] service_worker: chrome-extension://xxx/background.js
[2] page: chrome-extension://xxx/popup.html
```

### `get_console_logs`

取得指定目標的 Console 輸出。首次呼叫會開始監聽。

| 參數 | 類型 | 預設值 | 說明 |
|------|------|--------|------|
| `targetIndex` | number | 0 | 目標索引（從 list_targets 取得） |
| `maxLines` | number | 50 | 最大回傳行數 |
| `filter` | string | "all" | 過濾類型：all / error / warn / log / info / debug |
| `port` | number | 9222 | Chrome CDP 連接埠 |

```
=== Console Logs for http://localhost:3000 ===
[12:34:56] ERROR: Uncaught TypeError: Cannot read property 'x' of undefined
[12:34:57] WARN: Deprecation warning...
(showing 2 of 50 total logs, filter: all)
```

### `navigate`

導航到指定 URL 或重新整理頁面。

| 參數 | 類型 | 預設值 | 說明 |
|------|------|--------|------|
| `url` | string | - | 目標 URL 或 "reload" |
| `targetIndex` | number | 0 | 目標索引 |
| `port` | number | 9222 | Chrome CDP 連接埠 |

```
Navigated to: http://localhost:3000/login
Page title: "Login"
(Console logs cleared)
```

---

## Chrome Extension 開發

這個 MCP 支援監聽 Chrome Extension 的 Console 輸出：

```
[0] page: http://localhost:3000           ← 一般網頁
[1] service_worker: chrome-extension://abc/background.js  ← Extension 背景腳本
[2] page: chrome-extension://abc/popup.html               ← Extension 彈出視窗
```

用不同的 `targetIndex` 分別監聽各個目標。

---

## 運作機制：Pull-based（被動式）

```
Claude 呼叫 get_console_logs → MCP 回傳累積的 logs → Claude 處理
         ↑                                              |
         └──────────── Claude 必須再次呼叫 ──────────────┘
```

**行為說明**：
1. 第一次呼叫 `get_console_logs` 時，MCP 開始監聽該 target
2. Console 事件持續被收集到記憶體（最多 500 條）
3. **Claude 不會自動收到通知** — 必須再次呼叫 `get_console_logs` 才能看到新 log

> **為什麼是 Pull-based？**
> MCP 協議是 request-response 模式，不支援主動推送。Server 無法主動通知 Claude「有新錯誤」，Claude 必須主動詢問。

### 實際使用對話範例

```
你：「幫我 debug 這個頁面」
Claude：[呼叫 list_targets]
Claude：[呼叫 get_console_logs]
Claude：「目前沒有錯誤，頁面看起來正常。」

你：「我點了那個按鈕，頁面壞了」
Claude：[再次呼叫 get_console_logs]  ← 需要你提示後才會再查
Claude：「發現新錯誤：TypeError at app.js:42...」
```

---

## 技術棧

| 技術 | 用途 |
|------|------|
| Node.js 18+ | 執行環境 |
| ES Modules | 模組系統 |
| @modelcontextprotocol/sdk | MCP 協議實作 |
| puppeteer-core | Chrome CDP 連接（不含 Chromium） |
| zod | 參數驗證 |

---

## 專案結構

```
simple-console-mcp/
├── src/
│   └── index.js        # MCP Server 主程式（~200 行）
├── bin/
│   └── start-chrome.sh # Chrome 啟動腳本
├── package.json
├── README.md           # 中文說明
├── README_EN.md        # 英文說明
└── LICENSE             # Apache-2.0
```

---

## 環境需求

| 項目 | 需求 |
|------|------|
| Node.js | 18+ |
| Chrome | 任意版本，需開啟 `--remote-debugging-port` |
| 作業系統 | macOS / Linux / Windows |

---

## 注意事項

1. **Chrome 必須開啟 CDP**：沒有 `--remote-debugging-port` 參數的 Chrome 無法連接
2. **一次只能連一個 Chrome**：如果有多個 Chrome 實例，MCP 會連接到第一個
3. **Log 快取上限**：每個目標最多保留 500 條 Log，超過會自動清除舊的
4. **導航會清除 Log**：呼叫 navigate 後，該目標的 Log 會被清空

---

## 授權

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

本專案採用 [Apache License 2.0](LICENSE) 授權。

---

## 作者

- GitHub: [@tznthou](https://github.com/tznthou)
- 專案屬於 [muripo 30-day challenge](https://github.com/tznthou/muripo-hq) - Day 14
