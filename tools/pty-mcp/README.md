# pty-mcp

本機 MCP server（stdio），讓 Claude Code 等 MCP 客戶端能在 PTY 裡**執行程式並看到它的渲染畫面**，用來操作與觀察全螢幕 TUI（例如 Pi）。它是開發輔助工具，**不是 Pi 的 extension，也不是本專案的模組**，不隨套件發布（根 `package.json` 的 `files` 不含 `tools/`）。

與 `modules/pty-terminal`（Pi 內的 PTY 工具，回傳原始 ANSI 輸出）的差別：這裡用 `@xterm/headless` 維護虛擬螢幕，`term_screen` 回傳的是人眼會看到的畫面（含游標位置、alt-screen 狀態與捲動緩衝），所以 TUI 的重繪、游標定位都能正確呈現。

## 工具

| 工具 | 用途 |
|---|---|
| `term_spawn` | 啟動程式，回傳 session id 與畫面。Windows 上非 `.exe` 的指令（如 npm shim `pi`）自動經 `cmd.exe` |
| `term_screen` | 目前畫面，可加 `scrollback` 看上方的歷史行 |
| `term_send` | 先送字面 `text`，再逐鍵送 `keys`（`Enter`、`Escape`、`Up`、`Ctrl+C`、`Alt+x`…，鍵與鍵之間隔 30ms），等畫面靜止後回傳畫面 |
| `term_wait` | 等畫面符合 RegExp、靜止、程式結束或逾時 |
| `term_resize`／`term_kill`／`term_list` | 調整大小、關閉、列出 |

## 安裝與測試

```bash
cd tools/pty-mcp
npm install --ignore-scripts      # 只裝 MCP SDK、@xterm/headless、zod（純 JS）
node test.mjs                      # 經真實 MCP stdio 協定的端到端測試
```

- 這個目錄有自己的 `package.json` 與 lockfile，**不屬於根目錄的依賴管理**；不要把它加進根 `package.json`。
- `node-pty`（原生模組）直接借用根目錄 `node_modules/node-pty`（先做過 `npm ci --ignore-scripts`），路徑可用環境變數 `PTY_MCP_NODE_PTY` 覆蓋。

## 掛載到 Claude Code

```bash
claude mcp add pty-term --scope local -- node D:/GitHub/pi-better-tools-main/tools/pty-mcp/server.mjs
```

新增後需重新啟動 Claude Code session（或 `/mcp` 重新連線）才會出現 `mcp__pty-term__*` 工具。

## 限制

- 單一 session 只有一個虛擬螢幕；程式輸出的圖片、超連結、滑鼠事件不處理。
- 最多 8 個 session；畫面輸出上限 6 萬字元。
- `term_kill` 不保證程式的子行程已停止（Windows 的 PTY 沒有 POSIX signal）。
- 它能執行任何指令，權限等同本機 shell，只在本機 stdio 使用，不開網路埠。
