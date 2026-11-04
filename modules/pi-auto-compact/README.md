# Pi Auto Compact

原生模組：以**確定性純函式**壓縮歷史，**不呼叫任何模型**。把歷史由新到舊分成 L1（原樣）、L2（工具呼叫折成一行並附 session 檔行號參照）、L3（只留對話）三層，各有字元預算，溢出者滑動丟棄。完整設計見本機計畫 `plan/pi-auto-compact-plan.md`（`plan/` 不進版控）。

## 目前狀態：M5＋進度錨點（真實 host 整合測試已加入；比較腳本為 M6）

- `session_before_compact` hook 現在會產生確定性摘要：Pi 決定何時壓縮；切點預設取 `preparation.firstKeptEntryId`，但 Pi 保留的尾端超過 L1 預算時，本模組回傳的 `firstKeptEntryId` 會被移到後面的合法切點（見下；預設 L1 為 30000 字元，小於 Pi 預設保留量，所以**預設設定下切點常會被移動**）。切點之後是 L1 原樣訊息，只替換切點之前的摘要，不呼叫任何模型。
- 以下情況一律回傳 `undefined`，把壓縮交還 Pi：設定檔無效（有 UI 時警告一次）、`ctx.model.contextWindow` 未知、切點不在分支上或切點之前沒有內容、任何非預期例外（警告一次，壓縮不會因此遺失）。
- 摘要由切點之前的 branch entries 每次重建（純函式，同輸入同位元組）：先 `buildItems`（套用 `context_edit`、配對工具呼叫與結果；先前的 compaction entry 不當來源，只讀它 `details` 中記錄的視窗起點，且只認本模組、版本 1 的紀錄），再依 `layout` 決定 L2／L3 邊界，最後組裝。
- 摘要順序：固定首行（session id、視窗起點 `⟦L<行>:<id>⟧`、更早歷史用 `session_window before=<行>`，並提示三個 session 工具需經 `tool_search` 載入——**提示但不預設啟用**）→ 目標（第一則使用者訊息）→ `## Earlier conversation`（L3，含 L4 緩衝）→ `## Recent activity`（L2，折疊工具行）→ `## State at compaction`（異動檔案、commit；工作目錄內的檔案以相對路徑顯示、同一檔案的絕對與相對寫法合併為一筆，目錄外維持絕對路徑）→ 壓縮當下的系統狀態：`[Background Jobs]`、`[Active Monitors]`、`Working tree at compaction`（每次都會變，所以固定放最末）。
- **使用者訊息完整保留**（L3、L2、`session_window` 都是；使用者常把真正的要求寫在最後一句，附圖標記 `[+N image]` 也在尾端）：只有超過該段設定預算一半的訊息（L3 預設 3000、L2 預設 10000 字元，`session_window` 固定 3000）才保留頭 60%、尾 40%，中間寫 `[… N chars omitted …]`，避免一次貼上的大塊資料吃掉整段；原文用參照 `session_read` 讀。上限只看設定預算、不含 L1 借來的部分，所以渲染不隨 L1 填充量變動。assistant 文字仍有上限（L3 400、L2 1200 字），同樣可由參照讀全文；工具輸出尾端與 shell 指令會遮罩憑證；通知訊息只留 kind／status／id 與 `agent:status`，自由文字丟棄；thinking、檔案內容、圖片不進摘要。
- L1 預算：Pi 的 `keepRecentTokens` 以 4 字元一個 token 估算，但 JSON、程式碼、中文與工具輸出實際接近 2.2 字元一個 token（實測一個 207k 的 session：Pi 以為保留 20k，實際約 34k）。保留尾端的字元數超過 `max(ctx × l1Ratio, l1MinChars)` 時，切點移到下一個合法切點（user／assistant／bashExecution／custom_message／branch_summary，永不落在 tool result 上，可落在同一個 turn 中間，與 Pi 自己的 split turn 相同）使尾端符合預算；沒有任何切點符合時用最後一個，至少保留一點原樣內容，工具呼叫仍與結果同在。被移出的內容進摘要；`details.stats.cutMoved` 記錄移了幾個 entry。預設 L1 為 30000 字元（約 14k tokens），Pi 保留的尾端較大時切點會往後移。
- 總量保險：`maxTotalRatio × contextWindow × charsPerToken` 對摘要加上切點後保留尾端（L1）的估計字元；超過時依序放棄 L4 緩衝（起點重設）→ 縮 L3 → 縮 L2，不動 L1，仍超過就只剩固定區塊。
- `details` 記錄 `{compactor:'pi-auto-compact', version:1, windowStart:{entryId,line,sessionId}, stats}`（不送給模型）；`stats.windowStartKept` 與 `guard` 可用來檢視快取穩定度。
- 系統狀態（`src/state/`）：`jobs.ts`、`monitors.ts` 資料來自 `modules/shell-tools/src/monitor-capability.ts` 的唯讀 briefs（相對 import，需 owner sessionId＋canonical cwd 相符；只有 ID、狀態、時限、label，無指令／輸出／路徑；讀取失敗回空字串，不阻擋壓縮）。`worktree.ts` 以有時限、有輸出上限的 `git`（移除 `GIT_DIR` 等重導向變數）取 HEAD、分支與異動檔路徑＋單字標籤（new／unstaged／staged／deleted／renamed／conflicted），最多 20 筆，不含 diff 或內容；非 git 目錄、逾時、中止都回空。這三塊不 carry forward：摘要每次從原始分支重建，不會 carry forward。
- 真實 host 測試（`tests/real-host.integration.test.mjs`＋`tests/fixtures/real-host.mjs`，約 12 秒，屬一般整合組、非重型組）：以真實 Pi 1.5.0 SDK 建隔離 session（隔離 home／agentDir／workspace、離線假 provider、`fetch` 一律拒絕），直接用 `SessionManager` 灌入含工具呼叫、`write`、`git commit` 的歷史，再呼叫 `session.compact()` 走真實壓縮流程。三個情境：`full`（壓縮持久化、`firstKeptEntryId` 與 `tokensBefore` 沿用 Pi、摘要中每個 `⟦L行:id⟧` 都指到該行真實 entry、重新 `SessionManager.open` 後 context 恰為「摘要＋Pi 保留的尾端」、第二次壓縮保留視窗起點且摘要開頭逐位元組不變、`[Background Jobs]`／`[Active Monitors]` 在最末、檔案內容不進摘要、三個 session 工具在真實 host 啟用並讀到壓縮掉的內容、全程 `providerCalls: 0`）、`invalid-config` 與 `unknown-window`（交還 Pi，Pi 自己產生並持久化摘要）。只驗證手動 `session.compact()`（`reason: "manual"`）；自動 threshold／overflow 路徑尚未以真實 host 驗證。
- 儲存點時序測試（`tests/deadline-timing.integration.test.mjs`＋`tests/fixtures/deadline-timing-host.mjs`，約 22 秒，一般整合組）：真實 Pi 1.5.0 `AgentSession`、Pi 原生門檻壓縮（自動 threshold 路徑）、離線 provider（usage 由腳本決定）。**不載入本模組**，只固定設計依賴的 Pi 時序（計畫 §13）：`turn_end` 追加的草稿在下一次回應前被計入門檻估算、請求在壓縮先發生時仍會留下並於壓縮後被回答、壓縮前已回答的回答會留在保留尾端。它只固定 Pi 的時序；本模組的死線觸發由下方的 `tests/deadline-host.integration.test.mjs` 驗證。
- 進度錨點（長任務的斷點）：單一超大回合（同一個請求下連續大量工具呼叫、沒有任何 assistant 文字）會讓摘要的對話層是空的、L1 切點也沒有清楚的位置。因此 context 用量（`ctx.getContextUsage()`）自上次 assistant 文字或錨點呼叫起增加 `checkpointRatio × contextWindow`（預設 0.5）、**且 context 大於 `checkpointMinTokens`**（預設 200000，只在大 context 才啟用；`0` 完全停用間隔觸發）時，在 `turn_end` 邊界追加一則標記過的 `custom_message`（`pi-auto-compact:checkpoint`，`display:false`）並要求繼續，請模型回報 2 到 4 句進度後繼續；每累積一次門檻只要求一次（要求後基準前移，未回應也不重複）。
  - 回報優先用錨點工具 `progress_checkpoint({ summary })`（`defaultActive:true`，仍受宿主 allowlist／exclusions 控制；AGENTS.md 已記錄為例外）：工具呼叫一定會回到模型，所以不會像純文字回覆那樣讓 run 結束。工具不在 active 清單時改要求文字回報；文字回報後若 run 就要結束，會在 `agent_before_settle` 追加**一則**繼續訊息（`pi-auto-compact:continue`）。每次繼續都綁定恰好一次檢查點要求，不會自行重複，因此不設上限。
  - **死線觸發**（與上面的間隔觸發並存，訊息與回應處理分開）：壓縮是確定性的、不呼叫模型，所以模型的決策與進度只能在壓縮之前自行記錄。這是行為引導、不是要求工具：追加一則固定英文短句訊息（`pi-auto-compact:deadline`，`display:false`），說明壓縮即將發生，請把任務進度寫入筆記檔（該任務已有筆記檔就更新，否則建立；`note` 工具啟用時用它建立並取得路徑，後續以 edit 更新），回覆中寫出路徑後繼續任務。寫什麼由模型決定，不要求 `progress_checkpoint`。`turn_end` 時用 `ctx.getContextUsage()`（與 Pi 回應前的門檻檢查是同一個估算）與 Pi 壓縮門檻 `T = contextWindow − reserveTokens` 比較，`reserveTokens` 由 `pi.getSettings()` 依 `compaction.modelOverrides["<provider>/<id>"].reserveTokens` → `compaction.reserveTokens` → 16384 解析（`src/checkpoint/threshold.ts`；解析函式未暴露給擴充，所以重現一份，並由 `tests/threshold.test.ts` 以真實 `SettingsManager` 對照，Pi 拋錯的輸入這裡回「未知」）。五個條件同時成立才送出：`T` 已知（壓縮啟用、設定有效、視窗已知）、API 回報用量 ≥ `T − max(0.1 × contextWindow, 20000)`、回報用量 < `T`、本壓縮週期還沒送過、agent 有可寫檔工具（`note`／`write`／`edit` 任一在 active 清單；唯讀 agent 無法照做，所以略過）。用量取該回合 assistant 回應的 `usage`（`totalTokens`，缺席則四項相加，與 Pi 的 `calculateContextTokens` 相同），這正是 Pi 在回應後判斷是否壓縮所用的數字；不用 `ctx.getContextUsage()`，因為它是「上一次回報用量 + 其後訊息（本回合的工具結果、追加的通知）以約 4 字元一 token 估算」，中文與程式碼的工具結果會被低估（實測一次 `read` 批次真實增加約 13.4k、估算只有約 11.7k，通知在估算還低於門檻時送出，下一個回應卻已超過）。回報缺席（回應錯誤、被中止、零用量、provider 不回報）才退回 Pi 的估算。用量已達 `T` 時 Pi 在該回應後立刻壓縮，所以不送；用量在 `T` 之下但下一個回應越過時，該回應仍會發生並可寫筆記，壓縮接在其後。每個壓縮週期只送一次，不論模型是否照做，也不看先前有沒有 `progress_checkpoint` 或文字回報（筆記檔是另一種紀錄，不由回報取代）；壓縮或新 session（`session_start`）才重置，新的使用者訊息不重置（context 沒有縮小）；回合同時帶文字與工具呼叫也照送。通知後第一個沒有工具呼叫的回合（即使前面已有幾個工具回合，例如先用 `note` 寫筆記）只回文字、run 就要結束時，沿用同一則繼續訊息，每則通知只補一次；壓縮、新的使用者請求或新 session 會關閉尚未回答的通知；帶工具呼叫的回合不追加（結果本來就會回到模型）。摘要不含筆記內容，所以 system prompt section 提示壓縮後先讀筆記檔。比例 `0.1` 是內部常數、不是設定鍵，下限是設定鍵 `deadlineMarginMinTokens`（預設 20000）；依據是三輪實測共 296 個回合的每回合 context 增量（中位數 848、p90 3.6k、p95 8.8k、p99 17k token，重尾來自一次寫入大檔案）估算「被單一回合跳過」的比例：margin 取 3.7k 約 30%、10k 約 8%、15k 約 2%；樣本只有一種任務與一個模型。下限 20000 來自後續真實執行：100k 視窗下單回合一次讀三個大檔增加約 15k，比例邊際（10k）跨過去而漏掉通知，所以小視窗以下限為準（100k 視窗為 20k，200k 視窗恰好等於 0.1 × 視窗）。想關掉間隔觸發、只留死線，把 `checkpointMinTokens` 設為 0。
  - **不設固定區塊**：曾實作過把最新回報釘在摘要「State at compaction」之前，已移除——它會讓往前幾步的狀態看起來像壓縮當下的狀態，也與時間線重複一份；回報只出現在時間線（L1 原樣、L2／L3 的對話行）上它發生的位置。代價：回報若很長或早已被預算擠出視窗，摘要裡只剩截短版或沒有（L3 把 assistant 文字截到 400 字元，可用 `session_read` 讀全文）；死線的進度紀錄寫在筆記檔，不依賴摘要。
  - 錨點對壓縮等同 assistant 文字訊息：計數器歸零（任何 assistant 文字亦同）；摘要把 `summary` 當作該 assistant 訊息的文字（進 L3 對話層），錨點呼叫與其 tool result 不再另列；**L1 切點與 L2／L3 交界都純看預算**（L1：最早能放進預算的合法切點；L2：能放進預算的最新一段），不受錨點影響。錨點的唯一作用是被當作 assistant 文字，所以交界落在長 turn 中間時，交界之前的錨點會以文字出現在 L3（工具行已被 L3 規則去掉）。
  - 提示訊息只是觸發器：不進摘要，且一旦分支內已有 compaction，已被回答的提示會由 `context` 事件自模型 context 移除（session 檔保留原樣，`session_grep` 仍查得到）。
  - 主對話、Fork、Subagent 各自獨立計數，同一個 extension 掛載即生效；Subagent 子行程若有明確的 `--tools` 清單，argument builder 會附上 `progress_checkpoint`（`+name`／`-name` 清單附 `+progress_checkpoint`）。
  - 真實 host 測試（`tests/fixtures/checkpoint-host.mjs`）以離線 provider 驗證錨點與文字兩種路徑；Fork 與 Subagent 子行程的實際載入尚未以真實子行程驗證。死線觸發有 `tests/deadline-host.integration.test.mjs`＋`tests/fixtures/deadline-host.mjs`（約 12 秒，一般整合組）：真實 Pi 1.5.0 `AgentSession`、載入本模組、Pi 原生門檻壓縮由本模組的確定性摘要回應（`providerCalls` 等於腳本請求數，沒有摘要呼叫）、usage 由腳本決定、間隔觸發關閉（`checkpointMinTokens: 0`）。兩個情境：`reported`（進入區間後下一個請求才收到通知、以 `note` 工具回答、之後壓縮、壓縮後模型看得到摘要）與 `missed`（單一回應回報的用量直接越過門檻，不追加通知）。限制：usage 是腳本值、沒有 thinking、單一模型尺寸；fixture 的 `note` 是離線替身、不含真實 Note Tools 模組；模型是否照通知寫筆記無法由離線腳本驗證，只固定通知的條件與時機；文字回覆路徑只有單元測試。
- System prompt：`before_agent_start` 寫入結構化 section `pi_better_tools_auto_compact`（`src/guidance.ts`，固定文字約 170 token，不影響快取；設定檔無效、壓縮交還 Pi 時移除；與 forced／custom prompt 並存的處理同 Shell 的背景生命週期 section，不整份覆蓋）。內容：舊訊息被確定性摘要取代、`⟦L<行>:<id>⟧` 與回溯工具（`tool_search "session"` 載入、`session_read`／`session_grep`）、先看摘要再決定是否重讀、**回報進度或完成任務時第一句先講結論**（assistant 文字被截短時保留開頭）。風格指示只限進度回報與完成回報，不改變一般回覆。實際效果以任務試驗（`tools/pi-auto-compact-bench/`）量測，不假設有效。
- 設定面板：`/settings:auto-compact`（`src/settings.ts`，共用層 `modules/pi-runtime/src/settings-panel/`）。兩頁：Budgets（L1～L4 各自的比例與最小字元數）、Limits（總量上限、每 token 字元數、錨點間隔）；數值欄位為文字輸入，**留空＝使用預設值**（預設值以淡色佔位顯示），存檔時刪除該鍵。驗證與錯誤訊息直接用 `parseConfig` 的規則（錯誤不回顯輸入值）。面板頂端顯示目前模型的有效預算（`max(視窗 × 比例, 最小值)`，取自磁碟上的檔案，不含未存檔的編輯）。不需 trust（使用者層檔案）；非 TUI 拒絕並說明檔案位置；檔案無效（含未知鍵）時詢問是否從預設值重來，存檔會取代該檔。只有按存檔才寫入（保留未改的鍵、原子寫入、沒有鍵時刪檔）；存檔後**不問 reload**（`SettingsSchema.appliesWithoutReload`）。
- 尚未做：跨壓縮共同前綴比較（M6）。
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

讀回一或多個 entry 的原文（解碼成可讀文字）。帶 `id` 時，該行 entry id 不符就報錯並指出該 entry 實際在第幾行，不讀錯行。**目標檔案裡找不到該 id（或行號超過檔尾）時，會在其他可讀的 session（目前 session 與祖先鏈）依序搜尋一次，由第一個含有該 id 的 session 讀回**，結果開頭註明改讀了哪個 session 與行號，`details.redirectedFrom` 記錄原定 session：Fork 的 session 檔只含父代的 active branch（`modules/fork/src/snapshot.ts`），父代產生的參照可能指向 Fork 檔案沒有的條目或超出檔尾的行號。這只在帶 `id` 時發生（沒有 id 無從搜尋，仍照行號讀），且仍限於可讀鏈內；同檔內 id 在別行時維持原本的報錯與修正行號，不轉讀；各 session 都找不到則報錯並列出已搜尋的 session。每次最多 20 行、預設 2 萬字元（上限 5 萬）；超長 entry 以 `offset` 分段，輸出末尾寫明下一次呼叫的 `line`／`offset`。

### `session_window({ from?, to?, before?, count?, session_id?, max_chars? })`

範圍大綱：**與摘要的 L3 規則相同**：只列 user／assistant 文字（截短），進度錨點（`progress_checkpoint`）的報告算 assistant 文字，所以長任務依然看得出脈絡、也能以錨點為段落邊界；shell 指令、備註與 compaction 邊界照列；**不列任何工具呼叫或結果**（只呼叫工具的 assistant 訊息不顯示）。要看工具細節用 `session_read`，要找工具內容用 `session_grep`。`before=<行>` 專門往前讀（壓縮後起點不是第 1 行時用）。session 檔含所有分支，**被放棄分支的 entry 標 `(other branch)`**（以目前 leaf 沿 `parentId` 判定；連結不完整時不過濾，寧可多顯示也不隱藏歷史）。每次最多 400 行、預設 8000 字元，輸出末尾給下一次的 `from` 與往前的 `before`。

### `session_grep({ pattern, role?, tool?, from?, to?, include_other_branches?, limit?, session_id? })`

在解碼後的對話文字（user／assistant 文字、工具呼叫參數、工具結果、compaction 摘要）裡找關鍵字，每個符合的 entry 一行：參照＋短片段（前後各 80 字，經憑證遮罩與控制字元清除）＋出現次數。**只做字面比對、不分大小寫、不支援 regex**（模型給的 pattern 不能拖垮行程）；pattern 2～200 字元。thinking 與圖片不搜；被放棄分支預設排除並回報被隱藏的筆數，`include_other_branches` 可開啟。預設最多 30 筆（上限 100）、10 秒時間上限，皆附 `from` 續查；支援取消。

## 只掛其一

是否啟用由 extension 入口是否掛載決定（預設 manifest 已掛載；排除 `./modules/pi-auto-compact/src/index.ts` 即回到 Pi 原生壓縮），不是設定鍵。

## L3 視窗起點與 L4 緩衝（M3 已實作）

摘要放在 context 最前面，所以摘要**開頭**一旦改變，system prompt 之後的 prompt 快取就全部失效。L3 滿了之後若每次壓縮都丟掉最舊的一段，開頭每次都變。因此視窗起點 S 要另外記錄，並用遲滯控制它的移動：

- 摘要從 S 顯示到 L2 邊界。每次壓縮先算 S 到邊界的大小：不超過 `L3+L4` 就**不動 S**（摘要只在尾端增長，前段逐位元組相同）；超過就一次重設，S 改為「從邊界往回數剛好 `L3`」的位置，L4 清空。起點變動頻率降為原本的 `L4 ÷ 每次壓縮的增量`。
- L4 的內容**必須顯示**在摘要裡（隱藏的話摘要仍會位移，沒有快取效益）；它只是 L3 的溢出空間，不是獨立的一層。
- **起點記錄**：以 compaction entry 的 `details` 為準（機器讀、不送進模型；以 entry id 為準，行號只用來顯示，因為 Fork 複製的 entry id 不變、行號會變）；摘要第一行寫成固定句式 `History shown from ⟦L<行>:<id>⟧; earlier: session_window before=<行>` 供模型看。只有重設時這行才變，而重設時本來就整份失效，沒有額外成本。
- 下一次壓縮沿目前分支找最近一個 compaction entry 讀 `details`；找不到（entry 已不在分支、上次是 Pi 自己壓的、`details` 缺失）就從 L3 名目起點重算，只破壞一次快取。
- **逐位元組穩定**：每個項目的呈現只能依自己的內容，不依預算或位置；摘要第一行與 L3 區段不放會變動的東西（計數、壓縮次數、時間、總字數）；會變動的固定狀態區塊放在摘要**最尾端**。
- 已知限制：L2 預算含 L1 借來的部分，所以連續**手動**壓縮（兩次之間歷史幾乎沒增加）時，L2/L3 交界可能比上次靠前，交界之後的前綴快取會失效一次；自動壓縮兩次之間歷史會前進很大一段，借用量折成 L2 後遠小於它，實際上不會倒退，因此不另外記錄交界做單調限制。
- 已知限制：L2 的項目變老降為 L3 時折疊行會被刪掉，改寫 L2/L3 交界之後的文字（交界之前的前段仍穩定）。對這個交界做同樣的批次移動留待量測後再決定。
- 驗證指標：M6 比較腳本量「相鄰兩次摘要的最長共同前綴」。

## 使用邊界與真實模型實測

**邊界：只存在於工具輸出裡的資訊，在 L3 視窗起點滑動後會掉。** L3 保留的是 user／assistant 文字（與進度錨點報告），不保留工具輸出；L2 只留折疊行，也不含內容。所以：

- 規則、需求、約束寫在**使用者訊息**裡 → 安全。使用者訊息完整保留，而且「Goal (first request)」一行放的是第一個請求的完整文字，視窗起點滑過它之後仍在摘要開頭。
- 寫在 `AGENTS.md` 或 system prompt → 安全（每輪由宿主注入，不經壓縮）。
- 只存在於某次 `read` 的結果（例如 agent 讀 `PROMPT.md` 才知道規則）→ 視窗起點滑過之後摘要裡沒有它。agent 若手邊還有可抄的範例（例如最近寫過的檔案在 L1 尾端）通常照樣遵守，沒有範例時會猜錯，只能靠自己重讀來源或用 `session_read` 取回。要讓規則存活，請放進使用者訊息或 `AGENTS.md`。

**滑動門檻是 `l3 + l4`，不是只看 `l3`**：L3 區段（含 L4 溢出緩衝）累積超過 `l3 + l4` 字元才一次重設起點；預設 6000 + 6000 在 200k 視窗下要連續很多次壓縮才會走到。

**真實模型實測**（`tools/pi-auto-compact-bench/` 的 `constraint` 任務：每項讀一個約 30k 字元的檔案、寫一個小模組，規則只說一次；模型 `opencode-go/deepseek-v4.1-flash`，context 200k，用真實 Pi TUI 以 `tools/pty-mcp` 操作；每組只有單次結果，變異未量測，不能當作統計結論）：

| 情境 | 結果 |
|---|---|
| 手動 `/compact`、8 項 | 摘要約 1.6k 字元；壓縮後 agent 如實說明哪些原文已不在畫面中，並以重讀取回 |
| 自動壓縮、30／60 項（預設設定） | 各壓縮 1～2 次，30／60 項全過；壓縮後直接接續下一項，重讀僅 0～2 個檔、共約 2k 字元 |
| 120 項、縮小預算（L1 20k、L2 4k、L3 0.8k、L4 3k）、排除 `subagent`／`fork` | 壓縮 4 次，120 項全過；L3 單調累積（約 8→48 項）、起點固定在第一則使用者訊息；摘要每次只增加約 0.5～1k 字元 |
| 同上，L4 縮到 0.4k（門檻 1.2k） | 第 4 次壓縮起點一次跳到後段（第 5 行→第 133／222 行） |
| 滑動後，規則只在 `PROMPT.md`（工具輸出） | 滑動後第一個寫入就違規（首行寫成別的團隊名），agent 自己重讀 `PROMPT.md` 後修正 |
| 滑動後，規則在第一則使用者訊息 | 120 個寫入全部遵守；寫 `FINAL.md` 前以 `tool_search "session"`→`session_grep`→`session_read` 取回原文（第一次實測到回溯工具被使用） |

其他觀察：

- 壓縮後第一輪的快取讀取比例約 0.47～0.62，之後回到約 0.80；壓縮前約 0.93。這是摘要取代前綴的固有成本，四次壓縮的曲線一致。
- 原始來源仍可重讀時（例如磁碟上的檔案），agent 傾向直接重讀而不是用回溯工具；回溯工具在來源無法重新取得時才會被用到。
- 單輪平行多個工具呼叫是不可切分的單元：壓縮正好落在一批平行讀取之後時，L1 尾端會超過預算（實測保留約 64k 字元，預算 30k），這是為了讓模型看得到剛讀的結果；未用完的 L1 預算會借給 L2。
- 任務夠大時 agent 可能自行委派給 `subagent`，主 session 的 context 就不會被填滿；做壓縮試驗時需用 `--exclude-tools subagent,fork` 排除。
- 狀態列的 context 用量是 API 最後一次回傳的值，壓縮後要等下一次請求才會更新；TUI 預設只顯示「Compacted from N tokens」，摘要內容不給使用者看（按 `Ctrl+O` 展開）。這兩點都是 Pi 的行為，不是本模組的問題。
- 尚未測到：L3 預算大幅超過後的多次連續滑動、規則放在使用者訊息但該訊息本身很長（超過該段預算一半的頭尾保留）、手動連續壓縮時 L2／L3 交界前移。

## 設定

使用者層 `<agentDir>/auto-compact.json`（預設 `~/.pi/agent/auto-compact.json`，路徑由 Pi 的 agentDir 解析）。檔案可省略；省略的鍵使用預設值。唯一的寫入者是 `/settings:auto-compact` 面板（見下），且只在按存檔時寫入；載入 extension 不改任何 settings。**沒有開關鍵**，也沒有專案層設定。也可以直接編輯檔案；壓縮、錨點與 system prompt section 每次使用都重讀，所以兩種方式都不需要 `/reload`。

| 鍵 | 預設 | 範圍 | 說明 |
|---|---|---|---|
| `l1Ratio`／`l1MinChars` | 0.01／30000 | 比例 (0,1]；正整數 | L1 預算 = `max(ctx × 比例, 最小值)` 字元，`ctx` 為模型 context window 的 token 數；保留尾端超過時切點往後移（見上），不是 token 上限 |
| `l2Ratio`／`l2MinChars` | 0.01／20000 | 同上 | L2 預算；實際生效值 = 此預算 + L1 沒用完的部分（`max(0, L1 預算 − 切點後保留尾端字元)`，記錄於 `details.stats.l2Lent`）。L1 常因整批平行工具結果切不開而用不滿，借給 L2 後 L1＋L2 約維持 `l1 + l2`，最壞情況總量不變 |
| `l3Ratio`／`l3MinChars` | 0.01／6000 | 同上 | L3 預算 |
| `l4Ratio`／`l4MinChars` | 0.01／6000 | 同上 | L4 = L3 視窗的**溢出緩衝**（見下節）。摘要的 L3 區段大小在 `L3` 到 `L3+L4` 之間浮動 |
| `charsPerToken` | 2.2 | 1～8 | 估算 token 用；Pi 內建為 4，中文為主的 session 實測約 2.2 |
| `checkpointRatio` | 0.5 | (0,1] | 進度錨點：context 自上次 assistant 文字／錨點呼叫起增加此比例的 context window 時要求一次進度回報（見上） |
| `checkpointMinTokens` | 200000 | 非負整數 | 進度錨點只在 context 大於此 token 數時啟用；`0` 停用間隔觸發（死線通知不受影響） |
| `deadlineMarginMinTokens` | 20000 | 非負整數 | 壓縮前死線通知的邊際下限：通知在 Pi 壓縮門檻之前 `max(0.1 × contextWindow, 此值)` token 送出；視窗低於 200k 時以此值為準，`0` 只留 10% 比例；通知最早不會早於 Pi 壓縮門檻的一半（小視窗或過大的值不會讓通知在第一回合就送出） |
| `maxTotalRatio` | 0.5 | (0,1] | 估算總量（最壞情況 L2＋L3＋L4）占 context window 的硬上限；超過時先重設視窗起點、再縮 L3、再縮 L2，不縮 L1 |

- **比例預設都是 0.01，實際生效的幾乎都是最小字元數**：`ctx × 0.01` 要超過最小值才會生效，門檻是 L1 約 300 萬、L2 約 200 萬、L3／L4 約 60 萬 token 的 context window。例：200k 窗口的預算為 L1 30000、L2 20000、L3 6000、L4 6000 字元；1M 窗口為 L1 30000、L2 20000、L3 10000、L4 10000 字元。要讓預算隨窗口成長，須自行調高比例或最小值。
- 未知鍵、型別錯誤或超出範圍都是**錯誤**，不退回其他值；hook 會以 warning 通知一次（有 UI 時），並把壓縮交還 Pi。
- 檔案不存在視為全部預設。

## 驗證

`npm run test:module -- pi-auto-compact`：設定預設值／覆寫／嚴格驗證、設定面板（欄位與設定鍵一一對應、留空刪除該鍵、非法值拒絕且不寫檔、存檔不問 reload）、hook 註冊與交還 Pi 的行為、全部已登記工具的折疊規則與安全性（不洩漏內容、遮罩、截斷、失敗保留、請求≠完成）、通用後備、工具註冊覆蓋掃描、參照格式，以及三個 session 工具的串流讀行、描畫、祖先鏈範圍與環／偽造 header、id 驗證、分頁與大 entry、大綱的配對與分支標示、grep 的遮罩與過濾。真實 Pi host 整合測試見上（`tests/real-host.integration.test.mjs`，只涵蓋手動 `session.compact()`；自動 threshold 路徑與「切點被移動」已在真實 TUI 以真實模型人工觀察過（見上節），但沒有自動化測試；overflow 路徑尚未驗證）。

真實模型長程試驗（會花真實模型費用，不屬於任何測試組、需使用者明確指示才執行）：`tools/pi-auto-compact-bench/`（產生任務、判分、蒐集壓縮與行為統計；用法見其 README）；在真實 Pi TUI 上操作與觀察用 `tools/pty-mcp/`。
