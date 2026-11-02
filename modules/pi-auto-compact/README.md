# Pi Auto Compact

原生模組：以**確定性純函式**壓縮歷史，**不呼叫任何模型**。把歷史由新到舊分成 L1（原樣）、L2（工具呼叫折成一行並附 session 檔行號參照）、L3（只留對話）三層，各有字元預算，溢出者滑動丟棄。完整設計見本機計畫 `plan/pi-auto-compact-plan.md`（`plan/` 不進版控）。

## 目前狀態：M2（折疊規則已寫、尚未接入 hook）

- 已註冊 `session_before_compact` hook 並驗證設定檔，**尚未產生任何摘要**：hook 一律回傳 `undefined`，壓縮完全交還 Pi。
- 只註冊一個唯讀工具 `session_read`（`defaultActive:false`，不會自動進入模型的工具清單，需用 `--tools` 或 `defaultTools` 啟用）；不註冊命令或訊息。
- `src/fold/` 的工具折疊註冊表與通用後備、`src/session-read/` 都已實作並有單元測試，但**還沒有被 hook 使用**；L1/L2/L3 往回填、固定狀態區塊、系統狀態移植依序為 M3～M4。是否預設啟用 `session_read` 留待接入 hook 時決定。

## 工具折疊（`src/fold/`）

純函式：`foldToolUse(call, result)` 把一組 tool call＋result 折成一行 `[tool] 關鍵參數 → 結果摘要 ⟦L<行>:<id 前 8 碼>⟧`。參照指向 session 檔裡**結果 entry** 的行號（檔頭為第 1 行），單行 ≥ 8KB 時附大小，例如 `⟦L1234:a1b2c3d4 · 82.0KB⟧`；對話（L3）的連續訊息合併成範圍 `⟦L120–124:a1b2c3d4⟧`（`formatRef`／`formatRange`）。沒有 session 檔（未持久化）時不附參照。

- **只用 session 實際持久化的資料**：`toolResult` 訊息只有 `content` 文字、`details`、`isError`、`durationMs`；`structuredContent` 不會被持久化，所以規則一律從文字與 `details` 取值（例如 bash 的退出碼來自文字尾端的 `Command exited with code N`，耗時來自 `durationMs`）。
- **不保留內容**：檔案內文、diff、網頁內文、搜尋 snippet、資料列、對端訊息內文、手冊文字一律不進折疊行；`pty_keyin` 不保留任何結果文字，失敗也只回報「失敗」。
- **遮罩與長度**：指令與 SQL 先遮罩常見憑證形狀（Bearer、`password=`、`--token`、URL 內帳密）再截斷；URL 去掉 query 與 fragment；每行去除控制字元與雙向字元。遮罩是盡力而為，不保證涵蓋所有形狀。
- **失敗保留較多**：失敗呼叫保留錯誤文字前 400 字元（web 與 remote 為 200）；bash／powershell 的非 0 退出是正常結果，由規則自行處理。
- **請求不等於完成**：cancel／kill／message 類工具的折疊行明寫「request／accepted 不代表已停止／已套用」。
- **未登記工具**走通用後備：參數摘要（含 `password`／`token`／`apiKey` 等鍵一律 `***`）＋輸出頭 200／尾 100 字元＋總字元數。規則拋例外時也退回通用後備，不退回原文。
- **配對**：`foldUnpairedCall`（沒有結果）與 `foldUnpairedResult`（找不到呼叫）都明確標記，不當成成功。
- 新增工具時：`tests/registry-coverage.test.ts` 會掃描各模組以字面名稱註冊的工具，未登記規則也未列入「通用後備白名單」就會失敗。動態命名的工具（如 `shell_job_*`、`mysql_*`）掃不到，由 `tests/fold.test.ts` 的明確清單把關。
- 尚未折疊的通知訊息（`fork-result`、`monitor_event`、`remote_message` 等 custom_message）屬 §4.3，留待 M3 之後。

## 回溯：`session_read`（`src/session-read/`）

session 檔是 append-only JSONL，行號一旦寫入就不變，所以參照可以跨多次壓縮使用。

`session_read({ line, id?, to_line?, session_id?, offset?, max_chars? })`：

- **範圍**：只讀目前 session，以及沿各檔 header `parentSession` 往上的祖先鏈（Fork 讀得到自己的來源，讀不到兄弟 session）。只跟隨首行是 session header 的 `.jsonl`，深度上限 16、遇環即停，所以被竄改的 `parentSession` 不能把它變成通用讀檔工具。`session_id` 不在鏈上時報錯並列出可讀的 id。
- **防誤讀**：帶 `id` 時，該行的 entry id 不符就報錯（並指出該 entry 實際在第幾行），不讀錯行。
- **防爆量**：逐行串流讀取，不整檔載入；單行超過 64MB 只回報大小；每次最多 20 行、預設 2 萬字元（上限 5 萬）。內容解碼成可讀文字，圖片、thinking 區塊與長 base64 換成佔位文字；超長 entry 以 `offset` 分段，輸出末尾會寫明下一次呼叫的 `line`／`offset`。
- 輸出去除控制字元與雙向字元。內容是同一 session 的原始資料（含當時的工具輸出），不是新的外洩面，但仍屬不受信任的歷史資料。
- 本工具自己的結果在日後被折疊時只留「讀了哪裡、多少字元」，不把內容再折進去。

## 只掛其一

本模組與 Blackhole **只掛其一**。兩者都掛在 `session_before_compact`，同時掛載時**不做任何協調**，行為未定義。切換方式是在 Pi package 設定中啟用／停用對應的 extension 入口（`./modules/pi-auto-compact/src/index.ts` 或 `./modules/blackhole/src/index.ts`），不是設定鍵；也不修改 Blackhole 的任何設定。

## 設定

使用者層 `<agentDir>/auto-compact.json`（預設 `~/.pi/agent/auto-compact.json`，路徑由 Pi 的 agentDir 解析）。檔案可省略；省略的鍵使用預設值。本模組只讀不寫，載入 extension 不改任何 settings。**沒有開關鍵**，也沒有專案層設定。

| 鍵 | 預設 | 範圍 | 說明 |
|---|---|---|---|
| `l1Ratio`／`l1MinChars` | 0.3／30000 | 比例 (0,1]；正整數 | L1 預算 = `max(ctx × 比例, 最小值)` 字元，`ctx` 為模型 context window 的 token 數 |
| `l2Ratio`／`l2MinChars` | 0.2／20000 | 同上 | L2 預算 |
| `l3Ratio`／`l3MinChars` | 0.1／10000 | 同上 | L3 預算 |
| `charsPerToken` | 2.2 | 1～8 | 估算 token 用；Pi 內建為 4，中文為主的 session 實測約 2.2 |
| `maxTotalRatio` | 0.5 | (0,1] | 估算總量占 context window 的硬上限；超過時先縮 L3、再縮 L2，不縮 L1 |

- 未知鍵、型別錯誤或超出範圍都是**錯誤**，不退回其他值；hook 會以 warning 通知一次（有 UI 時），並把壓縮交還 Pi。
- 檔案不存在視為全部預設。

## 驗證

`npm run test:module -- pi-auto-compact`：設定預設值／覆寫／嚴格驗證／唯讀、hook 註冊與交還 Pi 的行為、全部已登記工具的折疊規則與安全性（不洩漏內容、遮罩、截斷、失敗保留、請求≠完成）、通用後備、工具註冊覆蓋掃描、參照格式，以及 `session_read` 的串流讀行、描畫、祖先鏈範圍與環／偽造 header、id 驗證、分頁與大 entry。尚未做真實 Pi host 的整合測試（M5）。
