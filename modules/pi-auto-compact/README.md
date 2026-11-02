# Pi Auto Compact

原生模組：以**確定性純函式**壓縮歷史，**不呼叫任何模型**。把歷史由新到舊分成 L1（原樣）、L2（工具呼叫折成一行並附 session 檔行號參照）、L3（只留對話）三層，各有字元預算，溢出者滑動丟棄。完整設計見本機計畫 `plan/pi-auto-compact-plan.md`（`plan/` 不進版控）。

## 目前狀態：M4（摘要含系統狀態與工作樹；真實 host 整合為 M5）

- `session_before_compact` hook 現在會產生確定性摘要：Pi 仍決定何時壓縮與切點，本模組原樣回傳 `preparation.firstKeptEntryId`（切點之後是 L1 原樣訊息），只替換切點之前的摘要，不呼叫任何模型。
- 以下情況一律回傳 `undefined`，把壓縮交還 Pi：設定檔無效（有 UI 時警告一次）、`ctx.model.contextWindow` 未知、切點不在分支上或切點之前沒有內容、任何非預期例外（警告一次，壓縮不會因此遺失）。
- 摘要由切點之前的 branch entries 每次重建（純函式，同輸入同位元組）：先 `buildItems`（套用 `context_edit`、配對工具呼叫與結果；先前的 compaction entry 不當來源，只讀它 `details` 中記錄的視窗起點，且只認本模組、版本 1 的紀錄），再依 `layout` 決定 L2／L3 邊界，最後組裝。
- 摘要順序：固定首行（session id、視窗起點 `⟦L<行>:<id>⟧`、更早歷史用 `session_window before=<行>`，並提示三個 session 工具需經 `tool_search` 載入——**提示但不預設啟用**）→ 目標（第一則使用者訊息）→ `## Earlier conversation`（L3，含 L4 緩衝）→ `## Recent activity`（L2，折疊工具行）→ `## State at compaction`（異動檔案、commit）→ 壓縮當下的系統狀態：`[Background Jobs]`、`[Active Monitors]`、`Working tree at compaction`（每次都會變，所以固定放最末）。
- 對話文字原樣保留（上限 400／1200 字）；工具輸出尾端與 shell 指令會遮罩憑證；通知訊息只留 kind／status／id 與 `agent:status`，自由文字丟棄；thinking、檔案內容、圖片不進摘要。
- 總量保險：`maxTotalRatio × contextWindow × charsPerToken` 對摘要加上切點後保留尾端（L1）的估計字元；超過時依序放棄 L4 緩衝（起點重設）→ 縮 L3 → 縮 L2，不動 L1，仍超過就只剩固定區塊。
- `details` 記錄 `{compactor:'pi-auto-compact', version:1, windowStart:{entryId,line,sessionId}, stats}`（不送給模型）；`stats.windowStartKept` 與 `guard` 可用來檢視快取穩定度。
- 系統狀態（`src/state/`）：`jobs.ts`、`monitors.ts` 自 Blackhole 移植，**輸出與 Blackhole 逐字相同**（已用同一批輸入比對），資料來自 `modules/shell-tools/src/monitor-capability.ts` 的唯讀 briefs（相對 import，需 owner sessionId＋canonical cwd 相符；只有 ID、狀態、時限、label，無指令／輸出／路徑；讀取失敗回空字串，不阻擋壓縮）。`worktree.ts` 以有時限、有輸出上限的 `git`（移除 `GIT_DIR` 等重導向變數）取 HEAD、分支與異動檔路徑＋單字標籤（new／unstaged／staged／deleted／renamed／conflicted），最多 20 筆，不含 diff 或內容；非 git 目錄、逾時、中止都回空。這三塊不帶 Blackhole 的 span 證明機制：摘要每次從原始分支重建，不會 carry forward。
- 尚未做：真實 host 整合測試（M5）、跨壓縮共同前綴比較（M6）。
- 只註冊三個唯讀、deferred 的 session 工具（`session_grep`／`session_window`／`session_read`，命名空間 `session`，由 `tool_search` 載入，註冊時不會被啟用）；不註冊命令或訊息。

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
- 通知訊息（`fork-result`、`monitor_event`、`remote_message` 等 custom_message）在摘要中只保留識別欄位（見上）；各類專屬折疊規則仍屬計畫 §4.3。

## 回溯：session 工具（`src/session-read/`）

壓縮後可見的歷史可能從很後面才開始，更早的內容只剩摘要裡的參照。三個唯讀工具構成漏斗：先用**大綱或關鍵字**確定範圍，再用 `session_read` 讀細節。三者都是 deferred（命名空間 `session`），都用 session 檔行號當參照；session 檔是 append-only JSONL，行號一旦寫入就不變，可跨多次壓縮使用。

共同規則：

- **範圍**：只讀目前 session，以及沿各檔 header `parentSession` 往上的祖先鏈（Fork 讀得到自己的來源，讀不到兄弟 session）。只跟隨首行是 session header 的 `.jsonl`，深度上限 16、遇環即停，所以被竄改的 `parentSession` 不能把它變成通用讀檔工具。`session_id` 不在鏈上時報錯並列出可讀的 id。
- **防爆量**：逐行串流讀取，不整檔載入；單行超過 64MB 只回報大小；圖片、thinking 區塊與長 base64 一律換成佔位文字或略過；輸出去除控制字元與雙向字元。
- 內容是同一 session 的原始資料（含當時的工具輸出），不是新的外洩面，但仍屬不受信任的歷史資料。
- 這些工具自己的結果日後被折疊時只留「查了哪裡、多少筆」，不把內容再折進去。

### `session_read({ line, id?, to_line?, session_id?, offset?, max_chars? })`

讀回一或多個 entry 的原文（解碼成可讀文字）。帶 `id` 時，該行 entry id 不符就報錯並指出該 entry 實際在第幾行，不讀錯行。每次最多 20 行、預設 2 萬字元（上限 5 萬）；超長 entry 以 `offset` 分段，輸出末尾寫明下一次呼叫的 `line`／`offset`。

### `session_window({ from?, to?, before?, count?, session_id?, max_chars? })`

範圍大綱：user／assistant 文字截短、每個工具呼叫以折疊規則折成一行並附結果行的參照、compaction 邊界標示。`before=<行>` 專門往前讀（壓縮後起點不是第 1 行時用）。呼叫在範圍尾端時往後看 60 行找結果，結果在範圍起點時往前看 40 行找呼叫，找不到才標 `(unpaired)`。session 檔含所有分支，**被放棄分支的 entry 標 `(other branch)`**（以目前 leaf 沿 `parentId` 判定；連結不完整時不過濾，寧可多顯示也不隱藏歷史）。每次最多 400 行、預設 8000 字元，輸出末尾給下一次的 `from` 與往前的 `before`。

### `session_grep({ pattern, role?, tool?, from?, to?, include_other_branches?, limit?, session_id? })`

在解碼後的對話文字（user／assistant 文字、工具呼叫參數、工具結果、compaction 摘要）裡找關鍵字，每個符合的 entry 一行：參照＋短片段（前後各 80 字，經憑證遮罩與控制字元清除）＋出現次數。**只做字面比對、不分大小寫、不支援 regex**（模型給的 pattern 不能拖垮行程）；pattern 2～200 字元。thinking 與圖片不搜；被放棄分支預設排除並回報被隱藏的筆數，`include_other_branches` 可開啟。預設最多 30 筆（上限 100）、10 秒時間上限，皆附 `from` 續查；支援取消。

## 只掛其一

本模組與 Blackhole **只掛其一**。兩者都掛在 `session_before_compact`，同時掛載時**不做任何協調**，行為未定義。預設 manifest 只掛本模組；要改用 Blackhole，需自行在 Pi 的套件設定加入 `./modules/blackhole/src/index.ts` 並排除本模組入口（`./modules/pi-auto-compact/src/index.ts` 或 `./modules/blackhole/src/index.ts`），不是設定鍵；也不修改 Blackhole 的任何設定。

## L3 視窗起點與 L4 緩衝（M3 已實作）

摘要放在 context 最前面，所以摘要**開頭**一旦改變，system prompt 之後的 prompt 快取就全部失效。L3 滿了之後若每次壓縮都丟掉最舊的一段，開頭每次都變。因此視窗起點 S 要另外記錄，並用遲滯控制它的移動：

- 摘要從 S 顯示到 L2 邊界。每次壓縮先算 S 到邊界的大小：不超過 `L3+L4` 就**不動 S**（摘要只在尾端增長，前段逐位元組相同）；超過就一次重設，S 改為「從邊界往回數剛好 `L3`」的位置，L4 清空。起點變動頻率降為原本的 `L4 ÷ 每次壓縮的增量`。
- L4 的內容**必須顯示**在摘要裡（隱藏的話摘要仍會位移，沒有快取效益）；它只是 L3 的溢出空間，不是獨立的一層。
- **起點記錄**：以 compaction entry 的 `details` 為準（機器讀、不送進模型；以 entry id 為準，行號只用來顯示，因為 Fork 複製的 entry id 不變、行號會變）；摘要第一行寫成固定句式 `History shown from ⟦L<行>:<id>⟧; earlier: session_window before=<行>` 供模型看。只有重設時這行才變，而重設時本來就整份失效，沒有額外成本。
- 下一次壓縮沿目前分支找最近一個 compaction entry 讀 `details`；找不到（entry 已不在分支、上次是 Pi 自己壓的、`details` 缺失）就從 L3 名目起點重算，只破壞一次快取。
- **逐位元組穩定**：每個項目的呈現只能依自己的內容，不依預算或位置；摘要第一行與 L3 區段不放會變動的東西（計數、壓縮次數、時間、總字數）；會變動的固定狀態區塊放在摘要**最尾端**。
- 已知限制：L2 的項目變老降為 L3 時折疊行會被刪掉，改寫 L2/L3 交界之後的文字（交界之前的前段仍穩定）。對這個交界做同樣的批次移動留待量測後再決定。
- 驗證指標：M6 比較腳本量「相鄰兩次摘要的最長共同前綴」。

## 設定

使用者層 `<agentDir>/auto-compact.json`（預設 `~/.pi/agent/auto-compact.json`，路徑由 Pi 的 agentDir 解析）。檔案可省略；省略的鍵使用預設值。本模組只讀不寫，載入 extension 不改任何 settings。**沒有開關鍵**，也沒有專案層設定。

| 鍵 | 預設 | 範圍 | 說明 |
|---|---|---|---|
| `l1Ratio`／`l1MinChars` | 0.3／30000 | 比例 (0,1]；正整數 | L1 預算 = `max(ctx × 比例, 最小值)` 字元，`ctx` 為模型 context window 的 token 數 |
| `l2Ratio`／`l2MinChars` | 0.2／20000 | 同上 | L2 預算 |
| `l3Ratio`／`l3MinChars` | 0.1／10000 | 同上 | L3 預算 |
| `l4Ratio`／`l4MinChars` | 0.1／10000 | 同上 | L4 = L3 視窗的**溢出緩衝**（見下節）。摘要的 L3 區段大小在 `L3` 到 `L3+L4` 之間浮動 |
| `charsPerToken` | 2.2 | 1～8 | 估算 token 用；Pi 內建為 4，中文為主的 session 實測約 2.2 |
| `maxTotalRatio` | 0.5 | (0,1] | 估算總量（最壞情況 L2＋L3＋L4）占 context window 的硬上限；超過時先重設視窗起點、再縮 L3、再縮 L2，不縮 L1 |

- 未知鍵、型別錯誤或超出範圍都是**錯誤**，不退回其他值；hook 會以 warning 通知一次（有 UI 時），並把壓縮交還 Pi。
- 檔案不存在視為全部預設。

## 驗證

`npm run test:module -- pi-auto-compact`：設定預設值／覆寫／嚴格驗證／唯讀、hook 註冊與交還 Pi 的行為、全部已登記工具的折疊規則與安全性（不洩漏內容、遮罩、截斷、失敗保留、請求≠完成）、通用後備、工具註冊覆蓋掃描、參照格式，以及三個 session 工具的串流讀行、描畫、祖先鏈範圍與環／偽造 header、id 驗證、分頁與大 entry、大綱的配對與分支標示、grep 的遮罩與過濾。尚未做真實 Pi host 的整合測試（M5）。
