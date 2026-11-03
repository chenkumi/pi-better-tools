# Pi Auto Compact：確定性壓縮（不呼叫模型）

## 指令與工具

- `/settings:auto-compact`：設定面板（互動 TUI），兩頁（Budgets：L1～L4 的比例與最小字元數；Limits：`maxTotalRatio`、`charsPerToken`、`checkpointRatio`）。欄位留空＝使用預設值並刪除該鍵；只有按存檔才寫入 `auto-compact.json`；存檔後立即生效，不需 `/reload`。檔案有誤（含未知鍵）時會詢問是否從預設值重來。
- 三個唯讀 deferred 工具（命名空間 `session`，用 `tool_search` 載入）：`session_window`（依行號範圍看對話大綱，規則同摘要的 L3：只有對話與進度錨點文字、不列工具；`before` 往前讀）、`session_grep`（字面關鍵字搜尋）、`session_read`（依行號讀原始 entry）；只讀目前 session 與其祖先 session。無指令；壓縮時由 `session_before_compact` hook 運作。
- hook 會產生確定性摘要（Pi 決定時機；切點預設取 Pi 的，但保留尾端超過 L1 預算時會被移到後面的合法切點，預設 30000 字元所以常會移動；切點之前的內容才進摘要）；設定無效、未知 context window 或失敗時交還 Pi。摘要末端附壓縮當下的背景 job／monitor 狀態與工作樹 HEAD／異動檔路徑（只有識別與狀態，不含輸出或 diff）。
- 與 Blackhole **只掛其一**：兩者同時掛載時不做協調。切換方式是在 Pi 的套件／extension 設定中啟用或排除對應入口，不是設定鍵。

## Config 與作用範圍

使用者層 `<agentDir>/auto-compact.json`（預設 `~/.pi/agent/auto-compact.json`，路徑由 Pi 的 agentDir 解析）。沒有專案層設定、沒有開關鍵；檔案可省略，省略的鍵用預設值。可用 `/settings:auto-compact` 編輯，也可直接改檔；兩種方式都不需 `/reload`。模組只讀不寫。

| 鍵 | 預設 | 範圍 |
|---|---|---|
| `checkpointRatio` | 0.5 | 大於 0 且至多 1；長任務中 context 自上次 assistant 文字或 `progress_checkpoint` 起增加此比例的 window 時，要求一次簡短進度回報；設為 1 等於關閉這個間隔觸發（壓縮前的死線觸發仍會在接近 Pi 壓縮門檻時要求一次，且為內部常數、不可設定） |
| `l1Ratio`、`l2Ratio`、`l3Ratio`、`l4Ratio` | 皆 0.01 | 大於 0 且至多 1 |
| `l1MinChars`、`l2MinChars`、`l3MinChars`、`l4MinChars` | 30000、20000、6000、6000 | 正整數 |
| `charsPerToken` | 2.2 | 1～8 |
| `maxTotalRatio` | 0.5 | 大於 0 且至多 1 |

各層預算 = `max(模型 context window × 比例, 最小值)` 字元。使用者訊息完整保留（超過該段預算一半才保留頭尾）；assistant 文字有上限，可用 `session_read` 讀全文；L2 實際預算 = 設定值 + L1 沒用完的部分（L1 常因平行工具結果切不開而用不滿）；L1 切點與 L2／L3 交界都純看預算；進度錨點只是 assistant 文字（交界之前的錨點會以文字出現在 L3）。比例預設 0.01，通常小於最小值，所以實際生效的多半是最小字元數（200k 窗口：L1 30000、L2 20000、L3 6000、L4 6000；比例要在 L1 約 300 萬、L2 約 200 萬、L3／L4 約 60 萬 token 的窗口才會超過最小值）。未知鍵、型別錯誤、超出範圍都是錯誤，不會退回其他值。

## 診斷

- 啟動後出現 `pi-auto-compact: … Compaction is left to Pi.` 警告：設定檔有誤，依訊息中的鍵與路徑修正；修正前壓縮由 Pi 處理。
- 想停用：從套件／extension 設定排除 Pi Auto Compact 入口，不要建立開關鍵。
- 想改用它取代 Blackhole：先排除 Blackhole 入口，再啟用本模組；不要兩者同時掛載。
