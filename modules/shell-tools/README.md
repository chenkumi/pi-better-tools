# Shell Tools

覆寫 Pi 內建的 `bash` 與 `powershell` 工具，將以秒為單位的 `timeout` 改為以毫秒為單位的「輸出停滯逾時」`timeoutMs`。其餘執行行為（輸出處理、session 環境、PowerShell UTF-8、Bash `shellPath`／`shellCommandPrefix`）沿用 Pi 內建實作。結果 renderer 亦沿用宿主；命令呼叫的 TUI 預覽限制如下。

## 工具

主代理的兩個工具共用相同 schema（不允許額外欄位）：

| 參數 | 型別 | 說明 |
|---|---|---|
| `command` | string（必填） | 要執行的 shell 指令 |
| `timeoutMs` | integer（選填，1 ～ 2147483647） | 輸出停滯逾時，單位毫秒 |
| `background` | boolean（選填，預設 false） | true 時立即回傳背景工作 receipt，完成後自動喚醒 owner session |

- `bash`：使用 Pi 的平台 shell 解析；Windows 需安裝 Git Bash 或設定 `shellPath`。
- `powershell`：僅支援原生 Windows；其他平台即使有 `pwsh` 也不提供此後端。不套用 Bash 的 `shellCommandPrefix`。

兩者皆以 `defaultActive: false` 註冊：載入本擴充不會啟用未被選取的 shell，是否啟用由 Pi 預設 loadout、`defaultTools`、`--tools`、排除設定或 `setActiveTools()` 決定。

## Managed subagent 前景工具

由 Subagents 經既有 managed admission／argument builder／startup guard 啟動的 child（含 new、resume 與 ready-query），使用同名 `bash`／`powershell` 的專用前景 definition：schema 只有 `command`／`timeoutMs`，description／prompt guidelines 不介紹背景 receipt，outputSchema 只保留宿主同步完成結果；不註冊 `shell_job_status`／`shell_job_cancel`，也不建立背景 registry／通知／面板。直接 `execute()` 繞過 schema 時，任何 `background` 欄位（包括 false、undefined 或 null）均在讀取 execution/effective Shell settings（`pi.getSettings()`）／建立 backend／spawn 前拒絕。這不表示零診斷 I/O：拒絕仍走既有 failure diagnostics，依個人家目錄 opt-in 設定決定是否保存失敗日誌，不移除或自動啟用該功能；測試須隔離 home。

身份來自 parent 明確加入 `PI_SUBAGENTS_GUARD` 的 `shellMode: "foreground-v1"`；Shell factory 與 guard 共用消耗 helper，先載入者立即刪除環境 handshake，process-local copy 保留整個 child process 生命週期與 reload。不是以 RPC／JSON／cwd／prompt 推測；一般 shell／手動 Pi 孫行程不繼承 managed 身份。此為可信擴充之間的私有協定，不是抵抗惡意擴充或 shell 手動仿造環境的安全邊界。

同 process guard reload 僅對同一已驗證 invocation 的原 startup receipt 做只讀重驗證（配置／trust、bigint 檔案身份／固定預期 size、原始 Buffer bytes 精確 equals、讀前後 descriptor／path metadata），不以容錯 UTF-8 解碼字串比對；新 invocation 仍 exclusive 建立，不覆寫外來／變造 receipt、不重建遺失檔案。這些是離散檢查點的觀測，不是原子快照、永久禁止外部修改或讀取記憶體硬上限。拒絕或 receipt 驗證故障直接終止 child，不假定一般 `session_start` handler throw 可以停止 Pi。完整政策與驗證邊界見 Subagents README。

主代理的 schema、背景 receipt／管理工具、工具選取、trust-aware 設定及取消不變。前景 child 與主代理共用執行核心、停滯計時器、宿主輸出與 process-tree 取消委派，不複製 extension；仍以 `defaultActive:false` 保留 loadout。ready-query 原本的 `--no-tools` 與遞迴 exclusions 亦不變。前景 child 的停滯錯誤提示不建議 `background:true`。這不限制 `!`／`pi.exec()`／自行建立 OS process，也不是 OS sandbox。

## 命令呼叫 TUI 預覽

`bash`／`powershell` 的命令呼叫區塊最多 **5 個實際終端行**（包含窄欄折行）。超過時顯示前 4 行，第 5 行為 `...`；欄寬足夠時仍保留 `(timeout Ns)`。未超過者完整呈現，resize／streaming 更新重新計算。這個上限只套用呼叫預覽，不縮減實際執行命令、模型 arguments、結果輸出或背景通知；宿主外層內距另計。沿用宿主 Text component reuse 與 timing state，不改 timeout／取消／activation 行為。

## API 中斷工具卡片

載入 Shell extension 即註冊公開 `registerToolRenderer` resolver，套用有完整 call/result renderer 的工具（不限 bash，亦含 read 等）；不啟用任何未選工具。未載入 Shell、缺少 renderer 或其他 resolver 優先完全取代者保留宿主行為。

只有 assistant `stopReason:error` 中的 toolCall ID、沒有 execution start/end 證據、卡片 `executionStarted:false`，且結果精確符合宿主合成的單一 provider error 文字／無 details，才換中性色。`API interrupted · recovery not confirmed` → 觀察到後續 `before_provider_request` 時 `Resuming API request…` → 正常 assistant `message_end` 時 `API response recovered`。始終明示 `Previous tool call was not executed.`，不把舊 call 標成成功；新 call 仍依自己的真實結果顯示。展開保留清除控制碼的 provider diagnostic。取消、input／settled 邊界切斷未確認續接，真正工具 error／exit code 不隱藏。

Default-shell 卡片改由 self-shell 重建原有 Box，避免外層留白仍紅；正常 call/result renderer、lastComponent/state、outputPad、圖片與展開維持宿主流程，原 self-shell 正常路徑沿用。事件 invalidate，沒有 ticker／輪詢；records／execution IDs／callbacks 各最多512，診斷最多4096字元；過大診斷保留原 error，不強行推測。session replacement 清除狀態，reload／歷史僅掃 active branch 最後4096筆、排除有真實 toolResult 的 ID，保守顯示 interrupted，不從後來不相關回答推測歷史 retry 成功。大量歷史超出範圍或 IDs 超出追蹤上限仍可能保留原卡片。

只改工具卡片 UI，不修改 content/details/structuredContent、message、session 檔、工具副作用或 API 重試策略；Pi 原生 assistant error 仍保留。這不是官方 auto_retry_start/end 訂閱，沒有精確 attempt／倒數／耗盡資訊；後續請求也可能由其他合法 continuation 觸發，因此使用 Resuming 而非宣稱官方 retry 次數。真實 loader/hooks/ToolExecutionComponent 回歸無 provider 呼叫；未進行付費 API 中斷或人工 fullscreen 驗證。

## timeoutMs 行為

| 輸入 | 效果 |
|---:|---|
| `20000` | 連續 20 秒沒有輸出即停止 |
| `120000` | 連續 120 秒沒有輸出即停止 |
| `2147483647` | 不逾時（上限值，相容保留；工具描述已改寫為「省略即不逾時」） |
| 省略 | 不逾時 |

- `timeoutMs` 是停滯期限，不是總時限：持續輸出的指令不會逾時，安靜的長指令（sleep、無輸出的建置）會被終止；此類指令請省略或調大 `timeoutMs`；`background: true` 只是非同步執行，仍使用相同停滯計時器。
- 計時於 shell 開始執行時啟動，每收到一個 stdout／stderr 資料區塊即重新計時；只有輸出停滯達該時間才會逾時。持續有輸出的指令可執行超過 `timeoutMs`。計時在行程啟動前就開始，行程啟動時間計入第一次輸出的等待；`timeoutMs` 過小（例如數十毫秒）可能在指令尚未輸出前就被終止，建議使用數秒以上的值（工具描述已註明）。
- Pi 內建的絕對計時器對此覆寫停用。內部以 `timeout:<秒數>` 丟出，宿主會格式化為 `Command timed out after N seconds`；本擴充改寫為 `Command stopped: no output for N seconds (timeoutMs idle timeout). If the command is expected to remain quiet, omit or increase timeoutMs. Use background:true separately if you want asynchronous execution.`，以符合「輸出停滯」語意並提示處置。
  只改寫宿主附加在錯誤訊息**尾端**的診斷（`appendStatus` 的最後一行）；命令輸出中間出現相同字樣保持原樣，改寫後不再匹配故在多層 catch 中冪等。背景 job 的 `timed_out` 仍只由尾端 `(timeoutMs idle timeout)` marker 判定，不信任命令輸出。回歸測試：`tests/timeout-diagnostics.integration.test.mjs`（以 fake process backend，無 idle／sleep 等待）。
- PowerShell 工具的宿主選項不支援 `shellPath`／`shellCommandPrefix`，這兩項設定僅套用於 Bash。
- 非正數、小數、非安全整數、超過上限的值會被拒絕。
- 新的呼叫若帶舊版 `timeout`（秒）欄位會直接報錯，請改用 `timeoutMs`；舊 session 紀錄中的 `timeout` 仍可正常顯示。
- TUI 以秒顯示（例如 `timeout 20s`）。
- 省略或使用哨兵值不會停用取消：`AbortSignal` 仍會交由 Pi 的 process tree 終止機制處理。逾時只是停滯門檻，不保證啟動與清理在該時間內完成。

### Codemode

```javascript
const result = await tools.bash({ command: "printf hello", timeoutMs: 20000 });
text({ output: result.output, exitCode: result.exit_code });
```

Windows 上可用 `tools.powershell({ command, timeoutMs })`。該 shell 必須已被選取，載入本擴充不會自動讓 codemode 可用。

## 背景工作

### 模型提示與提前停止

每回合透過 `before_agent_start` 注入共享 `pi_better_tools_background_lifecycle` system prompt section（與 Subagents 去重）。只在相關建立／管理工具被選取時存在；不啟用工具、不修改設定，保留其他 sections／custom／forced prompts。

- 通知抵達順序不等於工作完成順序；依 job／task／invocation ID 核對，不以舊通知覆蓋新版結果。
- log、partial 結論及 snapshot 只支持暫定結論；整個工作通過須有 terminal status／result 與可用退出／錯誤資訊。只有 log 時須明說尚未確認 runner 退出／cleanup。
- 已有充分結論且剩餘工作不再需要時，要求用已選取的 owned cancel 工具停止，不為等通知放著繼續跑。必要測試、寫入、checkpoint／commit／cleanup 則須完成並說明理由；提前取消不能宣稱完整驗證通過。
- 取消要求不等於 runner／process tree 已停止；等待 followUp，禁止輪詢／sleep 等通知，允許一次性核對終結／取消收尾。未選 cancel 時明說限制、不自動啟用或亂殺行程；可能需要提前停止的工作優先使用前景。

這是模型操作指引，不是從輸出文字自動取消的 runtime heuristic；既有 registry／通知／取消與清理機制不變。

### 即時 TUI 面板

原生 footer 的 extension 狀態列透過 `setStatus()` 顯示 `▸ Subagents：N ｜ ▸ Shell：M`，按 key 排序並由宿主截短，與 Fast／其他狀態共存，不替換 footer。預設收合不掛 widget；摘要不含命令／標題，footer 文字不可點擊。Shell 計算目前 session/runtime 擁有的 running／cancelling Bash／PowerShell 工作，取消要求直到 registry 終結仍計數。用 `/background-jobs shell` 操作（省略參數或 all 切換全部、collapse 全收合）。展開時才在 belowEditor（輸入框下方／footer 上方）掛詳細 widget，全螢幕可左鍵單擊其 Shell 標籤切換；一般模式不接管終端滑鼠。不搶 editor focus；詳細 widget 未完整顯示的截短標籤不接點擊，窄欄縮寫 S／Sh。

展開保留 tool、running／cancel requested、job ID 尾六碼與單行 command 預覽；投影先限256字元，顯示再清除 ANSI／控制碼與限制欄寬，最多八列加 header／省略數（十行），不讀 log／輸出。完成逐項移除；該區清零重設收合、另一區仍保留，所有工作終結才清除自有 footer 狀態與 widget，不移除其他 extension 狀態。以事件更新、無輪詢／ticker，shutdown／owner／generation／disposed pointer 防護仍保留；取消要求或面板消失不表示 process tree 已停止。

共用 key `pi-better-tools-background-jobs`，由純 UI helper 經公開 pi.events rendezvous 與 Subagents 協調，沒有共用 job registry，不覆蓋 Schedule Prompt／footer、不啟用未選工具。僅 TUI 且 hasUI 綁定；RPC／JSON／print 不掛 widget，UI 錯誤不改工作／通知。只載入一模組也可顯示摘要／使用指令；不列前景、其他 session/runtime 或 OS 行程，完整 ID/log 仍由既有 receipt/status 查看。等待背景工作結束後 `/reload` 載入。

```javascript
const receipt = await tools.bash({ command: "npm test", background: true });
// structuredContent: { jobId, status: "running", liveLogPath }，不是完成結果，沒有 exit_code。
// 模型可見文字僅 "job <id> running / log <path> / 下一步提示"。
text(receipt);
```

- 同步模式（省略／false）維持原有 `output`、`exit_code`、`wall_time_seconds` 等 codemode 格式；`outputSchema` 為原有完成結果與 receipt 的 union。
- `liveLogPath` 在 receipt 回傳前已建立。執行中可用 `read` 查閱；完成後通知提供相同有效 `logPath`，沒有 rename 競態。檔案沒有新內容不代表工作已完成。
- **模型可見文字已瘦身**（`structuredContent` 與 `outputSchema` 維持完整、不移除必填欄位）：receipt 只含 jobId、log 路徑與下一步提示；status／cancel／完成通知以 `compactJob` 輸出，省略預設值與重複欄位（`cancelRequested` 僅 true 時出現、log 路徑只在 running 或輸出被截斷時以 `log` 提供、不輸出 `toolCallId`／`startedAt`／`logBytes`／重複的 `logPath`、空 tail）。單一 status 不含 `command`；list 文字僅 jobId／status／command（80 字）／elapsedMs／exitCode／error；cancel 文字不含 output。完成通知為單一 JSON 陣列（含 command、output、error，標記為不可信資料），完整 metadata 留在 message `details`。一般（前景）shell 輸出由宿主產生，未更動。
- 新增 `shell_job_status({ jobId? })` 與 `shell_job_cancel({ jobId })`。兩者均為 `defaultActive: false`，需要以 `--tools`、`defaultTools` 或 `setActiveTools()` 明確選取；它們不啟用或執行任何未選取的 shell。只有 shell 的 loadout **不能呼叫 status/cancel**。receipt 以 `pi.getActiveTools()` 判斷：未選取時只提示「用 `read` 讀 `liveLogPath` 尾端」，已選取時才提示 `shell_job_status`；不暗中呼叫 `setActiveTools()`。
- status 省略 `jobId` 時列出此 session 的所有 jobs（running／cancelling 在前，其後依開始時間新到舊），每筆含 `jobId`、`status`、`tool`、`command`、`startedAt`、`elapsedMs`、`logBytes`。指定 `jobId` 時回傳 `jobId`、`status`、`tool`、來源 `toolCallId`、截短至 200 字元的 `command`、`startedAt`（ISO）、`elapsedMs`（完成後凍結）、`logBytes`、`cancelRequested`、log 路徑、`outputTruncated`，完成時另含 `exitCode`、`output`（head）、`error`。輸出被截斷或工作仍在執行時另含 `outputTail`（最後約 8 KiB）；工作執行中時模型可見文字只附最後 2000 字元（避免每次輪詢重複付費，完整 tail 仍在 `structuredContent`，更多內容請讀 `liveLogPath`）。未知 jobId 的錯誤會區分「已被淘汰（evicted）」與「不存在」，並列出 running jobs；active／retention 上限錯誤會列出占用名額的 jobs 並指出可取消或等待。狀態為 `running`／`cancelling`／`completed`／`failed`／`cancelled`／`timed_out`。只有 owner session/runtime 能查詢或取消。
- cancel 是終止要求：先回 `cancelling`（並設 `cancelRequested: true`），等待宿主 runner 結束後才標示 `cancelled`；若 runner 在取消送達前已產生成功結果，以該結果為準（`completed`，`cancelRequested` 仍為 true）；不宣稱已驗證所有 descendant process 清空。取消、逾時、執行失敗不偽造成功 exit code。
- 完成先保存結果、關閉 log，並加入本地待回報集合；主 agent 忙碌時不逐項提交 followUp。只在 `agent_start` 設為 busy，`agent_settled` 清除 busy 並安排單次 `setImmediate`，以單一 `shell-job-completed` custom message 回報**當時全部已完成待通知結果**；不是等所有仍執行中的工作結束。`agent_end`／`agent_before_settle` 不提早發送，因 retry／recovery／其他 extension 的 queued work 可能繼續。`before_agent_start` 尚屬 preflight，失敗未必有 settle，所以不鎖 busy。取消後亦於 settled 回報；原本閒置時用 immediate 合併同個事件迴圈，不輪詢、不固定延遲。已發送之後新完成者屬下一批，不能回改先前訊息；不回填已排入宿主的舊通知。面板仍只計 running／cancelling，不計待回報結果。
- 送出仍為 `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`，保留原 payload/schema、metadata 與逐項真實 status／exitCode。通知內含 `command`、`outputTruncated`，被截斷時附 log 提示（log 保留前 1 MiB）。command output 是回傳資料，不提升為 system 指令。重檢 owner／generation／agent busy 並防同步重入；同步提交失敗保留待回報結果與 retention 保護，待下一個 lifecycle opportunity 再嘗試，不自動重試迴圈。sendMessage 不是送達確認，非 exactly-once，異步宿主失敗仍以 status／journal 為準。
- 這是**主 agent run 的批次回報**，不是新模型互斥或完整宿主 idle gate。手動 compaction／tree summary 可能取消且沒有 settle 事件，故不以全宿主 `isIdle()`／retained queue 計數硬擋通知，沿用其既有宿主 delivery 行為；成功／失敗 compaction 與 tree 事件也可提供回報機會。`agent_settled` handler 本身只排 immediate，不直接啟動模型。
- 接受前仍檢查工具 signal；接受後使用 job-owned `AbortController`，主回合 signal 不會取消已接受的背景工作。`timeoutMs` 仍由所有 stdout／stderr 區塊刷新，即使輸出已達保留上限亦同；省略／哨兵值不啟動 idle timer。Bash 有效 trust-aware 設定在提交時捕獲，PowerShell 保留宿主 UTF-8。
- 每個 runtime 最多 **8 個 active（含 cancelling）**，不排無限佇列；超額直接拒絕。最多保留 **32 個工作**，新提交時移除最早且已提交完成通知的終結工作與其 log；仍待回報者不可淘汰，若32個皆執行中或待回報，拒絕新提交，不丟棄既有結果。
- 每個背景 log 只保存最前 **1 MiB**；另在記憶體保留最後 **8 KiB** tail（`outputTail`）。head（`output`）加 tail 的 decoded 合計最多 **32 KiB**：raw forwarding 僅最前 **8,192 bytes**（`(32 KiB − 8 KiB) / 3`，保留最壞 invalid UTF-8 → U+FFFD 三倍膨脹餘裕），且不超過 1000 行；超額仍持續消費 stdout／stderr，但不保存後續輸出，`outputTruncated: true`。背景 log **不是完整輸出**，最多約 32 MiB/runtime；同步原有完整輸出行為不變。log 使用暫存目錄，POSIX 檔案為 `0600`，Windows 沿用 ACL；輸出可能包含機密。
- quit／reload／new／resume／fork 的 `session_shutdown` 會停止接受、取消所有 jobs、抑制舊 generation 通知、最多等待 2 秒宿主 cleanup，再關閉／移除背景 log。背景工作不跨 replacement/reload 持續，沒有 daemon 或自動恢復。背景 log 目錄（`pi-shell-job-*`）移除時會重試（Windows 暫時佔用），並在每個行程第一次提交背景工作時清掃明確過期的殘留目錄：目錄內 `owner.pid` 標記的行程已不存在，或無標記的舊目錄超過 24 小時未被修改；存活行程（含本行程）的目錄與非一般目錄一律不動。異常強制退出或 I/O 清理失敗仍可能留下 bounded 暫存檔／orphan process，不能保證 process tree 全部已停止。
- SDK 嵌入式宿主必須 **`await runtime.dispose()`**，讓宿主發送 `session_shutdown` 並等待 extension cleanup。單獨呼叫同步 `session.dispose()` 不保證發送此事件，**不能當作背景退出清理 API**。若執行／輸出／通知時觀察到 owner getter 已失效，會 fail closed、取消並清理已觀察到的工作、抑制通知；不使用輪詢 timer，因此安靜且沒有後續 callback 的工作不保證立即偵測，仍需正確 runtime dispose。
- 長例外訊息在判定原始 timeout 尾部後才縮減，保留頭尾與省略標記；超長輸出不會吞掉 timeout 狀態或尾部診斷。
- owner 綁 session，不綁目前 branch；來源 toolCallId 隨通知提供，切換 branch 不會撤銷背景副作用。所有工作與主 agent 共用 workspace，避免並行修改同一檔案；必要時自行使用獨立 worktree。
- 背景失敗仍沿用下面的選用 failure debug log（其既有不自動輪替政策不變）。query／control 不適用 shell。

## Session 載入核對（不是工作恢復）

- 受理／開始／取消要求／終結及 shutdown reason 寫入版本化 `pi-better-tools-background-state` session journal，只投影 job/toolCall ID、owner/canonical cwd/runtime、狀態、exit/error code；不保存 command/output/log/credentials。受理紀錄寫入失敗拒絕提交；後續 I/O 故障不改已產生的結果，歷史可能只能報 unknown。Pi 1.0.0 會緩存無 user/assistant 的空 session，`--no-session` 不落盤；這兩種情況以 `BACKGROUND_JOURNAL_FAILED` 拒絕背景提交，同步呼叫不變。不改宿主內部 flush 或捏造 user 訊息。
- `session_start` 的 startup/resume/reload 核對 session-wide 同 owner/cwd 紀錄，通知附在 active branch；fork/clone 不採用沒有原 owner 證據的舊 receipt。已保存的同 branch 通知／正常完成通知去重，新證據可補，沒有相關歷史不發訊息。一般 foreground output 不當作 journal；舊文字 receipt 必須對應 assistant 的 `background:true` tool call。
- customType `background-runtime-recovery-shell`、display:true、triggerTurn:false；英文安全前言＋compact JSON，詳細 metadata 放 details。finding 為 `terminal_result_recorded`／`shutdown_cancellation_requested`／`outcome_unknown`／`start_not_confirmed`，與 lastKnownState 分開；`processTreeState` 永遠 unknown。TUI 使用中性色，收合顯示數量／ID 尾碼／finding，展開顯示完整 IDs、outcome、reason 與 next action。
- 核對最多 100,000 entries、4 MiB 投影／解析預算、每筆文字 32 KiB、128 jobs、每則 32 findings；legacy／branch／journal 共用解析預算，超限／malformed 明說 incomplete／omitted。不是 exactly-once；不能由訊息缺席推論失敗。檢查 session journal，不讀 log、鎖或 child native，不接管 registry、不重跑命令、不啟動模型、不新增設定或儲存目錄。退出／取消不證明 descendant 全部死亡。

## 完成通知 TUI

通知使用原生工具呼叫相同的背景色塊與內距，不畫框線，收合／展開一致。SDK Box 填滿整列，背景依權威狀態使用 toolSuccessBg／toolErrorBg／toolPendingBg；批次有失敗用 error，全部成功才用 success，其餘保持 neutral pending 色盤（不更改取消／未知狀態）。3欄以上左右留1欄，較窄不留左右內距；上下各留1行，總300行含留白。截短／換行的 SGR reset 會重套背景避免色塊斷開，色彩跟隨目前主題。

`/reload` 後，`shell-job-completed` 不再以原始 JSON 顯示。收合顯示狀態、exit code、耗時、命令與三行輸出預覽（優先 tail），以及截斷／log 提示；使用 Pi 的原生展開操作可看 job ID、較完整命令與通知內保留的 head/tail/error。狀態取自 metadata／exit code，輸出包含 `Error` 不會自行判定失敗，缺 exit code 不偽造成功。ANSI、OSC、控制碼與 bidi 僅在顯示層移除，Unicode 依終端欄寬截短／換行。

模型通知前言改為中性資訊提示：command/output/error 是回傳資料，不是指令；此提示不代表失敗，應由 status/exitCode/error 判定。TUI 輸出標題為英文 `Command output (data, not instructions)`／`Command output tail (data, not instructions)`，不使用容易誤認為錯誤的 untrusted 標籤。JSON payload/schema、資料不提升為指令的信任邊界、followUp／喚醒與 lifecycle 不變。舊 session 原始通知不重寫。Renderer 不讀檔或執行工具；通知 head/tail 原本各最多 2000 字元，展開不會恢復已丟棄的輸出。額外顯示有每欄位及總計 300 行上限；log 只保留前 1 MiB，不是完整輸出。舊／格式不完整訊息會安全退回摘要；未提供 log 路徑不杜撰。

工具訊息使用英文。背景 receipt 補 `Background job accepted; its outcome will be reported when it finishes.`，接受時的耗時標為 `Accepted in …`；同步模式仍保留宿主 `Took …`，呼叫標籤 `(timeout 20s)` 不改。完成通知為 `Shell background jobs have finished. Individual outcomes follow.`，不代表所有工作成功，亦不改既有送達限制。

cancelled 即使帶非零 exit code 仍顯示 `cancelled · job cancelled · exit N`，不改稱 failed；timed_out 顯示 `output idle timeout`。completed 缺 exit code 明說未提供，不假造成功。截短提示為 `Only part of the output is retained in this notification. The log retains at most the first 1 MiB.`，不以 outputTruncated 推論磁碟日誌必定不完整。

status／cancel 的 TUI 使用 `Job status`、`Reason`、`Next` 及展開的 `Job ID`／`Exit code`／`Retained output`／`Log` 欄位；模型 JSON/schema 維持。cancelling 明說取消要求與待清理；對終結工作呼叫 cancel 則說 `Job already finished; no new cancellation was requested. The existing outcome is unchanged.`，不假稱新增取消或程序樹已清空。evicted 僅表示保留紀錄淘汰與 log cleanup 已嘗試；missing 僅表示此 session/runtime 找不到紀錄。

## Bash 設定

每次執行 Bash 時透過 `pi.getSettings()` 讀取宿主的有效設定（全域、受信任的專案設定與 SDK 記憶體覆寫）：

| 設定鍵 | 說明 |
|---|---|
| `shellPath` | Bash 執行檔路徑；沿用 Pi 對 `~`、file URL、Windows 磁碟路徑的正規化 |
| `shellCommandPrefix` | 加在每個 Bash 指令前的前綴 |

本模組不會自行重讀設定檔。修改持久化設定後請使用 Pi 的 `/reload`（或嵌入式宿主呼叫 `settingsManager.reload()`）；SDK `applyOverrides()` 的變更在下次執行時生效。

## 失敗除錯日誌（選用，預設關閉）

在 `~/.pi/agent/settings.json` 加入：

```json
{
  "pi-shell-tools": {
    "debugLog": true
  }
}
```

- 只有字面布林值 `true` 會啟用。每次失敗時才讀取此檔，修改後不需 `/reload`。
- 開關固定讀取使用者家目錄下的 `~/.pi/agent/settings.json`；專案設定、SDK 覆寫與 `PI_CODING_AGENT_DIR` 都不會改變開關或日誌位置。檔案不存在、無法讀取、JSON 無效或非一般檔案時視為關閉。
- 本模組的 `bash`／`powershell` 執行拋出例外（含逾時、取消、輸入驗證錯誤）或回傳 `isError: true`（例如非零結束碼）時，每次失敗寫入一個檔案：

```text
~/.pi/logs/pi-shell-tools/<UTC時間戳>-<ULID>.json
```

- 內容（`schemaVersion: 1`）包含：時間戳、process id、工具名稱、toolCallId、cwd、sessionId、耗時毫秒、原始輸入（含 `timeoutMs`），以及例外（name／message／stack／cause）或失敗結果。字串超過 65,536 字元時保留前後各 32,768 字元並加上省略標記，原始輸入／結果不受影響。
- 成功呼叫不產生日誌。診斷 I/O 的等待上限為 2 秒，寫入屬 best-effort，失敗最多警告，不改變原本的工具結果或例外。
- 日誌可能包含指令與含機密的輸出；不會自動輪替或清理，請自行刪除。POSIX 上新檔／目錄要求 `0600`／`0700`，Windows 依檔案系統 ACL。本模組不會自動修改你的設定來啟用日誌。

## 範圍與限制

- 只改變模型可呼叫的 shell 工具，不影響 `!`／`!!` 使用者 shell 指令或 `pi.exec()`。
- 同名 shell 工具應只由一個擴充擁有；本模組不會與 SSH、sandbox 或 spawn-hook 覆寫自動組合，也不保證保留其執行限制，不要把載入順序當作安全邊界。
