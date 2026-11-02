# Pi Auto Compact：確定性壓縮（不呼叫模型）

## 指令與工具

- 無工具、無指令；只在壓縮時由 `session_before_compact` hook 運作。
- 目前是骨架：只驗證設定檔，不產生摘要，壓縮一律交還 Pi。
- 與 Blackhole **只掛其一**：兩者同時掛載時不做協調。切換方式是在 Pi 的套件／extension 設定中啟用或排除對應入口，不是設定鍵。

## Config 與作用範圍

使用者層 `<agentDir>/auto-compact.json`（預設 `~/.pi/agent/auto-compact.json`，路徑由 Pi 的 agentDir 解析）。沒有專案層設定、沒有開關鍵；檔案可省略，省略的鍵用預設值。模組只讀不寫。

| 鍵 | 預設 | 範圍 |
|---|---|---|
| `l1Ratio`、`l2Ratio`、`l3Ratio` | 0.3、0.2、0.1 | 大於 0 且至多 1 |
| `l1MinChars`、`l2MinChars`、`l3MinChars` | 30000、20000、10000 | 正整數 |
| `charsPerToken` | 2.2 | 1～8 |
| `maxTotalRatio` | 0.5 | 大於 0 且至多 1 |

各層預算 = `max(模型 context window × 比例, 最小值)` 字元。未知鍵、型別錯誤、超出範圍都是錯誤，不會退回其他值。

## 診斷

- 啟動後出現 `pi-auto-compact: … Compaction is left to Pi.` 警告：設定檔有誤，依訊息中的鍵與路徑修正；修正前壓縮由 Pi 處理。
- 想停用：從套件／extension 設定排除 Pi Auto Compact 入口，不要建立開關鍵。
- 想改用它取代 Blackhole：先排除 Blackhole 入口，再啟用本模組；不要兩者同時掛載。
