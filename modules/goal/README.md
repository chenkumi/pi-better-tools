# Goal（原生）

入口 `modules/goal/src/index.ts`；只支援 Pi **1.5.2**。把一份**已定案的計畫**交給背景執行：逐個 checkpoint 由獨立的 agent session 實作，再由本模組自己驗收（指令或唯讀審查），失敗時帶著失敗原因重試，直到完成或停在需要人處理的地方。使用者不必看著它跑；結束時 agent 會被告知結果。

來源是 pi-web（Pi Harbor）的 Goal v1，只移植功能，沒有 TUI 渲染。pi-web 的 Goals 分頁、引擎設定與 `pi-durable` 引擎不在這裡。

> 舊的 Goal 模組（`/goal` 指令、`goal` 工具、自動續跑、`pi-better-goal-state`）已在更早移除（見 `docs/migration.md`）。本模組是另一個功能：它不續跑對話，也不讀舊 entries；工具名稱不重疊。

## 使用流程

1. 使用者輸入 `/goal <要完成的事>`（prompt 範本，`prompts/goal.md`）。agent 先**研究**（只讀，不改檔），再寫**計畫**，把會改變範圍、方向或驗收方式的問題一起問使用者（OQ1、OQ2…，附建議），得到答案後記入計畫的 `decisions`。
2. agent 以 `tool_search "goal"` 載入 goal 工具，呼叫 `plan_submit`。計畫經檢查（有問題就回傳錯誤讓 agent 修正）；通過後**使用者在底部面板確認**計畫、規則與每一個會被執行的指令，才儲存並開始。
3. goal 在背景跑。結束（`done`、`blocked`、`failed`）時，模組送一則 `goal-result` 訊息（`deliverAs: "steer"`、`triggerTurn: true`，與其他背景通知一致）：各 checkpoint 的狀態、失敗者最後一筆驗證記錄、計畫與記錄檔路徑。
3a. 進行中可用 `goal_pause` 立即暫停、`goal_resume` 繼續；暫停期間 `goal_cancel` 與 `goal_resolve`（只改記錄、仍維持 `paused`）可用，`goal_retry` 不可（只有 `blocked` 才能重試）。
4. `blocked` 時 agent（或使用者）用 `goal_retry` 讓失敗／跳過的 checkpoint 重來，或 `goal_resolve` 記錄「需要人」的 checkpoint 的結果。

## `/goals` 面板（僅互動 TUI）

`/goals` 在輸入框上方開底部面板（與 `/schedule-commands` 同一組 bottom panel），列出本專案的 goal：`↑／↓`、`PgUp／PgDn` 移動，`Enter` 看詳細，`p` 暫停（`goal_pause`）、`r` 恢復（`goal_resume`）、`t` 重試第一個 `failed`／`skipped` 的 checkpoint（`goal_retry`）、`x` 取消（先經底部確認，再 `goal_cancel`），`Esc` 關閉。面板只選動作，動作一律經同一份 `goal_*` 工具程式碼執行（owner 鎖、狀態檢查與錯誤訊息都沿用，不複製驗證）；工具拒絕時以通知顯示原因。`goal_resolve` 需要備註，不在面板內（用工具）。非 TUI 或已有其他底部面板開著時只通知、不開。

## 工具（deferred，命名空間 `goal`）

| 工具 | 作用 |
|---|---|
| `plan_submit` | 提交計畫（`title`、`goal`、`references`、`rules`、`decisions`、`checkpoints`）。需要互動 UI 與受信任專案；使用者不確認就什麼都不存。 |
| `goal_status` | 不帶參數列出本專案的 goal；帶 `goalId` 顯示各 checkpoint 的狀態、次數與最後一筆驗證記錄。 |
| `goal_cancel` | 停止進行中的 session，goal 標為 `cancelled`，已完成的保留。已結束的 goal 不變。 |
| `goal_pause` | 立即暫停 `queued`／`running` 的 goal：進行中的 session 或驗收指令被中止、該 checkpoint 退回 `pending`，**該次嘗試不計次數**（不耗 `maxAttempts`），已改的檔案留在原處；goal 標為 `paused`，不送 `goal-result`。已是 `paused` 不變，其餘狀態拒絕（`GOAL_REJECTED`）。 |
| `goal_resume` | 把 `paused` 的 goal 排回 `queued` 並繼續跑；被中斷的 checkpoint 重新開始，提示會註明上次被暫停、資料夾可能有未完成的修改，先看現況再做。 |
| `goal_retry` | 把 `failed`／`skipped` 的 checkpoint 重新排隊（次數重算）並繼續跑。 |
| `goal_resolve` | 記錄 Tier 2（人工操作）或沒有結論的審查的結果（`passed`、`note`）並繼續跑。 |

錯誤碼：`GOAL_PLAN_INVALID`、`GOAL_NEEDS_UI`、`GOAL_PROJECT_NOT_TRUSTED`、`GOAL_NOT_CONFIRMED`、`GOAL_UNKNOWN`、`GOAL_RUNNING_ELSEWHERE`、`GOAL_REJECTED`、`GOAL_NO_SESSION`。

## 計畫與驗收

每個 checkpoint 有一種驗收（`verify`）：

- **Tier 1**：一條 `command`，在專案資料夾經系統 shell 執行（Windows 為 `cmd`），exit code 0 即通過。10 分鐘未結束即終止並算失敗。
- **Tier 2**：人工操作，`check` 寫步驟。不自動驗收，goal 停在 `blocked`，等 `goal_resolve`；依賴它的 checkpoint 等待。
- **Tier 3**：靜態審查。獨立 session 只有 `read`／`grep`／`find`／`ls`，不執行任何東西，最後一行必須是 `VERDICT: PASS` 或 `VERDICT: FAIL`；通過記為「reviewed, not run」並附 `note`（沒驗證的部分）；沒有結論交給人。

`maxAttempts` 預設 3。失敗或跳過的 checkpoint 讓依賴它的後續都標 `skipped`，其餘照跑，最後 goal 為 `blocked`。

## 檔案

`<專案>/.pi/goals/<ULID>/`（ULID 大寫）：

| 檔案 | 內容 |
|---|---|
| `plan.json` | 定案的計畫，不再改動。 |
| `goal.json` | 進度與每個 checkpoint 的驗證記錄，唯一的真相來源；每次變更以暫存檔＋rename 原子寫入。 |
| `plan.md` | 由前兩者產生的唯讀檢視，沒有東西讀回它。 |
| `sessions/` | 每個實作／審查 session 的 Pi session 檔，事後可讀。 |
| `owner.json` | 正在執行這個 goal 的行程（pid）；行程已不在即視為無主。取得時先寫私有暫存檔再以 `link` 發佈（已存在即失敗，兩個行程不會同時取得、讀者看不到寫到一半的內容）；`release` 只刪自己的紀錄。兩個行程同時接管同一個已崩潰 owner 的過期紀錄仍可能競爭。 |

建議把 `.pi/goals/` 加進 `.gitignore`。

## 執行方式與限制

- 每個任務是同一行程內的一個 Pi SDK `AgentSession`（`src/child.ts`），使用呼叫 `plan_submit` 的 session 的**目前模型與思考強度**。它**不載入任何 extension**（不會提交計畫、不會建排程，也不會重複載入本套件），只有 Pi 內建工具（`bash`、`read`、`edit`、`write`、`grep`、`find`、`ls`）與專案的 context 檔（`AGENTS.md` 等）。因此 File Tools 的版本權杖、FFF、Shell 背景 job、MCP 在 goal 的 session 裡都沒有；要求某個工具的規則請寫成 `rules` 時以內建工具為準。
- 每次嘗試是一個全新的 session，沒有對話記憶：計畫就是它拿到的全部，加上前幾次失敗的原因。
- 受信任專案才執行（Pi 的 `isProjectTrusted()`）；不受信任時 `plan_submit` 拒絕，重啟後也不續跑。
- **重啟後續跑**：`session_start` 時，狀態為 `queued`／`running` 的 goal 從檔案繼續（`paused` 不續跑，須 `goal_resume`）；被打斷的 checkpoint 計一次嘗試。正常關閉 session（`session_shutdown`）時停止進行中的 session，goal 留在原狀態，不通知。
- **同一時間只有一個行程跑同一個 goal**（`owner.json`）。暫停或關閉落在存入 `verifying` 的期間時，不會再啟動驗收指令（`check` 前與 `runCommand` spawn 前各檢查一次取消）。其他行程不續跑它，`goal_cancel`／`goal_pause`／`goal_resume`／`goal_retry`／`goal_resolve` 對它回 `GOAL_RUNNING_ELSEWHERE`。
- 不是 sandbox：session 以使用者的權限執行指令與改檔，所以才要先確認計畫與受信任專案。取消不保證子行程樹已停止（Tier 1 指令以行程樹終止）。
- 費用沒有上限、也沒有顯示；每個 checkpoint 最多 `maxAttempts` 次 session。
- **Jobs 面板**：每個 goal 一列（種類 `goal`、標籤 `GL`），`queued`／`running`／`paused`／`blocked` 算進行中；列上只有標題、進度（完成數／總數）、目前 checkpoint 與次數，詳細頁列各 checkpoint 的狀態與次數；不含計畫全文、驗收指令或驗證記錄（看 `goal_status`），也沒有即時對話。Jobs 面板本身只顯示、不操作；要用按鍵操作用 `/goals`（見下）。`/background-jobs goal` 可篩選。Goal 與其他工作共用同一個 Jobs 面板（與 Schedule 一樣經 `pi` 會合到共用實例，不自己畫第二份）；進行中（含暫停、blocked）的 goal 固定排在所有工作之前（Schedule 不置頂），已結束的 goal 照一般順序。
- 與 pi-web 的差異：沒有信任提問（交給 Pi 的信任機制）、沒有進度事件。

## 測試

`npm run test:module -- goal`：計畫驗證、狀態機、runner（假 host）、真實 host 對 faux 模型（實作、Tier 1 指令、唯讀審查、模型失敗、取消）、extension（`plan_submit` 的拒絕與確認、背景跑完的訊息、goal 工具、重啟續跑、跨行程鎖）。**未對真實模型實測**。
