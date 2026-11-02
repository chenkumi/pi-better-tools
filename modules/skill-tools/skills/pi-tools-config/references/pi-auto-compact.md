# Pi Auto Compact：確定性壓縮（不呼叫模型）

## 指令與工具

- 三個唯讀 deferred 工具（命名空間 `session`，用 `tool_search` 載入）：`session_window`（依行號範圍看大綱，`before` 往前讀）、`session_grep`（字面關鍵字搜尋）、`session_read`（依行號讀原始 entry）；只讀目前 session 與其祖先 session。無指令；壓縮時由 `session_before_compact` hook 運作。
- hook 會產生確定性摘要（Pi 決定時機與切點，本模組只換切點之前的摘要）；設定無效、未知 context window 或失敗時交還 Pi。摘要末端附壓縮當下的背景 job／monitor 狀態與工作樹 HEAD／異動檔路徑（只有識別與狀態，不含輸出或 diff）。
- 與 Blackhole **只掛其一**：兩者同時掛載時不做協調。切換方式是在 Pi 的套件／extension 設定中啟用或排除對應入口，不是設定鍵。

## Config 與作用範圍

使用者層 `<agentDir>/auto-compact.json`（預設 `~/.pi/agent/auto-compact.json`，路徑由 Pi 的 agentDir 解析）。沒有專案層設定、沒有開關鍵；檔案可省略，省略的鍵用預設值。模組只讀不寫。

| 鍵 | 預設 | 範圍 |
|---|---|---|
| `l1Ratio`、`l2Ratio`、`l3Ratio`、`l4Ratio` | 0.3、0.2、0.1、0.1 | 大於 0 且至多 1 |
| `l1MinChars`、`l2MinChars`、`l3MinChars`、`l4MinChars` | 30000、20000、10000、10000 | 正整數 |
| `charsPerToken` | 2.2 | 1～8 |
| `maxTotalRatio` | 0.5 | 大於 0 且至多 1 |

各層預算 = `max(模型 context window × 比例, 最小值)` 字元。未知鍵、型別錯誤、超出範圍都是錯誤，不會退回其他值。

## 診斷

- 啟動後出現 `pi-auto-compact: … Compaction is left to Pi.` 警告：設定檔有誤，依訊息中的鍵與路徑修正；修正前壓縮由 Pi 處理。
- 想停用：從套件／extension 設定排除 Pi Auto Compact 入口，不要建立開關鍵。
- 想改用它取代 Blackhole：先排除 Blackhole 入口，再啟用本模組；不要兩者同時掛載。
